<!-- Provided by the project owner on 2026-11-01. Canon for agents / mandates / request_payment. Refinements and the exact on-chain interface: docs/adr/0003-agents-and-mandates.md (ADR wins where they differ). -->

# Agent Access & Mandates — feature spec

Brief for the coding agent. Read `CLAUDE.md` first. This file extends it: it turns the vault from "one payroll worker" into "any number of agents, each with its own mandate". Where this file and `CLAUDE.md` disagree, this file wins for everything about agents, mandates and `request_payment`. UI for this feature is specified in `DESIGN_AGENTS.md`.

## 1. Goal

Any AI agent — ours or a third party's — can be connected to a vault in minutes and spend money **only within a mandate** the owner set for it. If an agent is compromised or misbehaves, the damage is capped by its mandate and the other agents keep working.

Demo target: one vault, two agents:
1. **Payroll agent** (TEE, Shade Agent): pays fixed recipients on a schedule.
2. **Procurement agent** (Claude via our MCP server, function-call key): pays invoices on request, gets refused with a machine-readable reason when it goes over its limit.

## 2. Concepts

| Term | Meaning |
|------|---------|
| Vault | The contract. Holds USDC, owner, global policy, agents, payouts. |
| Agent | An on-chain identity allowed to ask the vault for payments. Has exactly one mandate. |
| Agent kind | `tee` (registered via attestation against an approved code hash) or `key` (owner registers an account + function-call access key). |
| Mandate | Per-agent rules: limits, allowed recipients, allowed chains, approval threshold, expiry, status. |
| Global policy | Vault-wide caps that apply on top of every mandate (vault daily limit, global pause). A payment must pass both. |
| Payment request | `request_payment(...)` call by an agent. Results in Rejected (with reason), PendingApproval, or Reserved → Sent → Confirmed/Failed/Refunded. |

Payroll is a special case: a mandate with `recipients_mode = fixed` and per-recipient fixed amounts and periods.

## 3. Contract changes (`/contract`)

### 3.1 Types

```rust
enum AgentKind { Tee, Key }
enum AgentStatus { Active, Paused, Revoked }
enum RecipientsMode {
    Fixed,     // only recipients listed in mandate.recipients, only their configured amount, only when due
    Allowlist, // only addresses in mandate.allowlist, any amount within limits
    Open,      // any address on allowed chains, any amount within limits
}

struct Mandate {
    daily_limit: U128,
    per_tx_limit: U128,
    approval_threshold: U128,   // amounts strictly above require owner approval
    allowed_chains: Vec<String>, // e.g. ["base","solana","tron","near"]
    recipients_mode: RecipientsMode,
    allowlist: Vec<Destination>, // used when Allowlist
    recipients: Vec<RecipientId>,// used when Fixed (refs to vault recipients)
    expires_at: Option<u64>,    // ms; None = no expiry
}

struct Destination { chain: String, address: String, label: Option<String> }

struct Agent {
    id: AgentId,                 // short slug chosen by owner, unique
    name: String,
    kind: AgentKind,
    account_id: AccountId,       // the NEAR account that calls request_payment
    public_key: Option<PublicKey>, // for Key agents: the function-call key added to account_id
    codehash: Option<String>,    // for Tee agents
    mandate: Mandate,
    status: AgentStatus,
    spent_today: U128,
    day_index: u64,
    created_at: u64,
    last_request_at: Option<u64>,
}
```

`Payout` gets `agent_id: AgentId` and `memo: Option<String>` (≤ 140 chars, stored as given, shown in UI; never interpreted as instructions).

### 3.2 Owner methods

- `add_agent(id, name, kind, account_id, codehash?, mandate)` → Agent
- `update_mandate(agent_id, mandate)`
- `pause_agent(agent_id)`, `resume_agent(agent_id)`
- `revoke_agent(agent_id)` — terminal; agent can never be reactivated (create a new one instead)
- existing: `pause()`/`resume()` (global), `set_policy`, `approve_payout`, `reject_payout`, `withdraw`, `approve_codehash`, recipients CRUD

### 3.3 Agent methods

- `register_agent(...)` — Shade Agent standard, for `Tee` agents only. Succeeds only if an Agent with this `account_id`, kind `Tee` and an approved `codehash` exists (owner pre-created it with `add_agent`). Without that, registration fails.
- `request_payment(chain, address, amount, memo?, recipient_id?, deposit_address) -> PaymentResult`
  - caller must be the `account_id` of an `Active` agent (and for `Tee`, registered with a valid attestation)
  - see §3.4 for checks
- `report_payout_status(payout_id, status, tx_hash?)` — only the agent that created the payout, or the payroll worker
- existing `request_payout(recipient_id, deposit_address, amount)` becomes a thin wrapper over `request_payment` with `recipient_id` set (kept for the payroll worker)

