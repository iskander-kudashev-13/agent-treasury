# ADR-0005: Hyperliquid spot trading agent with owner-confirmed rules

## Date
2026-11-02

## Status
Accepted (owner decisions of 2026-11-02). Items marked **[verify]** come from `docs/research/hyperliquid-trading.md`
where they are unverified. Each one has a spike task in the task list, and that spike must run before the code that
depends on it.

## Context
The owner wants a second reference use case next to payroll: an agent that trades Hyperliquid (HL) **spot** with
money from the vault, for the 2026-11-14 deadline. It runs in local mode for now (TEE later) and the demo is one tiny
mainnet session.

Facts this ADR builds on (from the research, which cites HL and 1Click):
- An HL API wallet signs L1 actions (orders, cancels, `scheduleCancel`, `agentSendAsset` between the account's own
  balances). It cannot sign user-signed actions (`withdraw3`, `spotSend`, `usdSend`, `approveAgent`). **HL cannot
  restrict it to spot**, so the same key can open leveraged perps.
- 1Click delivers NEAR USDC to HyperCore spot USDC: asset `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054`,
  8 decimals, fixed 0.3153 USDC fee, minimum input about 2 USDC, recipient a plain `0x` + 40 hex address.
- HL needs at least 10 USDC per order. Spot asset id = `10000 + spotIndex` (mainnet HYPE/USDC `@107` → 10107; testnet
  `@1035`). Ids are read from `spotMeta` and never hard-coded.
- The testnet faucet pays only addresses that have already deposited on mainnet.
- `@nktkas/hyperliquid` 0.33.3 needs Node >= 22.12. The worker image is `node:22-alpine` pinned by digest, minor
  version unknown **[verify]**. `worker/package.json` has no `engines` field.

Code facts checked for this ADR:
- Contract: chain ids are free strings of at most 16 bytes (`contract/src/agent.rs` `validate_mandate`,
  `MAX_CHAIN_LEN = 16`), so `"hypercore"` is accepted. Allowlist matching uses `same_address`, which compares `0x`
  addresses case-insensitively (`contract/src/lib.rs:613`). **No contract change is needed.**
- SDK: `resolveUsdc` throws `UNSUPPORTED_ASSET` on `hypercore`, because 1Click lists two USDC tokens there (hip1 and
  erc20). `EVM_CHAINS` has no `hypercore`, so addresses are not format-checked. `resolveAssets` already rescales by
  `destDecimals`, so 8 decimals work. The SDK quote check has no fee cap, so the fixed fee is fine.
- Dashboard `lib/address.ts` `EVM_CHAINS`, `lib/recipientForm.ts` and worker `src/ai/chains.ts` `CHAINS` have no
  `hypercore` either.
- The worker does not depend on the SDK (it has its own `oneclick.ts`, `quote-check.ts` and `vault.ts` on top of
  `ShadeClient`). The MCP server uses `"agent-treasury-sdk": "link:../sdk"`. The worker Docker build context is
  `worker/` only.
- The assistant already has NEP-413 owner sign-in (`worker/src/ai/session.ts`: `nep413Digest`, `verifyEd25519`,
  `ChallengeStore`, HMAC bearer tokens). It checks that the signer used a full-access key and is the vault owner
  (`route.ts`).

## Decision

### 1. Process and identity
- The trader is a **worker module `worker/src/trading/`** in the same process, switched off by default
  (`TRADING_ENABLED=false`). It shares the Hono server, CORS, NEAR AI client and owner sessions with `/ai`.
- On the vault it is a **Key agent `hl-trader`**. It uses `agent-treasury-sdk` (`createTreasuryClient`,
  `requestPayment`, `watch`/report) with its own function-call key on `hl-trader.<owner>`. That key is restricted to
  `request_payment` and `report_payout_status` with a 0.25 NEAR allowance and is created by the existing
  `sdk/scripts/setup-key-agent.ts`.
- Why Key and not the worker's TEE identity:
  - The `payroll` slot has a `Fixed` mandate and cannot pay an allowlisted address. Sharing a slot would merge two
    mandates.
  - One enclave key binds one slot, and a second TEE slot needs a second enclave-derived key that we do not have.
  - The trader runs in local mode anyway, so calling it "TEE" would be dishonest.
  - Per ADR-0003 §11, a key agent is bounded by its limits, which is the real guarantee here.
- TEE later: a separate image or a derived key binds a `Tee` slot `hl-trader`. The Docker build context then has to
  include `sdk/` (task for M4, not now).

