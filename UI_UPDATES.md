<!-- Provided by the project owner on 2026-11-01. Contract-side refinements and exact interface: docs/adr/0004-schedules.md. -->

# Agent Treasury — UI updates (schedules, Payments page, AI assistant)

Read after `UI_PLAN.md` and `DESIGN_AGENTS.md`. This file records product decisions made after those were written. **Where this file conflicts with `UI_PLAN.md` or `DESIGN_AGENTS.md`, this file wins.** Visual tokens, stack and conventions stay as in `UI_PLAN.md`.

Summary of changes:
1. Two payment modes are first-class: **scheduled** (owner decides who/when) and **on-demand** (agent decides within its mandate).
2. `/recipients` becomes **`/payments`** with tabs **Scheduled** and **Recipients**. Schedules are their own entity, assigned to an agent.
3. Treasury home gets an **Upcoming payments** block with a funding warning.
4. Overdue scheduled payments beyond a grace period require owner approval.
5. A chat **AI assistant** (NEAR AI Cloud) configures everything through proposal cards the owner signs. It replaces the "Describe in plain words" field from `UI_PLAN.md` §5.2.

---

## 1. Navigation (final)

```
Treasury · Agents · Payments · Payouts · Policy            [Assistant ✦]
```

- `Payments` replaces `Recipients`. Route `/recipients` redirects to `/payments?tab=recipients`.
- `Assistant` is a toggle button at the right of the TopBar that opens the chat panel (§6). Keyboard shortcut `/` focuses the chat input when the panel is open.
- Mobile: bottom tabs Treasury · Agents · Payments · Payouts; Policy moves into an overflow menu; Assistant is a floating button bottom-right.

## 2. Concepts the UI must reflect

| Concept | Owner sets | Who executes | Where in UI |
|---|---|---|---|
| Recipient | name, chain, address | — (address book only) | Payments → Recipients |
| Schedule | recipient, amount, frequency, start/end, executing agent | the assigned agent, when due | Payments → Scheduled |
| Mandate | limits, chains, who the agent may pay, approval threshold | — (rules) | Agents → agent → Mandate |
| On-demand payment | nothing per payment | agent decides | appears in Payouts feed and agent Activity |

Copy line used on the Payments page header: "Scheduled payments are paid by the agent you assign, on the dates you set. Agents can also pay on demand within their mandate — see Agents."

## 3. Data model additions (coordinate with `/contract`)

UI depends on these; if missing, add them to the contract — do not emulate in the UI.

```
Schedule {
  id: ScheduleId,
  recipient_id: RecipientId,
  amount: U128,
  frequency: Once | Weekly { weekday: 0..6 } | Monthly { day: 1..28 } | EveryNDays { n: 1..365 },
  start_at: u64,              // ms
  end: Never | AfterCount { count } | On { at: u64 },
  agent_id: AgentId,          // executing agent; its mandate must allow this recipient and amount
  status: Active | Paused | Ended,
  last_paid_at: Option<u64>,
  paid_count: u32,
  created_at: u64,
}
```

Views: `get_schedules()`, `get_schedule(id)`, `get_upcoming(from_ms, to_ms)` → `{ schedule_id, recipient_id, agent_id, amount, due_at, will_need_approval: bool }[]`, `get_due(now_ms)`.
Owner calls: `add_schedule`, `update_schedule`, `pause_schedule`, `resume_schedule`, `end_schedule`.
Policy addition: `overdue_grace_ms` (default 3 days). A due payment older than the grace period is not auto-paid: `request_payment` returns `OVERDUE_NEEDS_APPROVAL` and the payout is stored as pending approval.
`Recipient` no longer carries amount/period; those live on `Schedule`. A recipient can have several schedules.

Validation rule shown in UI and enforced in contract: a schedule is valid only if the assigned agent's mandate allows its recipient (Fixed mode: recipient included; Allowlist: destination included; Open: chain allowed), its chain, and `amount <= per_tx_limit`.

## 4. Payments page (`/payments`)

### 4.1 Tab: Scheduled (default)

Table, one row per schedule:

| Column | Content |
|---|---|
| Recipient | name + chain badge |
| Amount | mono, USDC |
| Frequency | human text: "Monthly on the 1st", "Every Monday", "Every 14 days", "Once on 3 Dec" |
| Next payment | date + relative ("in 4 days"); "Overdue 5 days — needs approval" in amber when past grace |
| Paid by | agent icon + name |
| Progress | "3 of 6 paid" when `AfterCount`, otherwise "Paid 3 times" |
| Status | Active / Paused / Ended pill |
| Actions | Edit · Pause/Resume · End |

