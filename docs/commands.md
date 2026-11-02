# Commands log

Every command used to set up, build, deploy and operate Agent Treasury, in order, so a human can replay it.
Mainnet commands are marked **[MAINNET]** and were run only after explicit human confirmation.

## Toolchain (2026-11-01)

```bash
rustup update stable && rustup default stable          # rustc 1.99.1
rustup target add wasm32-unknown-unknown
rustup component add rust-analyzer clippy rustfmt
cargo install --locked cargo-near near-cli-rs           # cargo near, near
```

## Agent tooling (optional, for Claude Code users)

```bash
git clone --depth 1 https://github.com/near/agent-skills /tmp/near-agent-skills
cp -R /tmp/near-agent-skills/skills/* .claude/skills/    # gitignored, see README
```

## Contract

```bash
brew install llvm                     # clang with wasm32 backend (needed by ring, via shade-attestation)
cd contract
cargo test                            # unit tests on host (stable rustc)
./build.sh                            # wasm via rustc 1.86.0 + Homebrew clang, -mcpu=mvp, --no-abi
# → contract/target-wasm/near/agent_treasury_vault.wasm
```

## Dashboard

```bash
cd dashboard
pnpm install                       # pnpm 11; pnpm-workspace.yaml sets allowBuilds: unrs-resolver: false
cp .env.example .env.local         # set VITE_VAULT_CONTRACT_ID
pnpm typecheck && pnpm lint && pnpm test
VITE_VAULT_CONTRACT_ID=vault.example.testnet pnpm build
pnpm dev                           # http://localhost:5173
```

## Worker

```bash
cd worker
# package.json written by hand, then:
pnpm add --save-exact @hono/node-server @neardefi/shade-agent-js@2.2.0 hono dotenv zod @near-js/providers@2.5.1 @near-js/types@2.5.1
pnpm add -D --save-exact typescript@5.9.3 @types/node@20.19.39 tsx vitest eslint @eslint/js typescript-eslint @neardefi/shade-agent-cli@2.4.0
pnpm typecheck && pnpm lint && pnpm test      # 47 tests, fake 1Click + fake vault, no network
pnpm build                                   # tsc -> dist/
pnpm dry-quote                               # read-only mainnet 1Click call: one dry:true quote, NEAR USDC -> Base USDC, 1 USDC (ran once, 2026-11-01)
pnpm dev                                     # local (insecure) worker; set DRY_RUN=true first
pnpm exec shade auth set near testnet create-new   # sponsor account for the agent (see worker/README.md)
pnpm exec shade plan && pnpm exec shade deploy     # TEE deploy; signs as vault owner via CLI credentials
```

Owner calls for the worker (1 yoctoNEAR each; `shade whitelist` / `shade deploy` approvals do not attach it, so they are disabled):

```bash
near contract call-function as-transaction <VAULT> whitelist_agent_for_local json-args '{"account_id":"<AGENT_ACCOUNT_ID>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config testnet sign-with-keychain send
near contract call-function as-transaction <VAULT> approve_measurements json-args '{"measurements":<MEASUREMENTS_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
near contract call-function as-transaction <VAULT> approve_ppids json-args '{"ppids":<PPIDS_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

Worker agent slot (A2, ADR-0003): the owner creates the `payroll` Tee agent before the worker can register (1 yoctoNEAR):

```bash
near contract call-function as-transaction <VAULT> add_agent json-args '{"id":"payroll","name":"Payroll","kind":"Tee","account_id":null,"public_key":null,"mandate":<MANDATE_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
# payroll mandate example: {"daily_limit":"5000000","per_tx_limit":"2000000","approval_threshold":"1500000","allowed_chains":["base","sol","arb"],"recipients_mode":"Fixed","allowlist":[],"recipients":[0,1,2],"expires_at":null,"max_payments_per_day":10}
# if register_agent says the slot is bound to a live agent: near contract call-function as-transaction <VAULT> unbind_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
# payroll mandate example: {"daily_limit":"5000000","per_tx_limit":"2000000","approval_threshold":"1500000","allowed_chains":["base","sol","arb"],"recipients_mode":"Fixed","allowlist":[],"recipients":[0,1,2],"expires_at":null,"max_payments_per_day":10}
# if register_agent says the slot is bound to a live agent (no deposit):
near contract call-function as-transaction <VAULT> unbind_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

## SDK & MCP

