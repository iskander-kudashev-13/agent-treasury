# Security audit addendum: multi-strategy trading (ADR-0006), pre-mainnet (2026-11-03)

Auditor: `security-auditor` agent, `near-contract-audit` skill. This is an addendum to
[`audit-2026-11-03-trading.md`](audit-2026-11-03-trading.md). It covers what changed with commits `8af67f7` (several bots on
one HL account) and `ae64345` (the rules card makes the owner pick "update" or "new"). Read-only: nothing was deployed, signed
or sent. No repo code was changed.

## Scope

- Worker:
  - `worker/src/trading/{bots,confirm,store,service,route,index}.ts`
  - `engine/{tick,risk,state,migrate}.ts`
  - `rules/canonical.ts`
  - `worker/src/ai/{trading,chat,route,prompt,proposals}.ts`
  - `config.ts` (`TRADING_MAX_BOTS`, `HOST`)
- Dashboard:
  - `lib/tradingClient.ts` (`confirmTradingRules` v2)
  - `features/assistant/{botTarget.ts,ProposalCardView.tsx}`
  - `features/trading/{KillSwitch,bot/BotManage,bot/StopButton}.tsx`
  - `lib/tradingBots.ts`
  - `features/trading/SetupCard.tsx` (re-check of M6)
- Docs:
  - ADR-0005: review, re-review, volume-gate and accounting sections;
  - ADR-0006: including the owner defaults;
  - the previous audit;
  - `docs/commands.md` "[MAINNET] Trading session runbook";
  - README "What the vault does NOT protect".
- Secrets at rest: `.env*` modes and ignore status; `.gitignore` coverage of `TRADING_STATE_DIR` values used in the docs.
  Names only; no values were read.

Evidence:
- `pnpm exec vitest run test/trading`: 37 files, 801 tests, green.
- Scratch tests outside the repo:
  `/private/tmp/claude-501/-Users-iskander-faggod-Desktop-agent-treasury/acaebd01-7007-45e2-b1ee-672f52efb453/scratchpad/multibot/multibot.audit.test.ts`
  (config next to it). Both pass, which proves MM1 and MM2.
- `git check-ignore --no-index` on the documented state dirs (MH1).

Not checked:
- HL server behaviour. No new live calls were made. The live facts in the brief were taken as given.
- Dashboard pages outside trading and the assistant card.
- `cargo test`: the contract is unchanged by these commits.
- `pnpm audit`: needs network.

## Summary

The multi-bot engine keeps the account caps as account totals:
- `TRADING_HARD_*`;
- `MAX_ORDERS_PER_TICK` = 2;
- account orders per day;
- summed positive losses;
- `min(hard, Σ stops)` backstop.

So two bots cannot spend or lose more than one bot could, and the session worst case (about 26 USDC) is unchanged. Sell
capacity per bot comes from its own fills, and no bot can sell another bot's coins or coins held by hand. The registry fails
closed. Owner writes are blocked while the state is unusable, and kill still works then (halt marker).

The real problems are:
1. A secrets-hygiene gap in the runbook's state-dir name (MH1).
2. Two owner-intent races around confirm (MM1, MM2).
3. A runbook that was not updated for bots (MM3).

---

## Critical

None found.

## High

### MH1. The runbook's state dirs are not gitignored, so the HL API-wallet key can be committed to the public repo

**Where:**
- `.gitignore:30` ignores only `.trading/`.
- The runbook uses `TRADING_STATE_DIR=./.trading-mainnet` (`docs/commands.md` step 7).
- The testnet drills and README F2 use `./.trading-testnet`.
- `git check-ignore --no-index worker/.trading-mainnet/api-wallet.json` returns 1 (not ignored).
- `worker/.trading/api-wallet.json` returns 0 (ignored).

**Attack:** a routine `git add -A && git commit` before the submission or X post stages these files from
`worker/.trading-mainnet/`:
- `api-wallet.json` (the HL API-wallet private key, plain text);
- `rules/*.json` (owner signatures);
- `bots.json`;
- the fills journal;
- `log.jsonl`.

The repo must be public (hackathon rule). The `Dockerfile.worker.dockerignore` allow-list keeps the files out of the image,
but not out of git.

**Impact:** whoever reads the repo while the API wallet is still approved gets the full H2 power over the HL master: trading,
perps, wash trades, possibly `vaultTransfer`. That means the whole HL balance, up to about 26 USDC in the session.

**Fix:**
- In `.gitignore`, replace `.trading/` with `.trading*/`. Then check that
  `git check-ignore worker/.trading-mainnet/api-wallet.json worker/.trading-testnet/x` prints both.
