# Agent Treasury

A USDC vault contract on NEAR that AI agents can spend from only within an on-chain mandate set by the owner: per-payment
limit, daily limit, daily payment count, allowed chains, allowed recipients, approval threshold, expiry, pause.
Agents ask the vault to pay; the vault checks the mandate and sends USDC to a NEAR Intents (1Click) deposit address, which
delivers it on the recipient's chain (Base, Arbitrum, Solana, …). The first use case is payroll: one organisation pays
people on different chains on a schedule, without a human signing each payment. The second is a Hyperliquid spot trading
agent: the vault funds the owner's own Hyperliquid account, and a deterministic engine trades rules the owner signed
(section "Trading agent (Hyperliquid)").

Built for NEAR HACKATHON (Nov 2026). Tracks: `security`, `business`, `realworld`.

## Problem

An autonomous agent that pays people needs money. Giving it a private key lets it spend everything. Approving every
payment by hand removes the autonomy. Agent Treasury puts the rules in a contract the agent cannot change: the agent holds
only a key (or a TEE identity) that can call `request_payment`, and every call is checked against its mandate on-chain.
A leaked agent key or a prompt-injected model is capped by the mandate limits; other agents keep working.

## How NEAR is used

| Piece | What is built | Status |
|---|---|---|
| **Vault contract** (`contract/`, Rust, near-sdk 5.26.1) | Holds NEP-141 USDC; owner, global policy (daily limit, min payment, overdue grace, pause); agents with mandates; recipients address book; schedules (once / weekly / monthly / every N days); `request_payment` with ordered checks and machine-readable rejection codes; owner approvals; payout log; rejection log; refund crediting; owner is never locked out (`withdraw` ignores pause). | Deployed on **testnet** (`at-vault-11012309.testnet`). Not on mainnet. |
| **Function-call access keys** | A "key agent" is a NEAR account whose function-call key may call only `request_payment` and `report_payout_status` on the vault, with a capped gas allowance. The NEAR runtime enforces the method restriction; the contract enforces the mandate. | Used on testnet (`claudeagent.at-owner-11012309.testnet`). |
| **Shade Agent (TEE)** (`contract/src/agent.rs`, `worker/`) | The vault is the Shade Agent v2 contract (ADR-0001): `register_agent` verifies a TEE attestation (measurements + PPID) and binds a "Tee" agent slot. The payroll worker (TypeScript, `@neardefi/shade-agent-js` 2.2.0) registers into that slot. | Only **local mode** was run (no TEE, mock all-zero measurements, owner-whitelisted account; `requires_tee: false`). **Not deployed to Phala / no real attestation yet.** |
| **NEAR Intents 1Click API** | Worker, SDK and MCP server request a real quote (`/v0/tokens`, `/v0/quote`), verify the quote echo before signing, pass the `depositAddress` to the vault, submit and poll `/v0/status`, then report the status. The dashboard looks up `/v0/status?depositAddress=` before the owner can approve a payment. | Read-only calls verified against mainnet 1Click (`pnpm dry-quote`). **No real cross-chain payout yet**: NEAR Intents has no testnet, so all testnet payouts used `ONECLICK_MODE=simulated` (fake 1Click; USDC moves on NEAR testnet to a random deposit account, nothing is delivered cross-chain). |
| **NEAR AI Cloud** (`worker/src/ai`) | Optional assistant: `POST /ai/chat` (SSE) calls the OpenAI-compatible NEAR AI Cloud endpoint, reads the vault over RPC, and returns typed proposals that the owner signs in the wallet. Owner sign-in is NEP-413. The assistant has no key. | Built and unit-tested against a scripted fake model. **Not run against the live NEAR AI Cloud API** (no API key yet). |
| **Trading agent** (`worker/src/trading`, ADR-0005) | Key agent `hl-trader` with an `Allowlist` mandate whose only destination is `hypercore` + the owner's Hyperliquid (HL) master address. It tops up that account through 1Click (NEAR USDC → HyperCore spot USDC). Rules are owner-signed with NEP-413 (same sign-in as the assistant). | Built; unit and e2e tests with fakes only. **Not run on HL testnet or HL mainnet yet.** |
| **Wallet** (`dashboard/`) | Static SPA, `@near-wallet-selector` 10.1.4 (Meteor Wallet, MyNearWallet). View calls go over RPC; owner calls are signed in the wallet. | Used on testnet with Meteor Wallet. |

## Architecture