```bash
# sdk/  (TypeScript SDK + key-agent scripts; no root workspace, each package has its own lockfile)
cd sdk
pnpm add --save-exact near-api-js@7.4.0 zod@4.6.7
pnpm add -D --save-exact typescript@5.9.3 @types/node@20.19.39 tsx@4.23.15 vitest@5.0.5 eslint@10.14.0 @eslint/js@10.0.1 typescript-eslint@8.72.1
pnpm typecheck && pnpm lint && pnpm test      # fake vault + fake 1Click, no network
pnpm build                                    # tsc -> dist/ (the MCP package links to it)

# Key agent (setup A). The dry run sends nothing and needs no key:
pnpm setup-key-agent --owner <OWNER> --vault <VAULT> --name procurement --mandate examples/mandate.procurement.json --dry-run
# Real run: OWNER_PRIVATE_KEY is read from the environment for this run only; the agent key is printed once.
OWNER_PRIVATE_KEY=ed25519:... pnpm setup-key-agent --owner <OWNER> --vault <VAULT> --name procurement --mandate examples/mandate.procurement.json   # add --confirm-mainnet --network mainnet for mainnet
OWNER_PRIVATE_KEY=ed25519:... pnpm revoke-key-agent --owner <OWNER> --vault <VAULT> --agent-id procurement --public-key ed25519:...

# mcp/
cd ../mcp
pnpm add --save-exact @modelcontextprotocol/server@2.4.0 zod@4.6.7 link:../sdk      # SDK linked by path (build ../sdk first)
pnpm add -D --save-exact @modelcontextprotocol/client@2.4.0 typescript@5.9.3 @types/node@20.19.39 tsx@4.23.15 vitest@5.0.5 eslint@10.14.0 @eslint/js@10.0.1 typescript-eslint@8.72.1
pnpm typecheck && pnpm lint && pnpm test && pnpm build
TREASURY_VAULT=<VAULT> TREASURY_NETWORK=testnet TREASURY_AGENT_ACCOUNT=<AGENT_ACCOUNT> node dist/index.js    # stdio server (read-only without TREASURY_AGENT_PRIVATE_KEY)
```

Schedule demo (owner, 1 yoctoNEAR; see worker/README.md "Schedule-based payroll"): `add_recipient`, then `add_schedule` with a `Once` schedule five minutes ahead:

```bash
START=$(( ($(date +%s) + 300) * 1000 ))
near contract call-function as-transaction <VAULT> add_schedule json-args "{\"schedule\":{\"recipient_id\":0,\"amount\":\"1000000\",\"frequency\":\"Once\",\"start_at\":\"$START\",\"end\":\"Never\",\"agent_id\":\"payroll\"}}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

## AI assistant

```bash
# worker/  (no new dependencies: plain fetch to NEAR AI Cloud, zod 4.6.7 already pinned)
cd worker
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # fake model server + fake RPC, no network, no key
pnpm exec vitest run test/ai                              # only the assistant tests (incl. docs/frequency-vectors.json)

# Live check (needs a real key in the environment; never commit it)
curl -s https://cloud-api.near.ai/v1/models | jq '.data[] | select(.owned_by=="nearai") | {id, supported_features}'
NEARAI_API_KEY=... AI_SESSION_SECRET=$(openssl rand -hex 32) pnpm dev     # without AI_SESSION_SECRET the /ai routes are not mounted
curl -s localhost:3000/ai/info
curl -s -X POST localhost:3000/ai/session/challenge        # sign {message, nonce, recipient} with the owner wallet (NEP-413), then POST /ai/session
curl -N -X POST localhost:3000/ai/chat -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"conversation_id":"c1","vault":"<VAULT>","owner_account":"<OWNER>","messages":[{"role":"user","content":"What do we pay this week?"}]}'
```

Worker TEE hardening (audit H1/M3): after the worker registered and its attestation was checked, pin the slot (1 yoctoNEAR); local mode on mainnet needs `ALLOW_INSECURE_LOCAL_MODE=true` in the worker and `allow_insecure_local_mode: true` in the vault's `new`:

```bash
near contract call-function as-transaction <VAULT> pin_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

## Testnet deployment (2026-11-01)

```bash
# accounts via faucet (keys saved to ~/.near-credentials/testnet, never committed)
near account create-account sponsor-by-faucet-service at-owner-11012309.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
near account create-account sponsor-by-faucet-service at-vault-11012309.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
# vault storage for ~1 MB wasm
near tokens at-owner-11012309.testnet send-near at-vault-11012309.testnet '3 NEAR' network-config testnet sign-with-legacy-keychain send
# deploy + init in ONE transaction (new is #[private]: nobody can front-run init)
cd contract && ./build.sh && cd ..
near contract deploy at-vault-11012309.testnet use-file contract/target-wasm/near/agent_treasury_vault.wasm \
  with-init-call new json-args '{"owner_id":"at-owner-11012309.testnet","treasury_token":"3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af","policy":{"daily_limit":"1000000000","min_payment":"500000","overdue_grace_ms":"259200000"},"requires_tee":false,"attestation_expiration_time_ms":"604800000","storage_deposit_yocto":null,"allow_insecure_local_mode":true}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
# register the vault on testnet USDC so it can receive ft_transfer_call
near contract call-function as-transaction 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af storage_deposit \
  json-args '{"account_id":"at-vault-11012309.testnet","registration_only":true}' prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' \
  sign-as at-owner-11012309.testnet network-config testnet sign-with-legacy-keychain send
# check: a non-agent gets a machine-readable rejection, no money moves
near contract call-function as-transaction at-vault-11012309.testnet request_payment \
  json-args '{"chain":"base","address":"0x1111111111111111111111111111111111111111","amount":"1000000","memo":null,"schedule_id":null,"deposit_address":"78afe8ceccf6cf20593f2afb36fb195339855e29b7661795c5e6024ffe4376a6","deposit_expires_at_ms":null}' \
  prepaid-gas '150.0 Tgas' attached-deposit '0 NEAR' sign-as at-owner-11012309.testnet network-config testnet sign-with-legacy-keychain send
# → {"Rejected":{"reason":"AGENT_NOT_FOUND","detail":"The calling account is not an agent of this vault."}}
```

