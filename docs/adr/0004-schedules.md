# ADR-0004: Schedules as their own entity; overdue rule; exact date semantics

## Date
2026-11-01

## Status
Accepted. Implements `UI_UPDATES.md` §3 on top of ADR-0003 (which stays valid unless changed here).

## Context
`UI_UPDATES.md` makes scheduled payments (owner decides who/when) and on-demand payments (agent decides within its mandate)
first-class. Amount and period move from `Recipient` to `Schedule`; a schedule names its executing agent. The contract,
the dashboard (`lib/frequency.ts`) and the assistant must compute **the same dates**, so the date rules are fixed here.

## Decisions

### 1. Data model
- `Recipient` = address book entry: `{ label, destination_chain, destination_asset, destination_address, created_at_ms, last_paid_at_ms }`.
  No amount, period, enabled flag. Remove is refused while any non-`Ended` schedule references it.
- `Schedule { id, recipient_id, amount, frequency, start_at, end, agent_id, status, last_paid_at, paid_count, created_at,
  next_due_at, open_payout, failed_attempts }`. `next_due_at` is the earliest **unpaid** occurrence (`None` once ended).
- `Payout.schedule_id: Option<ScheduleId>` replaces `recipient_id` as the link; `source` in the UI = `scheduled` if set,
  else `on demand`. `Payout.recipient_id` is kept (filled from the schedule) for the address book.
- Policy gains `overdue_grace_ms: U64` (default 3 days = 259 200 000).

### 2. Date semantics (UTC, ms) — identical in Rust and TypeScript
Let `tod = start_at mod DAY_MS` (time of day of `start_at`), `day(t) = floor(t / DAY_MS)` (days since 1970-01-01).
Occurrences are timestamps `D * DAY_MS + tod` for qualifying days `D`, and only those `>= start_at`:
- `Once` → exactly `[start_at]`.
- `Weekly { weekday }` → days with `weekday(D) == weekday`, where `weekday(D) = (D + 4) mod 7` and **0 = Sunday … 6 = Saturday**
  (JS `getUTCDay()` convention; 1970-01-01 was a Thursday = 4).
- `Monthly { day }` (1..=28) → the `day`-th of every month (civil calendar, proleptic Gregorian, UTC).
- `EveryNDays { n }` (1..=365) → `start_at + k * n * DAY_MS`, k ≥ 0.
- `end`: `Never`; `AfterCount { count }` (≥ 1) → at most `count` occurrences are paid; `On { at }` → only occurrences `<= at`.
Functions (both languages): `first_at_or_after(freq, start_at, t)`, `next_after(freq, start_at, t) = first_at_or_after(freq, start_at, t + 1)`,
`occurrences(freq, start_at, end, paid_count, from, to, max)`. Shared test vectors: `docs/frequency-vectors.json`.

### 3. Paying a schedule
`request_payment(chain, address, amount, memo?, schedule_id?, deposit_address, deposit_expires_at_ms?)` (`recipient_id`
argument replaced by `schedule_id`). Wrapper `request_payout(schedule_id, deposit_address, deposit_expires_at_ms?)` fills
chain/address/amount from the schedule and its recipient.

Check order (ADR-0003 numbering; scheduled-only steps marked S):
1–3 as before (pause, agent status, attestation, expiry, agent failures, request validity, deposit address) →
4 `CHAIN_NOT_ALLOWED` →
5 recipient rule:
  - with `schedule_id`: S `SCHEDULE_NOT_FOUND`, S `SCHEDULE_NOT_ACTIVE` (Paused/Ended), S schedule's `agent_id` must be the caller's
    agent and chain/address must equal its recipient's → else `RECIPIENT_NOT_ALLOWED`; then the mandate must still allow
    the recipient (Fixed: recipient in `mandate.recipients`; Allowlist: destination in allowlist; Open: pass) → `RECIPIENT_NOT_ALLOWED`;
  - without `schedule_id`: Fixed → `RECIPIENT_NOT_ALLOWED` ("Fixed agents only pay their schedules"); Allowlist/Open as before →
6 S `AMOUNT_MISMATCH` (amount ≠ schedule.amount) →
7 S `NOT_DUE` (`next_due_at > now`), S `TOO_MANY_FAILED_TRANSFERS` (schedule), S `PAYOUT_IN_PROGRESS` (schedule has an open payout) →
`BELOW_MIN_PAYMENT` → 8 … 11 as before →
12 approval: if S `now > next_due_at + overdue_grace_ms` **or** `amount > approval_threshold` → `PendingApproval`
   (requires `deposit_expires_at_ms`), with a reason; else 13 reserve + transfer.

`PaymentResult::PendingApproval { payout_id, reason }` where `reason` ∈ `ABOVE_THRESHOLD` | `OVERDUE_NEEDS_APPROVAL`.

On reservation a scheduled payment pays occurrence `next_due_at`: `paid_count += 1`, `last_paid_at = now`,
`next_due_at = next occurrence after it` (respecting `end`, `None` → status `Ended`). The previous values are stored in the
payout and restored if the transfer fails. Missed occurrences are paid one by one (each overdue one needs approval).

