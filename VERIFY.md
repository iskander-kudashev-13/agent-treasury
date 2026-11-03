# VERIFY.md — how a reviewer (human, Claude Code, Codex) checks Agent Treasury

Everything here is read-only: no keys, no wallet, no transactions, no money. Run from the repo root.

## 1. One command

```bash
scripts/verify.sh            # offline build + lint + tests of every package, then the on-chain checks
scripts/verify.sh offline    # only build / lint / tests (no network used by the tests)
scripts/verify.sh onchain    # only the read-only checks of the live mainnet demo
```

Requirements: Rust stable + `cargo` (tested 1.99.1), Node.js ≥ 22.12 (tested 23.11.0), pnpm 11 (tested 11.22.0), `curl`, `jq`.
Expected last line: `ALL CHECKS PASSED` (exit code 0). First offline run takes about 6–8 minutes (Rust compile).

Expected counts (2026-11-03, branch `main`):

| Package | Check | Expected |
|---|---|---|
| contract | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` | `174` tests passed |
| sdk | typecheck, lint, test, build | `Tests 93 passed` |
| mcp | typecheck, lint, test, build | `Tests 42 passed` |
| worker | typecheck, lint, test, build | `Tests 1072 passed` |
| dashboard | typecheck, lint, test, build | `Tests 502 passed` |

Known harmless output: cargo warns about `wasmparser v0.78.2` (future-incompat, test tooling); the dashboard build prints
`[EVAL] Use of direct eval` for `js-sha256` (wallet dependency) and a chunk-size warning.

## 2. Claims and where each one is proven

| Claim | Proof (command or file) | Expected |
|---|---|---|
| A vault contract enforces each agent's mandate; agents can only *ask* to pay | `contract/src/payment.rs` (`request_payment`: ordered checks, machine-readable reasons), unit tests in `contract/src/tests.rs` | 174 passing tests incl. per-tx / daily / count limits, allowlist, chains, expiry, pause, unknown caller |
| Deployed on NEAR mainnet | `scripts/verify.sh onchain` → `vault.agenthack.near` `get_contract_info` | owner `agenthack.near`, `requires_tee: true` |
| Real cross-chain payouts through NEAR Intents | same script: `get_payouts` + 1Click `/v0/status` per deposit address | 3 payouts `Confirmed`; 1Click `SUCCESS` for all three |
| Payroll paid by an AI agent (Claude Code over MCP) on Base and Arbitrum | payouts 1–2 (`agent_id: payroll`); Base tx `0xdc9d7b846e638eb3436655d450e9a643ae72609aa7be3f0ab9089139f4c290b2`, Arbitrum tx `0x7c110eba42d8992935e26afb9a29c81a0d2404a1518c1ea6b72ad883d4f7c940` (open on basescan.org / arbiscan.io) | 1.997196 USDC on Base, 1.994296 USDC on Arbitrum, sender "NEAR Intents: Treasury" |
| Out-of-mandate requests are refused by the contract, not by the agent | `get_rejections` (in the script) | `PER_TX_LIMIT_EXCEEDED` (50 USDC) and `RECIPIENT_NOT_ALLOWED` (prompt-injected address) for `payroll` |
| Vault funds a Hyperliquid account; trading bots act inside owner-signed limits | payout 0 (`hl-trader`, `hypercore`, 20 USDC → 19.68 USDC); HL `userFills` of `0x072994Aa1Bdb9886Ce04f6D42c6ee513fA92ab0d` | two fills whose `cloid` starts with the signed rules / mandate hash (`0x8d0b7dea…`, `0xa277ef47…`) |
| An external AI agent trades only through the same deterministic risk gate | `worker/src/trading/engine/tick.ts` (`attempt()`), `worker/test/trading/agent-same-path.test.ts`; ADR `docs/adr/0007-agent-driven-trading.md` | same `checkOrder` inputs for DSL rules and agent orders |
| Agent keys cannot withdraw; Stop cuts an agent off | `worker/src/trading/agent.ts`, `service.ts` (`revokeOnStop`), tests `worker/test/trading/agent-*.test.ts`; on mainnet `hl-trader` is `Revoked` | token 401 after Stop; no withdraw tool in `mcp/src/trading.ts` |
| Security reviews were done and fixed | `docs/security/*.md` (each has a "Fixes" table) | — |

All mainnet ids, amounts and the exact commands used: `docs/deployments.md` → "Mainnet". The session runbook:
`docs/commands.md` → "[MAINNET] Trading session runbook". Demo video script: `docs/demo-script.md`.

## 3. Optional: see it in the dashboard (read-only, no wallet)

```bash
cd dashboard && pnpm install --frozen-lockfile
VITE_NEAR_NETWORK=mainnet VITE_VAULT_CONTRACT=vault.agenthack.near \
VITE_USDC_CONTRACT=17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 pnpm dev
# open http://localhost:5173/#/payments?tab=history → "Payouts (3)", all Confirmed
# open http://localhost:5173/#/agents/payroll → mandate (6 USDC/day, only Maria on Base and Alex on Arbitrum), Activity
```
Without a wallet the owner buttons are disabled; nothing can be signed.

## 4. What is NOT claimed (honest limits)

- The worker ran in **local mode**, not inside a TEE (Phala). `requires_tee: true` means the mainnet vault accepts only key agents.
- On that vault no TEE worker reports final payout statuses; the owner set `Confirmed` with `report_payout_status` after
  1Click showed `SUCCESS` (allowed to the owner by design).
- A leaked agent key can still spend up to its own daily limit; that is the bound the mandate gives.
- Demo amounts are tiny (≤ 22 USDC total). The demo video re-captures some dashboard screens for clarity; all values are from
  the mainnet run and are checked by `scripts/verify.sh onchain`.

## 5. Do not

- Do not run `docs/commands.md` steps marked ⚠ or `[MAINNET]`: they sign transactions with the owner's keys.
- No `.env` file is needed for any check above.
