# Prototype screens

| File | Route | Spec | What it shows | Try |
|---|---|---|---|---|
| `Main.dc.html` | `/` | UI_PLAN §5.1, UI_UPDATES §5 | Treasury: balance count-up, daily-limit ring, policy card, Upcoming (7/30 days) with daily-limit and funding warnings, agent card with TEE proof and route pulse, approval banner, payouts feed with source tags | Approve Maria → feed row Pending → Confirmed, ring turns amber; approve Studio Kite → "Blocked by policy"; Pause → confirm → red banner; switch Upcoming to 30 days → "short by …" |
| `PayoutDetail.dc.html` | `/payouts/:id` | UI_PLAN §5.5 | Six-step payout timeline that fills in sequence and ends "Money arrived" | Replay |
| `Mobile.dc.html` | `/` at 390 px | UI_PLAN §8 | Single column, sticky Pause button | — (static) |
| `Agents.dc.html` | `/agents` | DESIGN_AGENTS §3.1 | Agent rows: trust icon, mandate summary, spend bar, pending/refused badges, status pill; revoked dimmed at bottom | Pause / Resume a row; Open → procurement; Add agent → wizard |
| `AddAgent.dc.html` | `/agents/new` | DESIGN_AGENTS §3.2 | 5-step wizard: type cards, identity (key account or TEE hash check), mandate form with live sentence, review with per-tx signing progress, Connect screen with blurred key and config tabs | Change limits and watch the sentence; set per-payment > daily to see validation; sign; Done unlocks after 3 s + checkbox |
| `AgentDetail.dc.html` | `/agents/:id` | DESIGN_AGENTS §3.3–3.4 | Overview stats + trust card; Activity with paid / pending / refused (reason chips); Mandate tab with diff; Revoke dialog | Simulate request from Claude; Approve/Reject inline; edit daily limit → diff; Revoke |
| `Payments.dc.html` | `/payments` | UI_UPDATES §4 | Scheduled tab (frequency text, next date, overdue → Approve, progress, status) and Recipients tab (remove blocked while schedules active); schedule drawer with frequency control, live next-3-dates preview and mandate checks | New schedule: try amount 2,500 (red), 1,500 (amber), payroll + new recipient via `+` (red → "Also add to mandate"), procurement + Tron (red) |
| `Assistant.dc.html` | any + panel | UI_UPDATES §6, §9 | Chat panel with suggestions, streaming replies, proposal cards (draft → queued → signed), follow-up question chips, batch bar, review & sign, data answer, emergency pause | Run the demo: "Pay Maria…" → Yes → queue 3 cards → Review & sign → Maria appears on the left; then "What do we pay this week?" |

Assistant replies in the prototype are scripted by keyword; the real panel streams from `POST /ai/chat`.
