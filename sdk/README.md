# agent-treasury-sdk

TypeScript SDK for an AI agent that pays from an Agent Treasury vault **within an on-chain mandate**.
Mandates are enforced by the vault contract; the checks in this SDK are previews only (AGENT_ACCESS.md section 10).

```ts
import { createTreasuryClient } from "agent-treasury-sdk";

const treasury = createTreasuryClient({
  vaultId: "vault.owner.near",
  network: "mainnet",
  agentAccountId: "procurement.owner.near",
  agentPrivateKey: process.env.TREASURY_AGENT_PRIVATE_KEY, // function-call key; omit for read-only
  oneclick: { baseUrl: "https://1click.chaindefuser.com", apiKey: process.env.ONECLICK_JWT, mode: "live" },
});

await treasury.getBudget();
await treasury.quotePayment({ chain: "base", address: "0x...", amountUsdc: "50" }); // preview + 1Click dry quote, no state change
const r = await treasury.requestPayment({ chain: "base", address: "0x...", amountUsdc: "50", memo: "invoice 42" });
// r.status: "rejected" (reason, detail) | "pending_approval" | "submitted" (payoutId, nearTx) | "transfer_failed"
await treasury.getPaymentStatus(r.status === "submitted" ? r.payoutId : "0");
```

Rules baked in:
- Amounts are decimal USDC strings (`"12.5"`), converted with bigint; at most 6 decimals; never floats.
- Chains are 1Click `blockchain` ids: `base`, `arb`, `sol`, `near`, `eth`, ... Aliases `solana`->`sol`, `arbitrum`->`arb`. USDC only; `tron` lists only USDT in 1Click, so it is refused with a clear error.
  Use the same ids in the mandate's `allowed_chains` (the contract compares strings).
- `requestPayment`: `/v0/tokens` (cached) -> real EXACT_INPUT quote (refundTo = vault, DESTINATION_CHAIN, no `msg`, deadline now+30 min, now+24 h above the approval threshold)
  -> verify the quote echo (recipient, asset, amount, refundTo, 64-hex deposit address, deadline) **before signing** -> `request_payment`
  -> on `Submitted`: `/v0/deposit/submit` and a background watch that calls `report_payout_status` on SUCCESS / REFUNDED / FAILED.
- Only `request_payment` and `report_payout_status` are ever signed (150 TGas, zero deposit).
- `oneclick.mode: "simulated"` fakes 1Click (testnet has no 1Click). It is refused on mainnet and, before first use, the SDK asks the RPC (`status` -> `chain_id`) and refuses unless it is really `"testnet"` (a label is not proof).
- If the signed call times out the SDK throws `AMBIGUOUS_SUBMISSION`: the transaction may have executed; check the payment list before retrying.

## Key agent setup (setup A)

```bash
pnpm install
# print the 3 planned transactions, send nothing:
pnpm setup-key-agent --owner owner.testnet --vault vault.owner.testnet --name procurement \
  --mandate examples/mandate.procurement.json --dry-run
# for real (reads OWNER_PRIVATE_KEY from the environment for this run only; prints the agent key ONCE):
OWNER_PRIVATE_KEY=ed25519:... pnpm setup-key-agent --owner owner.testnet --vault vault.owner.testnet \
  --name procurement --mandate examples/mandate.procurement.json
# revoke (vault.revoke_agent, then delete the access key):
OWNER_PRIVATE_KEY=ed25519:... pnpm revoke-key-agent --owner owner.testnet --vault vault.owner.testnet \
  --agent-id procurement --public-key ed25519:...
```

Mandate files use the contract JSON (amounts are USDC base units, 6 decimals; `"100000000"` = 100 USDC).
`examples/mandate.hl-trader.session.json` is the mainnet Hyperliquid trading session mandate (approval_threshold 0, daily 25, per-tx 25,
1 payment/day, allowlist `hypercore` + the owner's HL address). Before use replace the allowlist address with your HL master and
`expires_at` (placeholder `REPLACE_WITH_UNIX_MS_NOW_PLUS_48H_MAX`, a unix ms string, at most 48 h ahead, e.g. `$(( $(date +%s) * 1000 + 172800000 ))`);
the loader refuses the file until `expires_at` is a number.

Setup B (bring your own account): the owner only calls `add_agent` with that `account_id`.

## Development

`pnpm typecheck && pnpm lint && pnpm test && pnpm build`

## Security notes (ADR-0003 section 11)

- Mandates are enforced by the vault; this SDK only previews them. A rejection is final.
- For **key agents** the destination checks (Allowlist / Open chain and address) are *declarative*: the vault cannot see what a 1Click deposit address pays out to, so a compromised key could quote to another address. The hard caps are the mandate limits: per-tx, daily amount, daily payment count (`max_payments_per_day`), `min_payment`, and the vault's global daily limit. The approval threshold can be split into smaller payments; only the daily limits bind.
- For TEE agents the destination is meaningful because their code is attested to quote honestly.
- Above `approval_threshold` the contract requires `deposit_expires_at_ms` (the SDK always sends the quote deadline, 24 h for such payments); pending payments older than 72 h cannot be approved.
- 1Click auth: `oneclick.apiKey` is sent as `X-API-Key`, `oneclick.jwt` as `Authorization: Bearer`. `deposit/submit` uses the vault as `nearSenderAccount` (the actual token sender).
- Function-call keys cannot transfer NEAR or call other contracts; the memo is untrusted text.
