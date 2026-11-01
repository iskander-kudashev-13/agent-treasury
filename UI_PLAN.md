<!-- From the design package design-kit/agent-treasury-design/specs/ (2026-11-01). Contract-side refinements: docs/adr/0003, 0004 (the vault has no vault-level approval_threshold/per_tx_limit/allowlist: they live in mandates). -->

# Agent Treasury — Dashboard UI plan

Brief for the coding agent building `/dashboard`. Read `CLAUDE.md` first for the product and contract. This file defines what the dashboard is, every screen, every component, the data it reads and writes, and the order to build it in.

> **Superseded parts.** `DESIGN_AGENTS.md` adds the Agents section. `UI_UPDATES.md` replaces the Recipients page with Payments (schedules + recipients), adds Upcoming payments and the AI assistant, and replaces the build order from U3 on. Where they conflict with this file, they win.

## 1. Purpose and principles

The dashboard is the **owner's control panel** for a vault. In 10 seconds it must answer three questions:

1. How much money is in the vault and how much can the agent still spend today?
2. What has the agent done, and did the money arrive?
3. How do I stop it?

Principles:
- **Control-panel, not crypto-dashboard.** No token charts, no price tickers, no "connect to the future" copy. Think of a bank's internal admin tool.
- **Owner never gets lost.** Pause and Withdraw are always reachable; the agent can never disable them.
- **Proof is visible.** TEE code hash, approved hash in the contract, NEAR tx hashes and destination-chain explorer links are shown, not hidden behind "verified" badges without detail.
- **Plain words.** "Daily limit", "Waiting for your approval", "Money arrived on Base". Technical terms only in detail views.
- **Demo-first.** Every screen is built so the 3-minute demo video reads well: large numbers, clear status transitions, visible links.

## 2. Stack

- **Vite + React 18 SPA**, TypeScript, Tailwind CSS, React Router. Pure client-side app: no SSR, no server code in `/dashboard`. Wallet libraries are browser-only, so this avoids hydration and `window is not defined` problems.
- Any server-side logic (AI parsing with the NEAR AI Cloud key) lives in the **worker**, never in the dashboard. The browser must never see secret keys.
- Deploy as static files (Vercel or Netlify static build); `vite build` output in `/dashboard/dist`.
- `@near-wallet-selector/core` + modal UI, with at least `my-near-wallet` and `meteor-wallet` modules. Network from env (`VITE_NEAR_NETWORK` = `testnet` | `mainnet`).
- `near-api-js` for view calls via RPC (`VITE_NEAR_RPC`). If a wallet-selector or near-api-js package needs Node polyfills (`buffer`, `process`), add `vite-plugin-node-polyfills` rather than hand-rolled shims.
- Data fetching: TanStack Query, polling every 10 s for contract views and worker status.
- Charts: none in v1 (a single progress bar is CSS).
- Icons: lucide-react. Fonts: Inter for UI, JetBrains Mono for hashes, addresses and amounts.
- No component library beyond Tailwind; small hand-written primitives in `/dashboard/components/ui`.

Environment (`.env.example` in `/dashboard`):
```
VITE_NEAR_NETWORK=testnet
VITE_NEAR_RPC=https://rpc.testnet.near.org
VITE_VAULT_CONTRACT=vault.example.testnet
VITE_USDC_CONTRACT=<usdc nep-141 contract id for the network>
VITE_WORKER_URL=http://localhost:3000
VITE_AI_ENABLED=false
```

Everything prefixed `VITE_` is public and ends up in the browser bundle. Only public values go here.

The worker must send CORS headers allowing the dashboard origin (`http://localhost:5173` in dev, the deployed URL in prod).

## 3. Data sources

### 3.1 Contract views (read, no wallet needed)

| View | Used by |
|------|---------|
| `get_balance()` → U128 | Treasury card |
| `get_policy()` → `{ daily_limit, per_tx_limit, approval_threshold, allowlist_only, paused }` | Policy card, Pause button state |
| `get_spent_today()` → `{ spent: U128, day_index }` | Daily limit progress bar |
| `get_recipients()` → `Recipient[]` | Recipients table, Treasury "next payouts" |
| `get_due_recipients(now_ms)` → `RecipientId[]` | "Next run will pay N recipients" hint |
| `get_payouts(from_index, limit)` → `Payout[]` (newest first) | Payouts feed, payout detail |
| `get_pending_approvals()` → `Payout[]` | Approval banner |
| `get_agents()` → `{ account_id, codehash, registered_at }[]` | Agent card, Policy page |
| `get_approved_codehashes()` → `string[]` | Agent card verification |

