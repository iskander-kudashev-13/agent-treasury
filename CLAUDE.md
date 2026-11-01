# Agent Treasury — NEAR HACKATHON project

This file is the project brief for the coding agent. Read it fully before touching code. Re-read `https://nearhackathon.com/HACKATHON.md` before any submission step.

Spec files and precedence (later overrides earlier on its topic):
1. `CLAUDE.md` — product, architecture, hackathon rules, milestones
2. `UI_PLAN.md` — dashboard stack, base screens, visual style
3. `AGENT_ACCESS.md` — agents, mandates, `request_payment`, MCP server (overrides §3.1–3.2 here on those topics)
4. `DESIGN_AGENTS.md` — UI for agents and mandates
5. `UI_UPDATES.md` — schedules as a separate entity, Payments page, Upcoming payments, overdue rule, AI assistant (chat via worker + NEAR AI Cloud). Its §3 changes the contract data model: amount/period move from Recipient to Schedule.

## 0. Development workflow (agents, skills, checks)

Project agents live in `.claude/agents/`, NEAR skills in `.claude/skills/` (installed locally, see README "Agent tooling").
Follow the triggers in their `description` automatically.

| Agent | When |
|---|---|
| **planner** | Any non-trivial task — FIRST, before code |
| **architect** | Choosing between approaches, new integrations (1Click, Shade Agent, NEAR AI), ADR in `docs/adr/` |
| **tester** | After any change to the vault contract or the worker payout path |
| **code-reviewer** | Before committing anything that moves money |
| **security-auditor** | Before testnet/mainnet deploys and before submission (`near-contract-audit` skill) |

**Hard rule**: anything that moves money (`request_payout`, callbacks, `withdraw`, `ft_on_transfer`, worker payout loop) → `tester` + `code-reviewer` mandatory.

Feature order: `planner` → (`architect` for integrations) → code → `tester` → `code-reviewer` → checks → commit.
Skip agents for typos, formatting, docs-only changes, edits inside one function.

Skills to load for the matching work: `near-smart-contracts` (contract), `near-contract-audit` (review/audit),
`near-intents` (1Click client), `near-cli-rs` (commands in `docs/commands.md`), `near-api-js` / `near-kit` (worker + dashboard RPC),
`near-dapp` (dashboard wallet), `near-ai-cloud` (M6, worker `/ai`).

Checks before commit:
- contract: `cd contract && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
- worker / dashboard / sdk / mcp (each its own package): `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Parallel work: independent parts (`/contract`, `/worker`, `/dashboard`, `/sdk`, `/mcp`) go to separate agents on separate
branches/worktrees (`isolation: "worktree"`). Interfaces between parts live in `docs/adr/0003-agents-and-mandates.md` (contract
JSON), this file and `UI_PLAN.md` (worker HTTP API); change them there first and tell the human.

Git: feature branches; merge to `main` only after the human reviewed the diff. Never push, deploy, or sign mainnet
transactions without explicit confirmation of the exact action.

Architecture decisions (`docs/adr/`) refine the specs on technical details verified against current docs:
0001 vault = Shade Agent v2 contract (measurements + PPID instead of codehash), 0002 payout flow and trust boundaries,
0003 agents/mandates refinements + **exact contract interface** (wins over `AGENT_ACCESS.md` where they differ).
0004 schedules (exact date rules, overdue rule, schedule interface; wins over `UI_UPDATES.md` §3 on contract details).
All spec files are in the repo root. Design package (design system, tokens, prototypes, open questions): `design-kit/agent-treasury-design/`; its React/Tailwind implementation: `dashboard/src/kit/`.

## 1. What we are building

**Agent Treasury** is a safe wallet for AI agents on NEAR.

Problem: AI agents that act autonomously need money, but giving an agent a private key means it can spend everything, and approving each payment by hand kills autonomy.

Solution: money sits in an on-chain **vault contract** with owner-defined **policies** (daily limit, per-recipient limit, allowlist, large-payment approval, kill switch). An **agent worker** running in a TEE (Shade Agent) can only ask the vault to pay; the vault enforces policies and cannot be bypassed, even by the developer. Payouts go cross-chain through **NEAR Intents** (1Click API), so the agent never handles bridges or other chains. Optional natural-language management through **NEAR AI Cloud**.

Shipped as a **reusable kit** (contract + worker template + dashboard) with **payroll** as the first reference use case: "pay my distributed team in their chains every month, without a human signing each payment".

Pitch line: *"Give AI a wallet with rules it cannot break."*

Hackathon tracks: `security` (primary), `business`, `realworld`.

## 2. Hackathon constraints (hard)

- Deadline: **2026-11-14T23:59:00Z**. One submission per project, cannot be edited.
- Public GitHub repo + public demo post on X with video are both required.
- Judges screen with Claude Code/Codex first: **README must be machine-followable** ("do X → see Y"), reproducible, no marketing.
- NEAR Intents has **no testnet**. Intents calls run on **mainnet** with dedicated dev accounts and tiny amounts. Use `dry: true` quotes wherever possible.
- Vault contract is developed and tested on **testnet**; a mainnet deployment is done only for the final demo and only with the human's explicit go-ahead.
- Never commit secrets. Keys and API tokens live in `.env` (gitignored). Provide `.env.example`.
- Never send a submission, post on X, deploy to mainnet, sign mainnet transactions, or spend real tokens without the human confirming the exact action.
- License: MIT. Add `LICENSE`.
- List all templates, libraries and AI-generated code in README (allowed, must be disclosed).