### 2. Funding (no contract change)
- Mandate for `hl-trader`:
  - `recipients_mode = "Allowlist"`;
  - `allowlist = [{chain:"hypercore", address:<HL master>, label:"Owner HL"}]`;
  - `allowed_chains = ["hypercore"]`;
  - `per_tx_limit` 25 USDC, `daily_limit` 50 USDC, `max_payments_per_day` 2;
  - `approval_threshold` 25 by default (see owner decision 3);
  - `expires_at` = now + 30 days.
- The bot asks for a top-up only when all of these hold:
  - not halted or stopped;
  - free HL USDC is below `TRADING_TOPUP_FLOOR_USDC`;
  - `get_agent_budget` shows status `Active` and enough remaining.
- Each top-up is exactly `TRADING_TOPUP_USDC`. The destination is the **single** allowlist entry. The bot refuses to
  start if the allowlist does not have exactly one `hypercore` entry, or if that entry differs from
  `HL_MASTER_ADDRESS`.
- Funding parameters are env config, not DSL: the AI never controls how much money moves.
- Profits back stay manual. The owner sends USDC with `spotSend` from the HL master to a 1Click deposit address
  (recipient = vault, `refundTo` = HL master), then runs the two-phase `sync_surplus`. The dashboard shows the steps and
  a dry quote.

### 3. HL API wallet
- The bot generates a fresh secp256k1 key on first start and stores it in `TRADING_STATE_DIR/api-wallet.json`
  (mode 0600, gitignored). `HL_API_WALLET_PRIVATE_KEY` overrides this for tests.
- The dashboard shows only the address. The owner approves it on app.hyperliquid.xyz → API, signing with the master
  account, and names it `agent-treasury valid_until <ms>` with at most 180 days; 30 days is recommended.
- The bot trades only while its address appears among the master's approved agents (HL info `extraAgents`
  **[verify]**) and `valid_until` is more than 1 h away.
- Rotation creates a new key and never reuses an address (HL nonce/replay rule).
- Fallback if the HL UI cannot approve an external address **[verify]**: the dashboard signs EIP-712 `approveAgent`
  through an injected EVM wallet (viem). Risk: the domain uses `signatureChainId 0xa4b1`, and some wallets refuse
  typed data for a chain they are not connected to.
- Use a **dedicated HL master address** for the treasury, not the owner's personal trading account. Position, P&L and
  the perp check read the whole account, so the owner's manual trades would trip them. The address must be active
  already, because of HL's 1-USDC activation fee.

### 4. Strategy authoring: natural language → DSL → owner signature → deterministic engine
1. The owner types rules in the assistant chat (or on the trading screen).
2. The worker's NEAR AI model calls the tool `propose_trading_rules(rules)`. The worker validates the result with zod,
   then against hard limits and fresh `spotMeta`/volume.
3. The worker emits a `TradingRules` proposal (§Interfaces). The LLM output is data only.
4. The dashboard renders the rules with **its own deterministic renderer**, never with LLM text, and computes the
   canonical hash itself.
5. The owner signs a NEP-413 message containing that hash (wallet `signMessage`, full-access key).
6. `POST /trading/rules/confirm` verifies:
   - the signature;
   - that the key is full-access and the signer is the vault owner;
   - that the nonce is single-use;
   - that the hash matches `sha256(canonical(rules))`;
   - the hard limits, again.
7. The engine then runs the rules every tick with no LLM involved. The LLM never sees keys, never places orders, and
   never runs at trade time.

### 5. Where the confirmed rules live
- **Worker storage, signed by the owner.** Files under `TRADING_STATE_DIR`:
  - `rules/<hash>.json`: rules plus the full NEP-413 envelope;
  - `active.json`: pointer to the active hash;
  - `state.json`: fired times, day-start equity, halt reason;
  - `log.jsonl`: append-only decisions and order results.
- On load the worker re-verifies the envelope (signature, hash, signer still the owner). If verification fails, it
  refuses (`no_rules`).
- Every order carries `cloid = 0x || rules_hash[0..8] || counter_be64` (16 bytes). HL's own order history therefore
  links each order to a rule set. The owner can prove which rules were active from the signed envelope plus HL
  history, with no new contract state.
- Rejected for v1: an on-chain hash (needs a contract change). v2: add an owner method `set_agent_strategy_hash` or a
  mandate field, which the engine reads and requires to match.

### 6. Hard limits (env, outside the DSL)
- A DSL limit may be **tighter** than a hard limit, never looser. A rule set that exceeds a hard limit is **rejected**,
  not clamped.