If a view is missing in the contract, add it to the contract (coordinate with `/contract`), do not fake it in the UI.

### 3.2 Contract calls (write, wallet signature)

| Call | Screen |
|------|--------|
| `ft_transfer_call` on USDC contract with `receiver_id = vault`, `msg = ""` | Deposit modal |
| `pause()` / `resume()` | Pause button |
| `set_policy(policy)` | Policy editor |
| `add_recipient(...)`, `update_recipient(...)`, `remove_recipient(id)` | Recipients |
| `approve_payout(id)` / `reject_payout(id)` | Approval banner |
| `withdraw(amount, to)` | Withdraw modal |
| `approve_codehash(hash)` | Policy page → Agents section |

Every write: optimistic UI off; show a "Confirm in wallet" state, then refetch the affected queries on success, show a toast with the NEAR tx link on success or the error message on failure.

### 3.3 Worker API (read)

- `GET {WORKER_URL}/status` → `{ mode: "local" | "tee", running: boolean, last_run_at, next_run_at, codehash, attestation: { verified: boolean, quote?: string, report_url?: string }, agent_account_id, version }`
- `GET {WORKER_URL}/runs?limit=20` → `{ run_id, started_at, finished_at, paid: PayoutRef[], skipped: { recipient_id, reason }[], errors: string[] }[]`
- `POST {WORKER_URL}/ai/parse-recipient` (only when AI is enabled) → body `{ text: string }` → `{ name, amount_usdc, period, chain, address, confidence, notes? }`. The worker calls NEAR AI Cloud with its own key and returns a proposal only; it never writes to the contract.

If the worker is unreachable, the Agent card shows "Agent offline" with the last known time; the rest of the dashboard keeps working from the contract.

## 4. Information architecture

React Router routes:

```
/                 Treasury (home)
/recipients       Recipients list + add/edit
/policy           Policy editor + registered agents + code hashes
/payouts          Full payouts history (table with filters)
/payouts/:id      Payout detail (timeline)   — can be a modal over the feed
```

Static hosting needs an SPA fallback (all paths → `index.html`): add `vercel.json` rewrites or Netlify `_redirects`.

Top bar on every page: product name, vault contract id (copyable), network badge (testnet/mainnet), wallet button. A thin red bar under the top bar when `paused = true`: "Agent paused — no payments will be made until you resume."

## 5. Screens

### 5.1 Treasury (`/`)

Layout: two columns on desktop (≥1024px), stacked on mobile.

**Left column**
- **Treasury card**: large balance in USDC (mono, 40px), "Available to agent today: X of Y" where X = daily_limit − spent_today, buttons `Deposit` and `Withdraw` (secondary).
- **Policy card**: daily limit progress bar (spent / limit, turns amber at 80 %, red at 100 %), per-payment limit, approval threshold, `allowlist_only` chip, `Edit policy` link to `/policy`.

**Right column**
- **Agent card**:
  - status dot + text: `Running in TEE` (green) / `Running locally (dev)` (amber) / `Offline` (grey)
  - code hash (short, mono, copy button) + verification line: `✓ matches approved hash in contract` or `✗ hash not approved`. Clicking opens the Attestation modal.
  - "Last run 12 min ago · next run in 48 min"
  - "Next run will pay 3 recipients" (from `get_due_recipients`)
  - **Pause agent** button, large, red outline; becomes green `Resume agent` when paused. Confirmation dialog on both.

**Full width below**
- **Approval banner** (only if pending approvals exist): amber background, one row per pending payout: label, amount, destination chain, `Approve` / `Reject`. Approving signs `approve_payout`; UI shows the payout moving to the feed as Pending.
- **Payouts feed**: last 10 payouts as rows: status icon, recipient label, amount, `→ chain`, relative time, links `NEAR tx ↗` and `Track ↗` (Intents explorer or destination-chain explorer, see §7). Row click opens Payout detail. Link to `/payouts` for history.