## Testnet e2e run, part 1 (2026-11-01): payroll agent in local mode

```bash
near account create-account sponsor-by-faucet-service at-sponsor-11012309.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
# worker/.env (gitignored): RUN_MODE=local, ONECLICK_MODE=simulated, DRY_RUN=false, LOOP_INTERVAL_MIN=1,
#   VAULT_CONTRACT_ID=at-vault-11012309.testnet, AGENT_ID=payroll, SPONSOR_* from ~/.near-credentials
cd worker && pnpm build && node dist/index.js      # prints "Agent account ID: 99d14ac4…1dc3"
# owner setup (each 1 yoctoNEAR, sign-as at-owner-11012309.testnet):
#   add_recipient {label "Maria (test)", base, nep141:base-0x8335…913.omft.near, 0x…dead}  → id 0
#   add_agent {id payroll, kind Tee, account_id null, mandate Fixed [0], 50/day, 10/tx, threshold 5, 10/day}
#   whitelist_agent_for_local {account_id: <agent account>}
#   approve_measurements {all-zero mock: 96 hex zeros ×5, app_compose_hash_payload 64 zeros}
#   approve_ppids {["000…0" (32 zeros)]}
# → worker registers by itself: get_agent(payroll).tee.valid == true
#   add_schedule {recipient 0, 1 USDC, Once, start_at now+2min, agent payroll}
# → next run: vault answers Rejected INSUFFICIENT_BALANCE (vault has no USDC yet), nothing moves
```

## Testnet e2e run, part 2 (2026-11-02): first payout

```bash
# owner got 20 testnet USDC from https://faucet.circle.com (NEAR Testnet), deposited 10 via dashboard Treasury -> Deposit
#   (= ft_transfer_call on the USDC contract to at-vault-11012309.testnet, amount 10000000)
# dashboard RPC: rpc.testnet.near.org answers browser preflight with 429 and no CORS header -> use https://test.rpc.fastnear.com
cd worker && pnpm build && node dist/index.js   # RUN_MODE=local, ONECLICK_MODE=simulated
# → run 1: schedule 0 (Maria) dry quote ok → request_payout → payout 0 Sent → deposit/submit → reported Confirmed
near contract call-function as-read-only at-vault-11012309.testnet get_payout json-args '{"payout_id":"0"}' network-config testnet now
near contract call-function as-read-only at-vault-11012309.testnet get_balance json-args '{}' network-config testnet now   # 9000000
# test recipients (addresses are dummies; 1Click is simulated on testnet), asset ids from GET /v0/tokens
#   add_recipient {"recipient":{label, destination_chain, destination_asset, destination_address}}  (1 yoctoNEAR, owner)
#   1 Alex (test)  sol  nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near  1nc1nerator11111111111111111111111111111111
#   2 Kenji (test) arb  nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near 0x0000000000000000000000000000000000000b0b
#   3 Priya (test) base nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near 0x0000000000000000000000000000000000000a11
# update_mandate payroll: allowed_chains [base, sol, arb], recipients [0,1,2,3], limits unchanged (50/day, 10/tx, threshold 5)
# add_schedule with amount above per_tx_limit is refused by the contract itself:
#   → "Smart contract panicked: Amount exceeds payroll's per-payment limit (10)"
```

## Trading agent (Hyperliquid), local commands

```bash
cd worker
pnpm exec vitest run test/trading          # trading tests only: fake HL, fake SDK/NEAR, fake model; no network
# HL info API, read-only, no key (use https://api.hyperliquid-testnet.xyz/info for testnet):
curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"extraAgents","user":"<HL_MASTER_0x>"}'
curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"spotClearinghouseState","user":"<HL_MASTER_0x>"}'
curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"openOrders","user":"<HL_MASTER_0x>"}'
curl -s localhost:3000/trading/status | jq '{state, state_reason, api_wallet, pnl, vault: .limits.vault, dead_man}'
```

## Trading testnet drills (ADR-0005 test plan §2, audit 2026-11-03 M4)

Run these before the mainnet session, or write down here why they were skipped. Nothing here touches mainnet.

