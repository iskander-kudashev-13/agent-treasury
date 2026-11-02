# Demo video script

Total about 3.5 min: payroll 2.5 min (main), grant milestones 30 s, hackathon prizes 30 s, close 10 s.
Theme: an organisation has to pay people on different chains; an agent does the paying, the vault sets the rules.

Markers: **[BUILT]** works today on testnet. **[MAINNET]** needs the mainnet demo vault and real 1Click with tiny
amounts (only after the human's explicit go-ahead). **[NOT BUILT]** feature does not exist yet; use the fallback or cut.

If the video is recorded on testnet, say on screen once: "Testnet. NEAR Intents has no testnet, so 1Click is simulated:
USDC moves on NEAR, nothing arrives on Base or Solana." Show the `SIMULATED 1CLICK` badge/log line.

## Setup before recording

- Vault funded (≥ 10 USDC), dashboard open on Treasury, owner wallet connected (Meteor Wallet).
- Recipients: Maria (base), Alex (sol), Kenji (arb), Priya (base). Payroll agent registered (TEE badge if M4 is done; otherwise the "LOCAL MODE - not TEE" badge stays visible, do not hide it).
- Key agent `procurement` (or `claudeagent`) with an Allowlist mandate: Alex + Priya, per-tx 3, approval above 2, 5 per day.
- Claude Code with the `agent-treasury` MCP server connected (`/mcp` shows it).
- Worker running with `LOOP_INTERVAL_MIN=1`, or ready to trigger `POST /run`.
- One crafted pending payout with a fake deposit address (see scene 6) prepared on the recording network.

## Part 1: Payroll (2:30)

**0:00–0:15 Problem.** Voice: "Our team is paid on Base, Solana and Arbitrum. We want an AI agent to run payroll. Give
it a private key and it can spend everything. Approve every payment by hand and it is not autonomous." Screen: title card.

**0:15–0:35 The vault.** [BUILT] Dashboard → Treasury: balance, vault daily limit, Agents card with Payroll and the key
agent. Voice: "The money sits in a NEAR contract. Each agent has a mandate: limits, chains, recipients. The contract
enforces it; the agent cannot change it."

**0:35–1:05 Scheduled payroll.** [BUILT] Payments → Recurring payment: Maria, 1 USDC, monthly (for the video: Pay once,
a minute ahead). Sign in wallet. Cut to the worker log / `#/payouts`: run picks it up → quote → `request_payout` → payout
`Sent` → `Confirmed`. Voice: "The payroll agent runs in a TEE. It can pay only the amount on the schedule, only when it
is due, only to that recipient."
[MAINNET] instead of `Confirmed (simulated)`, open the destination tx on Basescan.

**1:05–1:20 The contract says no to the payroll agent.** [BUILT] Try to add a schedule above the agent's per-payment
limit → wallet transaction fails: "Amount exceeds payroll's per-payment limit (10)". Voice: "Even the owner's schedule
cannot exceed the agent's mandate."

**1:20–1:40 A key agent in Claude Code.** [BUILT] Claude Code: "What's my treasury budget?" → `treasury_get_budget`.
"Pay Alex 1 USDC on Solana for the bug fix." → `treasury_request_payment` → `submitted`. Dashboard Payouts: new row
tagged with the agent and memo.

**1:40–2:00 Rejections.** [BUILT] "Pay Priya 4 USDC." → `rejected PER_TX_LIMIT_EXCEEDED`, Claude relays "Per-payment
limit for agent 'claudeagent' is 3 USDC; requested 4." and does not split the amount. "Pay 1 USDC to 0x…beef on Base." →
`rejected RECIPIENT_NOT_ALLOWED`. Dashboard → agent → Rejections log shows both. Voice: "These rejections come from the
contract, not from the prompt."

**2:00–2:15 Approval.** [BUILT] "Pay Priya 2.5 USDC." → `pending_approval` (above 2). Dashboard Payouts → payout →
quote check panel → Approve → wallet → `Confirmed`.
On testnet the panel says "Simulated 1Click — quote check skipped (testnet only)" and needs the acknowledgement tick;
on mainnet it shows the verified recipient, refund address and amount from 1Click.

**2:15–2:30 Fake deposit address → owner cannot approve.** [BUILT on the dashboard side] Open the prepared pending
payout whose deposit address is not a 1Click address. The panel shows "1Click has no quote for this deposit address.
The agent may have submitted an address that is not a real Intents deposit address. Do not approve." Approve stays
disabled; there is no override. Voice: "A compromised agent can label a payment 'Priya' and point the money somewhere
else. The dashboard asks NEAR Intents what that deposit address really pays, and blocks the approval."
How to prepare it: the key agent calls `request_payment` directly (near-cli-rs, signed with its function-call key)
for an allowlisted recipient, an amount above the approval threshold, `deposit_expires_at_ms` a few hours ahead and a
random 64-hex `deposit_address` (`openssl rand -hex 32`). Any address 1Click does not know works (for example `curl
"https://1click.chaindefuser.com/v0/status?depositAddress=<64 hex>"` → 404). On testnet the simulated-mode switch hides
this case, so record this scene with `VITE_ONECLICK_MODE` unset (the e2e run on 2026-11-02 showed exactly this block).

Optional, if time: owner clicks Pause on the key agent; next Claude request → `AGENT_PAUSED`; payroll keeps working.
[BUILT in the contract and UI; not yet run in the testnet e2e.]

## Part 2: Grant milestones (0:30)

Story: a foundation pays grantees per milestone, on their chain.
- [BUILT] fallback: each milestone is a `Once` schedule for the grantee (amount, date) executed by the payroll agent;
  an amount above the threshold, or a late milestone (overdue), lands in Payouts as "needs approval" and the owner approves.
  Screen: Payments with three milestone schedules; one overdue → `OVERDUE_NEEDS_APPROVAL`.
- [NOT BUILT] "AI checks the milestone submission and prepares the payout, human confirms". Possible with the existing
  assistant (`/ai`, NEAR AI Cloud) producing an `AddSchedule` proposal the owner signs, but milestone review is not
  implemented and the assistant has not been run against the live NEAR AI API.
Voice: "Same vault, same rules: money leaves only on the milestone date, and anything unusual waits for a human."

## Part 3: Hackathon prizes (0:30)

Story: an organiser pays winners on whatever chain each winner wants.
- [BUILT] fallback: add winners as recipients (chain + address) and one `Once` schedule each; the agent pays all of them
  in its next run. Screen: Payouts filling with rows on base / sol / arb.
- [NOT BUILT] "upload a table (place, amount, chain, address), sign once". No CSV import or batch transaction exists today;
  each recipient and schedule is one owner transaction.
Voice: "One treasury, winners on three chains, no bridges for anyone."

## Close (0:10)

"Give AI a wallet with rules it cannot break. Contract, worker, MCP server and dashboard are open source. Repo link and
testnet vault in the description." Show repo URL and `at-vault-11012309.testnet` (or the mainnet vault).

## X post checklist (from HACKATHON.md)

The human writes and posts it. It must say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon, and
attach the video. Lead with the problem, show one moment from action to result (the rejection or the blocked
approval), say what NEAR does (vault contract, function-call keys, Shade Agent, NEAR Intents), end with repo link and a
question.