- Alternative: keep the pattern and use `TRADING_STATE_DIR=./.trading/mainnet` in the runbook and README.
- Either way, the worker should warn at start when `TRADING_STATE_DIR` is inside a git work tree and not ignored. That check
  is a v2 code change.

## Medium

### MM1. A "new strategy" confirm can silently replace the rules of an existing bot (proved)

**Where:**
- `confirm.ts` `challenge()` computes `is_new`, but the pending entry does not store it.
- `confirm()` calls `registry.check()` again and treats an existing id as an update.
- The dashboard's `confirmTradingRules` checks `ch.bot_id` but never `ch.is_new`.
- `botTarget.ts` builds the new id from a cached bot list (`makeBotId(name, takenIds)`).
- When the chat had no target, the worker's `suggestId` runs once per card.

**Repro:** see the scratch test, case 1. Two challenges for a new id `dca` (two cards from the same name, or two tabs, or a
stale bot list) both say `is_new: true`. The first confirm creates `dca`. The second confirm, still marked "New strategy",
activates its hash on that same bot. Result: one bot, whose active hash is that of the second card.

**Impact:**
- This is the same class as the live testnet incident ("a plain chat replaced the default bot's rules"), only through a race.
- The owner signed both rule sets, and limits stay inside the account caps, so no extra money is at risk.
- But a running strategy is swapped without the owner meaning to, and its cooldowns reset (`firedAt = {}` on a new hash), so
  an interval rule can fire at once.
- The NEP-413 message has a `bot:` line but nothing that says "create".

**Fix:**
- Store `isNew` in the pending challenge.
- In `confirm()`, refuse with `409 BOT_ID_TAKEN` when the challenge was for a new bot and the id now exists. Refuse the reverse
  case too: a challenge for an existing bot whose id was archived meanwhile is already refused.
- In the dashboard, require `ch.is_new === (target.botName !== undefined)` before asking the wallet.
- Optional: add a `create: yes|no` line to the v2 message.

**Session workaround:** create bots one at a time. Reload `/trading/bots` after each confirm. Never keep two unsigned
"new" cards open.

### MM2. Kill-all does not invalidate open challenges; a confirm that lands after the kill resumes trading (proved)

**Where:**
- `service.ts` `kill()` bumps `killEpoch` and halts everything, but `RulesConfirmer.pending` (in memory, 5 min TTL) is not
  touched.
- `/rules/confirm` → `activated()` → `clearHalt()` clears the account halt and the bot's halt (ADR-0006 §4 "Clearing").

**Repro:** see the scratch test, case 2.
1. Bot `alpha` runs.
2. A challenge for "Alpha v2" is issued.
3. `kill()` is called; the status is `halted`.
4. The signed challenge is confirmed.
5. On the next tick the state is `running`.

**Impact:**
- The owner presses Stop while a card's wallet prompt is open, or a redirect wallet returns and posts the confirm later. The
  kill is then undone without a clear "resume" decision.
- Exposure is bounded by the account caps (the session: 2 orders/day of ≤ 12 USDC, loss stop 5).
- But a kill switch that a stale signature can undo breaks the "kill only restricts" rule the ADRs rely on.