Known limits of HL testnet (from `docs/research/hyperliquid-trading.md`):
- The faucet (https://app.hyperliquid-testnet.xyz/drip, 1,000 mock USDC) pays only an address that has already deposited
  on **mainnet**. So the HL master needs its mainnet activation deposit first.
- Testnet HYPE/USDC (`@1035`) had mid 9777.5, bid 8200, ask 11355 when tested: the spread gate skips every tick. To see
  orders, put a testnet pair with a sane book in `TRADING_ALLOWED_PAIRS` and lower `TRADING_MIN_PAIR_VOLUME_USDC`. Which
  pair works was not checked. The kill, pause, `kill -9` and perp drills also work without fills.
- `ONECLICK_MODE=simulated`: top-ups move testnet USDC on NEAR only. Nothing reaches HL testnet.

Setup (sends testnet transactions from your own accounts):

```bash
# 1. hl-trader key agent on the testnet vault. Copy sdk/examples/mandate.hl-trader.json to /tmp and put the HL master in allowlist[0].address
cd sdk
OWNER_PRIVATE_KEY=$(jq -r .private_key ~/.near-credentials/testnet/at-owner-11012309.testnet.json) \
  pnpm setup-key-agent --owner at-owner-11012309.testnet --vault at-vault-11012309.testnet \
  --name hl-trader --mandate /tmp/mandate.hl-trader.testnet.json
# → prints TREASURY_AGENT_ACCOUNT=hl-trader.at-owner-11012309.testnet and TREASURY_AGENT_PRIVATE_KEY=ed25519:… (once)

# 2. worker/.env (on top of the payroll testnet settings in "Testnet e2e run, part 1"):
#   NEAR_NETWORK=testnet  VAULT_CONTRACT_ID=at-vault-11012309.testnet  RUN_MODE=local  ONECLICK_MODE=simulated  DRY_RUN=true
#   AI_SESSION_SECRET=<openssl rand -hex 32>  NEARAI_API_KEY=<key>  DASHBOARD_ORIGIN=http://localhost:5173
#   TRADING_ENABLED=true  HL_NETWORK=testnet  HL_MASTER_ADDRESS=<HL_MASTER_0x>  TRADING_STATE_DIR=./.trading-testnet
#   TRADER_NEAR_ACCOUNT_ID=hl-trader.at-owner-11012309.testnet  TRADER_NEAR_PRIVATE_KEY=<TREASURY_AGENT_PRIVATE_KEY from step 1>
cd ../worker && pnpm build && node dist/index.js
# → "TRADING ENABLED: hl=testnet account=<HL_MASTER_0x> agent=hl-trader api-wallet=0x…"

# 3. approve that api-wallet address on https://app.hyperliquid-testnet.xyz → API, name "agent-treasury valid_until <ms>"
# 4. dashboard (path C of README.md) with VITE_WORKER_URL=http://localhost:3000 VITE_AI_ENABLED=true → #/trading
# 5. chat: an "interval 1h" DCA of 10–12 USDC plus one price_change rule → card → Review & sign rules → wallet
```

Drills (expected results; fill in the "observed" column when run):

| # | Drill | Command / action | Expected | Observed |
|---|---|---|---|---|
| 1 | 12 h run | leave the worker running | `/trading/status` `state: "running"`, `last_tick_ms` advances every `TRADING_TICK_SEC`, `dead_man.cancel_at_ms` ≈ now + 180 s, `log.jsonl` has `order` or `skip` entries | not run yet |
| 2 | Kill switch | dashboard → Trading → Stop trading | `POST /trading/kill` → `{"state":"halted",…,"steps":{"cancel_all":"ok","schedule_cancel":"ok"}}`; then the wallet asks for `pause_agent`; `openOrders` = `[]` within one tick; no new orders | not run yet |
| 3 | `pause_agent` | `near contract call-function as-transaction at-vault-11012309.testnet pause_agent json-args '{"agent_id":"hl-trader"}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as at-owner-11012309.testnet network-config testnet sign-with-legacy-keychain send` | next tick: `state: "paused_onchain"`, orders cancelled; after `resume_agent` (1 yoctoNEAR) the state returns to `running` | not run yet |
| 4 | `kill -9` | `kill -9 $(pgrep -f 'node dist/index.js')` | resting orders gone within `TRADING_DEADMAN_SEC` (`openOrders` = `[]`); after restart the state, rules and log are reloaded from `TRADING_STATE_DIR` | not run yet |
| 5 | Manual perp | open a tiny perp on the master in the HL testnet UI | next tick: `state: "halted"`, `state_reason: "PERP_POSITION_DETECTED"`, spot orders cancelled; the perp stays open (close it by hand); halted stays after a restart | not run yet |

## [MAINNET] Trading session runbook

Every command below uses mainnet. **Nothing here has been run yet.** Steps marked **⚠ needs owner OK** sign a mainnet
transaction or spend money: run each one only after the owner has confirmed that exact command. Limits come from the
session decision in `docs/adr/0005-hyperliquid-trading-agent.md` (audit 2026-11-03 H1): vault funded with ≤ 26 USDC,
vault and mandate daily limit 25, one top-up per day, `approval_threshold` 0, agent expiry and API-wallet `valid_until`
≤ 48 h, everything revoked afterwards. Worst case: about 26 USDC.

Placeholders: `<OWNER>.near` (owner account), `<VAULT>.near` (vault account; a sub-account of the owner such as
`vault.<OWNER>.near` can be created by the owner with `fund-myself`), `<HL_MASTER_0x>` (the dedicated HL master,
`0x` + 40 hex). Signing uses `sign-with-legacy-keychain` as in the testnet sections, because
`sdk/scripts/setup-key-agent.ts` needs the owner key as a plain `OWNER_PRIVATE_KEY`. For other near-cli-rs steps a
Ledger owner can use `sign-with-ledger` instead.

```bash
OWNER=<OWNER>.near
VAULT=<VAULT>.near
HL_MASTER=<HL_MASTER_0x>
USDC=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1      # Circle USDC on NEAR mainnet, 6 decimals
```

Preconditions (check, nothing is signed):
- The owner holds ≥ 26 USDC and ≥ 13 NEAR on `<OWNER>.near`.
- The HL master is already active (it has deposited before; HL charges 1 USDC to activate a fresh address). It is in
  standard margin mode, not unified or portfolio (audit L8). It holds no other funds, sub-accounts or vault deposits.
  `extraAgents` for it returns `[]`.
- Testnet drills above are done, or the reason for skipping them is written there.
- `git status` is clean, and the commit to deploy has been reviewed.

**1. Build the wasm reproducibly** (local, nothing signed).

```bash
cd contract
cargo near build reproducible-wasm          # Docker; image + digest from Cargo.toml [package.metadata.near.reproducible_build]; --locked is implicit
shasum -a 256 target/near/agent_treasury_vault.wasm      # write the hash into docs/deployments.md
ls -l target/near/agent_treasury_vault.wasm              # size decides the NEAR needed in step 2 (~1.04 MB on 2026-11-01)
cd ..
```
If the container build fails (it has not been tried yet; `ring` needs a wasm32-capable clang, see `contract/build.sh`),
use the host build with `--locked` (audit L10). It is **not reproducible**, so record that in `docs/deployments.md`:
`cd contract && CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar CFLAGS_wasm32_unknown_unknown=-mcpu=mvp CARGO_TARGET_DIR=target-wasm cargo +1.86.0 near build non-reproducible-wasm --locked --no-abi`
(output `contract/target-wasm/near/agent_treasury_vault.wasm`).

**2. Create the vault account.** ⚠ needs owner OK (spends about 11.5 NEAR: storage costs 0.00001 NEAR per byte, so a
1,036,756-byte wasm locks about 10.4 NEAR, plus headroom for per-payout storage deposits; the surplus is recoverable
later with `withdraw_near`).

```bash
near account create-account fund-myself $VAULT '11.5 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as $OWNER network-config mainnet sign-with-legacy-keychain send
```

**3. Deploy and call `new` in one transaction** (`new` is `#[private]`, so nobody can front-run init). ⚠ needs owner OK.
`new()` validates nothing (audit 2026-11-01 L2), so check each value against this list before sending:
- `owner_id` = `<OWNER>.near`, not the vault or the token;
- `treasury_token` = `$USDC`;
- `policy.daily_limit` 25 USDC; `min_payment` 2 USDC (the 1Click minimum is about 2); `overdue_grace_ms` 3 days;
- trading-only vault: `requires_tee: true` and no `allow_insecure_local_mode`. Key agents work, and no local-mode
  account can be whitelisted, so audit L6 does not apply.

```bash
near contract deploy $VAULT use-file contract/target/near/agent_treasury_vault.wasm \
  with-init-call new json-args '{"owner_id":"<OWNER>.near","treasury_token":"17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1","policy":{"daily_limit":"25000000","min_payment":"2000000","overdue_grace_ms":"259200000"},"requires_tee":true,"attestation_expiration_time_ms":"604800000","storage_deposit_yocto":null}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' network-config mainnet sign-with-legacy-keychain send
near contract call-function as-read-only $VAULT get_contract_info json-args '{}' network-config mainnet now
# → "owner_id": "<OWNER>.near", "requires_tee": true
near contract call-function as-read-only $VAULT get_policy json-args '{}' network-config mainnet now
# → "daily_limit": "25000000", "min_payment": "2000000", "overdue_grace_ms": "259200000", "paused": false
```
Owner decision needed: the same vault should also serve the payroll demo (owner decision 1), but the payroll worker
runs only in local mode. Then use `"requires_tee":false,"allow_insecure_local_mode":true` instead. In that case audit L6
applies: the whitelisted dev worker may annotate the statuses of `hl-trader` payouts.

Optional, recommended by ADR-0002 §8: delete the vault account's own full-access key, so only contract code can move
its USDC. ⚠ needs owner OK, irreversible: after that, code changes go only through the owner's `update_contract`.
`near account delete-keys $VAULT public-keys <VAULT_PUBLIC_KEY> network-config mainnet sign-with-legacy-keychain send`

**4. Register the vault on mainnet USDC** so it can receive `ft_transfer_call`. ⚠ needs owner OK (0.00125 NEAR).

```bash
near contract call-function as-transaction $USDC storage_deposit json-args '{"account_id":"<VAULT>.near","registration_only":true}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.00125 NEAR' sign-as $OWNER network-config mainnet sign-with-legacy-keychain send
```

**5. Owner deposits ≤ 26 USDC.** ⚠ needs owner OK (moves 26 USDC). The dashboard Treasury → Deposit does the same thing.

```bash
near contract call-function as-transaction $USDC ft_transfer_call json-args '{"receiver_id":"<VAULT>.near","amount":"26000000","msg":""}' \
  prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $OWNER network-config mainnet sign-with-legacy-keychain send
near contract call-function as-read-only $VAULT get_balance json-args '{}' network-config mainnet now
# → "balance": "26000000", "in_flight": "0"
```

**6. Create `hl-trader` with the CLI script, not the dashboard key generator** (audit M6). First write the session
mandate: amounts in USDC base units, threshold 0, daily 25, per-tx 25, one payment per day, expiry 47 h from now, one
allowlist entry (`hypercore` + the HL master).

```bash
EXPIRES_MS=$(( ($(date +%s) + 47*3600) * 1000 ))
# template: sdk/examples/mandate.hl-trader.session.json (placeholders: allowlist address, expires_at)
jq --arg a "$HL_MASTER" --arg e "$EXPIRES_MS" '.allowlist[0].address = $a | .expires_at = $e' \
  sdk/examples/mandate.hl-trader.session.json > /tmp/mandate.hl-trader.session.json
cat /tmp/mandate.hl-trader.session.json   # check: threshold "0", daily/per-tx "25000000", max_payments_per_day 1, your HL master, expires_at
cd sdk
pnpm setup-key-agent --owner $OWNER --vault $VAULT --name hl-trader --network mainnet \
  --mandate /tmp/mandate.hl-trader.session.json --dry-run          # prints the 3 planned transactions, sends nothing
```
⚠ needs owner OK. Three transactions: create `hl-trader.<OWNER>.near` funded with 0.35 NEAR, add a function-call key
(vault only, `request_payment` + `report_payout_status`, 0.25 NEAR allowance), then `add_agent` (1 yoctoNEAR):

```bash
OWNER_PRIVATE_KEY=$(jq -r .private_key ~/.near-credentials/mainnet/$OWNER.json) \
  pnpm setup-key-agent --owner $OWNER --vault $VAULT --name hl-trader --network mainnet \
  --mandate /tmp/mandate.hl-trader.session.json --confirm-mainnet
# → stdout: TREASURY_AGENT_ACCOUNT=hl-trader.<OWNER>.near and TREASURY_AGENT_PRIVATE_KEY=ed25519:… (shown ONCE; it goes into worker/.env only)
cd ..
near contract call-function as-read-only $VAULT get_agent_budget json-args '{"agent_id":"hl-trader"}' network-config mainnet now
# → "status": "Active", "approval_threshold": "0", "daily_limit": "25000000", "max_payments_per_day": 1,
#   allowlist [{"chain":"hypercore","address":"<HL_MASTER_0x>",…}], "expires_at" = $EXPIRES_MS
```

**7. Worker `.env` for mainnet** (`worker/.env`, mode 0600, gitignored). Differences from `.env.example`. The hard limits
below are tighter than the defaults of owner decision 3; that is a proposal, and the owner may keep the defaults.

```bash
NEAR_NETWORK=mainnet
VAULT_CONTRACT_ID=<VAULT>.near
RUN_MODE=local
ALLOW_INSECURE_LOCAL_MODE=true       # required by the worker for RUN_MODE=local on mainnet (red warning at start)
DRY_RUN=true                         # payroll loop never calls request_payout; no SPONSOR_* needed (registration is skipped)
ONECLICK_MODE=live
NEARAI_API_KEY=<key>                 # the chat compiles the rules (not yet run against the live API)
AI_SESSION_SECRET=<openssl rand -hex 32>
DASHBOARD_ORIGIN=http://localhost:5173
HOST=127.0.0.1                       # default; keep it so the API is reachable on localhost only
TRADING_ENABLED=true
HL_NETWORK=mainnet
TRADING_ALLOW_MAINNET=true
HL_MASTER_ADDRESS=<HL_MASTER_0x>
TRADING_STATE_DIR=./.trading-mainnet # fresh dir: new API wallet, TRADING_START_MS = first tick
TRADER_AGENT_ID=hl-trader
TRADER_NEAR_ACCOUNT_ID=hl-trader.<OWNER>.near
TRADER_NEAR_PRIVATE_KEY=<TREASURY_AGENT_PRIVATE_KEY from step 6>
TRADING_ALLOWED_PAIRS=HYPE/USDC
TRADING_HARD_MAX_POSITION_USDC=25
TRADING_HARD_MAX_ORDER_USDC=12
TRADING_HARD_DAILY_LOSS_USDC=5
TRADING_HARD_MAX_ORDERS_PER_DAY=2
TRADING_TOPUP_ENABLED=true
TRADING_TOPUP_USDC=25                # = mandate per-tx = daily; one top-up
TRADING_TOPUP_FLOOR_USDC=10
# HL_API_WALLET_PRIVATE_KEY stays unset (refused on mainnet)
```

**8. Start exactly one worker, reachable on localhost only (`HOST=127.0.0.1`, the default)** (audit M5, L5). Nothing is signed at start, but from now on
the worker can request the top-up (it waits for approval, step 10).

```bash
cd worker && pnpm install --frozen-lockfile && pnpm build && node dist/index.js
# → mode=local network=mainnet dryRun=true vault=<VAULT>.near agent=payroll
# → red "INSECURE LOCAL MODE ON MAINNET …" and red "HYPERLIQUID MAINNET (TRADING_ALLOW_MAINNET=true) …"
# → TRADING ENABLED: hl=mainnet account=<HL_MASTER_0x> agent=hl-trader api-wallet=0x…   ← write this address down
pgrep -fl 'node dist/index.js'                 # exactly one process on this state dir
lsof -nP -iTCP:3000 -sTCP:LISTEN               # expect 127.0.0.1:3000 (default HOST=127.0.0.1, audit L5); if it shows *:3000, HOST is set wrong
```
Dashboard against mainnet (new terminal): `cd dashboard && VITE_NEAR_NETWORK=mainnet VITE_VAULT_CONTRACT=<VAULT>.near VITE_USDC_CONTRACT=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 VITE_WORKER_URL=http://localhost:3000 VITE_AI_ENABLED=true pnpm dev`
(leave `VITE_ONECLICK_MODE` unset) → http://localhost:5173/#/trading, connect the owner wallet.

**9. Approve the API wallet on Hyperliquid.** ⚠ needs owner OK (the master EVM key signs `approveAgent`).
- Compute the expiry: `echo $(( ($(date +%s) + 47*3600) * 1000 ))`. Use min(mandate `expires_at`, now + 47 h): the API wallet must not outlive the agent mandate nor exceed 47 h.
- Compare three addresses: the `api-wallet=` line in the worker console (step 8), the dashboard's API-wallet card, and
  `curl -s localhost:3000/trading/status | jq -r .api_wallet.address`. They must be the same. If they differ, stop
  (audit M7).
- In https://app.hyperliquid.xyz → API (signed in with the master), add that address with the name
  `agent-treasury valid_until <ms>`. Whether the HL web app accepts an external address was not verified (ADR V0). If it
  does not, stop: the fallback D4 (EIP-712 `approveAgent` from the dashboard) is not built.
- Check: `extraAgents` for the master lists exactly that address with `validUntil` = `<ms>`;
  `/trading/status` → `api_wallet.approved: true`.

**10. First top-up, before any rules** (audit M3). ⚠ needs owner OK (moves 25 USDC: vault → 1Click → HL master).
- The bot asks for the top-up while free HL USDC < 10. With threshold 0 the vault answers `PendingApproval`, so nothing
  moves until the owner approves.
- Dashboard → Payouts → the `hl-trader` payout (pending, 25 USDC, chain `hypercore`). The quote check panel must show
  recipient `<HL_MASTER_0x>`, refund address `<VAULT>.near`, amount 25 USDC and a future deadline.
- The panel does not check the destination asset (audit L1), so check it by hand:
  `curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=<DEPOSIT_ADDRESS>" | jq -r .quoteResponse.quoteRequest.destinationAsset`
  → must be `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054`.
- Then Approve (1 yoctoNEAR, wallet), within the quote's deposit window (about 10 minutes): `approve_payout` refuses once
  the payout's `deposit_expires_at_ms` has passed (contract `owner.rs` `approve_payout`), and also after 72 h.
- If the window is missed: the pending payout still counted as one of the day's payments (`push_payout` increments
  `payments_today` when the payout becomes pending; `reject_pending` does not decrement it). With
  `max_payments_per_day = 1` an expired or rejected pending approval therefore uses the only slot until the UTC day rolls
  over (`block_timestamp_ms / 86_400_000`). `reject_payout` does NOT free it; it only clears the open approval. Options:
  wait for 00:00 UTC and let the bot ask again with a fresh quote, or (owner decision, weakens the session mandate)
  `update_mandate` with `max_payments_per_day: 2`. Approve promptly to avoid this.

