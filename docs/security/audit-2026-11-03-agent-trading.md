# Security audit: agent-driven trading (ADR-0007), 2026-11-03

## Scope / what was not checked

- **Code**: branch `feat/kit-foundation`, commits `5dcbb9e..18a494c`. Reviewed with `git diff 5dcbb9e^..HEAD -- worker mcp dashboard docs`:
  - worker: `trading/{agent,route,service,confirm,bots,journal,propose,index}.ts`, `trading/engine/{tick,risk,state}.ts`,
    `trading/rules/*`, `ai/trading.ts`, `config.ts`;
  - mcp: `src/{config,trading,server,index}.ts`;
  - dashboard: `AgentConnectStep`, `bot/{AgentAccess,AgentActivity,Settings,Trades}`, `lib/{tradingClient,tradingAgentSetup,tradingRules,tradingSkips}`;
  - docs: `docs/commands.md`, vectors, `.env.example`.
- **Spec**: `docs/adr/0007-agent-driven-trading.md`.
- **Prior audits checked for regressions**: `audit-2026-11-03-trading.md`, `audit-2026-11-03-multibot.md`.
- **Method**: manual review against the threat model in the task, plus the `near-contract-audit` checklist.
  - The contract is untouched by this change, so the NEAR detectors do not apply: no callbacks, no promises, no storage changes.
  - The test suites were run: worker 1054 passed (2 expected fail), dashboard 497 passed, mcp 28 passed.
  - Two hypotheses were proved with a throw-away vitest file in the session scratchpad, using the real service and FakeHl. Nothing in the repo was changed.
- **Not checked**:
  - live HL behaviour (no testnet or mainnet calls were made);
  - undici's redirect handling of `Authorization` on the installed Node version;
  - TEE mode (agent env vars are not yet pinned in a measured compose; the ADR defers this);
  - the Claude Code client's own storage of MCP env values.

Owner decisions taken as given:
- Stop is a full cut-off: resuming needs a NEP-413 re-sign, which mints a new token.
- The mainnet session runs on HL mainnet, HYPE/USDC, with vault ≤ 26 USDC, `TRADING_AGENT_MAX_ORDERS_PER_DAY=2`,
  `MIN_ORDER_INTERVAL_SEC=30`, `TOKEN_TTL_HOURS=12`.

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low / hardening | 9 |

The core invariant holds: an agent order reaches HL only through `attempt()` (`engine/tick.ts:993`), after every account gate of the same tick.
- Tokens are minted only by a signed confirm.
- The engine checks the verified envelope's `mode`, not `bots.json`.
- Notes never reach the agent or an LLM.

Both Medium findings concern how far the owner's decision "Stop = cut-off" holds, and whether the mainnet runbook is ready. Neither lets an agent go beyond its signed limits.

## Critical

None.

## High

None.

## Medium

### AM1. Stop does not kill the token. The cut-off lives only in `engine-state.json`, so losing that file revives a stopped agent with its old token (proved)

- **Where**:
  - `worker/src/trading/service.ts:1339` (`kill`) and `:1381` (`killBot`) only set `halt` in engine state.
  - `worker/src/trading/agent.ts:56-70` (`verifyAgentToken`) accepts the token after a Stop.
  - `service.ts:1439` (`agentPrecheck`) and `tick.ts:1129` refuse only because of `state.bots[id].halt`.
  - `service.ts:562` tells the operator: "engine-state.json is unreadable …; fix or delete it after checking that no halt was recorded".
- **Attack / scenario**:
  1. The owner presses Stop on the agent bot because the agent misbehaves or the token leaked.
  2. Later `engine-state.json` is lost or reset: the operator deletes a corrupt file as the error message suggests, restores an older
     copy, or copies `bots.json` into a fresh state dir.
  3. `bots.json` still holds the token record (sha256 plus `expires_at_ms`), and nothing on startup checks that every active bot has a state block.
  4. The bot starts un-halted, and the old token trades again until its TTL ends.