## 3. Architecture

```
owner (wallet) ──► Vault contract (NEAR, Rust)  ◄── agent worker (TS, TEE via Shade Agent)
                     │ policies + USDC treasury          │ scheduler + 1Click client
                     │ request_payout()                  │
                     ▼                                   ▼
              USDC transfer to 1Click deposit addr ──► NEAR Intents ──► recipient chain (Base/Solana/Tron/…)

dashboard (Vite + React SPA, static) reads contract state + worker status; owner can pause/resume, add recipients
optional: NEAR AI Cloud (OpenAI-compatible, TEE), called from the worker, parses natural-language commands into structured proposals
```

### 3.1 Vault contract (`/contract`, Rust, near-sdk-rs)

State:
- `owner: AccountId`
- `treasury_token: AccountId` (USDC NEP-141 contract)
- `balance: u128` (tracked internally; actual tokens are held by the contract on the FT contract)
- `recipients: UnorderedMap<RecipientId, Recipient>` — `{ label, amount_per_period, period, destination_chain, destination_address, last_paid_at, enabled }`
- `policy: Policy` — `{ daily_limit, per_tx_limit, approval_threshold, allowlist_only: bool, paused: bool }`
- `spent_today: u128`, `day_index: u64`
- `agents: UnorderedMap<AccountId, AgentInfo>` — registered worker accounts with approved code hash
- `approved_codehashes: UnorderedSet<String>`
- `payouts: Vector<Payout>` — log `{ id, recipient_id, amount, status: Pending|Sent|Confirmed|Failed|Refunded, intents_deposit_addr, tx_hash, created_at, updated_at }`
- `pending_approvals: UnorderedMap<PayoutId, Payout>` — payouts above `approval_threshold`

Methods (owner):
- `new(owner, treasury_token, policy)`
- `set_policy(policy)`, `pause()`, `resume()`
- `add_recipient(...)`, `update_recipient(...)`, `remove_recipient(id)`
- `approve_codehash(hash)` (Shade Agent standard)
- `approve_payout(payout_id)`, `reject_payout(payout_id)`
- `withdraw(amount, to)` — owner only, always allowed (owner is never locked out)

Methods (agent):
- `register_agent(attestation...)` — Shade Agent standard; verifies TEE attestation against approved code hash
- `request_payout(recipient_id, deposit_address, amount) -> PromiseOrValue<PayoutId>` — the ONLY money-moving path for an agent:
  1. caller is a registered agent
  2. not paused
  3. recipient exists, enabled, and (if `allowlist_only`) is in the allowlist
  4. amount == recipient's configured amount (v1: no free-form amounts)
  5. period elapsed since `last_paid_at`
  6. `amount <= per_tx_limit`, `spent_today + amount <= daily_limit` (reset by day index)
  7. if `amount > approval_threshold` → store in `pending_approvals`, return Pending, do NOT transfer
  8. otherwise **reserve** (`spent_today += amount`, `balance -= amount`), then `ft_transfer` to `deposit_address` with a callback
- `on_transfer_result(payout_id)` — private callback: on failure, release the reservation and mark Failed
- `report_payout_status(payout_id, status, tx_hash)` — agent reports the terminal Intents status

Methods (anyone):
- `ft_on_transfer` (NEP-141 receiver) — accepts USDC deposits from owner into treasury
- views: `get_policy`, `get_recipients`, `get_due_recipients(now)`, `get_payouts(from, limit)`, `get_pending_approvals`, `get_balance`, `get_agents`

Rules:
- Reserve-before-transfer and release-on-failure. Never trust the callback ordering; handle re-entrancy by reserving first.
- All amounts are `U128` strings at the API boundary.
- Comprehensive unit tests with `near-workspaces` or the sdk test harness: allowlist, limits, day rollover, pause, approval threshold, unauthorized caller, failed transfer releases reservation.

### 3.2 Agent worker (`/worker`, TypeScript)

- Start from NEAR's Shade Agent quickstart template (`NearDeFi/shade-agent-template`, Hono + `shade-agent-js`). Keep the template's TEE/registration plumbing; replace the oracle logic.
- Loop (every N minutes, configurable):
  1. `get_due_recipients(now)` from the vault
  2. for each: `GET /v0/tokens` (cached) → `POST /v0/quote` with `dry: true` (sanity) → `POST /v0/quote` with `dry: false` to get `depositAddress` (valid ~10 min) → call `request_payout(recipient_id, depositAddress, amount)` on the vault → `POST /v0/deposit/submit` with the NEAR tx hash → poll `GET /v0/status` until `SUCCESS | FAILED | REFUNDED` → `report_payout_status`
  3. handle `Pending` (approval needed): skip, log, surface in dashboard