**11. Wait for the landing.**
- `curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=<DEPOSIT_ADDRESS>" | jq .status` → `SUCCESS`.
- `spotClearinghouseState` for the master shows USDC up by about 24.68 (25 minus the fixed 0.3153 fee).
- `curl -s localhost:3000/trading/status | jq .pnl.net_funded_usdc` must show about the delivered amount.
- **If it shows 0, do not confirm rules.** The ledger type of a 1Click landing is unknown (M3), and the loss stop would
  be wrong. Write the observed `userNonFundingLedgerUpdates` entry into `docs/research/hyperliquid-trading.md`.
- `get_payout` for that payout → `Confirmed`.

**12. Confirm rules in chat.** ⚠ needs owner OK (NEP-413 signature that lets the bot trade real money).
- Assistant panel, for example: "Buy HYPE for 12 USDC every 4 hours. Never hold more than 25 USDC. Stop if I lose
  5 USDC today. At most 2 orders a day." Every USDC order size must be ≥ 11: HL needs 10 and sizes round down.
- Check the card: it is rendered by the dashboard, with a hash computed in the dashboard. Then Review & sign rules,
  and the wallet signs.
- Expect `/trading/status` → `state: "running"` and `active_rules.confirmed_by: "<OWNER>.near"`.

**13. Observe one trade.** An `interval` rule fires at confirm time.
- `/trading/status` → `limits.today.orders: 1` and a position in `balances.positions`.
- `curl -s https://api.hyperliquid.xyz/info -H 'Content-Type: application/json' -d '{"type":"userFills","user":"<HL_MASTER_0x>"}' | jq '.[0] | {coin, side, px, sz, cloid}'`
  → `coin: "@107"`. `cloid` starts with `0x` + the first 16 hex characters of `active_rules.hash`.