Filters: agent, status, chain. Sort by next payment (default).
Top-right buttons: `+ Scheduled payment` (primary), `Ask assistant` (secondary, opens chat prefilled with "Add a scheduled payment: ").

Empty state: "No scheduled payments yet. Set up salaries, subscriptions or regular supplier payments — the assigned agent will pay them on time." + both buttons.

### 4.2 Schedule form (drawer)

> **Update 2026-11-02 (owner feedback during the testnet run).** Two separate paths instead of "Once" being one of the
> frequencies: **Pay once** (recipient, amount, agent, *When*: **Now** = start 2 min after Save so it survives the wallet
> confirmation, or **Later** with quick picks "In 15 min / In 1 hour / Tomorrow 09:00" and an exact date/time) and
> **+ Recurring payment** (Monthly / Weekly / Every N days, first payment, Ends). Both still call `add_schedule`
> (`Once` vs recurring frequency); no contract change. Dates and times are entered in the owner's **local** time with
> "= HH:MM UTC" under the field; recurring days stay UTC days (ADR-0004), and the form says so when the local start
> falls on another UTC day. The Scheduled table gets a **Type** filter (One-time / Recurring). The mock below is the
> recurring form.

```
┌ New scheduled payment ───────────────────────────────┐
│ Recipient     [ Maria — Base, 0xAb…12        ▾ ] [+] │
│ Amount        [ 1 500 ] USDC                         │
│ Frequency     ( ) Once on [ date ]                   │
│               (•) Monthly on day [ 1 ]               │
│               ( ) Weekly on [ Mon ▾ ]                │
│               ( ) Every [ 14 ] days                  │
│ Starts        [ 1 Dec 2026 ]                         │
│ Ends          (•) Never ( ) After [ 6 ] payments     │
│               ( ) On [ date ]                        │
│ Paid by       [ payroll (TEE) ▾ ]                    │
│                                                      │
│ Next payments: 1 Dec · 1 Jan · 1 Feb                 │
│ ⚠ Above payroll's approval threshold (1 000):        │
│   each payment will wait for your approval.          │
│                          [ Cancel ] [ Save & sign ]  │
└──────────────────────────────────────────────────────┘
```

Rules:
- `[+]` next to Recipient opens an inline mini-form (name, chain, address) and creates the recipient in the same signed batch.
- Monthly day limited to 1–28 (helper: "Use 28 for end-of-month").
- "Next payments" preview recalculates live (pure function `nextOccurrences(schedule, n=3)`; unit-test it).
- Mandate compatibility check against the selected agent, live, before Save:
  - red, blocks Save: "payroll can't pay this recipient (not in its mandate)" with link "Edit payroll's mandate"
  - red, blocks Save: "Amount exceeds payroll's per-payment limit (1 000)"
  - amber, allows Save: approval-threshold warning as shown
- Monthly total hint under amount: "≈ 1 500 USDC / month".

### 4.3 Tab: Recipients

Address book table: Name, Chain, Address (short + copy), Schedules (count, link filtered), Last paid, Actions (edit, remove). Remove is blocked while active schedules reference the recipient ("End its 2 schedules first").
Recipient drawer: name, chain, address with per-chain validation (unchanged from `UI_PLAN.md` §5.2 minus amount/period and minus the AI field).

## 5. Treasury home changes

### 5.1 Upcoming payments block (new, under the Policy card, full width on mobile)

```
┌ Upcoming · next 7 days ──────────────────── 4 300 USDC ┐
│ Mon 1 Dec   Maria    1 500 → Base     payroll   ⏳ approval │
│ Mon 1 Dec   Alex     2 000 → Solana   payroll            │
│ Wed 3 Dec   Hosting     40 → Base     ops-bot            │
│ …                                       [View schedule →]│
│ ⚠ Vault balance 3 100 USDC — short by 1 200 for these.   │
│   [Deposit]                                              │
└──────────────────────────────────────────────────────────┘
```

- Data: `get_upcoming(now, now + 7d)`.
- Funding warning appears when sum > balance; also when any single day's total > vault daily limit ("1 Dec exceeds the vault's daily limit; 500 will move to the next day").
- `⏳ approval` tag for items with `will_need_approval`.
- Range toggle: 7 days / 30 days.

### 5.2 Overdue

