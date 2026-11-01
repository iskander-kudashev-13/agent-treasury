<!-- From the design package design-kit/agent-treasury-design/specs/ (2026-11-01). Contract-side refinements: docs/adr/0003, 0004 (the vault has no vault-level approval_threshold/per_tx_limit/allowlist: they live in mandates). -->

# Agent Treasury — Design: agents & mandates

Design spec for the dashboard parts of the agent feature. Read `UI_PLAN.md` (stack, tokens, base screens) and `AGENT_ACCESS.md` (data model, contract methods) first. This file defines new screens, changes to existing ones, components, copy and states. Visual tokens are the ones from `UI_PLAN.md` §8; nothing here introduces new colors except where stated.

## 1. Design goals

1. **One glance per agent.** For every agent the owner sees: who it is, how much it may still spend today, whether it's trusted (TEE) or key-based, and a stop button.
2. **Mandate reads like a sentence.** Limits are shown as "Can spend up to 200 USDC per day, 50 per payment, only on Base and Solana, to any address. Payments above 30 need your approval." Form fields exist, but the summary sentence is always visible.
3. **Refusals are visible, not scary.** A rejected request is normal operation and proof the system works. Show it in neutral grey with the reason, not red.
4. **Trust level is explicit.** TEE agents get a green shield + code hash; key agents a grey key icon + public key. No ambiguous "verified" labels.
5. **Secrets shown once.** Private keys appear exactly once, with copy + download and a clear warning, then never again.

## 2. Navigation change

Top-level nav (left side of TopBar on desktop, bottom tabs on mobile):

```
Treasury · Agents · Recipients · Payouts · Policy
```

`Agents` is new and sits second, because it's the core of the product story.

## 3. Screens