- **Proof**: scratch test using `harness({agent})` and the real `TradingService`:
  1. confirm the agent mandate, then `killBot("hype-agent")`;
  2. `verifyAgentToken(...).ok === true` (the token is still valid after Stop);
  3. delete `engine-state.json` and open a new service on the same dir;
  4. `POST /trading/agent/order` with the OLD token gives `"filled"`, and 1 HL order is placed.

  With the state file present, the same order gives `BOT_HALTED` (as designed).
- **Impact**: the owner's decision "after a Stop the old token can never place another order" holds only as long as the halt record survives.
  - The orders still stay inside the signed mandate and the account caps, so the money bound does not change.
  - The broken property is the cut-off guarantee that the demo and README advertise.
  - The same reset also clears DSL halts and the write-ahead daily counters. That is pre-existing, but with an external agent it matters more.
- **Fix**, any one of these (the first is the smallest):
  1. In `kill()` and `killBot()`, after the synchronous halt, call `registry.revokeAgentToken(id)` for every agent bot that is stopped.
     Make it best-effort and catch errors: the halt must not depend on the `bots.json` write. This makes Stop literally "token dead", as the owner decided.
  2. Or persist a `halted_at_ms` / `min_token_issued_at_ms` in the `bots.json` record, and have `verifyAgentToken` refuse a token issued before it.
  3. Also, on startup, refuse to trade (`STATE_CORRUPT`) when `bots.json` has an active bot but the engine state has no block for it.
  4. Change the `service.ts:562` text to "… and revoke every agent token first".
- **Session workaround** if the code is not changed:
  - never delete or replace `engine-state.json` during the session;
  - after any Stop of the agent bot, also press **Disconnect** (revoke);
  - at the end, revoke and archive.

### AM2. The [MAINNET] runbook does not include agent mode, and the agent drills have not been run

- **Where**: `docs/commands.md:333-500` (the [MAINNET] session runbook, env block around lines 470-495); the drill table at `docs/commands.md` ~line 320 says "not run yet" in every row.
- **Scenario**: the operator follows the runbook. Either `TRADING_AGENT_ENABLED` is missing, so agent mode is off and the demo fails. Or it is set by hand and the
  other three values take their defaults.
  - Interval 10 s instead of 30 s.
  - Token TTL **72 h**. This is longer than the 48 h session discipline (agent expiry and API wallet ≤ 48 h) and longer than the owner's 12 h.
  - Agent orders 10/day. `TRADING_HARD_MAX_ORDERS_PER_DAY=2` still caps this, so the impact is low.
  - No runbook step revokes or archives the agent bot at the end, and none tells the operator to keep the token out of shell history and the recording.
- **Impact**: a leaked token stays valid 6× longer than decided. The session also runs without a recorded drill of Stop, Resume, Revoke and `kill -9`, which are the properties the pitch relies on.
- **Fix**:
  - Add these lines to the runbook env block: `TRADING_AGENT_ENABLED=true`, `TRADING_AGENT_MAX_ORDERS_PER_DAY=2`, `TRADING_AGENT_MIN_ORDER_INTERVAL_SEC=30`, `TRADING_AGENT_TOKEN_TTL_HOURS=12`.
  - Add the suggested mandate (HYPE/USDC, order 12, position 12, loss 2, 2/day).
  - Add an end-of-session step: Disconnect (revoke), archive, then `claude mcp remove agent-treasury-trading`.
  - Fill in the testnet drill table (rows 1-8) before the mainnet session.

## Low / hardening

- **AL1. The MCP client follows HTTP redirects with the bearer token.**
  - **Where**: `mcp/src/trading.ts:45-50`: `fetch` has no `redirect` option, so the default `"follow"` applies.
  - **Scenario**: the URL policy in `mcp/src/config.ts:82-84` is good (https or loopback http, no credentials, no query).
    But a redirect from the configured host (a misconfigured reverse proxy, or a hostile https endpoint the user was given) is followed.
    Whether `Authorization` is stripped on a cross-origin redirect depends on the undici version.
  - **Fix**: add `redirect: "error"` to both calls, and a test with a 302.