- Never-overridable invariants:
  - **Spot only.** The order builder refuses any asset id below 10000. The code has no perp order path.
  - **Perp alarm.** Any perp position, any open perp order, or perp account value above 1 USDC (standard mode) sets
    `halted` with `PERP_POSITION_DETECTED` and cancels all spot orders. The bot does not close the perp; the owner does
    that in the HL app and revokes the API wallet.
  - **Price band.** A buy price must be at most `mid·(1+band)` and a sell price at least `mid·(1−band)`.
    `band = TRADING_PRICE_BAND_BPS`, default 100 (±1%).
  - **Rounding.** Sizes round down to `szDecimals`. Prices round to 5 significant figures and at most
    `8 − szDecimals` decimals, toward the safe side (buy down, sell up).
  - **Liquid pairs only.** A pair must be in `TRADING_ALLOWED_PAIRS` with 24 h notional volume of at least
    `TRADING_MIN_PAIR_VOLUME_USDC` (`spotMetaAndAssetCtxs`). The bot skips a tick if the best bid/ask spread is wider
    than the band.
  - **Dead-man switch.** `scheduleCancel(now + TRADING_DEADMAN_SEC)` is refreshed every tick, before any order is
    placed. 10 triggers per day **[verify]** whether a refresh counts as a trigger.
  - **Fresh data.** No order if HL data or mids are older than 2 ticks.
  - **On-chain pause.** If the vault is paused or the agent is `Paused`/`Revoked`/expired (`get_agent_budget`, read
    each tick), the bot cancels all orders and enters `paused_onchain`.

### 7. Engine tick (every `TRADING_TICK_SEC`, default 60)
1. Read the vault budget.
2. Read HL state for the **master** address: spot balances, perp state, open orders, mids, approved agents, and
   candles if a rule needs them.
3. Safety checks: perp alarm, API wallet approved, data freshness, on-chain status.
4. Refresh `scheduleCancel`.
5. UTC day rollover. Loss stop: `loss_today = day_start_equity + net_inflow_today − equity_now`.
   - `net_inflow` = HL non-funding ledger deposits − withdrawals/sends **[verify fields]**.
   - If `loss_today >= daily_loss_stop`, cancel all and enter `stopped_today`, which auto-clears at 00:00 UTC.
6. Cancel limit orders past their `ttl`.
7. Evaluate rules in array order, at most 1 order per rule and 2 per tick.
   - Every candidate passes the risk guard: pair, minimum 10 USDC notional, `max_order`, position cap, daily order
     count, band, free balance. The position cap counts held base at mid **plus open buy orders**.
   - A candidate that fails is skipped and logged, never resized.
   - The rule's `last_fired_at` is set on every placement attempt, so an order HL rejects still starts the cooldown.
8. Funding check (§2).
9. Persist state.

States: `not_configured` | `awaiting_api_wallet` | `no_rules` | `running` | `paused_onchain` | `stopped_today` |
`halted` | `error`.
- `halted` is sticky (kill or perp alarm) and clears only when a newly signed rule set is confirmed.
- `paused_onchain` clears when the owner resumes the agent on the vault.

## Alternatives rejected
| Option | Why not |
|---|---|
| LLM decides trades at runtime | Not reproducible, open to prompt injection from market or news data, no provable rule set. |
| Rules on-chain in the vault (v1) | Contract change, migration and audit 12 days before the deadline. The owner's signed envelope plus `cloid` gives the same proof without them. Kept as v2 (hash only). |
| Separate `/trader` package and process | Duplicates the HTTP server, NEP-413 sessions and AI wiring, and gives the dashboard a second URL. The benefit (payroll TEE image unchanged) does not matter while the trader is local-only. |
| Trader uses the payroll TEE identity | Mixes a `Fixed` and an `Allowlist` mandate in one slot, and it is not a TEE in local mode anyway. |
| Owner pastes an HL API key into the dashboard | Key material would pass through the browser. Generating it in the bot means only the address leaves. |
| Bot auto-closes perp positions | Adds a perp order path. With no perp path at all, "spot only" can be audited with grep. |
| Rendering produced by the LLM | The owner would review text that could differ from the JSON. A code renderer on the same JSON, plus a hash computed in the dashboard, closes that gap. |
| HL withdraw → Arbitrum → 1Click for returns | Slower, more fees, needs an extra wallet and gas (research A4). |

