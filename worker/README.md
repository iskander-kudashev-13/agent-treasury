# Agent Treasury worker

TypeScript agent that asks the vault to pay due recipients through NEAR Intents (1Click). It is the TEE agent `payroll` (`AGENT_ID`) with a
`Fixed` mandate: it can only call `request_payout` (for its schedules) / `report_payout_status`; the vault enforces every rule
(`docs/adr/0002-payout-flow-and-trust-boundaries.md`, `docs/adr/0003-agents-and-mandates.md`).

Derived from [NearDeFi/shade-agent-template](https://github.com/NearDeFi/shade-agent-template) (Apache-2.0): registration plumbing
(`ShadeClient.create`, `register`, re-register every 6 days), Dockerfile, docker-compose, deployment.yaml. The oracle logic is replaced.
License of this directory: Apache-2.0 for template-derived files, MIT for the rest of the repo.

Status: local mode runs end to end against the testnet vault `at-vault-11012309.testnet` with simulated 1Click (2026-11-01/02, see `../docs/deployments.md`). Not yet run in a TEE or against real 1Click on mainnet.

## Run modes

| `RUN_MODE` | What | Secure? |
|---|---|---|
| `local` | No TEE. Agent key derived from `SPONSOR_PRIVATE_KEY`; owner must whitelist the agent account on the vault. On mainnet the worker refuses to start unless `ALLOW_INSECURE_LOCAL_MODE=true` (and logs a red warning). The vault itself must have been initialised with `allow_insecure_local_mode: true` (`Contract::new`). | **NO. Insecure development mode.** |
| `tee` | Phala Cloud (dstack). Keys are generated inside the TEE; vault checks attestation (measurements + PPID). | Yes, once measurements are approved on the vault. |

`DRY_RUN=true` (default): the loop only requests `dry: true` quotes. It never calls `request_payout` or `report_payout_status`.

## 1. Verify 1Click works (M0, read-only, no funds)

```bash
cd worker && pnpm install --frozen-lockfile
pnpm dry-quote
```
Expected: `token ok: USDC on near`, `token ok: USDC on base`, then a JSON quote with `"dry": true`, `quote.amountIn` = `"1000000"`,
`quote.amountOut` around `997000`, and no `depositAddress`.

## 2. Check the code

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all tests pass (fake 1Click, fake vault and fake RPC; no network).

## 3. Configure

```bash
cp .env.example .env     # then edit; .env is gitignored
```
Required: `VAULT_CONTRACT_ID`. When `DRY_RUN=false` also `SPONSOR_ACCOUNT_ID` and `SPONSOR_PRIVATE_KEY`
(create a funded dev account: `pnpm exec shade auth set near testnet create-new`). All variables: `.env.example`, validated in `src/config.ts`.

## 3b. Create the agent slot (owner, once)

The worker registers into a slot the owner creates first (`register_agent({ agent_id, attestation })`, no deposit). `<MANDATE_JSON>` is the
`Mandate` of ADR-0003, e.g. `{"daily_limit":"5000000","per_tx_limit":"2000000","approval_threshold":"1500000","allowed_chains":["base","sol","arb"],"recipients_mode":"Fixed","allowlist":[],"recipients":[0,1,2],"expires_at":null,"max_payments_per_day":10}`:
```bash
near contract call-function as-transaction <VAULT> add_agent json-args '{"id":"payroll","name":"Payroll","kind":"Tee","account_id":null,"public_key":null,"mandate":<MANDATE_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```
`shade-agent-js` 2.2.0 `register()` cannot be used with this vault (it sends `register_agent({ attestation })` plus a deposit and checks
`get_agent({ account_id })`), so `src/near.ts` builds the call itself from `getAttestation()`.

## 4. Run locally (insecure dev mode)

```bash
# DRY_RUN=true in .env, VAULT_CONTRACT_ID set to a deployed vault
pnpm dev
curl localhost:3000/status      # agentId, agentAccountId, registration, budget, lastRejections, lastRun, nextRunAt
curl localhost:3000/runs        # recent runs (ring buffer of 50)
```
To let the agent register in local mode the vault owner whitelists the printed `agentAccountId` (needs 1 yoctoNEAR; replace `<OWNER>`, `<VAULT>`, `<AGENT_ACCOUNT_ID>`):
```bash
near contract call-function as-transaction <VAULT> whitelist_agent_for_local json-args '{"account_id":"<AGENT_ACCOUNT_ID>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config testnet sign-with-keychain send
```
Local mode also needs the mock (all-zero) measurements and the default PPID approved once (same call shape, `approve_measurements` / `approve_ppids`,
1 yoctoNEAR); the vault checks for them in local mode. Then `curl localhost:3000/status` shows `registration.state: "registered"`.
`shade whitelist` does NOT work with this vault: shade-agent-cli 2.4.0 sends the call without any attached deposit
(`dist/src/commands/whitelist/index.js`, `callFunctionRaw` has no `deposit`), and the vault requires 1 yoctoNEAR.

To trigger a run now (needs `WORKER_ADMIN_TOKEN` in `.env`; without it the endpoint is disabled):
```bash
curl -X POST -H "Authorization: Bearer $WORKER_ADMIN_TOKEN" localhost:3000/run     # 202, then watch GET /runs
```

Live payouts (moves real USDC on mainnet 1Click, only with the human's explicit go-ahead): set `DRY_RUN=false`.
1Click has no testnet; amounts must stay tiny.

## 4b. Reproduce on testnet without 1Click (`ONECLICK_MODE=simulated`)

1Click has no testnet. For judges and CI the worker can replace it with an offline simulation:
```bash
# .env: NEAR_NETWORK=testnet  ONECLICK_MODE=simulated  DRY_RUN=false  (SIMULATED_OUTCOME=success|refunded)
pnpm dev
```
Quotes are synthesized locally with the real response shape; every real quote gets a fresh random 64-hex deposit address; `deposit/submit`
is a no-op; status is immediately `SUCCESS` (or `REFUNDED`). The vault really moves testnet tokens to that address, but **nothing is
delivered cross-chain**. The worker logs `SIMULATED 1CLICK — no cross-chain transfer` and `/status` shows `oneclickMode: "simulated"`.
The config refuses `simulated` when `NEAR_NETWORK=mainnet`.

## 5. Deploy in a TEE (M4)

**Pinned configuration (audit H1).** In `RUN_MODE=tee` the values that decide where money goes are fixed by the measured image:
`tee.config.json` (baked into the image) and the matching **literals** in `docker-compose.yaml`: `NEAR_NETWORK`, `VAULT_CONTRACT_ID`,
`AGENT_ID`, `ONECLICK_BASE_URL`, `ONECLICK_MODE` (always `live`), `DRY_RUN`. Env values are not measured, so the worker **refuses to start** if
its env sets any of them to something else (or sets `NEAR_RPC_URL`), or if `tee.config.json` is missing or still has a placeholder.
Edit both files together before `shade deploy`; changing either changes the measurements, so the owner must approve the new ones.
`test/tee-config.test.ts` checks that the two files agree.

```bash
cd worker
# deployment.yaml: set agent_contract.contract_id (= vault id) and build_docker_image.tag; environment: TEE
pnpm exec shade plan
pnpm exec shade deploy        # builds image and deploys to Phala (approvals are disabled in deployment.yaml, see below)
```
`shade deploy` cannot approve measurements/PPIDs for this vault (no attached deposit, vault needs 1 yoctoNEAR), so the owner does it with near-cli-rs
using the values for the deployed image (`<MEASUREMENTS_JSON>` = `{"rtmrs":{"mrtd":..,"rtmr0":..,"rtmr1":..,"rtmr2":..},"key_provider_event_digest":..,"app_compose_hash_payload":..}`,
`<PPIDS_JSON>` = JSON array of PPID strings; how to read them for a Phala deployment is not yet verified, see open items in the M4 notes):
```bash
near contract call-function as-transaction <VAULT> approve_measurements json-args '{"measurements":<MEASUREMENTS_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
near contract call-function as-transaction <VAULT> approve_ppids json-args '{"ppids":<PPIDS_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```
Then `curl <app-url>/status` shows `mode: "tee"` and an `attestation` summary (compose hash, RTMRs). Read `pnpm exec shade plan` before `shade deploy`.

## Schedule-based payroll (ADR-0004)

Recipients are an address book (chain, asset, address). Amount and timing live in **schedules**, each naming the agent that pays it
(`payroll`). The worker pays what `get_due({agent_id})` returns. To see it work end to end, add one recipient and a `Once` schedule a few
minutes ahead (owner, 1 yoctoNEAR each; `<ASSET>` is the 1Click `assetId` from `/v0/tokens`, e.g. Base USDC
`nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near`; the payroll mandate must list recipient `0` and chain `base`):
```bash
near contract call-function as-transaction <VAULT> add_recipient json-args '{"recipient":{"label":"Demo","destination_chain":"base","destination_asset":"<ASSET>","destination_address":"<0x...lowercase>"}}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
START=$(( ($(date +%s) + 300) * 1000 ))     # five minutes from now, ms
near contract call-function as-transaction <VAULT> add_schedule json-args "{\"schedule\":{\"recipient_id\":0,\"amount\":\"1000000\",\"frequency\":\"Once\",\"start_at\":\"$START\",\"end\":\"Never\",\"agent_id\":\"payroll\"}}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```
After `START` the schedule appears in `/status` under `due`; the next loop run (or `POST /run`) pays it once. Weekly / monthly examples:
`"frequency":{"Weekly":{"weekday":5}}` (0 = Sunday), `"frequency":{"Monthly":{"day":28}}`, `"frequency":{"EveryNDays":{"n":14}}`.
A schedule more than `overdue_grace_ms` (default 3 days) past due is **overdue**: the vault parks it for owner approval
(`OVERDUE_NEEDS_APPROVAL`) instead of paying.

## Payout flow (per due schedule)

1. `get_agent_budget({agent_id})`: stop if the vault is paused or the agent is not `Active`. Then pick up this agent's `Sent` payouts that were never reported (see step 8).
2. `get_due({agent_id})` returns schedules (`overdue` flag included); the recipient's chain, asset and address come from `get_recipient({recipient_id})`.
3. Asset ids must exist in `GET /v0/tokens` (cached 10 min); `destination_chain` must equal the token's `blockchain`.
4. `POST /v0/quote` `dry: true` (sanity), then `dry: false` (deposit address). The real quote is valid 30 min, or 24 h when the item is `overdue` or the amount is above the agent's `approval_threshold` (so the owner has time to approve).
5. Checks before paying (`src/quote-check.ts`): recipient, destination asset, origin asset, `amountIn` = schedule amount, `refundTo` = vault,
   no `msg`, `depositAddress` is 64-hex, `deadline` at least 5 min away. Any failure aborts before `request_payout`.
6. `request_payout({schedule_id, deposit_address, deposit_expires_at_ms})` (150 TGas, 0 deposit; the deadline is always sent). Never retried:
   if the call errors or its result is not understood, the worker re-reads schedule/payout state. `PaymentResult` handling:
   - `Rejected{reason,detail}`: recorded in the run (`outcome: "rejected"`), not retried (e.g. `SCHEDULE_NOT_FOUND`, `SCHEDULE_NOT_ACTIVE`, `NOT_DUE`); the vault also logs it (`/status.lastRejections`).
   - `PendingApproval{payout_id, reason}`: skipped, `reason` (`ABOVE_THRESHOLD` | `OVERDUE_NEEDS_APPROVAL`) is logged. After the owner approves, the vault transfers by itself and the payout shows up as `Sent` (step 8).
   - `TransferFailed{payout_id}`: recorded as failed; the vault released the reservation.
   - `Submitted{payout_id}`: the payout must show our deposit address in state, then continue.
7. `POST /v0/deposit/submit`, poll `GET /v0/status` (bounded, exponential backoff), `report_payout_status`.
8. A poll timeout leaves the payout `Sent`; every run first polls this agent's `Sent` payouts (`get_agent_payouts_count` + `get_payouts({agent_id, from_index})`, paged from the end) and reports terminal ones. This also covers owner-approved payouts.

`/status` also returns `due` (schedules payable now) and `upcoming` (next 5 of `get_upcoming` over 7 days).

## AI assistant (`/ai`, optional)

Backend of the dashboard chat panel (UI_UPDATES.md section 6). The assistant reads the vault over NEAR RPC and only PREPARES changes as typed
proposals; the owner signs them in the wallet. It has no key and no signing code: `src/ai` receives a read-only `view` function.
Inference runs on NEAR AI Cloud (OpenAI-compatible, `NEARAI_BASE_URL`), the key stays in the worker env.

```bash
# worker/.env
NEARAI_API_KEY=...                 # from https://cloud.near.ai (never commit)
AI_SESSION_SECRET=$(openssl rand -hex 32)   # required: without it the /ai routes are NOT mounted (a warning is logged)
NEARAI_MODEL=z-ai/glm-5.3-flash    # default; must support tools. owned_by "nearai" in GET /v1/models = confidential TEE
pnpm dev
curl -s localhost:3000/ai/info     # -> { model, provider: "NEAR AI Cloud", private, tier, attestation }
```

Sign-in (owner only, NEP-413; the dashboard does this with the wallet's `signMessage`):
1. `POST /ai/session/challenge` -> `{ nonce (32 bytes, base64), message: "Agent Treasury assistant session for <vault>", recipient: <vault>, expires_at }` (valid 5 min, single use).
2. Wallet signs `{message, nonce, recipient}` (NEP-413, ed25519 over sha256 of the borsh payload with tag 2^31+413).
3. `POST /ai/session` `{ accountId, publicKey, signature (base64), nonce, callbackUrl? }`. The worker verifies the signature, that `publicKey` is a FULL-ACCESS key of `accountId` (RPC `view_access_key`) and that `accountId` is the vault's `owner_id`. Returns `{ token, account_id, expires_at }` (HMAC token, 1 h).
4. `POST /ai/chat` with `Authorization: Bearer <token>` and body `{ conversation_id, messages: [{role, content}], vault, owner_account }`. `owner_account` must equal the signed-in account; ownership is re-checked (60 s cache).
   Response: SSE events `text`, `proposal`, `question`, `data`, `done` | `error`.

- `vault` must equal `VAULT_CONTRACT_ID` (403 otherwise). Without `NEARAI_API_KEY` the stream contains a single `error` event. 400 malformed, 401 no/expired session, 413 too large, 429 rate limit (`AI_RATE_LIMIT_PER_MIN` per IP).
- Only `user`/`assistant` roles are accepted; limits `AI_MAX_MESSAGES`, `AI_MAX_MESSAGE_CHARS`, `AI_TIMEOUT_MS`.
- Proposals are validated server-side against fresh contract state (address format per chain, mandate compatibility, limits, approval threshold). Invalid ones are still emitted with `validation.errors` and fed back to the model.
- Recipient `destination_asset` is the USDC `assetId` from 1Click `/v0/tokens` (cached; synthesized in `ONECLICK_MODE=simulated`). Tron is refused (only USDT exists on Tron in 1Click). Chains the assistant accepts: base, arb, eth, sol.
- Addresses in `AddRecipient` must appear in the owner's own messages; text from chain data (names, memos, rejection details) reaches the model only as `untrusted_*` fields.
- `/ai/info` fetches the NEAR AI attestation report (needs the key) but does NOT verify the TDX/NVIDIA evidence: `attestation.status` is `fetched_unverified`; verify at https://cloud.near.ai/verify.

Known limitations (v1): batches that depend on each other (new recipient + schedule + mandate change) are only linked within one assistant turn, because proposals are not part of the history the browser sends back; the NEAR AI attestation is fetched, not verified, by the worker; behind a proxy set `AI_TRUST_PROXY=true` or rate limits key on the socket address; sessions and challenges are in memory (a restart signs everyone out); model behaviour with real tool calls has only been tested against a scripted fake.

## Files

| File | Purpose |
|---|---|
| `src/config.ts` | env parsing (zod) |
| `src/oneclick.ts` | 1Click client (timeouts, typed errors, tokens cache) |
| `src/vault.ts` | vault views (RPC) and agent calls (`ShadeClient.call`) |
| `src/quote-check.ts` | pre-payment quote verification |
| `src/payout-loop.ts` | single-flight loop, run ring buffer |
| `src/near.ts` | ShadeClient, registration loop, attestation summary |
| `src/app.ts`, `src/index.ts` | Hono API, bootstrap |
| `scripts/dry-quote.ts` | M0 script |
| `Dockerfile`, `docker-compose.yaml`, `deployment.yaml` | TEE packaging (shade-agent-cli 2.4.0) |

After the worker shows `registration.state: "registered"` and `/status.attestation` matches what you deployed, the owner should pin the slot so no
other instance of the approved image can take it over (1 yoctoNEAR):
```bash
near contract call-function as-transaction <VAULT> pin_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

## Simulated 1Click safety

`ONECLICK_MODE=simulated` is refused unless the RPC itself reports `chain_id == "testnet"` (checked with the `status` RPC at start) and the vault
id does not end in `.near`; the `NEAR_NETWORK` label alone is not trusted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/status` `registration.lastError` contains "bound to another live agent account" | The slot is bound to an older, still valid enclave. Owner runs `unbind_agent({agent_id})` (1 yoctoNEAR), then the worker's next attempt binds. |
| `outcome: "rejected"` in `/runs` | Read `message` (vault reason code + detail); also `/status.lastRejections`. Not retried within the run. |