- **AL2. Retry with an unknown outcome can place a second order.**
  - **Where**: `mcp/src/trading.ts:57-67, 190`; `worker/src/trading/agent.ts:184-200`; `route.ts:464-472`.
  - **Scenario**:
    1. A tick takes longer than the 45 s client timeout. The MCP retries at once with the same key and gets `409 ORDER_IN_FLIGHT`.
       The cache is written only on `release`, and in-flight is checked after the cache.
    2. The model sees an error. It never saw the generated `idempotency_key`, so it cannot reuse it.
    3. It calls again after the interval and gets a fresh key, which places a new order. A worker restart loses the cache too (documented).
  - **Bound**: the write-ahead `max_orders_per_day` (2 on mainnet) × max order.
  - **Fix**:
    - return the `idempotency_key` in every tool result and error;
    - make a same-key request that arrives while the first is in flight wait for that first result instead of answering 409;
    - optionally persist `key → cloid` in engine state through `beforeOrder`, so a replay after a restart is detected.
- **AL3. Revoke or re-sign does not cancel a request that is already authenticated.**
  - **Where**: `route.ts:448` (auth), then `service.ts:1467` (`while (this.inflight) await this.inflight`), then `runOnce`.
  - **Scenario**: the agent's request waits behind a running tick. During the wait, the owner presses Disconnect, or re-signs (which mints a new token). The order still goes out.
    A Stop is handled correctly: the halt and the kill epoch are checked inside the tick.
  - **Fix**: pass `tokenId` to `agentOrder`, and re-check `registry.get(botId).agent?.token_id === tokenId` right before `runOnce` (and in `agentPrecheck`).
- **AL4. Pair checks come after the per-pair work, which also changes the demo codes.**
  - **Where**: `engine/tick.ts:993-1022`. `attempt()` runs `NO_MARKET`, `PAIR_LOW_VOLUME`, sell capacity (`INSUFFICIENT_BOT_BASE`), sizing and `hl.getBook(pair)` for any pair the agent names.
    Only after that does `checkOrder` return `PAIR_NOT_ALLOWED` / `PAIR_NOT_IN_RULES`.
  - **Impact**:
    - one HL read per request for any pair (rate-limited by the interval);
    - the refusal code for an injected off-mandate request is often `INSUFFICIENT_BOT_BASE`, `PAIR_LOW_VOLUME` or `NO_MARKET`, not the `PAIR_NOT_IN_RULES` that the ADR demo step 3 and drill row 4 expect.
    - **On the mainnet HYPE mandate, the ADR's injection text "sell all HYPE" is IN the mandate**: it would really sell the bot's own HYPE (allowed, but not the scripted refusal).
  - **Fix**:
    - for `source: "agent"`, check `allowedPairs` and `rules.pairs` first in `attempt()` (this does not change DSL behaviour: DSL rules are always on mandate pairs);
    - for the mainnet demo, inject a request for a pair outside the mandate (for example PURR), not HYPE.
- **AL5. Bot name is a text channel to the agent.**
  - **Where**: `service.ts` `agentState()`: `bot.name`.
  - **Scenario**: a stolen owner session can `POST /bots/:id/rename` (60 chars, control characters removed). That text reaches the agent as `bot.name` in `trading_get_state`. The impact is small because the agent is bounded by the mandate anyway.
  - **Fix**: drop `name` from `AgentState`, or keep the signed `mandate.name` only.
- **AL6. Token hygiene outside the worker.**
  - **Where**: `AgentConnectStep` snippet and `docs/commands.md:305`. `claude mcp add … -e TRADING_AGENT_TOKEN=<token>` writes the token to shell history and to `~/.claude.json` in plaintext.
  - The dashboard is fine:
    - the token is blurred (`secret`, focus to reveal);
    - it lives only in React state;
    - only its sha256 is on disk, and no repo file contains it (checked: no `atk1_…` literal in the diff).
  - **Fix (docs)**:
    - prefix the command with a space (`HIST_IGNORE_SPACE`), or use `read -s`;
    - `chmod 600 ~/.claude.json`;
    - never show the Connect step or the terminal unblurred in the demo video;
    - revoke after recording.