**Fix:**
- `kill()` (and `killBot(id)` for that bot's challenges) drops every pending challenge issued before it. Alternative: the
  challenge records `killEpoch`/`botEpoch`, and `confirm()` refuses `409 KILLED_SINCE_CHALLENGE` when the epoch has changed.
- The dashboard closes or disables open TradingRules cards after a Stop.

**Session workaround:** after any Stop, discard open cards and do not sign. Restarting the worker also clears the pending
challenges.

### MM3. The [MAINNET] runbook and drills were not updated for bots

**Where:** `docs/commands.md` steps 7, 12, 13, 14 and the testnet drills table.

**Problems:**
1. `TRADING_MAX_BOTS` is not set, so the default of 3 applies. The session plans one or two bots.
2. Drill 3 says "Dashboard → Trading → Stop trading". With the bots UI, kill-all plus `pause_agent` lives only on
   `/trading/connect` (`Connect.tsx` → `KillSwitch`). The **Stop** button on a bot page (`StopButton` → `killBot`) stops that
   bot only: no `pause_agent`, and the other bot keeps trading and the top-ups stay allowed. An operator who presses the
   nearest Stop gets a partial stop.
3. Steps 12 and 13 check `active_rules.confirmed_by` and `active_rules.hash`. Those fields are filled only from a bot with the
   id `default`. On the fresh `./.trading-mainnet` dir, the first card gets a slug id (`resolveTarget` → `suggestId`), so
   `active_rules` stays `null` and the check reads as a failure.
4. The ADR-0005 drills table still says "not run yet" for every row, and the ADR-0006 test plan §11 (two bots ≥ 6 h,
   per-bot kill drill, `fills.jsonl` vs `userFillsByTime`) is not recorded. Live testnet buys and a sell did happen; the
   drills are not on record.

**Fix:**
- Step 7: `TRADING_MAX_BOTS=2` (or 1).
- Drill 3: "`/trading/connect` → Stop trading (kill all + `pause_agent`)". Add a separate per-bot drill: stop bot A; bot B
  keeps running; `openOrders` shows no A cloid.
- Steps 12 and 13: read `GET /trading/bots` with the owner session, or `/trading/bots/<id>`, for `state: running` and
  `rules.hash`. Check that the cloid prefix equals `0x` + `rules.hash[0..16]`.
- Fill in the Observed column of the drills from the testnet run, or write down why a drill was skipped.

### Carried over: M3 (loss stop depends on an unobserved ledger type) is still open

The procedure in runbook step 11 (top up first; confirm rules only when `net_funded_usdc` shows the delivered amount) stays
a blocker. Multi-bot does not change it: per-bot stops use fills, but the equity backstop uses the ledger flows.

## Low / hardening

- **ML1. A failed archive puts the bot back into trading.** `archive()` halts the bot first. On `TICK_BUSY`,
  `POSITION_UNKNOWN` or `BOT_HOLDS_POSITION` after the halt, `restore()` puts back the previous halt state, so a running bot
  runs again. That fails toward running. *Fix:* on refusal, keep the bot halted with a clear reason ("archive refused; sell or
  resume"), or tell the owner that it resumed.
- **ML2. A kill whose state write fails is lost on restart.** The halt marker is written only while the state is `fatal`. If
  `persistState()` fails for another reason (disk full, permissions), the kill reports `state_saved: failed`, and a restart
  after the disk recovers forgets the halt. *Fix:* also write `halt-marker.json` when `persistState()` returns false in
  `kill`/`killBot`.
- **ML3. The state dir is not bound to its network, account or vault.** `meta.json` records only `startMs`. If a testnet dir
  is reused for mainnet, the envelopes are refused (the message binds `hl_network`, `hl_account` and the vault), but the
  registry, the fill sums and the cursor carry over. Sells are still capped by the account's real free base. *Fix:* record
  `{hl_network, hl_account, vault}` in `meta.json` and refuse to start on a mismatch. For the session, use a fresh dir, as
  step 7 already says.
- **ML4. The DSL has no one-shot action.** "Sell half" became "sell 50% every hour". Each run sells 50% of the bot's own
  position, with an IOC at no worse than mid − 1%, inside the order and day caps, until the order falls below the 10 USDC
  minimum. The loss is bounded (spread plus fees), but the owner's intent was changed. *Fix:* add a prompt rule (if the owner
  asks for a one-time trade, say it is not supported and ask) and a warning on the card for repeating sells. v2: a `once`
  action. For the session, read the card's sentences, which the dashboard renders itself, before signing.
- **ML5. The card can label a new bot as "Update".** With no chat target on a fresh dir, the card offers
  "Update agent «<name>»" for an id that does not exist yet, and the confirm then creates it. It is cosmetic, but it adds to
  MM1. *Fix:* show "Update" only when `p.bot.is_new === false`.
- **ML6. Signed rule sets still never expire (previous L4, open).** Message v2 adds `bot:` but no time. Anyone who can
  write the state dir can point a bot back at an older envelope of the same bot. `verifyEnvelope` requires
  `env.bot_id === bot.id`, which blocks moving an envelope to another bot.
- **ML7. The API-wallet address check has no independent source.** The runbook's three-way compare (console line,
  dashboard card, `/trading/status`) reads from one worker process. It catches a wrong `VITE_WORKER_URL`, not a compromised
  host. That is accepted for local mode. Say so in step 9.
- **ML8. Rotation is not blocked while the state is unusable.** `rotateApiWallet` runs without `assertWritable`. It only
  reduces what the bot can do, but the old address stays approved on HL, so show "revoke 0x… on Hyperliquid" afterwards
  (previous M7 note).
- **ML9. `mcp/.env.claudeagent` is still on disk.** It is now mode 0600 and gitignored, which closes half of previous L7.
  Delete it after the test, as STATUS says.