## Trust boundaries
| Boundary | Protects | Does NOT protect |
|---|---|---|
| Vault mandate (contract) | Vault USDC: only to the owner's HL master, at most `per_tx`/`daily_limit`/2 top-ups per day, until expiry; pause/revoke at any time | Anything already on HL. A leaked `hl-trader` NEAR key quoting to another address (ADR-0003 §11), bounded by the limits |
| HL API wallet (protocol) | Withdrawals and sends to other addresses | **Trading losses**, **perps with leverage through a leaked key**, wash trades against an attacker on thin books, staking moves |
| Bot risk guard + DSL validation (our code) | Pairs, band, size, position, daily loss, spot-only, LLM mistakes | A compromised host in local mode (it can skip its own code) |
| Owner NEP-413 confirmation | Rules running without the owner's consent; swapping rules between proposal and confirm | Owner signing bad rules |
| `scheduleCancel` (protocol) | Open orders surviving a bot crash | Filled positions |
| Owner EVM master key | Revoke API wallet, return profits, withdraw | It is a second root of trust; use a hardware wallet |

Under the status card the dashboard states in one line: "Funds on Hyperliquid can be lost through trading. The vault
limits only how much is sent there per day."

## Threats and mitigations
| # | Threat | Mitigation |
|---|---|---|
| T1 | LLM mis-compiles rules (hallucination, prompt injection in chat) | Zod schema, hard limits, the dashboard's own renderer, owner signs the hash, engine is deterministic |
| T2 | Worker swaps rules between propose and confirm | Dashboard computes the canonical hash from the JSON it rendered and refuses on mismatch; the signature covers the hash |
| T3 | Replay of an old confirmation | NEP-413 nonce issued by `/trading/rules/challenge`, single-use, 5 min TTL; the message includes the vault, agent, HL account and HL network |
| T4 | Leaked HL API key | Exposure capped by daily funding; `valid_until` 30 days; rotate; perp alarm halts and alerts; dedicated master account |
| T5 | Leaked `hl-trader` NEAR key | Mandate caps (25/tx, 50/day, 2/day, expiry); optional `approval_threshold = 0` so every top-up goes through the dashboard quote check |
| T6 | Compromised worker host (local mode) | Same bounds as T4 plus T5; documented as insecure; TEE later |
| T7 | Off-market fills on a thin book | Pair allowlist with minimum volume, ±1% band, skip on a wide spread, IOC by default |
| T8 | Bot crash leaves orders | `scheduleCancel` refreshed every tick before any order |
| T9 | Rule fires every tick | Required cooldown, `max_orders_per_day`, 2 orders per tick |
| T10 | Top-ups hide losses | Loss stop subtracts net inflows. A manual outflow counts as a loss, which errs toward stopping |
| T11 | Stale or failed HL data | No orders when data is stale; `error` state with backoff |
| T12 | Owner trades on the same account | Dedicated master address required in setup |
| T13 | Unauthenticated HTTP abuse | `propose`, `kill`, `rotate`, `rules` and `log` require an owner bearer token; `confirm` requires a NEP-413 signature; rate limits reused from `/ai` |
| T14 | Tampered rules file | Re-verified on load; refuses if verification fails |
| T15 | Funding to a fresh HL address loses the activation fee or fails | Use an already active master; refunds go to `refundTo = vault` |

## Interfaces

### Rules DSL v1 (canonical JSON; decimals are strings; all fields required unless marked `?`)
```ts
type Dec = string;        // ^\d+(\.\d{1,6})?$   human USDC or price
type SDec = string;       // ^-?\d+(\.\d{1,2})?$  percent, signed
type Window = "1h" | "4h" | "1d";
type Every = "1h" | "4h" | "1d" | "1w";
type Ttl = "15m" | "1h" | "4h" | "1d";
type Cooldown = "15m" | "1h" | "4h" | "1d" | "1w";

interface RuleSetV1 {
  version: 1;
  name: string;                       // 1..60 chars, plain text
  pairs: string[];                    // 1..3 HL spot display names ("HYPE/USDC"), quote USDC, each in TRADING_ALLOWED_PAIRS
  limits: {
    max_position_usdc: Dec;           // all allowed pairs at mid + open buys; <= hard
    max_order_usdc: Dec;              // >= 10 (HL minimum), <= hard
    daily_loss_stop_usdc: Dec;        // > 0, <= hard
    max_orders_per_day: number;       // 1..50, <= hard
  };
  rules: Rule[];                      // 1..5, evaluated in order
}
interface Rule {
  id: string;                         // ^[a-z0-9-]{1,16}$, unique
  pair: string;                       // one of pairs
  when: Trigger;
  action: Action;
  cooldown?: Cooldown;                // required unless when.type == "interval" (then cooldown = every)
}
type Trigger =
  | { type: "price_change"; window: Window; op: "lte" | "gte"; pct: SDec }   // (mid − ref)/ref·100; ref = close of the
                                                                             // candle starting `window` ago (candleSnapshot [verify spot])
  | { type: "price"; op: "lte" | "gte"; usdc: Dec }                          // mid vs constant
  | { type: "interval"; every: Every }                                       // DCA; first fire at confirm time
  | { type: "position_pnl"; op: "lte" | "gte"; pct: SDec };                  // mid vs avg cost of fills under this rule set; false if flat
interface Action {
  side: "buy" | "sell";
  size: { usdc: Dec } | { position_pct: Dec };                // position_pct: sell only, 1..100
  order: { type: "ioc" }                                      // limit IOC at mid·(1±band)
       | { type: "limit"; offset_pct: Dec; ttl: Ttl };        // GTC at mid·(1−offset) for buy, (1+offset) for sell; 0 <= offset <= 10
}
```
- Canonical form: keys sorted, no whitespace, UTF-8. Optional keys are omitted when unset.
  `hash = hex(sha256(canonical))`.