- **AL7. Error text reaches the agent without the public scrub.**
  - **Where**: `service.ts:1502` (`HL_REJECTED`: `hlErrorText(res.error)`); `tick.ts` (`BOOK_UNAVAILABLE: … ${errMsg(e)}`).
  - **Scenario**: an exception text, for example a network error with a URL or host name, goes to the agent with only control characters removed. The pre-tick path already uses `publicText`.
  - **Fix**: run `publicText` in `rejected()` / `responseMessage`.
- **AL8. A transient refusal is cached for 24 h.**
  - **Where**: `agent.ts:205-216`. `release` stores every response, `final: false` ones included. A model that reuses its own key after `retry_after_s` gets the stale refusal for 24 h.
  - This is not a safety problem; it fails closed.
  - **Fix**: do not cache responses with `final === false` (or with status `rejected` and a TRANSIENT code).
- **AL9. Body read before auth, and no streaming limit.**
  - **Where**: `route.ts:441-448`. Without `Content-Length` (chunked), `c.req.text()` reads the whole body before the 2 KB check and before auth. This is the same pattern as the existing `json()`; the worker is loopback-only, and the IP limiter runs first.
  - **Fix**: Hono `bodyLimit({ maxSize: 2048 })` on `/agent/*`.
- Info (no fix needed for the session): `tick()` chains after an agent tick (`service.ts` `tick()`), so several agent bots trading back to back could delay a DSL bot's turn. The monitoring (loss stops, cancels) runs in every agent tick, so safety is unchanged.

## Checked and fine

- **Token**:
  - `atk1_<bot>_<32 random bytes b64url>`, with the bot id validated by regex at mint.
  - Only sha256 is stored, with `token_id` = 8 hex.
  - `timingSafeEqual` on 32-byte digests, also run for unknown bots.
  - One `401 AGENT_UNAUTHORIZED` for unknown, archived, wrong-kind, no-record and mismatch alike.
  - Expiry is checked after the hash.
  - The bot id comes only from the token; no agent route takes an id.
  - A length cap of 100 before parsing.
- **Mint only by signature**:
  - `RulesConfirmer.confirm` consumes the nonce first.
  - Its checks stay intact: the nonce is bound to (hash, bot), plus `KILLED_SINCE_CHALLENGE` (MM2) and `BOT_ID_TAKEN` (MM1).
  - The token is minted and committed in the same `activate()` commit, so the previous token dies with it.
  - No owner-session route mints a token or clears a halt. The owner-session routes are kill, bot kill, revoke, rename, archive and api-wallet rotate.
  - **A stolen owner session cannot start trading or get a token**; it can only stop, revoke, archive or rename.
- **DSL / agent confusion**:
  - The schema is chosen by the presence of `mode` (strict): `mode:"rules"` gives `BAD_MODE`, and an agent mandate with rules gives `AGENT_HAS_RULES`.
  - `mode` is part of the hash.
  - The v3 message has its own header and a `mode:` line. `verifyEnvelope` derives the mode from the parsed signed rules.
  - The legacy no-bot-id path refuses `mode`.
  - `BOT_KIND_MISMATCH` applies both ways.
  - The assistant and `propose` refuse any `mode` key, and the assistant passes `kind: "rules"` to `registry.check`.
  - The engine refuses `NOT_AGENT_BOT` from the **verified envelope** (`tick.ts:1129+`), so a `bots.json` edited to say `kind:"agent"` cannot drive a DSL bot.
  - `parseBot` refuses a token record on a non-agent bot.
  - The dashboard rebuilds the message locally with the mode taken from the rules, and compares.
