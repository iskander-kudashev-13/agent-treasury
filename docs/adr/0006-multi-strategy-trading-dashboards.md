# ADR-0006: Several trading bots on one Hyperliquid account, per-bot dashboards

## Date
2026-11-03

## Status
Proposed. Implements owner decisions of 2026-11-03 (below). Refines ADR-0005; where they differ on bots, cloids,
storage, the confirm message or the `/trading` API, this ADR wins. Items marked **[verify]** must be checked while
building the task that depends on them.

## Context
Owner decisions (2026-11-03):
1. Several trading strategies ("bots") on ONE Hyperliquid account (same HL master, same API wallet). Each bot has its
   own signed rule set and its own limits. P&L is attributed per bot by cloid prefix.
2. A bots list page (status, P&L, sparkline per bot) and a per-bot dashboard: P&L curve over time (hour/day/week),
   price chart of the pair with buy/sell markers, trades table (time, side, price, size, fee, realized P&L), metrics
   (win rate, average trade, max drawdown, turnover, fees per period).
3. UI direction: the trading area looks like the Agents page: a list → click → the bot's page with its settings
   (rules as sentences, limits), charts, trades, metrics and a Stop button. Connecting Hyperliquid (account, bot
   wallet approval, funding) is a separate one-time "Connect Hyperliquid" flow. Minimal plain text, no long callouts
   on the main surface.

Facts this ADR builds on (code read on 2026-11-03, plus the live testnet trade):
- `cloid = 0x || rules_hash[0..8] || counter_be64` (`engine/risk.ts` `cloidPrefix`/`makeCloid`); one account-wide
  `orderCounter`. Live testnet fills carry the cloid (`0xbb49a14c0945f9330000000000000001`), so attribution by prefix
  works. The engine also attributes by remembered `oid` (`botOids`, 500) and remembers up to 64 prefixes
  (`botPrefixes`, oldest dropped with a warning).
- `EngineState` (`engine/tick.ts`) is single-bot: `rulesHash`, `firedAt`, `orders`, `lastSkip`, `ordersToday`,
  `stoppedDayIndex`, `stopReason`, `halt`, `fills` (one `FillTracker` with per-pair `today`/`total` sums).
- The day snapshot `startPositions` holds every allowed-pair coin of the account (including coins held by hand), and
  the loss stop marks all of it. The equity backstop is account-wide.
- Spot buy fees are charged in the base token (`fee 0.0021`, `feeToken PURR` on a 3 PURR buy → position 2.9979). The
  adapter converts the fee to USDC; `HlFill` carries only `feeUsdc`, so a per-bot base position cannot be computed
  exactly from fills today.
- Store: `rules/<hash>.json` envelopes + `active.json` pointer; `engine-state.json`, `log.jsonl`, `meta.json`.
- HL keeps only the 10000 newest fills; the engine keeps sums, not rows. A trades table therefore needs our own
  journal.
- The dashboard already calls the HL info API from the browser (`fetchHlApprovedAgents`), so `candleSnapshot` can be
  read the same way, without a worker proxy. Spot `candleSnapshot` with `coin: "@107"` works (V0 spike).
- `scheduleCancel` is volume-gated ($1M traded); the engine runs IOC-only while gated (ADR-0005).
- Another agent is editing `worker/src/trading/engine/*` and `hl/*` (review fixes, e.g. new ledger kinds
  `class_in`/`class_out`). Engine tasks here start after that work merges.

## Options

### A. Bot identity in the cloid
| Option | Pros | Cons |
|---|---|---|
| A1. Keep the format; the bot is found through a permanent prefix → bot registry (each rule-set hash belongs to exactly one bot) | No format change; every existing fill and order keeps its attribution; the HL history still proves which rule set placed an order | Two bots cannot run byte-identical rule sets (refused at confirm; changing the name changes the hash) |
| A2. `rules_hash[0..6] || bot_index_u16 || counter_be64` | Bot readable from the cloid alone | New format next to the old one; prefix shrinks to 6 bytes; index must never be reused; old fills need a legacy path anyway |
| A3. Bot id in the rule set (DSL v2 field) | Hash is unique per bot by construction | DSL version bump, new vectors, dashboard renderer change; more surface for no extra safety |