### 3.1 Agents list (`/agents`)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Agents                                                [+ Add agent]  │
├──────────────────────────────────────────────────────────────────────┤
│ 🛡 payroll            TEE · verified 7f3a…c21            ● Active    │
│   Pays 5 fixed recipients monthly                                    │
│   Today  ▓▓▓▓▓▓░░░░  1,200 / 2,000 USDC        last request 12m ago  │
│                                              [Pause]  [Open →]       │
├──────────────────────────────────────────────────────────────────────┤
│ 🔑 procurement        Key · ed25519:9Hk2…pQ            ● Active      │
│   Any address on Base, Solana · up to 50 per payment                 │
│   Today  ▓▓░░░░░░░░    150 / 200 USDC          last request 2m ago   │
│   ⚠ 1 payment waiting for approval                                   │
│                                              [Pause]  [Open →]       │
├──────────────────────────────────────────────────────────────────────┤
│ 🔑 old-bot            Key · ed25519:3Fa1…Lm            ○ Revoked     │
│   Revoked 3 days ago                                     [Open →]    │
└──────────────────────────────────────────────────────────────────────┘
```

Row anatomy (`AgentRow`):
- Icon: shield (TEE) or key (Key). Shield is green only when the code hash is approved and the agent is registered; otherwise amber with "not registered".
- Name (bold) + id (mono, muted) if they differ.
- Trust line: `TEE · verified <hash short>` or `TEE · waiting for registration` or `Key · <pubkey short>`.
- Status pill: Active (green dot), Paused (amber dot), Revoked (grey hollow dot), Expired (grey).
- One-line mandate summary (generated, see §5).
- Today's spend bar (agent's own limit), same component as the vault policy bar.
- Inline badges: pending approvals count, rejections today count (grey).
- Actions: Pause/Resume (secondary), Open (link). Revoked rows are dimmed and sorted to the bottom.

Empty state: illustration-free card: "No agents yet. Connect your first agent — it will only be able to spend within the limits you set." + primary `Add agent`.

### 3.2 Add agent wizard (`/agents/new`, full-page on mobile, large modal on desktop)

Four steps with a stepper at top. Back/Next at bottom, Next disabled until valid.

**Step 1 — Type**

Two large selectable cards:

| Card | Title | Body | Badge |
|------|-------|------|-------|
| TEE | Verified agent | Runs in a secure enclave. The vault checks its code fingerprint before it can pay. Best for agents you run long-term. | Highest trust |
| Key | Connected agent | Any agent — Claude, IronClaw, your own script. Gets a key that can only ask this vault for payments. Set up in 2 minutes. | Fastest |

Below: name field (2–32 chars) and id slug (auto from name, editable, `[a-z0-9-]`).

**Step 2 — Identity**

- TEE: code hash field (mono, paste) + "Is this hash approved?" live check against `get_approved_codehashes`; if not approved, checkbox "Also approve this code hash" (adds `approve_codehash` to the batch). NEAR account field for the agent's worker account.
- Key: radio
  - "Create a new agent account for me" (default) → shows the account that will be created: `procurement.<vault>` (editable prefix), note "~0.1 NEAR for storage, ~0.25 NEAR gas allowance".
  - "Use an existing account" → account field + public key field.

**Step 3 — Mandate**

Left: form. Right (desktop) / top (mobile): **live sentence preview** (§5) inside a card titled "This agent will be able to…".

Fields:
- Daily limit (USDC) — number, required
- Per payment limit (USDC) — number, required, ≤ daily
- Needs my approval above (USDC) — number, ≤ per payment; helper "Payments above this wait for you in the dashboard."
- Chains — multi-select chips: Base, Ethereum, Arbitrum, Solana, Tron, NEAR
- Who can it pay — segmented control:
  - `Only fixed recipients` → pick from vault recipients (checkbox list)
  - `Only these addresses` → editable list of chain + address + label rows
  - `Any address` → amber helper: "The agent can pay anyone on the selected chains, within the limits above."
- Expires — none / 7 days / 30 days / custom date

Validation errors inline, under the field, plain words ("Per payment limit can't be higher than the daily limit").

**Step 4 — Review & sign**

- Full sentence summary (big), trust line, account, list of transactions the wallet will be asked to sign (each with a one-line plain description), e.g.:
  1. Create account `procurement.vault.near`
  2. Add a key that can only call `request_payment` on your vault
  3. Register agent `procurement` with this mandate
- Primary button: `Sign in wallet`. While signing: stepper shows per-transaction progress.

**Step 5 — Connect (Key agents only, after success)**

This is the "secret shown once" screen.

```
┌──────────────────────────────────────────────────────────────┐
│ ✓ Agent "procurement" is ready                               │
│                                                              │
│ ⚠ Save this key now. You won't see it again.                 │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ ed25519:4fG8…(full key, mono, blurred until hover)  [Copy]│ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│ Connect it:  [ Claude Code ] [ Claude Desktop ] [ .env ] [SDK]│
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ {                                                        │ │
│ │   "mcpServers": {                                        │ │
│ │     "agent-treasury": {                                  │ │
│ │       "command": "npx",                                  │ │
│ │       "args": ["agent-treasury-mcp"],                    │ │
│ │       "env": { "TREASURY_VAULT": "…", … }                │ │
│ │ …                                                  [Copy]│ │
│ └──────────────────────────────────────────────────────────┘ │
│ [Download .env]                         [ I saved it → Done ] │
└──────────────────────────────────────────────────────────────┘
```

- Key is blurred by default; hover/tap reveals.
- Tabs generate ready-to-paste config with the real values filled in.
- `Done` is disabled for 3 seconds and requires the checkbox "I saved the key" — prevents accidental loss.
- The key exists only in browser memory; navigating away clears it.

TEE agents skip this step and see instead: "Deploy your worker with this code hash. It will register itself automatically." + link to docs.

### 3.3 Agent detail (`/agents/:id`)

Header: icon, name, status pill, trust line, buttons `Pause`/`Resume`, overflow menu (`Edit mandate`, `Revoke`, `Copy MCP config` (without key), `Delete access key` for Key agents).

Tabs:

**Overview**
- Mandate sentence (big), `Edit` link.
- Three stat cards: Spent today (bar), Spent this week, Requests today (submitted / pending / rejected).
- Trust card: for TEE the code hash, approved-in-contract check, attestation link (reuses Attestation modal); for Key the public key, account, permitted methods (`request_payment`, `report_payout_status`), gas allowance left.

**Activity** — unified timeline of this agent's requests, newest first:

| Kind | Look |
|------|------|
| Submitted → Confirmed | green check, amount, → chain, address short, memo in muted italic, links |
| Pending approval | amber clock, inline `Approve` / `Reject` |
| Rejected | grey ⊘, reason code as small mono chip (`AGENT_DAILY_LIMIT_EXCEEDED`), `detail` sentence below |
| Failed / Refunded | red x / grey ↺, reason |

Filter chips: All · Paid · Pending · Rejected.

**Mandate** — the same form as wizard step 3, prefilled; Save → `update_mandate`. Shows a diff summary before signing: "Daily limit 200 → 500 USDC".

### 3.4 Revoke flow

Confirm modal, red primary button, explicit text:
"Revoke procurement? It will never be able to request payments again. Pending approvals from this agent will be rejected. This can't be undone."
For Key agents, a second checkbox (checked by default): "Also delete its access key from `procurement.vault.near`" → second transaction.

## 4. Changes to existing screens

- **Treasury → Agent card** becomes **Agents summary card**: up to 3 agents as compact rows (icon, name, today bar, status dot) + "View all". The large global `Pause all agents` button stays here (maps to global `pause()`).
- **Payouts feed and history**: new first column "Agent" with icon + name. Filter by agent.
- **Approval banner**: each row shows the requesting agent and its memo: "procurement · 150 USDC → Base · 'Logo redesign invoice #42'".
- **Payout detail timeline**, step 1: "Requested by procurement (key agent)" + memo.
- **Policy page**: global vault daily limit gets a helper: "Applies on top of every agent's own limit."
- **Recipients page**: column "Used by agents" showing which Fixed mandates reference each recipient.

## 5. Mandate sentence generator

Pure function `describeMandate(mandate, recipientsById) → string`, used in list rows (short) and detail/wizard (long).

Long form template:
> Can spend up to **{daily} USDC per day**, **{per_tx} per payment**, on **{chains joined with ", " and "and"}**, {recipients clause}. Payments above **{threshold} USDC** need your approval.{expiry clause}

Recipients clause:
- Fixed: "only to {n} fixed recipients ({first two names}{, and N more}) on their schedule"
- Allowlist: "only to {n} approved addresses"
- Open: "to any address"

Expiry clause: " Expires on {date}." or "" when none.

Short form (list row, ≤ 70 chars): "Any address on Base, Solana · up to 50 per payment" / "Pays 5 fixed recipients monthly" / "3 approved addresses · up to 100 per payment".

Unit-test the generator with each mode and with one/two/many chains.

## 6. Components (new)

```
agents/  AgentsList, AgentRow, AgentStatusPill, TrustBadge, AgentSpendBar,
         AddAgentWizard (Stepper, TypeStep, IdentityStep, MandateStep, ReviewStep, ConnectStep),
         MandateForm, MandateSentence, ChainChips, RecipientsModeControl, AllowlistEditor,
         AgentDetail (OverviewTab, ActivityTab, MandateTab), AgentActivityItem, ReasonChip,
         RevokeDialog, SecretField, ConfigSnippetTabs
lib/     describeMandate.ts, reasonCodes.ts (code → human title + icon), keygen.ts (browser-only ed25519 keypair)
hooks/   useAgents(), useAgent(id), useAgentBudget(id), useAgentActivity(id), useAgentActions()
```

`reasonCodes.ts` maps every code from `AGENT_ACCESS.md` §3.4 to a short human title, e.g. `AGENT_DAILY_LIMIT_EXCEEDED → "Over the agent's daily limit"`.

## 7. Visual specifics

- Trust icons: lucide `ShieldCheck` (TEE, green when verified, amber when waiting), `KeyRound` (Key, muted).
- Status pill: 8px dot + label, no filled backgrounds.
- Reason chip: mono 11px, border only, muted text — rejections must not look like errors.
- Secret field: mono, `filter: blur(4px)` until hover/focus, amber border.
- Wizard type cards: 1px border, selected state = green border + check icon top-right. No gradients.
- Mandate sentence: 18px, bold for numbers and chains, regular for glue words.
- Spend bar colors follow `UI_PLAN.md`: neutral fill < 80 %, amber 80–99 %, red at 100 %.

## 8. States and edge cases

- Agent has pending approvals but is paused: show both; approvals still actionable (re-checks run at approval).
- TEE agent added but worker never registered: amber shield, line "Waiting for the worker to register (no attestation yet)", help link.
- Key agent whose access key was deleted outside the dashboard: status line "Access key not found on account" (check via `view_access_key_list`), offer "Recreate key".
- Mandate edit that lowers daily limit below today's spend: allowed; bar shows over-limit red, helper "No more payments today".
- Global pause on: every agent row shows "Vault paused" instead of its own status; per-agent buttons disabled with tooltip.
- Wallet is not owner: all agent actions disabled; Connect step never shown.

## 9. Copy (use as-is)

- Add button: "Add agent"
- Empty: "No agents yet. Connect your first agent — it will only be able to spend within the limits you set."
- Key warning: "Save this key now. You won't see it again."
- Open mode helper: "The agent can pay anyone on the selected chains, within the limits above."
- Rejection title in activity: "Refused: {human reason}"
- Pause confirm: "Pause {name}? It can't request payments until you resume it. Other agents keep working."
- Global pause: "Pause all agents"

## 10. Build order

| Step | Deliverable | Accept when |
|------|-------------|-------------|
| D1 | Agents list + AgentRow + `describeMandate` (read-only) | Two agents from testnet contract render with correct sentences and bars |
| D2 | Agent detail: Overview + Activity (incl. rejections) | A rejection made via MCP appears with its reason chip within one poll |
| D3 | Add agent wizard for Key agents incl. keygen, account + function-call key creation, Connect step | A new key agent is created from the UI and the MCP server works with the shown config |
| D4 | Pause/Resume/Revoke per agent; feed/approval attribution; Treasury summary card | Pausing procurement leaves payroll paying; revoke deletes the key |
| D5 | TEE path in wizard; Mandate edit tab with diff | Payroll agent created via wizard registers itself from the worker |

D1–D4 are needed for the demo. D5 can be done by script instead of UI if time is short.

## 11. Demo framing for the video

- Start on `/agents` with both agents visible; this frame says "many agents, each with its own rules".
- Split screen during the procurement part: left Claude chat, right dashboard Activity tab of `procurement`.
- Make sure the rejection row is visible on screen when Claude explains the refusal.