- **Limits**:
  - `effectiveLimits` caps agent bots by `min(hard, TRADING_AGENT_MAX_ORDERS_PER_DAY, mandate)`.
  - `validate` gives `LIMIT_AGENT_MAX_ORDERS`.
  - Orders are IOC only (`order: {type:"ioc"}` is fixed by the engine).
  - Sells are capped to the bot's own fills (`capacityOf`, `INSUFFICIENT_BOT_BASE`, `BOT_POSITION_UNKNOWN`).
  - `position_pct` sizes against `min(accountFree, botBase)`.
  - The same `checkOrder` runs with the same `RiskContext` (same-path test present).
  - Oversized orders give `MAX_ORDER`, and splitting is bounded by orders/day plus the start-to-start interval.
  - Spam is bounded by the IP limiter, one request in flight, and the interval.
- **Counters**: attempts are incremented once in `attempt()` and written ahead through `beforeOrder`. `beforeOrder` failing gives `STATE_WRITE_FAILED` and no order. Gate refusals do not count.
- **Kill vs agent order**:
  - The precheck runs before the wait.
  - `kill`/`killBot` set the halt synchronously, and the halt is replayed on the running tick's result through `pendingOps`.
  - The agent tick then sees `BOT_HALTED` / account `KILLED`.
  - A kill during the agent tick is caught by `stopped(bot.id)` (epoch), which gives `KILLED` with no order.
  - `haltAll` halts every live bot, so re-signing *another* bot after kill-all does not resume the agent bot.
- **Single flight**: `agentOrder` claims the slot synchronously after `while (inflight) await inflight`. A scheduled tick never joins an agent tick, and `waitTick` (kill) covers both kinds.
- **Notes**:
  - Sanitised (`\p{Cc}\p{Cf}`, U+2028/9; collapsed; 200 code points).
  - Stored in the log, `cloidNote` and the journal.
  - Never in `AgentState` (`recent_fills` / `recent_orders` hold numbers and codes only).
  - Never read by `worker/src/ai/*` (grep).
  - `/log` and `/bots/:id/fills` are owner-only; `/status` (public) carries no log entries.
  - The dashboard renders notes as React text children only: no `dangerouslySetInnerHTML` anywhere, no markdown, no links, no CSV export.
- **MCP**:
  - URL policy is https, or http to 127.0.0.1 / localhost / [::1] by exact hostname; `localhost.evil` and `127.0.0.1@evil` fail.
  - No credentials, query or fragment are allowed in the URL.
  - Token regex is checked at startup.
  - The startup line prints only the bot id.
  - One retry on network errors only, with the same key.
  - The trading instructions appear only when trading is configured.
- **Secrets**:
  - The worker logs nothing per request; a test asserts the Authorization value never appears in logs or files.
  - `.trading*/` and `.env*` are gitignored (MH1 fix still present).
  - The dashboard keeps the token in React state only (blurred field, `beforeunload` warning).
- **Flag off**:
  - The agent routes are not mounted.
  - `kindOf` refuses agent mandates with `AGENT_TRADING_DISABLED`.
  - `hardLimitsOf` is unchanged (the agent key is added only when enabled).
  - DSL hashes, messages and vectors are unchanged (the vectors diff only adds).
  - `bots.json` for DSL bots is unchanged (`kind` is omitted for rules bots).
  - The `step 7` refactor is a move without logic change (read line by line: dedup skip, kill `break`, counters, rollback all match). The full worker suite passes.
  - Additive output only: `TradingStatus.agent_trading`, `BotSummary.kind`, `agent_token: null`.
- **Money paths unchanged**: no withdraw, send or vault path is reachable from the agent. Top-ups stay env-driven (one per day, floor-based), so an agent spending USDC cannot draw more than the session vault (≤ 26 USDC).

## Status of the previous audits' findings (regression check)

| # | Status after ADR-0007 |
|---|---|
| H1 / H2 | Unchanged (config / by design) |
| M1 kill race | Holds for agent ticks (epoch + `stopped(bot.id)` inside `attempt`) |
| M2 kill with RPC down | Holds; revoke also uses `safetyOnly` |
| M3 ledger mapping | Still open (unchanged) |
| M5 one worker per dir | Holds (`lock.ts` unchanged) |
| L5 localhost + `publicText` | Holds for status; see AL7 for the agent error text |
| MH1 gitignore | Holds (`.trading*/`) |
| MM1 / MM2 | Hold (`BOT_ID_TAKEN`, `KILLED_SINCE_CHALLENGE` checks intact in `confirm.ts`; agent Resume goes through them) |
| MM3 runbook | Regressed in spirit: the agent mode is missing from the runbook (AM2) |
| ML1 / ML2 | Hold (archive leaves halted; halt marker) |