**14. Drills** (order chosen so the kill switch comes last, right before teardown):
1. `pause_agent`. Needs no deposit, but signs a mainnet tx: ⚠ needs owner OK.
   `near contract call-function as-transaction $VAULT pause_agent json-args '{"agent_id":"hl-trader"}' prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR' sign-as $OWNER network-config mainnet sign-with-legacy-keychain send`
   → next tick `state: "paused_onchain"`, open orders cancelled. Resume (1 yoctoNEAR), ⚠ needs owner OK:
   `near contract call-function as-transaction $VAULT resume_agent json-args '{"agent_id":"hl-trader"}' prepaid-gas '30.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $OWNER network-config mainnet sign-with-legacy-keychain send`
   → `state: "running"`.
2. `kill -9` and restart.
   - `kill -9 $(pgrep -f 'node dist/index.js')`, wait `TRADING_DEADMAN_SEC` (180 s).
   - `openOrders` for the master → `[]`. Positions stay.
   - Restart with `node dist/index.js` (step 8). State, rules and log reload from `./.trading-mainnet`.
3. Kill switch. Dashboard → Trading → Stop trading.
   - Expect `{"state":"halted",…,"steps":{"cancel_all":"ok","schedule_cancel":"ok"}}`.
   - Then the wallet asks for `pause_agent`: ⚠ needs owner OK.
   - Within one tick: no new orders, `openOrders` = `[]`.