`deposit_address` is the 1Click deposit address the agent obtained from a fresh quote. The contract does not call 1Click; it only transfers USDC to the given address. The vault records `chain`/`address` as the intended destination for audit; the agent is responsible for quoting to that destination. (v2 idea: a trusted worker re-verifies quotes. Out of scope.)

### 3.4 `request_payment` check order

Evaluate in this order and return the **first** failing reason. No state change on rejection except `last_request_at` and a rejection log entry.

1. `VAULT_PAUSED` — global pause
2. `AGENT_NOT_FOUND` / `AGENT_REVOKED` / `AGENT_PAUSED`
3. `AGENT_EXPIRED` — `now > expires_at`
4. `CHAIN_NOT_ALLOWED`
5. `RECIPIENT_NOT_ALLOWED` — per `recipients_mode` (`Fixed`: `recipient_id` must be in mandate and address must match; `Allowlist`: destination must be in allowlist; `Open`: pass)
6. `AMOUNT_MISMATCH` — `Fixed` only: amount must equal the recipient's configured amount
7. `NOT_DUE` — `Fixed` only: period not elapsed
8. `PER_TX_LIMIT_EXCEEDED` — amount > mandate.per_tx_limit
9. `AGENT_DAILY_LIMIT_EXCEEDED` — agent spent_today + amount > mandate.daily_limit (roll over by day index first)
10. `VAULT_DAILY_LIMIT_EXCEEDED` — vault spent_today + amount > policy.daily_limit
11. `INSUFFICIENT_BALANCE`
12. if amount > mandate.approval_threshold → store as `PendingApproval`, return `NEEDS_APPROVAL` with `payout_id`. No reservation yet; reservation happens on `approve_payout`, which re-runs checks 1–11 at that moment.
13. otherwise reserve (agent and vault `spent_today += amount`, `balance -= amount`), `ft_transfer` to `deposit_address`, callback releases on failure.

Return type:

```rust
enum PaymentResult {
    Rejected { reason: String, detail: String },        // reason is one of the codes above
    PendingApproval { payout_id: u64 },
    Submitted { payout_id: u64 },                        // transfer promise created
}
```

`detail` is a short English sentence an LLM can relay, e.g. `"Daily limit for agent 'procurement' is 200 USDC; 150 already spent today; requested 500."`

### 3.5 Function-call keys for `Key` agents

Two supported setups; implement A, document B.

- **A (recommended for demo):** owner creates a sub-account `procurement.<vault>.near` (or any account they control). The dashboard helps generate a key pair locally in the browser, and the owner signs a transaction that adds it to that account as a **function-call access key** restricted to `receiver_id = <vault>` and `method_names = ["request_payment", "report_payout_status"]`, with an allowance (e.g. 0.25 NEAR for gas). The private key is shown **once** in the UI for the developer to put in their agent's env. The vault's `add_agent` records `account_id` and `public_key`.
- **B:** the developer brings their own account and key; owner only calls `add_agent` with that `account_id`. Document in README.

Never store private keys anywhere server-side. Never commit them.

### 3.6 Views

- `get_agents()` → Agent[]
- `get_agent(agent_id)` → Agent
- `get_agent_budget(agent_id)` → `{ remaining_today, per_tx_limit, approval_threshold, allowed_chains, recipients_mode, allowlist, expires_at, status }`
- `get_payouts(from, limit, agent_id?)` → Payout[] (filter optional)
- `get_rejections(from, limit, agent_id?)` → `{ agent_id, at, reason, detail, chain, address, amount }[]` — capped ring buffer of the last 200

### 3.7 Tests (must exist and pass)