- Overdue items past grace appear in the existing Approval banner with an extra line: "Overdue since 1 Dec (agent was offline). Approve to pay now."
- Agent card shows "Missed 2 scheduled payments" when the executing agent was offline across a due date.

### 5.3 Payouts feed

Add a small source tag on each row: `scheduled` (calendar icon) or `on demand` (bolt icon). Filter in `/payouts` by source.

## 6. AI assistant

### 6.1 Purpose

Owner configures and queries the vault in plain language. The assistant **never changes anything by itself**: it reads state and produces **proposal cards**; the owner signs them with the wallet. Runs on NEAR AI Cloud (private inference in TEE) through the worker.

Supported in v1 (demo scope):
- Proposals: add recipient, add/update/pause/end schedule, update agent mandate limits, pause/resume agent, pause/resume vault.
- Questions: spending for a period (by agent/recipient), upcoming payments, will the balance cover the next N days, why a payment failed or was rejected, what an agent is allowed to do.
- Later (not v1): create new agents via chat, bulk import ("here's a list of 10 contractors").

### 6.2 Panel layout

Desktop: right-side panel 400px, pushes content (no overlay), resizable 360–560px, state remembered per browser (try/catch localStorage). Mobile: full-screen sheet.

```
┌ Assistant ✦  Private · NEAR AI Cloud (TEE)   [⟲] [×] ┐
│                                                     │
│ Suggestions (when empty):                           │
│  [Pay Maria 1500 monthly on Base]                   │
│  [What do we pay this week?]                        │
│  [Lower procurement's daily limit to 100]           │
│  [Why did Chen's payment fail?]                     │
│                                                     │
│ You: Add Maria, designer, 1500 USDC on the 1st      │
│      of every month, Base 0xAb12…, starting Dec.    │
│                                                     │
│ AI:  Here's what I prepared:                        │
│  ┌ New scheduled payment ─────────────── draft ┐   │
│  │ Maria · 1 500 USDC → Base 0xAb12…34         │   │
│  │ Monthly on the 1st · from 1 Dec · no end    │   │
│  │ Paid by payroll · next: 1 Dec, 1 Jan, 1 Feb │   │
│  │ ⚠ Above approval threshold (1 000)          │   │
│  │            [Edit in form] [Discard] [✓ Add]  │   │
│  └──────────────────────────────────────────────┘  │
│      Want me to raise payroll's approval            │
│      threshold to 2 000 so it goes out              │
│      automatically?                                 │
│                                                     │
├─────────────────────────────────────────────────────┤
│ 2 changes ready to sign          [Review & sign ▸]  │
├─────────────────────────────────────────────────────┤
│ [ Ask or describe a change…                    ⏎ ]  │
└─────────────────────────────────────────────────────┘
```

### 6.3 Proposal cards

- Card types map 1:1 to contract calls: `AddRecipient`, `AddSchedule`, `UpdateSchedule`, `PauseSchedule`, `EndSchedule`, `UpdateMandate`, `PauseAgent`, `ResumeAgent`, `PauseVault`, `ResumeVault`.
- Each card shows: title, human summary, for updates a **diff** ("Daily limit 200 → 100"), validation results (same checks as forms: address format, mandate compatibility, limits), and buttons:
  - `✓ Add to batch` (card becomes "Queued", green outline)
  - `Edit in form` (opens the corresponding drawer prefilled; saving there replaces the card)
  - `Discard`
- Invalid cards (validation error) cannot be queued; the error is shown in red on the card and the assistant is told about it so it can ask a follow-up.
- **Batch bar** at the bottom of the panel: "N changes ready to sign → Review & sign". Review modal lists all queued cards in order with plain-language transaction descriptions, then signs them as one wallet request (multiple actions in one transaction where the wallet supports it; otherwise sequential with progress).
- After signing: cards turn "Signed ✓" with tx link; the assistant posts a one-line confirmation.
- Emergency shortcut: if the user's message is a pause request ("stop everything", "pause procurement"), the card has a red primary `Pause now` that signs immediately (single action, no batch).

### 6.4 Answers to questions

- Short text answer first, then optional compact visuals inside the message: mini table (max 5 rows), a single number with a delta, or a list of upcoming items. No charts in v1.
- Every number links to its source view (e.g. "4 300 USDC upcoming" → opens Upcoming 7-day list).
- When unsure or data missing: "I don't see a payment to Chen this month" — never invent.

### 6.5 Clarifying questions