- Shared vectors in `docs/trading-rules-vectors.json` contain inputs, canonical strings, hashes and English renderings.
  Worker and dashboard both test against them.
- Example ("buy HYPE for 10 USDC when price drops 3% in a day; never hold more than 40 USDC; stop if −5 USDC today"):
```json
{"version":1,"name":"HYPE dip buyer","pairs":["HYPE/USDC"],
 "limits":{"max_position_usdc":"40","max_order_usdc":"10","daily_loss_stop_usdc":"5","max_orders_per_day":3},
 "rules":[{"id":"dip","pair":"HYPE/USDC","when":{"type":"price_change","window":"1d","op":"lte","pct":"-3"},
           "action":{"side":"buy","size":{"usdc":"10"},"order":{"type":"ioc"}},"cooldown":"1d"}]}
```

### NEP-413 confirmation message (exact, `\n`-separated; recipient = vault id)
```
Agent Treasury: activate trading rules
vault: <vault>
agent: <TRADER_AGENT_ID>
hl_network: <mainnet|testnet>
hl_account: <HL_MASTER_ADDRESS lower-case>
rules_sha256: <64 hex>
```

### Assistant proposal (new event payload on `/ai/chat`, no contract `call`)
```ts
{ id, type: "TradingRules", title, summary, rules: RuleSetV1, hash: string,
  validation: { ok, errors: string[], warnings: string[] },
  confirm: { kind: "nep413", challenge: "/trading/rules/challenge", endpoint: "/trading/rules/confirm" } }
```
The dashboard shows this card outside the transaction batch, with a single "Review & sign rules" button.

### Worker HTTP API (mounted at `/trading` only when `TRADING_ENABLED=true`; requires `AI_SESSION_SECRET`)
Auth: `owner` = `Authorization: Bearer <token from POST /ai/session>`. Errors: `{ type:"error", code, message }` with
400/401/403/409/429/502. HL amounts are human decimal strings. Times are ms numbers.

| Method, path | Auth | Request | Response 200 |
|---|---|---|---|
| `GET /trading/status` | none (data is public on HL and NEAR) | — | `TradingStatus` |
| `GET /trading/rules` | owner | — | `{ active: ConfirmedRules \| null, history: { hash, name, confirmed_at_ms, superseded_at_ms \| null }[] }` |
| `GET /trading/log?limit=50` | owner | limit 1..200 | `{ entries: { at_ms, kind: "order"\|"skip"\|"cancel"\|"topup"\|"state", rule_id?, detail, cloid?, oid? }[] }` |
| `POST /trading/rules/propose` | owner | `{ text: string (<=2000) }` | `{ rules, hash, validation, model }` (single-turn compile, same validator as the chat tool) |
| `POST /trading/rules/challenge` | owner | `{ rules }` | `{ nonce: base64(32), message, recipient, hash, expires_at }`, or 400 if validation fails |
| `POST /trading/rules/confirm` | NEP-413 | `{ rules, account_id, public_key, signature: base64, nonce: base64, callback_url? }` | `{ active: ConfirmedRules, state }`. 409 if halted by a perp alarm and a perp is still open |
| `POST /trading/kill` | owner | `{ reason?: string }` | `{ state: "halted", cancelled_orders: number, steps: { cancel_all: "ok"\|"failed", schedule_cancel: "ok"\|"failed" } }` |
| `POST /trading/api-wallet/rotate` | owner | `{}` | `{ address }` (old key deleted; state `awaiting_api_wallet`) |