```
 owner wallet ──(owner calls, 1 yoctoNEAR)──►┌──────────────────────────────┐
 dashboard (static SPA) ──(view calls, RPC)─►│ Vault contract (NEAR, Rust)  │
                                             │  policy · agents + mandates  │
 payroll worker (TS, Shade Agent, TEE*) ────►│  recipients · schedules      │
   request_payout(schedule_id, deposit)      │  payouts · rejections        │
                                             │  USDC balance (NEP-141)      │
 key agent: Claude Code + MCP server ───────►│                              │
   request_payment(chain, address, amount,   └──────────────┬───────────────┘
                   deposit_address)                         │ storage_deposit + ft_transfer (one batch)
                                                            ▼
                         1Click deposit address (64-hex NEAR implicit account)
                                                            │ NEAR Intents
                                                            ▼
                                 recipient on Base / Arbitrum / Solana / NEAR / …

 * TEE = Phala Cloud via shade-agent-cli; not deployed yet, local mode only.
 Agents get the deposit address from a fresh 1Click quote; the vault never calls 1Click.
 Optional: worker /ai → NEAR AI Cloud → proposals → owner signs.
 Optional: worker /trading = key agent hl-trader → request_payment(hypercore, HL master) → 1Click → owner's HL account;
           its engine trades HL spot with an HL API wallet (section "Trading agent (Hyperliquid)").
```

Details, payment path, trust boundaries and the exact check order: [`docs/architecture.md`](docs/architecture.md).

## What the vault does NOT protect

From the pre-mainnet audit of the trading agent ([`docs/security/audit-2026-11-03-trading.md`](docs/security/audit-2026-11-03-trading.md),
"Known limitations"). Items 2–7 are about the trading agent.

1. **The allowlist pins the declared destination, not the real one, for Key agents** (`hl-trader` included). The vault
   cannot see where a 1Click deposit address pays out. A stolen agent key can send up to its mandate limits to any NEAR
   account. Only an owner approval (the dashboard checks the deposit address with 1Click first) or TEE-attested agent
   code closes this.
2. **Funds on Hyperliquid are not protected by the vault.** The vault limits only how much is sent there per day. The
   bot's API wallet cannot withdraw or send to another address directly. But whoever holds its key can lose or route away
   the whole HL balance: trading, leveraged perps (HIP-3 builder-dex perps are not detected), moving USDC between spot
   and perp, wash trades against their own orders, and possibly `vaultTransfer` into an HL vault they lead (not verified).
3. **The trader runs in local mode, with no TEE.** Limits, perp alarm and loss stop are code on the operator's machine,
   and a compromised host can skip them. Keys sit in plain files (`worker/.env`, `TRADING_STATE_DIR/api-wallet.json`).
4. **The kill switch halts the bot and pauses top-ups, but positions stay open.** The real stop is revoking the API
   wallet on app.hyperliquid.xyz with the master key. The dashboard kill needs the worker to be reachable;
   `pause_agent` also needs NEAR RPC.
5. **Rules are owner-signed (NEP-413) and kept in worker storage, not on-chain.** The proof is the signed envelope plus
   the `cloid` prefix (first 8 bytes of the rules hash) on every HL order.
6. **The daily loss stop depends on reading HL ledger inflows.** A top-up must show up as an inflow, or that day's loss
   figure is wrong. Which ledger type a 1Click landing produces has not been observed yet.
7. **Profits do not flow back to the vault automatically.** The return is manual: HL `spotSend` → 1Click → vault, then
   the two-phase `sync_surplus`.
8. **Status reporting on local-mode vaults.** On a vault created with `allow_insecure_local_mode`, the whitelisted dev
   worker may annotate Key agents' payout statuses (`Confirmed` / `Refunded` / `Failed`). Annotation only: refunds and
   surplus are credited from the real token balance.
9. **The owner's HL master EVM key is a second root of trust,** next to the NEAR owner key. Use hardware wallets for
   both.

## Repo layout

```
contract/     Rust vault contract (near-sdk 5.26.1, shade-attestation 0.2.0). cargo test on host; build.sh builds wasm
worker/       TypeScript payroll agent: Hono HTTP API, Shade Agent registration, payout loop, 1Click client, /ai assistant,
              src/trading (Hyperliquid spot trading agent, off by default)
sdk/          TypeScript SDK for key agents (getBudget, quotePayment, requestPayment, getPaymentStatus, listAllowedRecipients)
              + scripts/setup-key-agent.ts, scripts/revoke-key-agent.ts
mcp/          MCP server (stdio) for Claude Code / Claude Desktop: five treasury_* tools, built on sdk/
dashboard/    Vite + React SPA for the owner: Treasury, Agents (+ wizard), Payments (schedules, recipients), Payouts, Policy
design-kit/   design package (tokens, prototypes) the dashboard is built from
docs/         architecture.md, comparison.md, demo-script.md, adr/ (0001–0005), security/audit-2026-11-01.md,
              security/audit-2026-11-03-trading.md, commands.md (every command used, incl. the mainnet trading
              runbook), deployments.md, research/hyperliquid-trading.md, trading-rules-vectors.json
skills/       empty for now (agent skill example not written yet; git does not track empty dirs, so absent in a clone)
third_party/  upstream LICENSE + NOTICE of NearDeFi/shade-agent-template and the list of files derived from it
CLAUDE.md, AGENT_ACCESS.md, UI_PLAN.md, DESIGN_AGENTS.md, UI_UPDATES.md   specs the code was built from
HACKATHON.md  copy of the hackathon rules
```