If a required field is missing or ambiguous (chain, address, which agent pays, day of month), the assistant asks one question at a time with quick-reply chips, e.g. "Which chain is Maria's wallet on?" `[Base] [Solana] [Tron] [Ethereum]`. Address mismatch with chain is reported before any card is produced.

### 6.6 Trust and safety cues (visible in UI)

- Panel header badge: "Private · NEAR AI Cloud (TEE)" with tooltip: "Your prompts and vault data are processed inside a secure enclave; the model provider and NEAR can't read them." Click opens the same Attestation-style modal showing the model and attestation status returned by the worker.
- Footer microcopy under input: "The assistant only prepares changes. Nothing happens until you sign."
- Recipient names and payment memos rendered in proposals are plain text; if the assistant's output references an instruction found inside data, the UI does not act on it (it can only render cards from the typed proposal schema).

### 6.7 Backend contract for the panel (worker)

`POST {WORKER_URL}/ai/chat` (streaming, SSE) with `{ conversation_id, messages: [{ role, content }], vault, owner_account }` → stream of events:
- `{ type: "text", delta }`
- `{ type: "proposal", proposal: Proposal }` — typed JSON, validated server-side against the contract state before emitting
- `{ type: "question", text, options?: string[] }`
- `{ type: "data", kind: "table" | "number" | "upcoming", payload }`
- `{ type: "done" }` / `{ type: "error", message }`

Model tools inside the worker: read-only views (balance, policy, agents, mandates, recipients, schedules, upcoming, payouts, rejections) and `propose_*` tools that only return proposals. No tool can sign or call contract change methods. NEAR AI key lives in the worker env.

Conversation history kept in the browser for the session (state variable; optional try/catch localStorage for the last conversation). Nothing is stored server-side beyond the request.

## 7. Components (new or changed)

```
payments/   PaymentsPage (tabs), SchedulesTable, ScheduleDrawer, FrequencyControl, NextPaymentsPreview,
            MandateCompatibility, RecipientsTable (moved), RecipientDrawer (no amount/period, no AI field)
treasury/   UpcomingPayments, FundingWarning, SourceTag
assistant/  AssistantPanel, AssistantToggle, MessageList, MessageText, ProposalCard, ProposalDiff,
            QuestionChips, DataTable, DataNumber, UpcomingList, BatchBar, ReviewSignModal, PrivacyBadge
lib/        frequency.ts (nextOccurrences, describeFrequency), proposals.ts (Proposal types → contract actions),
            assistantClient.ts (SSE client)
hooks/      useSchedules(), useUpcoming(range), useAssistant(), useProposalBatch()
```

Removed: `recipients/AiAssistField` (superseded by the assistant).

## 8. Build order (replaces UI_PLAN.md §10 from U3 on)

| Step | Deliverable | Accept when |
|---|---|---|
| U0–U2 | As in `UI_PLAN.md` | — |
| U3 | Payments page: Scheduled + Recipients tabs, ScheduleDrawer with frequency, preview and mandate check | A schedule created in UI is paid by the assigned agent on its due date (test with "Once" a few minutes ahead) |
| U4 | Approval banner incl. overdue; Deposit/Withdraw; UpcomingPayments with funding warning | Short balance shows the warning; overdue item can be approved |
| D1–D4 | Agents per `DESIGN_AGENTS.md` | — |
| U5 | Assistant panel: chat, streaming text, questions, data answers (read-only) | "What do we pay this week?" returns the correct list |
| U6 | Proposal cards + batch signing for AddRecipient, AddSchedule, UpdateMandate, Pause/Resume | One message creates recipient + schedule, signed in one review |
| U7 | Policy page, Attestation modal, Payouts history with source filter, mobile pass | As in `UI_PLAN.md` U5–U6 |

Cut list if late: EveryNDays and End-on-date options (keep Once, Weekly, Monthly; Never/AfterCount), DataTable answers (text only), assistant resizable panel, mobile assistant sheet.

## 9. Demo script changes

Insert after showing the Treasury screen (≈ 25 s):
1. Open Assistant. Type: "Add Maria, designer, 1500 USDC on the 1st of every month on Base 0x…, paid by payroll."
2. Card appears with next dates and the approval warning; assistant offers to raise the threshold; reply "yes".
3. "Review & sign" → one wallet confirmation → Payments → Scheduled shows Maria; Upcoming block updates.
4. Ask: "What do we pay this week, and do we have enough?" → short answer with the funding status.

For the live payout part of the video, use a `Once` schedule set a few minutes ahead so the agent pays on camera.
