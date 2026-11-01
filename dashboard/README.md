# Agent Treasury dashboard

Static Vite + React + TypeScript SPA (no server code). Reads vault state over RPC (no wallet needed), sends owner calls through a
NEAR wallet (`@near-wallet-selector` with MyNearWallet and Meteor), and shows the worker's `/status` and `/runs`.

## Run

1. `cd dashboard && pnpm install`
2. `cp .env.example .env.local` and set `VITE_VAULT_CONTRACT` (e.g. `vault.<you>.testnet`). Optional: `VITE_NEAR_RPC`, `VITE_USDC_CONTRACT`, `VITE_WORKER_URL`, `VITE_ONECLICK_BASE_URL`, `VITE_AI_ENABLED`.
3. `pnpm dev` and open http://localhost:5173 .
4. Hash routes: `#/` Treasury, `#/agents` (+ `/new`, `/:id`), `#/payments` (`?tab=scheduled|recipients`), `#/payouts` (+ `/:id`), `#/policy`. Architecture and conventions: `ARCHITECTURE.md`. Design kit demo: `/kit.html`.
5. Click **Connect wallet** (header), sign in with the vault owner account. The badge shows `owner`; any other account is read-only and all action buttons stay disabled.

## Build

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # vite build -> static dist/
pnpm preview                                              # serve dist/ locally
```

Deploy `dist/` to any static host (hash routing: no SPA fallback rewrite needed). Env vars are read at build time.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `VITE_NEAR_NETWORK` | `testnet` | `testnet` or `mainnet` (wallet network, default RPC, explorer links) |
| `VITE_VAULT_CONTRACT` | none (required) | vault account id. Legacy name `VITE_VAULT_CONTRACT_ID` still works. |
| `VITE_NEAR_RPC` | fastnear (`test.rpc` / `free.rpc`) | RPC endpoint for view calls. Legacy name `VITE_NEAR_RPC_URL` still works. |
| `VITE_USDC_CONTRACT` | none | USDC NEP-141 contract (Deposit flow, owner wallet balance) |
| `VITE_WORKER_URL` | none | worker API base (`GET /status`, `GET /runs`, polled every 10 s). The worker must allow CORS from the dashboard origin. |
| `VITE_ONECLICK_BASE_URL` | `https://1click.chaindefuser.com` | NEAR Intents 1Click API, read-only `/v0/status` for the Quote check before approving a payout |
| `VITE_AI_ENABLED` | `false` | `true` shows the Assistant (header button, panel, mobile button); needs worker `/ai/*`. Anything else hides it completely. |

All variables are public (bundled into the browser). Never put secrets here.

## Behavior notes

- Views: `get_contract_info`, `get_policy`, `get_balance`, `get_recipients`, `get_payouts_count` + `get_payouts({from_index, limit})` (newest first, 20 per page), `get_pending_approvals`, `get_agents`, `get_rejections({limit: 50})`.
- Owner calls: every deposit/gas rule is in `src/lib/calls.ts`, and `calls.contract-sync.test.ts` checks it against `contract/src/*.rs` (run `pnpm test` after contract changes). All signing goes through `useOwner()`.
- Agent memos are untrusted text from agents and are rendered as plain text only.
- Amounts are USDC with 6 decimals via bigint string math (`src/lib/amount.ts`), never floats.
- EVM recipient addresses are stored lowercased (1Click rejects bad mixed-case checksums); `sol` addresses are checked as base58.
- If the worker reports `mode: "local"` the Worker card shows "LOCAL MODE - not TEE".
- `tx_hash` is shown as-is (it may belong to another chain); deposit addresses link to nearblocks.

## Not in the UI yet

`update_contract` (raw wasm input), `update_attestation_expiration_time` is in Policy; contract upgrades, `credit_refund` edge cases and `sync_surplus` beyond the Treasury card still use `near-cli-rs` (see `docs/commands.md`).