Each package has its own `pnpm-lock.yaml`; there is no root workspace.

## Quickstart

Requirements (versions used): Rust stable (1.99.1) with `cargo`, Node.js ≥ 22 (tested with 23.11.0), pnpm 11.22.0,
`near-cli-rs` 0.30.1 (`cargo install --locked near-cli-rs`, binary `near`) for path B. Paths A, B, C, D1 and F1 need no
NEAR account, no keys and send no transactions (D2, E and F2 send testnet transactions from your own accounts; nothing
needs mainnet). Path F (trading agent) is in the section "Trading agent (Hyperliquid)".

### A. Run all tests offline

Contract (about 60 s; one test runs > 60 s):

```bash
cd contract
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Expected: `test result: ok. 174 passed; 0 failed` (count on 2026-11-03; it grows as tests are added).

TypeScript packages. Build `sdk` before `mcp`, because `mcp` links `../sdk` by path:

```bash
for p in sdk mcp worker dashboard; do
  (cd $p && pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build) || break
done
```

Expected (2026-11-03), no network used by the tests (fake vault, fake 1Click, fake RPC, fake Hyperliquid, fake model):

| Package | `pnpm test` | `pnpm build` output |
|---|---|---|
| sdk | `Tests  89 passed (89)` | `sdk/dist/` |
| mcp | `Tests  17 passed (17)` | `mcp/dist/index.js` |
| worker | `Tests  636 passed (636)` | `worker/dist/` |
| dashboard | `Tests  333 passed (333)` | `dashboard/dist/` (`✓ built in …`) |

The worker needs Node.js ≥ 22.12 (`@nktkas/hyperliquid` 0.33.3).

Optional, read-only, mainnet 1Click (no key, no funds): `cd worker && pnpm dry-quote` → prints
`token ok: USDC on near, 6 decimals`, `token ok: USDC on base, 6 decimals`, then a quote JSON with `"dry": true`,
`"amountIn": "1000000"` and `"amountOut"` around `"997398"`, and no `depositAddress`.

### B. Read the live testnet vault (near-cli-rs, read-only)

Vault `at-vault-11012309.testnet`, owner `at-owner-11012309.testnet`, token Circle testnet USDC
`3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`. Explorer:
https://testnet.nearblocks.io/address/at-vault-11012309.testnet . Amounts are USDC base units (6 decimals: `5500000` = 5.5 USDC).
Values below are from 2026-11-02 and change as the vault is used.

```bash
V=at-vault-11012309.testnet
near contract call-function as-read-only $V get_contract_info json-args '{}' network-config testnet now
```
→ `"owner_id": "at-owner-11012309.testnet"`, `"requires_tee": false`, `"version": "0.1.0"`.

```bash
near contract call-function as-read-only $V get_balance json-args '{}' network-config testnet now
```
→ `{"balance": "5500000", "in_flight": "0", "spent_today": …, "remaining_today": …, "day_index": …}`.

```bash
near contract call-function as-read-only $V get_agents json-args '{}' network-config testnet now
```
→ two agents:
- `payroll`: `"kind": "Tee"`, mandate `"recipients_mode": "Fixed"`, `"recipients": [0,1,2,3]`, `"per_tx_limit": "10000000"`, `"tee": {"valid": true, "ppid": "000…0", …}` (all-zero mock measurements = local mode).
- `claudeagent`: `"kind": "Key"`, `"account_id": "claudeagent.at-owner-11012309.testnet"`, `"recipients_mode": "Allowlist"` (Priya on base, Alex on sol), `"per_tx_limit": "3000000"`, `"approval_threshold": "2000000"`, `"daily_limit": "5000000"`.

```bash
near contract call-function as-read-only $V get_payouts json-args '{"from_index":0,"limit":10}' network-config testnet now
```
→ three payouts, all `"status": "Confirmed"` with `"tx_hash": "simulated-…"` (simulated 1Click):
`id 0` payroll → Maria (test), base, 1 USDC, `"schedule_id": 0`; `id 1` claudeagent → Alex, sol, 1 USDC;
`id 2` claudeagent → Priya, base, 2.5 USDC, `"approval_reason": "ABOVE_THRESHOLD"` (approved by the owner).

```bash
near contract call-function as-read-only $V get_rejections json-args '{"limit":3}' network-config testnet now
```
→ newest first: `RECIPIENT_NOT_ALLOWED` ("0x…beef on base is not in the allowlist of agent 'claudeagent'."),
`PER_TX_LIMIT_EXCEEDED` ("Per-payment limit for agent 'claudeagent' is 3 USDC; requested 4."),
`INSUFFICIENT_BALANCE` (payroll, before the vault was funded).

Other views: `get_policy`, `get_recipients`, `get_agent_budget '{"agent_id":"claudeagent"}'`, `get_pending_approvals`,
`get_payout '{"payout_id":"2"}'`, `get_payouts_count`.

Why the dashboard would refuse to approve payout 2 on mainnet: its deposit address came from the fake 1Click, so the real
1Click does not know it (read-only GET):

```bash
curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=f7d3c439a87910064628c8826e131afd5e22ab49bd0a5437e657cc97756a7c4b"
```
→ HTTP 404, `{"message":"Deposit address f7d3…7c4b not found","error":"Not Found","statusCode":404,…}`.

### C. Run the dashboard against the testnet vault

```bash
cd dashboard && pnpm install --frozen-lockfile
VITE_NEAR_NETWORK=testnet \
VITE_VAULT_CONTRACT=at-vault-11012309.testnet \
VITE_USDC_CONTRACT=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af \
VITE_ONECLICK_MODE=simulated \
VITE_WORKER_URL= \
pnpm dev
```
(or copy `.env.example` to `.env.local` and put the same values there). Open http://localhost:5173 . Expected on the
Treasury page without a wallet: header `at-vault-11012309.testnet` and `testnet`; "Vault balance 5.50 USDC"; "Agents (2)"
with `Payroll` and `claudeagent`, both `Active`; "Worker: offline" (no worker running); a Payouts list with three
`Confirmed` rows (Maria (test) · Payroll · scheduled; two on-demand rows from claudeagent). Hash routes: `#/agents`,
`#/payments`, `#/payouts`, `#/policy`. All buttons that change state need the owner's wallet; any other account is read-only.