## GO / NO-GO

**(a) Testnet drill (HL testnet, PURR/USDC, `TRADING_AGENT_ENABLED=true`): GO.**
- Record each row's observed result in `docs/commands.md`.
- Expect AL4: row 4 may show `INSUFFICIENT_BOT_BASE`, `PAIR_LOW_VOLUME` or `NO_MARKET` instead of `PAIR_NOT_IN_RULES`.
- Add one row for AM1: after Stop, run `verifyAgentToken` or `/agent/state` with the old token, and note that the token is still accepted for reads.

**(b) Small mainnet session (HYPE/USDC, vault ≤ 26 USDC): CONDITIONAL GO**, once all of these hold:
1. Testnet drill rows 1-8 have been run and recorded.
2. AM2: the runbook env block has `TRADING_AGENT_ENABLED=true`, `…_MAX_ORDERS_PER_DAY=2`, `…_MIN_ORDER_INTERVAL_SEC=30`, `…_TOKEN_TTL_HOURS=12`, plus the end-of-session revoke, archive and `claude mcp remove`.
3. AM1: either the code fix (Stop also revokes the agent token), or the session rule:
   - press Disconnect after any Stop of the agent bot;
   - never delete or replace `engine-state.json` during the session.
4. Demo script: the injection step names a pair outside the mandate, not "sell all HYPE" (AL4). The token is not visible in the recording (AL6).
5. Every condition of the two previous audits' go/no-go still holds:
   - vault ≤ 26 USDC; `approval_threshold` 0; 25/day; 1 top-up per day; agent and API wallet ≤ 48 h;
   - hard caps 25 / 12 / 5 / 2; a dedicated HL master; one worker on localhost (`HOST=127.0.0.1`, MCP URL `http://127.0.0.1:3000`);
   - revoke everything afterwards.

**Worst case with a leaked agent token** under these settings:
- it can place 2 IOC orders/day of at most 12 USDC, on HYPE/USDC only, selling only the bot's own HYPE;
- churn loss is cents, and it is capped by the mandate loss stop (2 USDC) and the account stop (5 USDC);
- it can write misleading notes, and use up the day's orders (DoS).

The worst case of the session as a whole stays the vault balance (about 26 USDC), as before.

## Known limitations (documented trust assumptions for the README)

- **The agent token is a static bearer secret.** Whoever holds it can trade within the signed mandate until it expires or the owner revokes it.
  - It sits in plaintext in the MCP client config (`~/.claude.json`).
  - The token cannot withdraw, move funds, change limits, mint tokens, or clear a Stop.
- **Stop blocks the agent through the worker's engine state.** With AM1 unfixed, the token itself stays valid for reads until a re-sign or revoke. Losing `engine-state.json` would also lose the Stop.
- **Idempotency lives in memory.** After a worker restart, a retried request is a new order. The persisted daily order count still bounds this.
- **The agent's `reason` is untrusted text.** It is shown to the owner as plain text; treat it like a message from a stranger.
- **Agent mode is not measured in TEE mode yet.** The `TRADING_AGENT_*` values must be pinned in the measured compose before a TEE deployment.

## Fixes (2026-11-03)