## Checked and fine

**Fund-loss paths across bots**
- All account caps are totals. `checkOrder` checks the bot limits, then
  `account.{maxPosition, maxOrdersPerDay, ordersToday, positionValue, openBuyValue}`. `accountPosition` grows by every placed
  buy within the tick. `MAX_ORDERS_PER_TICK` is account-wide. `effectiveLimits` = min(hard, signed), so a bot cannot widen a
  cap.
- The account loss stop sums only positive bot losses, so one bot's profit never hides another's loss. The equity backstop
  is `min(hard, Σ active stops)`.
- Sells are capped at `min(account free base, bot position − bot open sells)`. An incomplete history gives
  `BOT_POSITION_UNKNOWN`, which fails closed. Hand-held coins belong to no bot.
- Orders whose prefix maps to no bot, to an archived bot, a halted bot or a superseded hash are cancelled each tick. Without
  the dead-man switch every resting bot order is cancelled, and only IOC orders go out (the volume gate is handled by
  `LIMIT_NEEDS_DEADMAN` in `checkOrder` and a second check before placing).
- Attribution: the permanent prefix map, `RULES_USED_BY_OTHER_BOT`, `CLOID_PREFIX_TAKEN` and `TOO_MANY_RULE_SETS`.
  `FILLS_NOT_ATTRIBUTED` blocks every bot. The check and save at confirm commit run synchronously after the only `await`, so
  two confirms for the same hash and different bots cannot both win.
- Write-ahead `beforeOrder` writes the journal, then the state, before any order.

**Migration (v1 → v2).** It is pure and idempotent:
- `engine-state.v1.json` and `active.v1.json` are kept;
- an unreadable state never triggers the registry migration;
- a state/registry mismatch is fatal;
- the base fee is estimated in the safe direction;
- the v1 message is accepted only for `legacy_v1.hash` of `default`.

On mainnet the dir is fresh, so this path does not run.

**NEP-413 v2**
- The message binds vault, agent, bot, HL network, HL account and hash. Recipient = vault.
- The nonce is bound to (hash, bot) and consumed before verification.
- The key must be a full-access key of the current owner.
- Every envelope is re-verified for its own bot on every tick.
- The dashboard computes the hash and the exact message itself and refuses on a bot, vault, agent, account or network
  mismatch before the wallet is asked.

**Owner writes while fatal.** Challenge, confirm, rename and archive are refused (`SERVICE_STATE_UNUSABLE` /
`STATE_CORRUPT`). Kill and per-bot kill still cancel on HL and record the halt in `halt-marker.json`, which the next readable
start applies before trading. While fatal, no tick trades.

**Kill paths**
- Kill-all and per-bot kill bump an epoch synchronously, `shouldStop` checks it before every `scheduleCancel` and order, and
  the in-flight tick is awaited (bounded).
- Per-bot kill cancels only that bot's prefixes. Kill-all cancels every spot order.
- `/kill` works when RPC is down (`safetyOnly`) and is not rate limited.
- The perp alarm re-halts everything on the next tick even after a confirm.

**AI prompt injection**
- The model cannot choose the target bot: the worker takes `trading_bot` from the request, the prompt says so, and the
  dashboard requires an explicit choice when there is no target.
- It cannot widen limits: `validate()` refuses anything above the hard limits, the engine takes the minimum again, and the
  DSL has no destination field.
- It has no trading read tools, so no HL data is injected into the prompt.
- Bot names are owner-set, cleaned of control characters and rendered by React. There is no `innerHTML` sink in the
  dashboard.

**Dashboard trust (previous M7)**
- `hl_account` is checked against the on-chain allowlist, `agent_id` must be `hl-trader`, and the vault id must match.
- A mainnet dashboard refuses an HL testnet worker.
- `extraAgents` is read from HL directly.
- Previous M6 is closed: on mainnet `SetupCard` shows only CLI commands.

**Secrets at rest.** `worker/.env` is 0600 and gitignored. The API-wallet file is 0600 in a 0700 dir and refused when loose.
`HOST` defaults to `127.0.0.1`. Public status text is scrubbed of URLs. No `.env`, API-wallet or `.trading*` path appears in
the git history. `lightweight-charts` 5.2.1 is pinned exact.

## Status of the previous audit's findings