- 1Click facts: never construct `assetId` by hand, take it from `/v0/tokens`; omit `msg` on withdrawals so failures stay refundable; without a partner JWT there is a 0.2% fee (fine for demo).
- Expose a small HTTP API for the dashboard: `/status` (last run, next run, TEE attestation info, code hash), `/runs` (recent log).
- Two run modes: `local` (no TEE, for development, documented as such) and `tee` (Phala Cloud via `shade-agent-cli`).

### 3.3 Dashboard (`/dashboard`, Vite + React + wallet-selector)

Client-side SPA, no server code. Full spec in `UI_PLAN.md`. Reads contract views via RPC, calls owner methods via wallet, reads worker `/status` and `/runs`. The worker must allow CORS from the dashboard origin.

### 3.4 Optional AI layer (`/worker/src/ai`)

NEAR AI Cloud, OpenAI-compatible endpoint `https://cloud-api.near.ai/v1`. Input: free text ("add Maria, 1500 USDC monthly on Base 0x…"). Output: a **structured proposal** (JSON matching `add_recipient` args) that the owner reviews and signs. Exposed as `POST /ai/parse-recipient` on the worker; the NEAR AI key stays in the worker's env. The AI never has write access. Build only after the core loop works end to end.

## 4. Repo layout

```
/contract        Rust, cargo-near, tests
/worker          TypeScript, Hono, shade-agent-js, Dockerfile, docker-compose.yaml
/dashboard       Vite + React SPA, Tailwind, wallet-selector (see UI_PLAN.md)
/skills          agent skill files (how an external agent asks the vault to pay)
/docs            architecture.md, comparison.md (vs Ping, HOT Pay, OutLayer, Rise), demo-script.md
README.md        machine-followable: what, why, how NEAR is used, quickstart "do X → see Y", disclosures
HACKATHON.md     copy of the official file for reference
.env.example
LICENSE          MIT
```

## 5. Milestones and definition of done

| # | Milestone | Done when |
|---|-----------|-----------|
| M0 | Setup | Shade Agent quickstart runs unchanged locally; one `dry: true` 1Click quote returned from a script; repo skeleton + LICENSE + .env.example |
| M1 | Vault contract | All owner/agent methods implemented; tests pass; deployed to testnet; `request_payout` succeeds for a registered key and fails for an unknown key |
| M2 | Worker loop | Local-mode worker pays 2–3 recipients on different chains end to end on mainnet with tiny amounts; statuses written back to the vault |
| M3 | Dashboard | Treasury, recipients, payouts feed, policy editor, pause/resume, pending approvals; wallet connect works |
| M4 | TEE | Worker deployed to Phala, code hash approved, a payout executed from the TEE; attestation shown in dashboard. If blocked, document the exact steps and ship local mode |
| M5 | Kit packaging | README quickstart, `/skills` example, `/docs/comparison.md`, architecture diagram |
| M6 | AI layer (optional) | Text → proposal → owner confirms → recipient added |
| M7 | Submission | Demo video recorded, X post live, README re-verified by running it from a clean clone, form submitted after human confirmation |

Priority if time runs out: M1 > M2 > M3 > M5 > M4 > M6. Never ship M3 without M2.

## 6. Working conventions

Team: one human (Iskander, tech lead, reviews and decides) plus Claude Code agents. There are no other developers.

- Agents may work in parallel on independent parts (`/contract`, `/worker`, `/dashboard`) using separate git worktrees/branches. Interfaces between parts (contract view/call signatures, worker HTTP API) are defined in this file and `UI_PLAN.md`; change them only by updating these files first and telling the human.
- Merge to `main` only after the human has reviewed the diff.
- Small PRs/commits with clear messages; the human reviews every contract change.
- Explain non-obvious NEAR specifics in code comments (async cross-contract calls, callbacks, storage staking, gas).
- Before implementing anything against 1Click, Shade Agent or NEAR AI Cloud, read their current docs and verify endpoints/SDK versions; do not rely on memory.
- Prefer `near-cli-rs` commands and `cargo near`; record every command used in `/docs/commands.md` so the human can replay them.
- Keep a `CHANGELOG.md` with one line per working session.
- When unsure about a product decision, ask the human; when unsure about a NEAR technical detail, check docs first, then ask.

## 7. Links

- Hackathon: https://nearhackathon.com/ and https://nearhackathon.com/HACKATHON.md
- Track prompts: https://github.com/nearai/near-hackathon-prompt-examples (06-security, 04-business, 08-realworld)
- Shade Agents: https://docs.near.org/ai/shade-agents/ ; template https://github.com/NearDeFi/shade-agent-template
- NEAR Intents 1Click: https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api ; OpenAPI https://1click.chaindefuser.com/docs/v0/openapi.yaml ; partner key https://partners.near-intents.org
- NEAR AI Cloud: https://docs.near.ai/ ; https://cloud.near.ai
- NEAR docs: https://docs.near.org/ ; near-sdk-rs https://docs.rs/near-sdk
- Community: https://t.me/nearbuilderschat , https://discord.gg/nearprotocol