**15. Teardown.**
0. Stop the worker (Ctrl-C or `kill $(pgrep -f 'node dist/index.js')`; it releases the state-dir lock on SIGINT/SIGTERM) before deleting `api-wallet.json` or the trader key lines in `worker/.env`.
1. Kill switch (done in drill 3; run it now if it was skipped).
2. Revoke `hl-trader`: `revoke_agent` (1 yoctoNEAR), then delete its function-call key. ⚠ needs owner OK.
   `cd sdk && OWNER_PRIVATE_KEY=$(jq -r .private_key ~/.near-credentials/mainnet/$OWNER.json) pnpm revoke-key-agent --owner $OWNER --vault $VAULT --agent-id hl-trader --public-key <TRADER_PUBLIC_KEY> --network mainnet --confirm-mainnet`
   (`<TRADER_PUBLIC_KEY>`: the `ed25519:` key the real run of step 6 printed on stderr, also the agent's `public_key` in `get_agents`; add `--dry-run` first)
   → `get_agent_budget '{"agent_id":"hl-trader"}'` → `"status": "Revoked"`.
3. Revoke the API wallet on Hyperliquid (master key). ⚠ needs owner OK.
   - app.hyperliquid.xyz → API → remove it. A remove button was not verified.
   - Otherwise re-register the same name `agent-treasury valid_until <ms>` with a fresh throwaway address: that
     deregisters the old one. Never reuse an old address.
   - Check: `extraAgents` no longer lists the bot's address.
4. Return funds to the vault (optional; the owner may also keep the USDC on HL or withdraw it to Arbitrum with the master).
   - Sell HYPE to USDC in the HL app with the master. ⚠ needs owner OK.
   - Dry quote first, then a real one (`"dry":false`): hip1 USDC (8 decimals; `"2400000000"` = 24 USDC) → NEAR USDC,
     recipient the vault, refund to the master:
     ```bash
     # asset ids come from /v0/tokens, never by hand
     TOKENS=$(curl -s https://1click.chaindefuser.com/v0/tokens)
     HL_USDC=$(echo "$TOKENS" | jq -r '[.[] | select(.blockchain=="hypercore" and .symbol=="USDC")][0].assetId')
     NEAR_USDC=$(echo "$TOKENS" | jq -r '[.[] | select(.blockchain=="near" and .symbol=="USDC")][0].assetId')
     echo "$HL_USDC $NEAR_USDC"   # expect 1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054 and nep141:17208628…
     curl -s https://1click.chaindefuser.com/v0/quote -H 'Content-Type: application/json' -d '{"dry":true,"swapType":"EXACT_INPUT","slippageTolerance":100,
       "originAsset":"'"$HL_USDC"'","depositType":"ORIGIN_CHAIN",
       "destinationAsset":"'"$NEAR_USDC"'","amount":"2400000000",
       "refundTo":"<HL_MASTER_0x>","refundType":"ORIGIN_CHAIN","recipient":"<VAULT>.near","recipientType":"DESTINATION_CHAIN",
       "deadline":"<ISO time now+30 min>"}' | jq '{quote: .quote | {amountOut, depositAddress}}'
     ```
   - The master sends exactly `amount` USDC on HL spot to `depositAddress`. ⚠ needs owner OK. How this deposit step
     works was not verified (research A4): stop if `depositAddress` is not a `0x` address.
   - Poll `GET /v0/status?depositAddress=…` until `SUCCESS`.
   - 1Click pays with a plain `ft_transfer`, so the vault does not see it yet. Run `sync_surplus` twice, ≥ 60 s apart
     (the first call records a probe, the second credits; the dashboard Treasury → "Credit untracked tokens" card does
     the same in two steps). Each call needs 1 yoctoNEAR: ⚠ needs owner OK.
     `near contract call-function as-transaction $VAULT sync_surplus json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $OWNER network-config mainnet sign-with-legacy-keychain send`
5. Owner withdraws what is left in the vault (1 yoctoNEAR; `withdraw` ignores pause and agents). ⚠ needs owner OK.
   - `near contract call-function as-read-only $VAULT get_balance json-args '{}' network-config mainnet now` → use
     `balance` as `<AMOUNT>`.
   - `near contract call-function as-transaction $VAULT withdraw json-args '{"amount":"<AMOUNT>","receiver_id":null}' prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as $OWNER network-config mainnet sign-with-legacy-keychain send`
6. Record everything in `docs/deployments.md` (vault, wasm hash, init tx, payout ids, the HL ledger `delta.type` of the
   landing) and `CHANGELOG.md`. Delete `worker/.env` trader key lines and `./.trading-mainnet/api-wallet.json`.