| # | Status |
|---|---|
| H1 | Mitigated by config: `sdk/examples/mandate.hl-trader.session.json` has threshold 0, 25/25, 1/day, ≤ 48 h. The code fix is open |
| H2 | Open by design. Docs fixed. Session hygiene in the runbook |
| M1 | Fixed (`shouldStop`, kill epoch, bounded tick wait). Extended per bot |
| M2 | Fixed (`safetyOnly`) |
| M3 | **Open.** Runbook step 11 procedure |
| M4 | Runbook written, but see MM3 (multi-bot updates, drills not recorded) |
| M5 | Fixed (`lock.ts`) |
| M6 | Fixed (CLI on mainnet) |
| M7 | Fixed (see above). ML7 is the residual |
| L1 | Open. Manual `destinationAsset` check in runbook step 10 |
| L2 | Fixed (session mandate template ≤ 48 h) |
| L3 | Fixed. The engine now checks live 24 h volume (`PAIR_LOW_VOLUME`) |
| L4 | Open (= ML6) |
| L5 | Fixed (`HOST=127.0.0.1` default, `publicText`) |
| L6 | Not applicable if the vault is created with `requires_tee: true` (the runbook default). It applies if the owner chooses the shared payroll vault |
| L7 | Half fixed (= ML9) |
| L8, L9 | Runbook preconditions and one top-up per day |
| L10 | Fixed (README trading section) |

## Go / no-go for the tiny mainnet session

**Conditional GO**, with one or two bots, once these are done:
1. **MH1:** `.gitignore` covers the session state dir (`.trading*/`, or put the dir under `.trading/`). Verify it with
   `git check-ignore`. This is a one-line config change and needs the owner's OK.
2. **MM3:** runbook updated:
   - `TRADING_MAX_BOTS=2`;
   - the kill-all drill on `/trading/connect`, plus a per-bot stop drill;
   - steps 12 and 13 read `/trading/bots/<id>`;
   - the testnet drills table filled in, or the skip reasons written.
3. **MM1 / MM2:** either the small code fixes (store `isNew` and the kill epoch in the pending challenge, plus the dashboard
   `is_new` check), or the session procedure:
   - create bots one at a time and check the list after each;
   - after any Stop, discard open cards, do not sign, and restart the worker before resuming.
4. All conditions of the previous audit still hold:
   - vault ≤ 26 USDC;
   - `approval_threshold` 0, 25/day, 1 top-up/day, agent and API wallet ≤ 48 h;
   - hard limits position 25 / order 12 / loss 5 / orders 2;
   - a dedicated HL master;
   - one worker on localhost;
   - top up first and confirm rules only after `net_funded_usdc` shows the landing (M3);
   - revoke everything afterwards.

Worst case with these settings: about 26 USDC (the vault balance, which is the same money as the HL balance). More bots do
not raise it.

## Known limitations to add to the README

- **Bots are isolated from each other by our code, not by Hyperliquid.** All bots share one HL account and one API wallet.
  "Bot A never sells bot B's coins" is enforced by the worker (cloid prefixes, per-bot positions from fills), not by the
  exchange. A leaked API key ignores it (README item 2).
- **Stop on a bot page stops only that bot.** The account kill switch is on Connect Hyperliquid (kill all plus
  `pause_agent`).
- **A strategy can only run repeatedly.** The rules DSL has no one-time action, so a one-off order is expressed as a
  repeating rule.

## Fix status

Code fixes (worker and dashboard, tests added; the contract is untouched):

| # | Status |
|---|---|
| MM1 | Fixed. The pending challenge stores `isNew`; confirm refuses `409 BOT_ID_TAKEN` if the id exists now. The dashboard (`confirmTradingRules`, new `expectNew`) refuses before the wallet prompt unless `ch.is_new` matches the owner's choice |
| MM2 | Fixed. A challenge is bound to the kill stamp (kill-all epoch + the bot's epoch), taken before any await; confirm refuses `409 KILLED_SINCE_CHALLENGE` after a Stop. Open rule cards disable themselves after a Stop of everything or of their agent |
| ML1 | Fixed. A refused archive leaves the bot halted (`KILLED`, persisted) |
| ML2 | Fixed. If `persistState()` fails in `kill`/`killBot`, `halt-marker.json` is written too |
| ML5 | Fixed. "Update" is disabled and relabelled when the worker says the agent does not exist; a mismatch is also refused by the MM1 check |
| ML8 | Fixed. `rotateApiWallet` refuses with `STATE_CORRUPT` while the state is unusable |

Tests: `worker/test/trading/audit-multibot.test.ts`, `dashboard/src/lib/tradingClient.test.ts`. Still open: MH1 and MM3 (config and
runbook, not code), ML3, ML4, ML6, ML7, ML9.