### B. Position of a bot when two bots trade the same pair
| Option | Pros | Cons |
|---|---|---|
| B1. Each bot's position = sum of its own fills (net of base fees) since its creation; sells capped at that | A bot can never sell another bot's (or the owner's) coins; P&L is exact per bot | Coins held by hand belong to no bot; base-fee fields needed on `HlFill` |
| B2. Split the account balance pro rata | No new fields | Wrong as soon as one bot trades; bot A could sell bot B's coins |
| B3. One bot per pair | Simplest | Contradicts the owner's request (several strategies on HYPE/USDC) |

### C. Chart library (dashboard)
| Library | Version (npm 2026-11-03) | Size | Candles + markers | Dark theme | Notes |
|---|---|---|---|---|---|
| lightweight-charts (TradingView) | 5.2.1, Apache-2.0, 1 dep (`fancy-canvas`) | ≈45 KB gz **[verify with `vite build`]** | Built in: candlestick, line, area, baseline series; `createSeriesMarkers` for buy/sell markers; time scale with zoom | Options object (`layout.background`, `textColor`, grid colors) mapped to our tokens | Canvas, made for price data; the license asks for TradingView attribution (`attributionLogo`, on by default) |
| uPlot | 1.6.32, MIT, 0 deps | ≈20 KB gz | Line only built in; candles and markers are custom draw hooks | Manual | Fastest, smallest; we would write and test candle/marker drawing ourselves |
| recharts | 3.10.1, MIT, 11 deps (redux toolkit, immer, victory-vendor, …) | ≈100+ KB gz | No candlestick; markers via custom shapes | Manual | SVG, React-friendly, heaviest, slow for 2880-point series |

## Decision

### 1. Bot model
```ts
interface Bot {
  id: string;                 // ^[a-z0-9][a-z0-9-]{0,15}$, unique, never reused (also not after archive). Migration: "default"
  name: string;               // 1..60 chars, display only, owner can rename (not signed)
  created_at_ms: number;      // start of the bot's "all" window and of its fill attribution
  archived_at_ms: number | null;
  active_hash: string | null; // confirmed rule set in force; null = draft or after archive
  hashes: { prefix: string /* 0x + 16 hex */, hash: string | null /* null only for migrated prefixes */, activated_at_ms: number }[];
}
```
- **Per-bot limits** are the rule set's `limits` (DSL v1, unchanged): `max_position_usdc`, `max_order_usdc`,
  `daily_loss_stop_usdc`, `max_orders_per_day`. `validate()` keeps rejecting anything looser than the hard limits.
- **Account caps** are the existing env hard limits, now read as totals across all bots:

| Env | Applies to |
|---|---|
| `TRADING_HARD_MAX_ORDER_USDC` | every order of every bot |
| `TRADING_HARD_MAX_POSITION_USDC` | whole account: all allowed-pair holdings at mid (bots + by hand) + all open buys. Same as today's check |
| `TRADING_HARD_DAILY_LOSS_USDC` | sum of all bots' `loss_today` → account `stopped_today` (reason `ACCOUNT_LOSS_STOP`) |
| `TRADING_HARD_MAX_ORDERS_PER_DAY` | sum of all bots' order attempts today |
| `MAX_ORDERS_PER_TICK = 2` (code) | account-wide, unchanged |
| new `TRADING_MAX_BOTS` (default 3, 1..5) | bots that are not archived |

- The sum of per-bot limits may exceed an account cap. The account cap binds first-come in evaluation order; it is
  never raised by adding a bot.
- **Equity backstop** stays account-wide. Threshold = `min(TRADING_HARD_DAILY_LOSS_USDC, Σ daily_loss_stop_usdc of
  bots with an active rule set)`. With one bot this equals today's behaviour.

### 2. Cloids and attribution (option A1)
- Format unchanged: `0x || rules_hash[0..8] || counter_be64`. One account-wide `orderCounter` (cloids stay unique on
  the account).
- `bots.json` holds the permanent `prefix → bot` map. Confirm refuses:
  - `RULES_USED_BY_OTHER_BOT`: the hash already belongs to another bot (the owner renames the rule set);
  - `CLOID_PREFIX_TAKEN`: a different hash with the same 8-byte prefix exists (2⁻⁶⁴, checked anyway).
- Prefixes are never dropped (replaces the 64-entry window). Cap: 64 rule-set activations per bot; confirm beyond it
  is refused (`TOO_MANY_RULE_SETS`, the owner creates a new bot). That fails closed instead of losing attribution.
- `botOids` becomes `oid → bot_id` (500 newest, persisted), written when HL returns an oid.
- A fill is bot X's when its cloid prefix maps to X, else when its oid maps to X. Otherwise it is foreign (counted
  and warned, as now).
- Existing fills: every prefix in `EngineState.botPrefixes` and the old `rulesHash` map to bot `default`, so their
  attribution does not change.

