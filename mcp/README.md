# agent-treasury-mcp

MCP server (stdio) that lets an AI agent pay from an Agent Treasury vault **only within the mandate the owner set for it**.
It wraps `agent-treasury-sdk` (`../sdk`) and exposes five payment tools (plus two optional trading-bot tools, see [Trading bot tools](#trading-bot-tools-optional-docsadr0007)):

| Tool | Input | Output |
|---|---|---|
| `treasury_get_budget` | none | `{ remaining_today_usdc, per_tx_limit_usdc, approval_threshold_usdc, min_payment_usdc, payments_left_today, allowed_chains, recipients_mode, allowlist?, expires_at?, status }` |
| `treasury_list_allowed_recipients` | none | `Destination[]` (`{chain, address, label?}`; empty for Open mandates) |
| `treasury_quote_payment` | `{ chain, address, amount_usdc }` | `{ ok, would_reject_reason?, needs_approval, estimated_fee_usdc, estimated_arrival_s }` (dry run, spends nothing) |
| `treasury_request_payment` | `{ chain, address, amount_usdc, memo? }` | `{ status: "rejected" \| "pending_approval" \| "submitted" \| "transfer_failed", reason?, detail?, payout_id?, near_tx? }` |
| `treasury_get_payment_status` | `{ payout_id }` | `{ status, chain, address, amount_usdc, source ("scheduled" \| "on_demand"), near_tx?, intents_status?, destination_tx? }` |

Amounts are decimal USDC strings (`"50"`, `"12.50"`, max 6 decimals). Chains are 1Click ids (`base`, `arb`, `sol`, `near`, `eth`; aliases `solana`, `arbitrum`). USDC only (Tron lists only USDT in 1Click and is refused).
`pending_approval` also carries `reason` (`ABOVE_THRESHOLD` or `OVERDUE_NEEDS_APPROVAL`), and `treasury_get_payment_status` returns `source` (`scheduled` or `on_demand`).
`transfer_failed` is an addition to the spec's three statuses (ADR-0003: the `ft_transfer` failed and the reservation was released; nothing was spent).

## Install

No root workspace: the MCP package links the SDK by path (`"agent-treasury-sdk": "link:../sdk"`), so build the SDK first.

```bash
cd sdk && pnpm install && pnpm build
cd ../mcp && pnpm install && pnpm build        # produces mcp/dist/index.js
```

## Configuration (environment)

| Variable | Required | Meaning |
|---|---|---|
| `TREASURY_VAULT` | for payments | vault contract account, e.g. `vault.owner.near` |
| `TREASURY_NETWORK` | with `TREASURY_VAULT` | `mainnet` or `testnet` |
| `TREASURY_AGENT_ACCOUNT` | with `TREASURY_VAULT` | the agent's NEAR account, e.g. `procurement.owner.near` |
| `TREASURY_AGENT_PRIVATE_KEY` | for payments | the function-call key (`ed25519:...`). Without it only the read-only tools work. |
| `TREASURY_AGENT_ID` | no | skips the lookup of the agent id by account |
| `NEAR_RPC` | no | RPC URL (default FastNEAR for the network) |
| `ONECLICK_BASE_URL` | no | default `https://1click.chaindefuser.com` |
| `ONECLICK_JWT` | no | 1Click partner JWT, sent as `Authorization: Bearer` |
| `ONECLICK_API_KEY` | no | 1Click API key, sent as `X-API-Key` (set either or both) |
| `ONECLICK_MODE` | no | `live` (default) or `simulated` (testnet only; fakes 1Click, nothing leaves NEAR) |

Get the account, key and mandate from the owner: `sdk/scripts/setup-key-agent.ts` prints `TREASURY_*` lines once (see `../sdk/README.md`).

## Claude Code (`.mcp.json` in your project)

```json
{
  "mcpServers": {
    "agent-treasury": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js"],
      "env": {
        "TREASURY_VAULT": "vault.owner.near",
        "TREASURY_NETWORK": "mainnet",
        "TREASURY_AGENT_ACCOUNT": "procurement.owner.near",
        "TREASURY_AGENT_PRIVATE_KEY": "<paste the function-call key printed by setup-key-agent>",
        "ONECLICK_JWT": ""
      }
    }
  }
}
```

Do not commit this file with the key in it: add `.mcp.json` to `.gitignore`, or reference an environment variable (`"TREASURY_AGENT_PRIVATE_KEY": "${TREASURY_AGENT_PRIVATE_KEY}"`, Claude Code expands `${VAR}`).
Same thing via CLI: `claude mcp add agent-treasury -e TREASURY_VAULT=... -e TREASURY_NETWORK=mainnet -e TREASURY_AGENT_ACCOUNT=... -e TREASURY_AGENT_PRIVATE_KEY=... -- node /ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js`

## Claude Desktop (`claude_desktop_config.json`)

macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`. Restart Claude Desktop afterwards.

```json
{
  "mcpServers": {
    "agent-treasury": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js"],
      "env": {
        "TREASURY_VAULT": "vault.owner.near",
        "TREASURY_NETWORK": "mainnet",
        "TREASURY_AGENT_ACCOUNT": "procurement.owner.near",
        "TREASURY_AGENT_PRIVATE_KEY": "<paste the function-call key printed by setup-key-agent>"
      }
    }
  }
}
```

## Any other MCP client (stdio)

Spawn `node /ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js` with the environment above and speak MCP over stdin/stdout. stdout carries the protocol; logs go to stderr.
Smoke test without a client: pipe an `initialize` request and `tools/list` into the process (see `test/server.test.ts` for the in-memory equivalent).
HTTP transport is not implemented yet.

## What happens inside `treasury_request_payment`

1. `/v0/tokens` (cached) resolves the USDC asset ids; the asset id is never built by hand.
2. Real 1Click quote (EXACT_INPUT, refund to the vault, no `msg`; deadline +30 min, +24 h above the approval threshold) gives the deposit address.
3. The quote is checked (recipient, destination asset, amount, refund address, 64-hex deposit address, deadline). Any mismatch aborts **before** anything is signed.
4. `request_payment` is signed with the function-call key (150 TGas, zero deposit).
5. On `submitted`: `/v0/deposit/submit`, then a background poll of `/v0/status` that calls `report_payout_status` on SUCCESS / REFUNDED / FAILED. The tool returns immediately.
   If this process is stopped before the end, calling `treasury_get_payment_status` on a `Sent` payment restarts the watch.

## Trading bot tools (optional, docs/adr/0007)

The same server can also drive ONE agent-driven trading bot on Hyperliquid spot. The agent decides the orders; the worker checks
every order against the limits the owner signed (same risk gate as rule-based bots) and executes it as an immediate-or-cancel order
inside the price band. The agent never holds Hyperliquid or NEAR keys and there is no withdraw tool.

| Tool | Input | Output |
|---|---|---|
| `trading_get_state` | none | `AgentState`: `can_trade`, signed `mandate` (pairs, limits, effective limits), `today` (orders / loss used and left), `positions` (own coins only, `sellable_size`), `pnl`, `markets` (mid, `sz_decimals`), `recent_fills`, `recent_orders`, `next_order_allowed_at_ms` |
| `trading_place_order` | `{ pair, side, usdc? \| position_pct? (sell only, 1..100), reason (1..200), idempotency_key? }` | `{ status: "filled" \| "partially_filled" \| "unfilled" \| "rejected", code, message, final, retry_after_s, order, fill, remaining_today, replayed, idempotency_key }` |

A `rejected` result with `final: true` is final (do not retry, split or reshape). `final: false` means the market or worker was
briefly unavailable; one retry after `retry_after_s` is allowed. HTTP errors (401 bad / expired / replaced token, 409, 429) come
back as `isError` with `{ error, message, idempotency_key }`. The tool retries once on a network error with the same `idempotency_key` (it generates
one when the model gives none), so a lost answer cannot place a second order. Every `trading_place_order` result, errors included,
carries the `idempotency_key` it used; passing that key again for the same order replays the first answer (the worker makes a
duplicate that arrives while the first is still running wait for it). `OUTCOME_UNKNOWN` (final) means the order was sent but no clean
answer came back: call `trading_get_state` before anything else. The client timeout is 300 s, above the worker's worst case for one
order (it may wait for a running tick, then runs its own: about 2 x 10 sequential HL / RPC calls x `HTTP_TIMEOUT_MS` 15 s). The
client never follows an HTTP redirect (`redirect: "error"`), so the token cannot be forwarded to another host. A Stop in the dashboard
revokes the token: every call then gets 401 until the owner re-signs (Resume), which shows a new token. `reason` is stored for the owner only; it is never
returned to the agent and never sent to an LLM by the worker.

| Variable | Required | Meaning |
|---|---|---|
| `TRADING_AGENT_TOKEN` | for trading | `atk1_<bot>_<key>`, shown ONCE by the dashboard after the owner signs the bot's limits. A re-sign (Resume / New key) replaces it. |
| `TRADING_WORKER_URL` | with the token | worker base URL. `https://`, or `http://` to `127.0.0.1` / `localhost` / `[::1]` only (no token over plain HTTP). |

Each section is optional: `TREASURY_VAULT` turns on the five payment tools, `TRADING_AGENT_TOKEN` the two trading tools, and at least
one must be set. The startup line on stderr says `trading=enabled bot=<id>`; the token is never printed.

```bash
claude mcp add agent-treasury-trading -e TRADING_WORKER_URL=http://127.0.0.1:3000 -e TRADING_AGENT_TOKEN=<token> -- node /ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js
```

## Security notes

- **Mandates are enforced in the contract.** The checks in this server and the SDK are previews (`treasury_quote_payment`); the vault re-checks everything and a rejection is final.
- **The key is limited.** A function-call key can only call `request_payment` and `report_payout_status` on the vault; it cannot transfer NEAR or call other contracts, and its gas allowance is capped (0.25 NEAR).
  Treat it as a spending credential anyway: it is exactly as powerful as the mandate. Keep it in the MCP client's `env`, never in git.
- **Memo is untrusted text.** It is stored and shown to the owner, never executed, and this server never returns it to the model as instructions (`treasury_get_payment_status` omits it).
- **Destination checks are declarative for key agents (ADR-0003 section 11).** The vault cannot see the 1Click quote, so Allowlist/Open check the destination the agent *declares*; a compromised key agent could quote to another address. The hard caps are its limits: `min_payment`, per-tx, daily amount, daily payment count (`max_payments_per_day`) and the vault's global daily limit. The approval threshold can be split into smaller payments; only the daily limits bind. For TEE agents the destination is meaningful because the code is attested.
- Payments above the approval threshold need `deposit_expires_at_ms` (the SDK always sends the 24 h quote deadline); pending payouts older than 72 h cannot be approved.
- **`Open` mode trusts the agent to quote to the destination it declares.** The vault cannot see what a 1Click deposit address pays out to. The cap is the mandate's limits (per-tx, daily, approval threshold, allowed chains). The SDK verifies the quote echo before signing, which protects against a faulty 1Click response, not against a compromised agent. Use `Allowlist` mode when destinations are known in advance.
- **Revocation is immediate on-chain** (`revoke_agent`); for Key agents also delete the access key from the account (`sdk/scripts/revoke-key-agent.ts` does both).
- Never split a rejected amount into smaller requests to get under a limit: the tool descriptions tell the model so, and the vault's daily limit still applies to the sum.
- Simulated 1Click is refused on mainnet, and at startup the server asks the RPC (`status` -> `chain_id`) and refuses unless it is really `testnet`.

## Development

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Built on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server` 2.4.0, stdio transport) and zod 4.