RPC: the default is FastNEAR (`https://test.rpc.fastnear.com`). `rpc.testnet.near.org` answered browser requests with
HTTP 429 without CORS headers during testing.

### D. Connect Claude Code to the vault through the MCP server

Build (`sdk` first): `cd sdk && pnpm install && pnpm build && cd ../mcp && pnpm install && pnpm build`.

**D1. Read-only, no key (anyone can run this).** The server runs without `TREASURY_AGENT_PRIVATE_KEY`; then only the
read-only tools work. Smoke test over stdio:

```bash
cd mcp
{ printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"treasury_get_budget","arguments":{}}}'; sleep 8; } \
| TREASURY_VAULT=at-vault-11012309.testnet TREASURY_NETWORK=testnet \
  TREASURY_AGENT_ACCOUNT=claudeagent.at-owner-11012309.testnet ONECLICK_MODE=simulated \
  node dist/index.js
```
→ stderr: `SIMULATED 1CLICK - no cross-chain transfer (outcome=success)` and
`agent-treasury-mcp ready: vault=at-vault-11012309.testnet network=testnet agent=claudeagent.at-owner-11012309.testnet oneclick=simulated signing=DISABLED (read-only)`;
stdout: the `initialize` result (`"serverInfo":{"name":"agent-treasury",…}`), then a `treasury_get_budget` result with
`"recipients_mode":"Allowlist"`, `"per_tx_limit_usdc":"3"`, `"approval_threshold_usdc":"2"`, the two allowlist entries,
`"status":"Active"` (`remaining_today_usdc` depends on today's spending).

Same server inside Claude Code (writes to your Claude Code MCP config):

```bash
claude mcp add agent-treasury \
  -e TREASURY_VAULT=at-vault-11012309.testnet -e TREASURY_NETWORK=testnet \
  -e TREASURY_AGENT_ACCOUNT=claudeagent.at-owner-11012309.testnet -e ONECLICK_MODE=simulated \
  -- node "$(pwd)/dist/index.js"
```
Then ask Claude Code "What is my treasury budget?" → it calls `treasury_get_budget`.

**D2. Paying (needs a key agent on a vault you own).** The `claudeagent` key is not public. To pay, create your own
vault and key agent on testnet (this sends testnet transactions from your accounts):
1. Deploy and initialise a vault: `docs/commands.md` → "Testnet deployment" (deploy + `new` in one transaction, `storage_deposit` on testnet USDC). Fund it from https://faucet.circle.com (NEAR Testnet) with `ft_transfer_call`, or use the dashboard's Treasury → Deposit.
2. Create the key agent: dashboard Agents → Add agent (wizard), or `cd sdk && pnpm setup-key-agent --owner <OWNER> --vault <VAULT> --name procurement --mandate examples/mandate.procurement.json --dry-run` (drop `--dry-run` and set `OWNER_PRIVATE_KEY` in the environment to send). The private key is printed once.
3. Add the MCP server with `TREASURY_AGENT_PRIVATE_KEY=<that key>` and `ONECLICK_MODE=simulated` (config: `mcp/README.md`). Never commit the key.
4. Run the dashboard (path C) with `VITE_VAULT_CONTRACT=<VAULT>`, connect the owner wallet (Meteor Wallet worked; MyNearWallet did not connect on 2026-11-02).

Expected, as on 2026-11-02 with an Allowlist mandate (per-tx 3, approval above 2, 5/day):
- "Pay 1 USDC to Alex on sol" → `{"status":"submitted","payout_id":"1",…}`, later `Confirmed`.
- "Pay 4 USDC to Priya on base" → `{"status":"rejected","reason":"PER_TX_LIMIT_EXCEEDED","detail":"Per-payment limit for agent 'claudeagent' is 3 USDC; requested 4."}`.
- "Pay 1 USDC to 0x…beef on base" → `rejected`, `RECIPIENT_NOT_ALLOWED`.
- "Pay 2.5 USDC to Priya on base" → `{"status":"pending_approval","reason":"ABOVE_THRESHOLD",…}` → owner opens Payouts → payout → the quote check shows "Simulated 1Click — quote check skipped (testnet only)" → tick the acknowledgement → Approve → `Confirmed`.

Steps D2.1–D2.4 were run by the author on 2026-11-01/02 (see `docs/commands.md`), but not re-run from a clean clone.

### E. Payroll worker on testnet (local mode, simulated 1Click)

Sends testnet transactions; needs a funded sponsor account and owner setup (agent slot, local-mode whitelist, mock
measurements/PPID, recipient, schedule). Full sequence: `worker/README.md` sections 3–4b and `docs/commands.md` →
"Testnet e2e run, part 1/2". Expected: `curl localhost:3000/status` shows `registration.state: "registered"` and
`oneclickMode: "simulated"`; after the schedule's start time the next run creates a payout that ends `Confirmed`.

## Trading agent (Hyperliquid)

A second reference use case, switched off by default (`TRADING_ENABLED=false`). Design: [`docs/adr/0005-hyperliquid-trading-agent.md`](docs/adr/0005-hyperliquid-trading-agent.md).
Read "What the vault does NOT protect" above first.

What it does: trades **spot** HYPE/USDC on Hyperliquid (HL) with USDC from the vault, by rules the owner wrote in plain
language and signed. The LLM never places orders and never sees a key.

Flow:
1. **Funding.** The worker's trading module is the Key agent `hl-trader`. Its mandate has one allowlist entry,
   `hypercore` + the owner's dedicated HL master address. When free HL USDC falls below `TRADING_TOPUP_FLOOR_USDC`, it
   calls `request_payment` for exactly `TRADING_TOPUP_USDC`. The vault checks the mandate, and 1Click delivers NEAR USDC
   as HyperCore spot USDC to the master. With `approval_threshold` 0, every top-up waits for the owner, who approves it in
   the dashboard after the 1Click quote check.
2. **API wallet.** The worker generates an HL API wallet into `TRADING_STATE_DIR/api-wallet.json` (mode 0600). The
   owner approves its address on app.hyperliquid.xyz → API with the master key. The bot trades only while HL lists it as
   approved.
3. **Rules.** The owner types rules in the assistant chat. NEAR AI calls `propose_trading_rules` and returns a
   `RuleSetV1` JSON. The worker validates it against env hard limits (pair, max position, max order ≥ 10 USDC, daily
   loss, orders per day). The dashboard renders the card with its own code and computes the rules hash.
4. **Confirm.** The owner signs a NEP-413 message with that hash (full-access key of the vault owner).
   `POST /trading/rules/confirm` checks the signature, the owner, a single-use nonce, the hash and the limits.
5. **Engine.** A deterministic tick runs every `TRADING_TICK_SEC`, with no LLM involved. Each tick:
   - reads the vault budget and HL state;
   - checks the perp alarm, data freshness, API-wallet approval and on-chain pause or revoke;
   - refreshes the `scheduleCancel` dead-man switch;
   - applies the daily loss stop;
   - places at most 2 orders inside a ±1 % band, each with `cloid` = rules-hash prefix + counter.
6. **Stop.** The dashboard kill switch:
   - calls `POST /trading/kill` (cancels all orders, halts until new rules are signed, dead-man at now + 6 s);
   - then calls `pause_agent` on the vault;
   - then tells the owner to revoke the API wallet on HL.

   Positions stay open.

### F. Run the trading agent locally

**F1. Offline, with fakes (no network, no keys):**

```bash
cd worker && pnpm install --frozen-lockfile && pnpm exec vitest run test/trading
```
→ every test file passes (part of the 636 worker tests). `test/trading/e2e.test.ts` runs the whole path through
`createTradingModule` + `createApp` with a fake HL, SDK, NEAR and model: chat → proposal → sign → confirm → IOC order →
loss stop → kill. It also checks that a non-owner session cannot confirm or kill, and that a low HL balance with no
rules triggers exactly one top-up to `hypercore` + the master.

**F2. Against HL testnet, NEAR testnet and simulated 1Click.** This sends NEAR testnet transactions from your accounts
and HL testnet actions from your HL master. You need:
- a testnet vault you own (path D2.1);
- a NEAR AI key;
- an HL master address with testnet USDC. The faucet at https://app.hyperliquid-testnet.xyz/drip pays only addresses that
  have deposited on HL mainnet before.

Steps:
1. Create the key agent. Copy `sdk/examples/mandate.hl-trader.json` to `/tmp/mandate.hl-trader.testnet.json` and set
   `allowlist[0].address` to your HL master. Then run
   `cd sdk && OWNER_PRIVATE_KEY=ed25519:… pnpm setup-key-agent --owner <OWNER> --vault <VAULT> --name hl-trader --mandate /tmp/mandate.hl-trader.testnet.json`
   → it prints `TREASURY_AGENT_ACCOUNT=hl-trader.<OWNER>` and `TREASURY_AGENT_PRIVATE_KEY=ed25519:…` once.
2. Create `worker/.env` (gitignored; never commit it):
   ```bash
   NEAR_NETWORK=testnet
   VAULT_CONTRACT_ID=<VAULT>
   RUN_MODE=local
   ONECLICK_MODE=simulated              # top-ups move testnet USDC on NEAR only; nothing reaches HL testnet
   DRY_RUN=true                         # payroll loop off; no SPONSOR_* needed for trading
   AI_SESSION_SECRET=<openssl rand -hex 32>
   NEARAI_API_KEY=<key>
   DASHBOARD_ORIGIN=http://localhost:5173
   TRADING_ENABLED=true
   HL_NETWORK=testnet
   HL_MASTER_ADDRESS=<HL master 0x…>
   TRADING_STATE_DIR=./.trading-testnet
   TRADER_NEAR_ACCOUNT_ID=hl-trader.<OWNER>
   TRADER_NEAR_PRIVATE_KEY=<TREASURY_AGENT_PRIVATE_KEY from step 1>
   ```
3. Start the worker: `cd worker && pnpm build && node dist/index.js`
   → `TRADING ENABLED: hl=testnet account=<HL master> agent=hl-trader api-wallet=0x…`.
   `curl -s localhost:3000/trading/status | jq .state` → `"awaiting_api_wallet"`.
4. Approve that `api-wallet` address on https://app.hyperliquid-testnet.xyz → API with the name
   `agent-treasury valid_until <ms>`. Then `/trading/status` → `api_wallet.approved: true`, state `"no_rules"`.
5. Start the dashboard (path C) with `VITE_VAULT_CONTRACT=<VAULT> VITE_WORKER_URL=http://localhost:3000 VITE_AI_ENABLED=true`.
   Open `#/trading` and sign in as the owner. Type the rules in the assistant, for example "buy HYPE for 12 USDC every
   hour, max position 40, stop at −5 today". Then Review & sign rules → state `"running"`.

Known testnet limit: testnet HYPE/USDC had a very wide book (bid 8200 / ask 11355) when tested, so the spread gate skips
every tick there. Use a testnet pair with a sane book in `TRADING_ALLOWED_PAIRS` and a lower
`TRADING_MIN_PAIR_VOLUME_USDC` to see fills; which pair works was not checked. Drills (kill, `pause_agent`, `kill -9`,
manual perp → `halted`) and their expected results: `docs/commands.md` → "Trading testnet drills".

Mainnet: only with the owner's explicit OK for each step, following `docs/commands.md` →
"[MAINNET] Trading session runbook" (vault ≤ 26 USDC, daily 25, one top-up, threshold 0, agent and API wallet ≤ 48 h,
everything revoked afterwards).

Status (2026-11-03): built. The rules DSL, engine, funding, confirmation, routes and dashboard are unit-tested and
e2e-tested with fakes. Audit 2026-11-03 found 0 critical, 2 high (H1 mitigated by session config; H2 is an inherent HL
limit, now documented) and 7 medium. M1 and M2 are fixed; the rest are tracked in ADR-0005 "Audit 2026-11-03 follow-up".
**Not run on HL testnet or HL mainnet yet**; no real 1Click delivery to HyperCore has happened yet.

## Status

What was run and verified (testnet, 2026-11-01/02, local mode, simulated 1Click):

| Scenario | Result | Evidence |
|---|---|---|
| Unknown caller calls `request_payment` | `Rejected AGENT_NOT_FOUND`, no money moved | `docs/commands.md` "Testnet deployment" |
| Payroll worker registers into the `payroll` Tee slot (local mode) | `get_agent(payroll).tee.valid == true` | `get_agents` |
| Scheduled payout with an empty vault | `Rejected INSUFFICIENT_BALANCE`, nothing moved | `get_rejections` |
| Scheduled payroll payout (schedule 0, 1 USDC → Maria on base) | payout 0 `Confirmed`, balance 10 → 9 USDC | `get_payout 0` |
| `add_schedule` above the agent's per-tx limit | refused by the contract | `docs/commands.md` part 2 |
| Key agent via MCP from Claude Code: allowed payment (1 USDC → Alex, sol) | payout 1 `Confirmed` | `get_payout 1` |
| Key agent: 4 USDC (per-tx limit 3) | `Rejected PER_TX_LIMIT_EXCEEDED` (by the contract) | `get_rejections` |
| Key agent: address not in allowlist | `Rejected RECIPIENT_NOT_ALLOWED` (by the contract) | `get_rejections` |
| Key agent: 2.5 USDC (threshold 2) | `pending_approval ABOVE_THRESHOLD` → owner approved in dashboard → payout 2 `Confirmed` | `get_payout 2` |
| Dashboard quote check on a simulated deposit address | Approve blocked ("1Click has no quote for this deposit address"); testnet-only simulated mode added with explicit acknowledgement | `dashboard/src/features/payouts/QuoteCheckPanel.tsx`; 404 from 1Click (path B) |
| Trading agent with fakes: chat → proposal → NEP-413 confirm → IOC order → loss stop → kill; top-up to `hypercore` + master | passing (offline) | `worker/test/trading/e2e.test.ts`, path F1 |
| Offline tests | contract 174, sdk 91, mcp 17, worker 636, dashboard 343, all passing (2026-11-03) | path A |

"Confirmed" in simulated mode means the worker/MCP reported success after USDC moved on NEAR testnet to a random
64-hex deposit account. Nothing was delivered on Base, Solana or Arbitrum.

Not done yet:

| Item | State |
|---|---|
| Worker in a real TEE (Phala Cloud) with approved measurements and a real attestation | not deployed; only local mode ran |
| Mainnet vault and a real 1Click cross-chain payout | not done (needs explicit go-ahead; NEAR Intents has no testnet) |
| NEAR AI Cloud assistant against the live API | not run (no API key); tested against a fake |
| Owner pausing a key agent live (`AGENT_PAUSED`) and revocation in the e2e run | covered by contract unit tests, not run on testnet |
| `skills/` example for external agents | not written |
| Trading agent on HL testnet (12 h run + kill / `pause_agent` / `kill -9` / manual-perp drills) | not run; plan and expected results in `docs/commands.md` |
| Trading session on HL mainnet (first real 1Click delivery to HyperCore, one trade) | not run; runbook written (`docs/commands.md` → "[MAINNET] Trading session runbook"), each step needs the owner's OK |
| Trading audit findings M3, M5, M6, M7 | open or in progress (ADR-0005 "Audit 2026-11-03 follow-up") |
| Payouts approved for a key agent stay `Sent` until someone polls 1Click | fix in progress (ADR-0002 amendment 2026-11-02: worker reports Key agents' payouts); not deployed to the testnet vault |

## Security model (summary)

- **The contract is the only enforcement point.** SDK/MCP/worker checks are previews; the vault re-checks everything and returns the first failing reason (`docs/architecture.md` lists the order).
- **Reserve before transfer, release on failure.** Balance and daily counters are updated before the `storage_deposit + ft_transfer` batch; the `#[private]` callback never panics and releases the reservation if the transfer fails.
- **Key agents** (function-call keys) can call only `request_payment` / `report_payout_status` and cannot transfer NEAR. The vault cannot see 1Click quotes, so for key agents the destination check is on the *declared* destination; the hard caps are per-tx limit, daily amount, daily count, min payment, expiry and the vault daily limit. The approval threshold can be split into smaller payments; only daily limits bind.
- **Owner approval** is gated in the dashboard by a 1Click `/v0/status` lookup of the deposit address: recipient, refund address, amount and deadline must match, an unknown address cannot be approved (audit H2).
- **TEE agents**: money-relevant worker config is pinned in the measured compose file (audit H1); measurements and PPIDs are approved vault-wide; the owner should `pin_agent` after first boot. Not exercised on real TEE hardware yet.
- **Owner never locked out**: `withdraw` ignores pause; irreversible owner actions need 1 yoctoNEAR (wallet confirmation); pausing does not, so a kill switch works from a function-call key.
- **Memo** is untrusted text; it is displayed, never executed, and not returned to the model by the MCP status tool.
- **Simulated 1Click** is refused unless the RPC reports `chain_id == "testnet"`.

Full audit (0 critical; H1, H2, M1–M4, L1 fixed in code; trust-boundary table and known limitations):
[`docs/security/audit-2026-11-01.md`](docs/security/audit-2026-11-01.md). Trading agent audit (0 critical, 2 high, 7
medium; conditional go for one tiny mainnet session): [`docs/security/audit-2026-11-03-trading.md`](docs/security/audit-2026-11-03-trading.md).
Design decisions: [`docs/adr/`](docs/adr).

Known limitations: Shade Agent v2 tooling is unmaintained upstream (versions pinned, ADR-0001); `shade-attestation`
accepts any app-compose whose hash is approved; NEAR AI attestation is fetched but not verified by the worker; owner
full-access key compromise is total loss (no multisig or timelock).

## Hackathon work and baseline

The repository was created on 2026-11-01 (initial commit `c6144b6`, 2026-11-01 13:08 UTC), inside the submission window.
There is no pre-hackathon code; all commits on `feat/kit-foundation` were written during the hackathon. The project does
not exist on another chain.

## Disclosures

Templates and adapted code:
- [NearDeFi/shade-agent-template](https://github.com/NearDeFi/shade-agent-template) @816b75b (Apache-2.0): TEE attestation parts of `contract/src/agent.rs` (from `agent-contract/src/{lib,owner,views}.rs`, `internal/{attestation,helpers}.rs`), worker registration plumbing, `Dockerfile`, `docker-compose.yaml`, `deployment.yaml`. Attribution in file headers;
  upstream `LICENSE` and `NOTICE.txt` copied verbatim with the list of derived files in
  [`third_party/shade-agent-template/`](third_party/shade-agent-template/).
- NEAR agent skills from [near/agent-skills](https://github.com/near/agent-skills), used locally by Claude Code, not committed.

Main libraries (exact versions in `Cargo.toml` / `package.json`):
- Contract: `near-sdk` 5.26.1, `shade-attestation` 0.2.0, `serde` 1.0.228, `hex` 0.4.3.
- Worker: `@neardefi/shade-agent-js` 2.2.0, `@neardefi/shade-agent-cli` 2.4.0 (dev), `hono` 4.13.14, `@hono/node-server` 2.1.5, `@near-js/providers` / `@near-js/types` 2.5.1, `zod` 4.6.7, `dotenv` 18.0.9, `@nktkas/hyperliquid` 0.33.3 (Hyperliquid API client), `viem` 2.57.13 (secp256k1 API wallet), `agent-treasury-sdk` (`link:../sdk`, the trader's vault client).
- SDK: `near-api-js` 7.4.0, `zod` 4.6.7.
- MCP: `@modelcontextprotocol/server` 2.4.0 (`@modelcontextprotocol/client` 2.4.0 for tests), `zod` 4.6.7.
- Dashboard: `react` / `react-dom` 19.3.1, `react-router-dom` 7.18.5, `@tanstack/react-query` 5.105.1, `@near-wallet-selector/{core,modal-ui,meteor-wallet,my-near-wallet}` 10.1.4, `@near-js/crypto` 2.5.1, `tailwindcss` 4.3.3, `vite` 8.3.5, `vite-plugin-node-polyfills` 0.28.0.
- Tooling: TypeScript 5.9.3, vitest 5.0.5, eslint, tsx, cargo-near, near-cli-rs.
- Fonts: Inter and JetBrains Mono (SIL Open Font License 1.1), loaded from Google Fonts by `dashboard/index.html` and
  the design-kit prototypes; not committed.

External services: NEAR testnet RPC (FastNEAR), NEAR Intents 1Click API (`https://1click.chaindefuser.com`), NEAR AI
Cloud (`https://cloud-api.near.ai/v1`, optional), Circle testnet USDC faucet, Hyperliquid API
(`https://api.hyperliquid.xyz`, `https://api.hyperliquid-testnet.xyz`; trading module only).

AI-generated code: the code, tests and documentation in this repository were written with Claude Code agents (Anthropic
Claude), directed and reviewed by the human author. Specs (`CLAUDE.md`, `AGENT_ACCESS.md`, `UI_*.md`, `DESIGN_AGENTS.md`)
were provided by the author. `design-kit/` is the design handoff (tokens, HTML prototypes) the dashboard was built from;
it was produced with Claude Design (Anthropic) from the author's specs, and its `.dc.html` files are exported canvas
artboards (see `design-kit/agent-treasury-design/README.md`).

## License

MIT ([`LICENSE`](LICENSE)). The files derived from shade-agent-template (listed in
[`third_party/shade-agent-template/README.md`](third_party/shade-agent-template/README.md)) keep the template's
Apache-2.0 license; the rest of `worker/` and of `contract/` is MIT. `worker/package.json` declares `Apache-2.0` for
the package as a whole; the per-file split above is the accurate one.