### 3. Shared pairs (option B1)
- `HlFill` gets `feeToken: string` and `feeAmount: Dec` (raw HL fields) next to `feeUsdc`. Adapter task, after the
  current `hl/*` work.
- Bot position per pair = Σ buys `size − (feeToken == base ? feeAmount : 0)` − Σ sells, over the bot's fills since
  `created_at_ms`.
- Sell capacity of bot X = `min(account free base, X position − X open sell size)`. Otherwise `INSUFFICIENT_BOT_BASE`.
  `position_pct` is a percentage of X's own position.
- Buy checks: X position value at mid + X open buys + order ≤ X `max_position_usdc`; then the account check above.
  Free USDC is shared, first-come.
- Coins held by hand belong to no bot and no bot can sell them. They count in the account position cap and in the
  equity backstop.
- Per-bot loss stop = −(X trading P&L today): X's fills today + fees + mark-to-market of X's own start position (from
  X's fills at the day snapshot). This drops today's extra marking of hand-held coins from the stop. Those losses stay
  covered by the equity backstop.
- Migration: `default`'s position = its `total` aggregate. If `totalComplete == false` (history truncated), `default`
  gets sell capacity 0 and reason `BOT_POSITION_UNKNOWN` until the owner archives it or re-creates the strategy.

### 4. Engine
One tick, shared reads, then each bot in turn:
1. Account reads once (HL state, mids, books, fills since cursor, ledger, agents, vault budget), exactly as today.
2. Account gates, as today and for all bots: perp alarm (halts the account and every bot), vault pause / agent
   status (`paused_onchain`), API wallet, freshness, day snapshot.
3. `scheduleCancel` once per tick, before any order. IOC-only mode (`deadManGatedAtMs`) is account-wide.
4. Account loss stop and equity backstop → account `stopped_today`, cancel all.
5. Bots with an active rule set, not archived, not halted, not `stopped_today`, in `created_at_ms` order. Per bot:
   cancel its expired orders and orders of its superseded hashes; per-bot loss stop (cancel its orders →
   `stopped_today`); evaluate its rules (≤ 1 order per rule). Every candidate passes the per-bot checks and then the
   account checks. A failure is skipped and logged with `bot_id`, never resized.
6. Orders whose prefix maps to no bot, or to an archived bot, are cancelled (as now for foreign rule sets).

State v2 (`engine-state.json`, `version: 2`):
```ts
interface EngineStateV2 {
  version: 2;
  account: { day; halt; stoppedDayIndex; stopReason: "ACCOUNT_LOSS_STOP" | "EQUITY_DROP" | null; orderCounter;
             deadManAtMs; deadManGatedAtMs; lastTickMs; recent; lastStateKey; lastStateRepeats; ordersToday;
             fillCursor: { cursorMs; seen; foreignFills } };
  oidBot: Record<string, string>;           // oid -> bot id, 500 newest
  bots: Record<string, {
    rulesHash: string | null; firedAt; orders; lastSkip; ordersToday; filledOrdersToday;
    stoppedDayIndex: number | null; halt: { reason: "KILLED" | "PERP_POSITION_DETECTED"; atMs; detail } | null;
    agg: { today: AggMap; total: AggMap; totalComplete: boolean; botFillsToday: number };
    startPositions: Record<string, { size: Dec; mid: Dec }>;
  }>;
}
```
Migration v1 → v2 runs once on load (pure function, tested; the v1 file is kept as `engine-state.v1.json`):
- per-rule fields, `ordersToday`, `filledOrdersToday`, `fills.today/total` → `bots.default`;
- `stoppedDayIndex` with `DAILY_LOSS_STOP` → `bots.default`; with `EQUITY_DROP` → `account`;
- `halt` → `account.halt` **and** `bots.default.halt`;
- `botOids` → `oidBot[*] = "default"`.

Halts and kill:
- **Kill one bot** (`POST /trading/bots/:id/kill`): `bots[id].halt = KILLED`, its open orders are cancelled at once
  (same wait-for-tick and kill-epoch logic as `kill()` today, filtered to its prefixes). Other bots continue.
- **Kill all** (`POST /trading/kill`, unchanged): account halt + every bot halted + cancel all + `scheduleCancel`.
- **Perp alarm**: account halt + every bot halted, as today.
- **Clearing**: confirming a rule set for bot X (a new one, or re-signing the same hash with a fresh nonce = resume)
  clears X's halt and the account halt. Other bots stay halted until each is confirmed. The 409 perp check before
  confirm stays.

States. The account keeps the ADR-0005 enum. Bot state:
`draft` (no rules yet) | `running` | `stopped_today` | `halted` | `archived` | `blocked`. `blocked` = the account is
not `running`; the bot shows the account state as its reason.

### 5. Confirm and store
NEP-413 message v2 (adds the `bot:` line; recipient = vault id):
```
Agent Treasury: activate trading rules
vault: <vault>
agent: <TRADER_AGENT_ID>
bot: <bot_id>
hl_network: <mainnet|testnet>
hl_account: <HL_MASTER_ADDRESS lower-case>
rules_sha256: <64 hex>
```
- `ConfirmedRules` gets `bot_id: string`. `verifyEnvelope` requires the v2 message with that `bot_id`. The v1 message
  (no `bot:` line) is accepted **only** for the migrated `default` envelope whose hash equals the pre-migration
  `active.json` hash. Every new confirm, also for `default`, is v2.
- The challenge nonce is bound to `(hash, bot_id)`.
- Creating a bot = confirming its first rule set for a bot id that does not exist yet. The registry entry is written
  only after the signature verifies, so a nonce that is never confirmed creates nothing.
- Files under `TRADING_STATE_DIR`:
  - `rules/<hash>.json`: unchanged pool of envelopes;
  - `bots.json`: `{ version: 1, bots: Bot[] }`, atomic write. It replaces `active.json`. Migration: when `active.json`
    exists and `bots.json` does not, write `default` (active hash, prefixes from engine state), then rename
    `active.json` → `active.v1.json`;
  - `bots/<id>/fills.jsonl`, `bots/<id>/h-1m.jsonl`, `h-15m.jsonl`, `h-1d.jsonl` (§6);
  - `account/h-1m.jsonl`, `h-15m.jsonl`, `h-1d.jsonl` (equity, USDC, summed P&L).
- `loadActive` becomes `loadBots`: it re-verifies every active envelope on each load (as today). A refused bot gets
  `halted`-like `blocked` with reason `RULES_REFUSED`. Other bots are not affected.
- Rename (`name`) and archive are owner-session actions, not signed. Rename is cosmetic. Archive only reduces risk:
  it cancels the bot's orders and sets `active_hash = null`. Kill works the same way today. Only rule activation, the
  one action that widens what the bot may do, needs NEP-413.

### 6. History for charts
- **P&L/position snapshots.** At the end of each tick (also non-running ticks, so the curve has no false gaps), the
  service folds a per-bot sample into the open bucket of each tier. The sample is: total trading P&L (display
  valuation), today's P&L, position value, per-pair size and mid. A bucket is appended as one JSON line when it closes.
  ```json
  {"t":1793750400000,"pnl":"-0.0412","lo":"-0.0533","hi":"-0.0101","today":"-0.0412","val":"13.71","pos":{"HYPE/USDC":"0.42"},"px":{"HYPE/USDC":"32.65"}}
  ```
  | Tier | Bucket | Kept | Max lines | ≈ size |
  |---|---|---|---|---|
  | `h-1m` | 1 min | 48 h | 2880 | 0.35 MB |
  | `h-15m` | 15 min | 31 d | 2976 | 0.36 MB |
  | `h-1d` | 1 day | 400 d | 400 | 0.05 MB |
- Compaction: when a file exceeds 1.25 × its max lines, rewrite the newest max lines (tmp + rename). Bound:
  about 0.8 MB per bot, under 5 MB for 5 bots + account. The open bucket lives in memory only; a crash loses at most
  one bucket per tier.
- **Fills journal** `bots/<id>/fills.jsonl`: one line per attributed fill, written after the tick together with the
  state. Fields: `tid, oid, cloid, rule_id|null, time_ms, pair, side, px, sz, fee_usdc, fee_token, fee_amount,
  realized_usdc|null, pos_after`. Deduplicated by `fillKey`. Retention: all fills, cap 50 000 lines per bot (oldest
  dropped). The P&L sums do not depend on the journal.
- **Candles** are not stored. The dashboard reads HL `candleSnapshot` itself.
- Retention is checked on start and at each compaction. Archived bots keep their files.

### 7. Metrics (per bot, over a range; worker computes them, pure `metrics.ts`)
- **Realized P&L (average cost per pair).** Buy: cost += `px·sz` (+ `fee_usdc` if the fee is in USDC); size += `sz −
  base fee`. Sell: `realized = sz·(px − avg) − fee_usdc`; cost −= `sz·avg`.
- **Closed trade** = one sell order (`oid`) of the bot. Its realized P&L is the sum over the order's fills. A DCA bot
  rarely returns to flat, so flat-to-flat round trips would leave win rate empty.
- `win_rate` = closed trades with realized > 0 / all closed trades in range (`null` if none).
- `avg_trade_usdc` = Σ realized of closed trades / their count.
- `max_drawdown_usdc` = max over buckets t in range of (max(`hi`, `pnl`) of buckets before t) − `lo`_t, on the total
  P&L curve, at bucket resolution. In USDC only: a bot has no own capital, so a % would be made up.
- `turnover_usdc` = Σ `px·sz` of the bot's fills in range.
- `fees_usdc` = Σ `fee_usdc` in range.
- Also `realized_usdc`, `pnl_change_usdc` (last − first point), `fills`, `orders` (attempts from the log).
- Ranges: `1h` (from `h-1m`), `1d` (`h-1m`), `1w` (`h-15m`), `1m` (`h-15m`), `all` (`h-1d`, from `created_at_ms`).

### 8. HTTP API (mounted under `/trading`, errors and auth as in ADR-0005)
| Method, path | Auth | Request | Response 200 |
|---|---|---|---|
| `GET /trading/status` | none | — | `TradingStatus` (account). Additive: `bots: { id, name, state }[]`, `max_bots`. `active_rules` deprecated: filled from `default` while it exists, removed after D7 |
| `GET /trading/bots` | none (same exposure as `/status`: HL data is public) | — | `{ bots: BotSummary[] }` |
| `GET /trading/bots/:id` | owner | — | `BotDetail` |
| `GET /trading/bots/:id/history` | owner | `range=1h\|1d\|1w\|1m\|all` | `{ range, bucket_ms, points: HistoryPoint[] }` (max 3000) |
| `GET /trading/bots/:id/fills` | owner | `cursor?`, `limit` 1..200 (default 50), `from_ms?` | `{ fills: BotFill[] /* newest first */, next_cursor: string \| null }` |
| `GET /trading/bots/:id/metrics` | owner | `range` | `BotMetrics` |
| `GET /trading/log` | owner | `limit`, `bot?` | entries gain `bot_id: string \| null` |
| `POST /trading/rules/challenge` | owner | `{ rules, bot_id, bot_name? }` (`bot_name` required when `bot_id` is new) | ADR-0005 shape + `bot_id`; 409 `MAX_BOTS`, `RULES_USED_BY_OTHER_BOT`, `BOT_ARCHIVED` |
| `POST /trading/rules/confirm` | NEP-413 | ADR-0005 body + `bot_id`, `bot_name?` | `{ bot: BotSummary, state }` |
| `POST /trading/bots/:id/rename` | owner (fresh) | `{ name }` | `{ bot: BotSummary }` |
| `POST /trading/bots/:id/archive` | owner (fresh) | `{}` | `{ bot: BotSummary, cancelled_orders }` |
| `POST /trading/bots/:id/kill` | owner (`safetyOnly`, not rate limited) | `{ reason? }` | `{ bot_id, state: "halted", cancelled_orders, steps: { cancel: "ok"\|"failed", state_saved: "ok"\|"failed" } }` |
| `POST /trading/kill` | unchanged (kill all) | | |

`GET /trading/rules` is removed once D5 ships. Its data moves into `BotDetail.rules`.

```ts
type BotState = "draft" | "running" | "stopped_today" | "halted" | "archived" | "blocked";
BotSummary { id, name, state: BotState, state_reason: string | null, pairs: string[],
             pnl_today_usdc: SDec, pnl_total_usdc: SDec, position_usdc: Dec,
             spark: SDec[] /* 24 hourly pnl_total closes, oldest first, from h-15m */,
             created_at_ms, archived_at_ms: number | null, last_fill_ms: number | null }
BotDetail { bot: BotSummary,
            rules: ConfirmedRules | null, rules_history: { hash, name, confirmed_at_ms, superseded_at_ms | null }[],
            limits: { bot: RuleLimits, account: RuleLimits & { price_band_bps: number } },
            today: { orders: number, loss_usdc: Dec },
            positions: { pair, size: Dec, avg_cost: Dec | null, mid: Dec, value_usdc: Dec }[],
            pairs: { name, coin /* "@107", for candleSnapshot */, sz_decimals: number }[],
            open_orders: TradingStatus["open_orders"], hl_network }
HistoryPoint { t, pnl: SDec, lo: SDec, hi: SDec, today: SDec, val: Dec, px: Record<string, Dec> }
BotFill { tid: number | null, oid, cloid: string | null, rule_id: string | null, time_ms, pair, side: "buy" | "sell",
          price: Dec, size: Dec, fee_usdc: Dec, fee_token: string, realized_usdc: SDec | null }
BotMetrics { range, from_ms, to_ms, closed_trades: number, win_rate: string | null /* "0.5714" */,
             avg_trade_usdc: SDec | null, realized_usdc: SDec, pnl_change_usdc: SDec, max_drawdown_usdc: Dec,
             turnover_usdc: Dec, fees_usdc: Dec, fills: number, orders: number }
```
- `cursor` is an opaque base64 of `time_ms:tid`.
- Assistant proposal (`TradingRulesProposal`) gains `bot: { id, name, is_new: boolean }`.
- `/ai/chat` request gains an optional `trading_bot: string | "new"` set by the dashboard. Its default for
  `propose_trading_rules` is the target bot. The model may not switch targets: the worker fills `bot` from the
  request, and the card shows "New strategy" or "Changes <name>".
- For a new bot the worker derives the id from the name (slug, deduplicated with `-2`, `-3`).

### 9. Dashboard
Routes (lazy-loaded chunk for the detail page, so the chart library stays out of the main bundle):
| Route | Content |
|---|---|
| `/trading` | List like the Agents page. Header: "New strategy" (primary, disabled until connected) and "Stop all". Rows: name, status pill, pair, P&L today / total, sparkline. Archived bots below, collapsed. If Hyperliquid is not connected: one row "Hyperliquid is not connected" with a "Connect" button. No stepper here |
| `/trading/connect` | "Connect Hyperliquid": the existing account-level stepper (worker, `hl-trader` agent and mandate, HL master, API wallet approval, funding, pending top-ups), account status, account kill switch (kill all + `pause_agent` + revoke steps), return-profits steps. The current `Intro` collapses to one line here |
| `/trading/bots/:id` | Header: name (rename inline), pill, pair, **Stop** (per-bot kill), "Change rules", "Archive" (menu). Range tabs `1H 1D 1W 1M All`. P&L chart (baseline series, green above 0 / red below). Price chart (candles of the pair, buy/sell markers from fills in range). Metrics row (win rate, avg trade, max drawdown, turnover, fees, realized). Settings card: rules via `describeBlocks` + bot limits next to account caps. Trades table (cursor pagination) |
| `/trading/guide` | unchanged |

- **Chart library: `lightweight-charts` 5.2.1**, exact pin, only in the detail chunk. It is the only option with
  built-in candles and markers, and it is far lighter than recharts. Theme options come from `kit/tokens.ts`. Keep
  the attribution logo (license NOTICE) and list the library in README disclosures.
- Sparkline: a small SVG component in `kit/` (`<Sparkline values />`), no library.
- Candle intervals for `candleSnapshot` (`coin` from `BotDetail.pairs`): 1h → `1m`, 1d → `15m`, 1w → `1h`, 1m →
  `4h`, all → `1d`. Markers: fills with `from_ms` = range start, at most 500 (newest).
- "New strategy" opens the assistant with `trading_bot: "new"` and a short prefill. "Change rules" opens it with
  `trading_bot: <id>`. The TradingRules card shows the target bot, the dashboard's own sentences and hash, and signs
  the v2 message. The dashboard's `confirmationMessage` adds the `bot:` line and is tested on the shared vectors.
- Text: labels and numbers. At most one line of risk text, on `/trading/connect` next to funding. Reason codes use the
  existing `reason.CODE` translations (en/ru/uk, `trading.*` keys, see `src/i18n/README.md`).

### 10. Security
- More bots must not mean more risk than the account caps allow. All `TRADING_HARD_*` caps are account totals.
  `MAX_ORDERS_PER_TICK` stays account-wide. `TRADING_MAX_BOTS` ≤ 5. Per-bot limits can only be stricter
  (`validate()` + `effectiveLimits` min, unchanged).
- Bot A's rule set can never move bot B's coins:
  - sells are capped at A's own fill-derived position;
  - A's cancel step only touches A's prefixes;
  - attribution comes from a permanent prefix map that confirm refuses to make ambiguous;
  - per-bot kill only cancels A's orders.
- One signature activates one (bot, hash). The message names the bot, and the nonce is bound to both.
- Account-wide halts (perp alarm, kill all, `paused_onchain`, equity backstop, account loss stop) override every bot.
  No bot can clear them alone; only an owner confirm can.
- Unchanged: spot only, price band, liquid pairs, dead-man/IOC mode, fresh data, on-chain pause, vault funding caps.
  More bots do not change the vault mandate. Funding stays account-level (`funding.ts`, one allowlist entry).
- Residual risk (accepted):
  - with shared USDC, an early bot can use up the free balance, so a later bot skips (`INSUFFICIENT_USDC`), never
    over-spends;
  - hand-held coins are no longer marked by a bot's loss stop, only by the equity backstop.
- `security-auditor` runs on W9/W11 before any mainnet session with more than one bot.

## Consequences
- **Contract**: none.
- **Worker**: state v2 + migration, `bots.json`, message v2, per-bot engine loop, history/journal/metrics modules,
  new routes, `TRADING_MAX_BOTS`, `HlFill.feeToken/feeAmount`.
- **Dashboard**: three routes instead of one page, new dependency `lightweight-charts@5.2.1`, `Sparkline` in kit,
  client types/parsers, v2 confirm message.
- **Security**: new invariants above; ADR-0005 threats unchanged; `docs/architecture.md` trust rows get "per-bot
  isolation inside one HL account (our code, not protocol)".
- **Demo**: two bots on HYPE/USDC (DCA + dip buyer). The list shows both with sparklines; the detail page shows the
  price with buy markers and the P&L curve; stop one bot while the other keeps running; then Stop all.

## Test plan (vitest, fake `HlPort`)
1. Migration: v1 state + `active.json` → v2 + `bots.json` with `default`. Old fills stay attributed to `default`, a
   halt carries over, `EQUITY_DROP` lands on the account, and the legacy v1 message is accepted only for `default`'s
   migrated hash.
2. Attribution: fills of two bots (by prefix; by oid when the cloid is null); a foreign fill; confirm refuses
   `RULES_USED_BY_OTHER_BOT`, `CLOID_PREFIX_TAKEN`, `TOO_MANY_RULE_SETS`, `MAX_BOTS`.
3. Shared pair: A buys 3 HYPE, B buys 2; B's `position_pct: 100` sell sells 2 (net of base fee), never more; a sell
   with no own position is refused `INSUFFICIENT_BOT_BASE`; hand-held coins are never sold.
4. Caps: two bots each under their own caps but together over the account position / orders-per-day / per-tick cap
   → the second is skipped with the account code; account loss stop on the summed loss; equity backstop threshold =
   min(hard, Σ).
5. Halts: kill A → only A's orders cancelled, B places orders the same tick; kill all → all halted; confirm A → A and
   account cleared, B still halted; re-sign of the same hash resumes; perp alarm halts all; `paused_onchain` blocks
   all; IOC-only mode applies to all bots.
6. Confirm: v2 message with the wrong `bot_id` → `MESSAGE_MISMATCH`; a nonce for (hash, A) used for B → refused; a
   new bot is created only after a valid signature; archived id → `BOT_ARCHIVED`.
7. History: bucket fold (lo/hi/close), tier rollover, compaction keeps the newest N, restart resumes the files; range
   → tier mapping.
8. Metrics: vectors for average cost with a base-token fee, closed trade per oid over partial fills, win rate with 0
   closed trades = null, drawdown on a known curve, turnover, fees.
9. HTTP: auth matrix (list public, detail owner, kill `safetyOnly`), query validation, cursor round trip, 404 for an
   unknown bot.
10. Dashboard: parsers for every new shape; `confirmationMessage` v2 on shared vectors; sparkline scaling; range →
    candle interval; marker mapping from fills.
11. Testnet: two bots on one testnet account for ≥ 6 h; per-bot kill drill; check that `fills.jsonl` matches HL
    `userFillsByTime`.

## Implementation tasks (disjoint files; S ≤ 2 h, M ≈ half day, L ≈ 1 day)
| # | Package | Files | Size | Depends / order |
|---|---|---|---|---|
| W7 | worker | `src/trading/types.ts` (Bot, BotState, EngineStateV2 shape, API payloads, `HlFill.feeToken/feeAmount`) | S | after the review-fix agent merges (it touches `types.ts`) |
| W8 | worker | new `src/trading/bots.ts` (registry, migration of `active.json`), `store.ts`, `confirm.ts`, `rules/canonical.ts` (message v2), `docs/trading-rules-vectors.json` (v2 message vectors) | M | W7 |
| W10 | worker | new `src/trading/history.ts`, `src/trading/journal.ts`, `src/trading/metrics.ts` + tests | M | W7 (pure, may start on a draft of W7) |
| W9 | worker | `src/trading/engine/{tick,risk,fills,pnl}.ts`, new `engine/migrate.ts`, `hl/{nktkas,fake}.ts` (fee fields) | L | W7, and **only after the current engine/hl review-fix agent has merged** |
| W11 | worker | `src/trading/{service,route,index}.ts`, `src/config.ts` (`TRADING_MAX_BOTS`), `worker/.env.example` | M | W8, W9, W10 |
| W12 | worker | `src/ai/{trading,tools,prompt,route,proposals}.ts` (`trading_bot`, card `bot`) | S | W8 |
| D5 | dashboard | `src/lib/tradingClient.ts`, `src/lib/tradingRules.ts` (message v2) + tests, new `src/lib/tradingMetrics.ts` (format, range ↔ interval) | M | W7 shapes (can start from this ADR) |
| D6 | dashboard | new `src/pages/TradingConnectPage.tsx`; move stepper/setup/kill-all from `features/trading/Trading.tsx` into `features/trading/Connect.tsx`; `App.tsx` routes | M | D5 |
| D7 | dashboard | new `src/features/trading/BotsList.tsx`, `src/pages/TradingPage.tsx`, `src/kit/Sparkline.tsx` (+ `kit/index.ts`), i18n `en/ru/uk` `trading.bots.*` | M | D5 |
| D8 | dashboard | new `src/pages/TradingBotPage.tsx`, `src/features/trading/bot/{Charts,Metrics,Trades,Settings}.tsx`, `package.json` (`lightweight-charts` 5.2.1 exact), i18n `trading.bot.*` | L | D5; i18n keys in a separate block from D7 to avoid conflicts |
| D9 | dashboard | `src/features/assistant/{model.ts,ProposalCardView.tsx}`, `src/lib/assistantClient.ts` (`trading_bot`, bot on card) | S | D5, W12 |
| X3 | docs | `docs/architecture.md`, `README.md` trading section, `docs/commands.md` (two-bot testnet drill), `docs/demo-script.md`, `CHANGELOG.md` | S | after W11 |
| X4 | review | `tester` on W8–W11; `code-reviewer` on W9/W11 (moves money on HL); `security-auditor` before a multi-bot mainnet session | M | all |

Parallel lanes: {W10, D5, D7} now; {W7 → W8, W12} after the review-fix merge; then W9 → W11; D6/D8/D9 once D5 lands.
i18n files are shared by D6/D7/D8: one agent at a time, or each task owns its own key block.

## References
- `docs/adr/0005-hyperliquid-trading-agent.md` (all sections, incl. owner decisions, review fixes, accounting change,
  scheduleCancel volume gate).
- `docs/research/hyperliquid-trading.md` (V0 spike results, "Live testnet trade (2026-11-03)").
- `docs/research/trading-ux.md` (§3 patterns, §4 layout).
- Code: `worker/src/trading/{types,store,confirm,service,route,pairs}.ts`, `engine/{tick,risk,pnl,fills}.ts`,
  `rules/canonical.ts`, `worker/src/ai/trading.ts`, `worker/src/config.ts`; `dashboard/src/features/trading/Trading.tsx`,
  `dashboard/src/pages/AgentsPage.tsx`, `dashboard/src/App.tsx`, `dashboard/src/lib/tradingClient.ts`,
  `dashboard/package.json`, `dashboard/src/i18n/README.md`.
- npm registry metadata read 2026-11-03 (`npm view`): lightweight-charts 5.2.1, uplot 1.6.32, recharts 3.10.1.
  The gzip sizes in the table are estimates from memory, not measured here; D8 records the real chunk size from
  `vite build`. I did not re-fetch the HL `candleSnapshot` docs in this session; the spike result above is the source.

## Owner defaults (2026-11-03, changeable)

1. Up to 3 bots by default (`TRADING_MAX_BOTS`, hard max 5).
2. Archiving a bot that still holds coins is refused until its position is below the HL minimum order (10 USDC);
   the dashboard offers "sell this bot's position" first. Simpler than hand-over and no orphaned coins.
3. Win rate counts each sell order as a closed trade (DCA-friendly); the definition is shown next to the number.
4. `GET /trading/bots` public view shows only id, name, status and pair; P&L and sparklines need the owner session.
5. Bots run in creation order for v1 (no per-bot USDC budget field); revisit after the hackathon.
6. Accepted: a bot's daily loss stop ignores coins held by hand; the account-wide backstop covers them.
7. Accepted: the sum of bots' daily loss stops may exceed the account cap; the account cap stops everything.
8. Keep the TradingView attribution required by the lightweight-charts license.