Empty states:
- No balance: "Deposit USDC to let the agent start paying." with Deposit button.
- No recipients: "Add your first recipient" linking to `/recipients`.
- No payouts yet: "The agent hasn't paid anyone yet. Next run in N min."

### 5.2 Recipients (`/recipients`)

- Table columns: Enabled (toggle), Name, Amount (USDC), Period (monthly/weekly/daily), Chain (badge with chain name), Address (short mono + copy), Last paid, Next due, Actions (edit, remove).
- `Add recipient` button (primary) opens a right-side drawer with the form:
  - Name (text, 2–40 chars)
  - Amount in USDC (number, > 0, ≤ per_tx_limit; show warning if > approval_threshold: "Payments above X need your approval")
  - Period (select: monthly, weekly, daily)
  - Destination chain (select from supported list, loaded from a static config in v1: Base, Ethereum, Arbitrum, Solana, Tron, NEAR)
  - Destination address (text; validate format per chain: EVM 0x + 40 hex, Solana base58 32–44, Tron T + 33 base58, NEAR account regex)
  - Submit → `add_recipient` → wallet → toast → drawer closes → table refetches.
- Edit uses the same drawer with `update_recipient`. Remove asks for confirmation.
- **AI assist (only if `VITE_AI_ENABLED=true`)**: a text field at the top of the drawer, "Describe in plain words", e.g. "pay Maria 1500 USDC monthly on Base to 0x…". On submit it calls the worker's `POST /ai/parse-recipient` (see §3.3) and fills the form fields; the owner still reviews and signs. Show a small line "Parsed by NEAR AI Cloud (TEE) — review before saving". Never auto-submit.

### 5.3 Policy (`/policy`)

Section **Spending rules**: form with daily limit, per-payment limit, approval threshold, allowlist-only toggle. Save → `set_policy`. Inline validation: per-payment ≤ daily; threshold ≤ per-payment.

Section **Agents**: table of registered agents: account id, code hash (full, mono, wrap), registered at, status (`approved` if hash ∈ approved list). Button `Approve new code hash` → input + `approve_codehash`. Short explanation line: "Only workers whose code hash is approved here can ask the vault to pay."

Section **Danger zone**: Pause/Resume (same as home), Withdraw all to owner.

### 5.4 Payouts history (`/payouts`)

Table with filters: status (all / confirmed / pending / failed / refunded), recipient, chain. Columns as in the feed plus created/updated timestamps and payout id. Pagination via `get_payouts(from, limit)`. Row click → detail.

### 5.5 Payout detail (modal or `/payouts/[id]`)

Header: recipient, amount, chain, final status.

**Timeline** (vertical, each step with timestamp and link if available):
1. Requested by agent — agent account id, NEAR tx
2. Policy check passed — which limits applied (daily remaining, per-tx) — or "Waiting for approval" / "Approved by owner at …"
3. Reserved in vault — amount
4. Sent to NEAR Intents — deposit address (short), NEAR `ft_transfer` tx link
5. Intents status — Pending → Success / Failed / Refunded, with the Intents tracking link
6. Arrived on {chain} — destination tx link when available

Failure/refund shows the reason text reported by the worker and a note "Reservation released; daily limit restored".

### 5.6 Modals

- **Deposit**: amount in USDC, shows owner's USDC balance (view `ft_balance_of` on USDC contract), submit → `ft_transfer_call`. Note: "Funds stay in your vault contract. Only policy-approved payouts can leave."
- **Withdraw**: amount + destination NEAR account (defaults to owner), warning if agent is running.
- **Attestation**: mode (TEE / local), full code hash, approved hashes list with match indicator, attestation report excerpt or link, Phala deployment URL if present, and a one-paragraph plain-language explanation of what this proves.
- **Confirm Pause / Resume**.

## 6. Components (`/dashboard/src/components`)

Project layout: `/dashboard/src/{components,hooks,lib,pages,main.tsx,App.tsx}`, `index.html`, `vite.config.ts`, `tailwind.config.ts`.

```
ui/            Button, Card, Badge, Toggle, Input, Select, Drawer, Modal, Toast, Table, ProgressBar, CopyField, Skeleton
layout/        TopBar, PausedBanner, PageShell
treasury/      TreasuryCard, PolicyCard, AgentCard, ApprovalBanner, PayoutsFeed, PayoutRow
recipients/    RecipientsTable, RecipientDrawer, AiAssistField
policy/        PolicyForm, AgentsTable, DangerZone
payouts/       PayoutsTable, PayoutTimeline, StatusIcon
wallet/        WalletButton, WalletProvider
```