```ts
ConfirmedRules { rules: RuleSetV1, hash, message, signature, public_key, account_id, nonce, callback_url: string | null,
                 confirmed_at_ms }
TradingStatus {
  enabled: true, state, state_reason: string | null, state_detail: string | null,
  hl_network: "mainnet" | "testnet", hl_account: string, vault: string, agent_id: string,
  api_wallet: { address: string, approved: boolean, name: string | null, valid_until_ms: number | null },
  balances: { usdc_free: Dec, usdc_total: Dec, equity_usdc: Dec,
              positions: { pair, base, size: Dec, mid: Dec, value_usdc: Dec }[] },
  pnl: { today_usdc: SDec, total_usdc: SDec, net_funded_usdc: Dec, day_start_equity_usdc: Dec },
  limits: { effective: RuleSetV1["limits"] & { price_band_bps: number },
            today: { orders: number, loss_usdc: Dec }, position_usdc: Dec,
            vault: { status, remaining_today_usdc: Dec, per_tx_limit_usdc: Dec, payments_today: number,
                     max_payments_per_day: number, expires_at_ms: number | null } },
  open_orders: { oid: number, cloid: string, pair, side: "buy" | "sell", price: Dec, size: Dec, placed_at_ms, rule_id: string | null }[],
  active_rules: { hash, name, confirmed_at_ms, confirmed_by: string } | null,
  dead_man: { cancel_at_ms: number | null },
  perp_check: { ok: boolean, at_ms: number },
  last_tick_ms: number | null, next_tick_ms: number | null, warnings: string[] }
```
- `pnl.total_usdc = equity − net_funded`, where `net_funded` comes from the HL ledger since `TRADING_START_MS`. The
  value is cross-checked against the vault's `Confirmed` payouts for `hl-trader` and a warning is added on mismatch.
- When `TRADING_ENABLED=false`, `GET /trading/status` returns `{ enabled: false }` and the other routes return 404.

### Dashboard kill switch (one button, each step's result shown)
1. `POST /trading/kill`.
2. `pause_agent({ agent_id: "hl-trader" })` (no deposit). The bot also cancels orders on its next tick if step 1 failed.
3. Instructions to revoke the API wallet on app.hyperliquid.xyz → API, or "Rotate".
4. Optional: return-profits instructions.

### Config / env (worker `.env.example`)
| Var | Default | Meaning |
|---|---|---|
| `TRADING_ENABLED` | `false` | Mount the module and routes |
| `HL_NETWORK` | `testnet` | `mainnet` also requires `TRADING_ALLOW_MAINNET=true` |
| `TRADING_ALLOW_MAINNET` | `false` | Explicit opt-in, like `ALLOW_INSECURE_LOCAL_MODE` |
| `HL_MASTER_ADDRESS` | — | Dedicated owner HL account (0x + 40 hex); must equal the mandate's single allowlist entry |
| `HL_API_WALLET_PRIVATE_KEY` | unset | Tests only; otherwise generated into the state dir |
| `TRADING_STATE_DIR` | `./.trading` | Rules, state, log, API wallet (gitignored) |
| `TRADER_AGENT_ID` | `hl-trader` | Vault agent id |
| `TRADER_NEAR_ACCOUNT_ID` / `TRADER_NEAR_PRIVATE_KEY` | — | Key agent and its function-call key |
| `TRADING_TICK_SEC` | `60` | Tick interval, 15..600 |
| `TRADING_ALLOWED_PAIRS` | `HYPE/USDC` | Hard pair allowlist |
| `TRADING_MIN_PAIR_VOLUME_USDC` | `1000000` | Minimum 24 h notional volume |
| `TRADING_HARD_MAX_POSITION_USDC` | `50` | Hard cap |
| `TRADING_HARD_MAX_ORDER_USDC` | `20` | Hard cap (>= 10) |
| `TRADING_HARD_DAILY_LOSS_USDC` | `10` | Hard cap |
| `TRADING_HARD_MAX_ORDERS_PER_DAY` | `20` | Hard cap |
| `TRADING_PRICE_BAND_BPS` | `100` | ±band around mid, 10..200 |
| `TRADING_DEADMAN_SEC` | `180` | `scheduleCancel` horizon, >= 3 × tick |
| `TRADING_TOPUP_ENABLED` | `true` | Allow `request_payment` top-ups |
| `TRADING_TOPUP_USDC` / `TRADING_TOPUP_FLOOR_USDC` | `20` / `10` | Top-up size (>= 2, 1Click minimum) and trigger |
| `TRADING_START_MS` | first confirm | Baseline for `net_funded` |

In TEE mode later, the hard-limit env vars must be pinned in the measured compose (same as the H1 fix for payroll).

## Consequences
- **Contract**: none. An optional test adds a `hypercore` allowlist entry with a mixed-case `0x` address
  (`contract/src/tests.rs` only).