### 4. Schedule validity
`add_schedule` / `update_schedule` (owner, 1 yocto) require: recipient exists; agent exists and is not revoked; the agent's
mandate allows the recipient (Fixed/Allowlist/Open rule above) and its chain; `min_payment <= amount <= per_tx_limit`;
valid frequency params and end; at least one occurrence. The same rules are re-checked at payment time (mandates change).
`update_schedule` rejects an open pending approval and recomputes `next_due_at` from `max(start_at, last_paid_at + 1)`.
`pause_schedule`, `end_schedule`: no deposit. `resume_schedule`: 1 yocto.

### 5. Views
- `get_schedules({ from_index?, limit?, agent_id?, recipient_id? })`, `get_schedule({ schedule_id })`
- `get_due({ now_ms?, agent_id? })` → schedules with `next_due_at <= now`, Active, no open payout, below failure cap, each with
  `overdue: bool`.
- `get_upcoming({ from_ms, to_ms, from_index?, limit? })` → `{ schedule_id, recipient_id, agent_id, amount, due_at, will_need_approval }[]`
  sorted by `due_at`; `will_need_approval` = amount above the agent's threshold or `due_at + grace < now`. Window ≤ 62 days,
  ≤ 62 occurrences per schedule, ≤ 500 items.
- `get_contract_info` adds `next_recipient_id`, `next_schedule_id` so the dashboard can batch `add_recipient` + `add_schedule`
  in one transaction (owner-only, so the predicted id cannot be raced by others).
- Bounds: ≤ 500 schedules per vault (view gas).

## Consequences
- Contract: new `frequency.rs`, schedule state/methods/views; recipients slimmed; tests rewritten for schedules.
- Worker (payroll): due list = `get_due({ agent_id })`; pays via `request_payout(schedule_id, …)`; handles `PendingApproval.reason`.
- SDK/MCP: `request_payment` arg rename (`schedule_id`), `PendingApproval.reason`; on-demand flow unchanged.
- Dashboard: Payments page, Upcoming block, `lib/frequency.ts` tested against `docs/frequency-vectors.json`.
- Assistant (worker `/ai/chat`): reads `get_schedules`, `get_upcoming`, proposes `add_schedule` etc.

## Amendments after code review (2026-11-01)
- `Schedule.last_occurrence_handled` = last occurrence paid **or skipped**; `update_schedule` recomputes `next_due_at`
  from `max(start_at, last_occurrence_handled + 1)` (supersedes "last_paid_at + 1" above), so rejected dates never come back
  and unpaid dates between a due date and a late payment are not lost. Also on Schedule: `last_occurrence_paid`; on Payout:
  `schedule_id`, `occurrence_at`, `approval_reason`, `prev_schedule` (snapshot restored on failure).
- `reject_payout(payout_id, skip?)`: default skips the date, **except** when the payout can no longer be approved
  (deposit deadline passed or > 72 h) — then the date stays payable and the agent requests it again with a fresh quote.
- For scheduled requests, `SCHEDULE_NOT_FOUND` and a removed recipient (`RECIPIENT_NOT_ALLOWED`) are checked right before
  step 4 (chain). Approval also requires the schedule's `open_payout` to be this payout and `occurrence_at == next_due_at`.
- `update_schedule` refuses `Ended` schedules (terminal). `remove_schedule` deletes an `Ended` schedule without open payout;
  `MAX_SCHEDULES` counts current schedules. `remove_recipient` is also refused while any of its schedules has an open payout.
- Pausing keeps the pending approval but it can only be approved after `resume_schedule`; dates missed while paused stay
  payable after resume (those past grace need approval).
- `get_due(now_ms?, agent_id?, from_index?, limit?)` skips schedules whose agent is not Active. `get_upcoming` merges
  per-schedule cursors (exact global order; ≤ 1000 date steps per schedule for `AfterCount`, direct jump otherwise).
- `overdue_grace_ms` ∈ [1 h, 30 days].
- Key agents (function-call key limited to `request_payment` + `report_payout_status`) pay schedules via
  `request_payment(..., schedule_id)`; `request_payout` is a convenience for the payroll worker.
- State layout changed: deploy fresh (nothing on-chain yet). From the first deployment on, `StorageKey` and state structs
  change only with an explicit `migrate`.

JSON examples: `"frequency": "Once"`, `{"Weekly":{"weekday":1}}`, `{"Monthly":{"day":1}}`, `{"EveryNDays":{"n":14}}`;
`"end": "Never"`, `{"AfterCount":{"count":6}}` (number), `{"On":{"at":"1798761600000"}}` (U64 string); `start_at` is a U64 string.
- (tests round) `add_schedule` computes the first date from `max(start_at, now)`: a new schedule never owes dates before
  its creation (a `Once` in the past is refused). `update_schedule` continues after
  `max(start_at, last_occurrence_handled + 1, last_paid_at + 1)` — rejected dates never return and a late payment followed
  by a date change cannot pay twice; if no date is left it is refused for an unpaid schedule and ends a paid one.