- each rejection code is reachable and returned in the documented order
- Fixed mandate pays only due recipients with exact amounts
- Allowlist rejects unknown address, accepts known
- Open accepts any address on allowed chain
- agent daily limit and vault daily limit are independent; both enforced; day rollover resets both
- pause_agent blocks that agent only; global pause blocks all
- revoked agent can never pay again, even after resume attempts
- expired agent rejected
- approval flow: pending → approve re-checks limits at approval time → submitted; pending → reject
- failed `ft_transfer` releases both agent and vault reservations
- a `Key` agent account cannot call owner methods (contract-side check, independent of the key's method restriction)
- `report_payout_status` by another agent is rejected

## 4. MCP server (`/mcp`)

TypeScript, official MCP TypeScript SDK, stdio transport (and optional HTTP/SSE). Package name `agent-treasury-mcp`. Runs on the agent developer's machine or next to their agent.

Config via env:
```
TREASURY_VAULT=vault.example.near
TREASURY_NETWORK=mainnet
TREASURY_AGENT_ACCOUNT=procurement.vault.example.near
TREASURY_AGENT_PRIVATE_KEY=ed25519:...     # the function-call key
NEAR_RPC=...
ONECLICK_JWT=                              # optional
```

Tools (names, inputs, outputs are part of the public interface — keep stable):

| Tool | Input | Output |
|------|-------|--------|
| `treasury_get_budget` | — | `{ remaining_today_usdc, per_tx_limit_usdc, approval_threshold_usdc, allowed_chains, recipients_mode, allowlist?, expires_at?, status }` |
| `treasury_list_allowed_recipients` | — | `Destination[]` (empty for Open) |
| `treasury_quote_payment` | `{ chain, address, amount_usdc }` | `{ ok, would_reject_reason?, needs_approval, estimated_fee_usdc, estimated_arrival_s }` — dry run: runs the mandate checks client-side from `get_agent_budget` and a 1Click `dry: true` quote. No state change. |
| `treasury_request_payment` | `{ chain, address, amount_usdc, memo? }` | `{ status: "rejected" \| "pending_approval" \| "submitted", reason?, detail?, payout_id? }` |
| `treasury_get_payment_status` | `{ payout_id }` | `{ status, chain, address, amount_usdc, near_tx?, intents_status?, destination_tx? }` |

`treasury_request_payment` flow inside the server:
1. `/v0/tokens` (cached) → resolve USDC asset ids for NEAR and destination chain
2. `/v0/quote` with `dry: false`, recipient = destination address on chain → `depositAddress`
3. call vault `request_payment(chain, address, amount, memo, deposit_address)` signed with the function-call key
4. if `Submitted`: `/v0/deposit/submit` with the tx hash; start background polling of `/v0/status` and call `report_payout_status` on terminal state
5. return the result immediately (don't block the agent until arrival)

Tool descriptions must tell the model: amounts are in USDC; a rejection is final for this request and the `detail` should be relayed to the user; `pending_approval` means a human must approve in the dashboard; do not retry rejected requests with split amounts to bypass limits.

Ship `mcp/README.md` with copy-paste config for Claude Desktop / Claude Code (`.mcp.json`) and a generic MCP client.

## 5. TypeScript SDK (`/sdk`) — thin, optional

Same five operations as functions (`getBudget`, `quotePayment`, `requestPayment`, `getPaymentStatus`, `listAllowedRecipients`). The MCP server imports the SDK; do not duplicate logic. Publish-ready but publishing is not required for the hackathon.

## 6. Payroll worker changes (`/worker`)

- The worker is now the `Tee` agent with id `payroll` and a `Fixed` mandate.
- It calls `request_payment` (or the wrapper) and handles `PaymentResult` variants.
- No other behaviour change.

## 7. Dashboard changes

Specified in `DESIGN_AGENTS.md`. Summary: new Agents page and Add-agent wizard, agent detail with mandate editor and activity, agent attribution in payouts feed and approvals, rejections log, per-agent pause/revoke.

## 8. Demo script for this feature (≈ 70 s of the video)

1. Dashboard → Agents: two agents visible, `payroll` (TEE, verified) and `procurement` (key).
2. Claude Desktop/Claude Code with our MCP: "Pay this invoice: 50 USDC to 0x… on Base for design work." → agent calls `treasury_request_payment` → `submitted`. Dashboard feed shows the payment tagged `procurement`, then Confirmed with a Basescan link.
3. "Now send 5,000 USDC to 0x… ." → `rejected`, `AGENT_DAILY_LIMIT_EXCEEDED`; Claude explains the limit in plain words. Dashboard Rejections log shows the attempt.
4. "Send 150 USDC to this new address." → `pending_approval` (above threshold) → owner approves in dashboard → paid.
5. Owner clicks Pause on `procurement`; next request → `AGENT_PAUSED`. Payroll agent keeps working.

## 9. Milestones

Insert into the main plan after M2 (worker loop works):

| # | Milestone | Done when |
|---|-----------|-----------|
| A1 | Mandates in contract | Types, owner methods, `request_payment` with all checks, views, tests from §3.7 green on testnet |
| A2 | Payroll worker on mandates | Worker pays via `request_payment` under a Fixed mandate; behaviour unchanged |
| A3 | Key agent setup | Dashboard (or a script first) creates a function-call key limited to the vault and registers the agent; the key cannot call any other method |
| A4 | MCP server | All five tools work against mainnet vault with tiny amounts from Claude Code/Desktop |
| A5 | Dashboard Agents UI | Per `DESIGN_AGENTS.md` steps D1–D4 |
| A6 | Demo rehearsal | Script in §8 runs end to end twice without manual fixes |

Cut list if late: `Allowlist` mode (keep Fixed and Open), `get_rejections` ring buffer (log rejections in worker/MCP instead), SDK packaging (MCP-only), agent expiry.

## 10. Security notes (put in README)

- Mandates are enforced in the contract; MCP/SDK checks are only previews.
- Function-call keys cannot transfer NEAR or call other contracts; their gas allowance is capped.
- Memo is untrusted text; displayed, never executed or fed back as instructions.
- `Open` mode trusts the agent to quote to the destination it declares; the cap is the mandate's limits. State this limitation explicitly.
- Revocation is immediate on-chain; for Key agents also delete the access key from the account (dashboard offers this as a second transaction).