- **SDK**:
  - `resolveUsdc` prefers a per-chain pinned asset (`hypercore` → hip1 id, still taken from `/v0/tokens`);
  - `hypercore` is added to `EVM_CHAINS`;
  - `examples/mandate.hl-trader.json`;
  - the MCP tool description mentions `hypercore`.
- **Worker**:
  - new `src/trading/`;
  - new dependencies `@nktkas/hyperliquid` (exact pin), `viem` (secp256k1 via its accounts; check whether the HL
    library already includes it), `agent-treasury-sdk` (`link:../sdk`);
  - `engines.node >= 22.12`;
  - `config.ts` and `app.ts` get the trading section;
  - `ai/` gets the `propose_trading_rules` tool and `hypercore` in `chains.ts`.
- **Dashboard**:
  - "Trading agent" page: setup plus status card;
  - `TradingRules` proposal card with NEP-413 confirmation;
  - kill switch;
  - `hypercore` in address and chain lists.
- **Security**: new trust rows in `docs/architecture.md`. Run `security-auditor` before the mainnet session.
- **Demo**:
  - natural-language rule in chat, then rendered card, then signature, then the bot places one 10-USDC IOC on
    mainnet HYPE/USDC;
  - a rejected over-limit top-up and a rejected non-allowlisted address;
  - kill switch.

## Test plan
1. **Unit tests (vitest; fake `HlPort` with scripted mids, candles, balances, perp state and order results; fake
   `VaultPort`/`OneClickPort` from the SDK).**
   - DSL:
     - schema accepts and rejects each field;
     - canonical, hash and rendering vectors (also in the dashboard);
     - a rule set over a hard limit is rejected;
     - pair outside the allowlist or below minimum volume;
     - `max_order < 10`;
     - `position_pct` on a buy.
   - Confirmation:
     - valid NEP-413 signature;
     - wrong hash; reused or expired nonce;
     - function-call key; non-owner;
     - redirect `callback_url`;
     - tampered file on load.
   - Triggers: each of the 4; cooldown; interval first fire; flat position for `position_pnl`.
   - Risk:
     - band math and rounding direction;
     - `szDecimals` rounding;
     - minimum notional skip;
     - position cap counts open buys;
     - daily order count;
     - loss stop with a top-up the same day;
     - UTC rollover clears `stopped_today`.
   - Safety:
     - asset id < 10000 refused;
     - perp position, open perp order or perp equity → `halted` and cancel all;
     - halted is sticky until a new confirm;
     - agent `Paused` → cancel and `paused_onchain`, resume clears it;
     - `scheduleCancel` is called before any order in the tick;
     - stale data → no orders;
     - API wallet unapproved or expiring → no orders;
     - `cloid` format.
   - Funding:
     - only below the floor and not halted;
     - allowlist must have exactly one `hypercore` entry equal to `HL_MASTER_ADDRESS`;
     - each `PaymentResult` variant.
   - HTTP: auth matrix, body schemas, 404 when disabled.
   - SDK: `resolveUsdc("hypercore")` returns the hip1 asset; `validateAddress("hypercore", …)`; rescale from 8 decimals.
2. **Testnet run.**
   - Setup:
     - HL testnet (faucet after one mainnet deposit by the same address);
     - NEAR testnet vault with `hl-trader` and `ONECLICK_MODE=simulated` (top-ups exercise only the vault path;
       nothing reaches HL testnet).
   - Run an `interval 1h` DCA of 10 USDC plus a `price_change` rule for at least 12 h.
   - Drills:
     - kill switch;
     - `pause_agent`;
     - `kill -9` the worker → orders gone within `TRADING_DEADMAN_SEC`;
     - open a tiny perp by hand in the HL testnet UI → `halted`.
   - Record the commands in `docs/commands.md`.