Hooks (`/dashboard/src/hooks`): `useVault()` (all views, typed), `usePolicy()`, `useRecipients()`, `usePayouts(page)`, `usePendingApprovals()`, `useAgentStatus()`, `useWallet()`, `useVaultActions()` (typed write calls with toasts).

Types (`/dashboard/src/lib/types.ts`) mirror the contract's JSON exactly; amounts arrive as strings (U128) and are formatted with 6 decimals for USDC.

## 7. Links and explorers

Static config `/dashboard/src/lib/chains.ts`:
- NEAR tx: `https://nearblocks.io/txns/{hash}` (testnet: `https://testnet.nearblocks.io/txns/{hash}`)
- Intents tracking: `https://explorer.near-intents.org/transactions/{depositAddress}` — verify the exact URL pattern in the 1Click docs before use; fall back to showing the deposit address if unknown.
- Destination explorers: Base `https://basescan.org/tx/`, Ethereum `https://etherscan.io/tx/`, Arbitrum `https://arbiscan.io/tx/`, Solana `https://solscan.io/tx/`, Tron `https://tronscan.org/#/transaction/`.

## 8. Visual style

- Dark theme by default, light theme optional (CSS variables, `prefers-color-scheme`).
- Palette: background `#0B0D10`, surface `#13161B`, border `#232832`, text `#E6E8EC`, muted `#8A93A3`, accent green `#2ECC71` (verified/success), amber `#F5B544` (attention/pending), red `#E5484D` (pause/error only). One accent at a time per element.
- Type: Inter 14/16 for UI, JetBrains Mono for amounts, hashes, addresses. Balance at 40px mono.
- Spacing: 8px grid, cards with 16px padding, 12px radius, 1px borders, no shadows.
- Motion: status transitions in the feed fade/slide in 150 ms; nothing else animates.
- Mobile: single column, Pause button sticky at bottom.

## 9. States and edge cases

- Wallet not connected: everything readable; write buttons show "Connect wallet to …" tooltip and open the wallet modal.
- Connected wallet ≠ owner: show a grey banner "You are viewing this vault as a guest. Only the owner can change settings." and disable writes.
- Wrong network in wallet: banner with the expected network.
- Worker offline: Agent card grey, rest works.
- Contract not initialized / wrong id: full-page error with the contract id and env hint.
- Loading: skeletons, never spinners over the whole page.
- Errors from wallet (user rejected): quiet toast, no error state.

## 10. Build order and acceptance

| Step | Deliverable | Accept when |
|------|-------------|-------------|
| U0 | App shell, wallet connect, env, TopBar, typed `useVault` reading `get_policy` and `get_balance` from testnet | Balance and policy render from the real contract |
| U1 | Treasury page: TreasuryCard, PolicyCard, AgentCard (with worker `/status`), Pause/Resume | Pause toggles `paused` on chain and the banner appears |
| U2 | PayoutsFeed + PayoutTimeline modal | A payout made by the worker appears within one poll and its links open |
| U3 | Recipients page with drawer, validation, add/edit/remove | Adding a recipient via UI makes the worker pay it on the next run |
| U4 | ApprovalBanner + approve/reject; Deposit and Withdraw modals | A payout above threshold is approved from the UI and then executes |
| U5 | Policy page incl. Agents table and approve code hash; Attestation modal | Code hash from `/status` shows as approved after `approve_codehash` |
| U6 | Payouts history with filters; empty states; mobile pass | Lighthouse accessibility ≥ 90; works at 390px width |
| U7 | AI assist field behind flag | Free text fills the form correctly for 3 sample sentences; never auto-submits |

Do U0–U2 before anything else: they are what the demo video shows. U7 is last and optional.

## 11. Demo checklist for the UI

Before recording:
- Vault funded, 3 recipients on 3 chains, one with amount above the approval threshold.
- Worker in TEE if available, otherwise local mode with the amber "dev" label visible (honest).
- Browser zoom 110 %, dark theme, window 1440×900, no extensions visible.
- Feed empty at start so the transitions are visible during the recording.