Commits on `feat/kit-foundation`: `bc122bc` (worker), `7eb8367` (mcp), `d39719a` (dashboard), `1827d97` (docs).
Checks after the fixes: worker 1072 passed (0 expected-fail: the two `it.fails` token-recheck tests are now normal passing
tests), mcp 42 passed, dashboard 498 passed; `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green in all three.
DSL behaviour is unchanged with the flag off: v2 message bytes, hashes and vectors are untouched, and the existing DSL tests pass.

| Finding | Status | Commit | What changed |
|---|---|---|---|
| AM1 Stop does not kill the token | fixed | `bc122bc` | `kill()` / `killBot()` revoke the token of every stopped agent bot right after the synchronous halt (best effort, logged as "agent token revoked by the Stop" or "… FAILED"; the halt never depends on it). Test: Stop (bot / all) → delete `engine-state.json` → reopen → old token 401, no HL order. Also the `engine-state.json is unreadable` text now says "revoke every agent token first". Option 3 (STATE_CORRUPT when a bot has no state block) not done: with the token revoked, a lost state file no longer revives the agent. |
| AM2 runbook / drills | fixed (docs); drills **still not run** | `1827d97` | Runbook env block has the four `TRADING_AGENT_*` session values, step 12b (HYPE/USDC mandate 12/12/2/2, Claude Code over MCP), teardown 15.00 (Disconnect, archive, `claude mcp remove`, check `~/.claude.json`). Drill table: rows 4 and 6 updated, row 9 added for AM1. Rows 1-9 must still be run on HL testnet before the mainnet session. |
| AL1 redirect with the bearer token | fixed | `7eb8367` | `fetch(..., { redirect: "error" })`; test with a real loopback 302: the target never sees the request. |
| AL2 retry with unknown outcome | fixed | `bc122bc`, `7eb8367` | Worker: a same-key same-body request while the first runs waits for its answer and replays it (no 409). MCP: `idempotency_key` in every place_order result and error; the model may pass its own; client timeout 300 s (worst case 2 ticks × ~10 calls × 15 s). A restart still loses the cache (documented limitation). |
| AL3 revoke / re-sign does not cancel a waiting request | fixed | `bc122bc` | `agentOrder(botId, tokenId, …)` re-checks the registry token id and expiry before the pre-check and right after the slot wait → 401, nothing runs, nothing cached. |
| AL4 pair checks after per-pair work | fixed | `bc122bc` | For `source: "agent"`, `PAIR_NOT_ALLOWED` / `PAIR_NOT_IN_RULES` come first (same text as `checkOrder`), no HL read. DSL path unchanged. Demo uses an OFF-mandate pair (PURR on a HYPE mandate). |
| AL5 bot name as a text channel | fixed | `bc122bc` | `AgentState.bot.name` goes through the note sanitiser and is cut to 60 code points. |
| AL6 token hygiene outside the worker | fixed (docs) | `1827d97` | Leading-space `claude mcp add`, `chmod 600 ~/.claude.json`, never record the Connect step / terminal, `claude mcp remove` + grep at teardown. The token still sits in `~/.claude.json` while connected (accepted, known limitation). |
| AL7 error text without the public scrub | fixed | `bc122bc` | `responseMessage` (all agent text, incl. `HL_REJECTED` and engine refusals) removes URLs and query strings. |
| AL8 transient refusal cached 24 h | fixed | `bc122bc` | `rejected` with `final: false` is not cached; the same key after `retry_after_s` runs again. |
| AL9 body read before limit | fixed | `bc122bc` | The order route reads the body through a bounded stream reader (cut at 2 KB, 413), after the IP limiter. |
| Info: agent ticks can delay a DSL tick | accepted | — | Monitoring runs in every agent tick; safety unchanged; bounded by the agent interval. |
| Review M1 / L4 / L5 no clean outcome after placement | fixed | `bc122bc`, `d39719a` | Final code `OUTCOME_UNKNOWN` ("call trading_get_state before anything else") when the write-ahead succeeded but no clean outcome came back: the order call threw (non-`ApiRequestError`, timeout), a throw later in the tick or service, or a throw at the route. Never a transient code. In the ADR table and dashboard labels (en/ru/uk). |
| Review M2 token re-check after the wait | fixed | `bc122bc` | Same as AL3. |
| Review M3 idempotency in flight | fixed | `bc122bc` | Same as AL2 (pending entry `{body, promise}` at `begin()`). |

Known limitations, updated: "Stop blocks the agent through the worker's engine state" no longer holds; a Stop revokes the token
in `bots.json`, and the halt remains the second barrier if that write fails.