3. **Mainnet session (each step needs the owner's explicit OK).**
   - Steps:
     1. one 1Click top-up of 20–30 USDC to the dedicated HL master (also unlocks the faucet and resolves the
        landing-balance and activation questions);
     2. approve the API wallet with `valid_until` = 7 days;
     3. confirm a rule set limited to at most 2 orders of 10–12 USDC on HYPE/USDC;
     4. observe the fills;
     5. kill switch and revoke the API wallet;
     6. optional manual return of profits plus `sync_surplus`.
   - Worst case loss: the funded amount. Expected costs: about 0.32 USDC (1Click) plus less than 0.02 USDC in HL fees.

## Implementation tasks (disjoint files; S ≈ ≤ 2 h, M ≈ half day, L ≈ 1 day)
| # | Package | Files | Size | Depends |
|---|---|---|---|---|
| V0 | spikes | none (notes in `docs/research/hyperliquid-trading.md`) | S | — : Node version of the pinned image; HL UI accepts an external address; `extraAgents` shape; spot `candleSnapshot`; `scheduleCancel` trigger counting; ledger fields for `net_inflow` |
| S1 | sdk | `sdk/src/chains.ts`, its tests, `sdk/examples/mandate.hl-trader.json` | S | — |
| S2 | mcp | `mcp/src/*` tool descriptions | S | S1 |
| C1 | contract (optional) | `contract/src/tests.rs` | S | — (tester) |
| W0 | worker | `worker/src/trading/types.ts` (RuleSetV1, HlPort, TradingStatus, state enums) | S | — ; first, so the others can start in parallel |
| W1 | worker | `worker/src/trading/rules/{schema,canonical,describe,validate}.ts`, `docs/trading-rules-vectors.json` | M | W0 |
| W2 | worker | `worker/src/trading/hl/{nktkas,fake,format}.ts`, `package.json` deps and `engines` | M | W0, V0 |
| W3 | worker | `worker/src/trading/engine/{tick,risk,triggers,pnl}.ts` | L | W0 (W1, W2 through interfaces) |
| W4 | worker | `worker/src/trading/{store,confirm,funding,wallet}.ts` | M | W0, S1 |
| W5 | worker | `worker/src/trading/route.ts`, `worker/src/config.ts`, `worker/src/app.ts`, `worker/src/index.ts`, `worker/.env.example` | M | W1, W3, W4 |
| W6 | worker | `worker/src/ai/{tools,prompt,proposals,chains}.ts` (tool `propose_trading_rules`, `hypercore`) | M | W1 |
| D1 | dashboard | `dashboard/src/lib/tradingRules.ts` (+ test on shared vectors), `lib/address.ts`, `lib/recipientForm.ts` | M | W1 vectors |
| D2 | dashboard | `dashboard/src/features/trading/*`, `pages/TradingPage.tsx`, nav entry in `App.tsx` / `features/layout` | L | W0 types, D1 |
| D3 | dashboard | `dashboard/src/features/assistant/{model.ts,ProposalCardView.tsx}` (`TradingRules` card, NEP-413 confirm) | M | D1 |
| D4 | dashboard (only if V0 says the HL UI cannot approve) | `dashboard/src/features/trading/ApproveAgent.tsx` (viem EIP-712) | M | V0 |
| X1 | docs | `README.md` trading section, `docs/architecture.md` (component plus trust rows), `docs/commands.md`, `docs/demo-script.md`, `CHANGELOG.md` | S | after W5 |
| X2 | review | `tester` on W3, W4 and the SDK; `code-reviewer` on funding; `security-auditor` before the mainnet session | M | all |

## References
- `docs/research/hyperliquid-trading.md`, which cites:
  - https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
  - https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
  - https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
  - https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids
  - https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size
  - https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
  - https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes
  - https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet
  - https://1click.chaindefuser.com/docs/v0/openapi.yaml
  - https://github.com/nktkas/hyperliquid
- NEP-413: https://github.com/near/NEPs/blob/master/neps/nep-0413.md (as implemented in `worker/src/ai/session.ts`)
- Code read for this ADR:
  - `contract/src/agent.rs`, `contract/src/lib.rs`, `contract/src/payment.rs`;
  - `sdk/src/chains.ts`, `sdk/src/client.ts`;
  - `worker/src/ai/{session,route,proposals}.ts`, `worker/src/config.ts`, `worker/src/app.ts`, `worker/Dockerfile`,
    `worker/package.json`;
  - `mcp/package.json`, `dashboard/src/lib/address.ts`;
  - ADR-0001 to ADR-0004.
- This ADR draws on the research doc and code only; I did not fetch upstream HL documentation in this session.

## Owner decisions (2026-11-02)

1. Mainnet session: deploy the vault to mainnet with tiny limits (one deployment serves payroll and trading demos);
   every mainnet step needs the owner's explicit confirmation of the exact action.
2. Top-ups run on their own within the mandate: `approval_threshold = 25 USDC` (= per-tx limit), 50 USDC/day,
   2 top-ups/day, destination = the owner's HL master address only.
3. Hard limits as proposed: max position 50 USDC, max order 20 USDC, daily loss stop 10 USDC, pairs HYPE/USDC only,
   spot only, min 24 h volume 1M USDC.
4. The owner creates a dedicated HL master EVM account for the bot and shares only its address; we never receive its
   private key.
5. Strategy authoring: natural language in the assistant chat → AI proposes the DSL rule set → owner confirms
   (NEP-413) → deterministic engine. The LLM never places orders.
