# Commands log

Every command used to set up, build, deploy and operate Agent Treasury, in order, so a human can replay it.
Mainnet commands are marked **[MAINNET]** and were run only after explicit human confirmation.

## Toolchain (2026-11-01)

```bash
rustup update stable && rustup default stable          # rustc 1.99.1
rustup target add wasm32-unknown-unknown
rustup component add rust-analyzer clippy rustfmt
cargo install --locked cargo-near near-cli-rs           # cargo near, near
```

## Agent tooling (optional, for Claude Code users)

```bash
git clone --depth 1 https://github.com/near/agent-skills /tmp/near-agent-skills
cp -R /tmp/near-agent-skills/skills/* .claude/skills/    # gitignored, see README
```

## Contract

```bash
brew install llvm                     # clang with wasm32 backend (needed by ring, via shade-attestation)
cd contract
cargo test                            # unit tests on host (stable rustc)
./build.sh                            # wasm via rustc 1.86.0 + Homebrew clang, -mcpu=mvp, --no-abi
# → contract/target-wasm/near/agent_treasury_vault.wasm
```

## Dashboard

```bash
cd dashboard
pnpm install                       # pnpm 11; pnpm-workspace.yaml sets allowBuilds: unrs-resolver: false
cp .env.example .env.local         # set VITE_VAULT_CONTRACT_ID
pnpm typecheck && pnpm lint && pnpm test
VITE_VAULT_CONTRACT_ID=vault.example.testnet pnpm build
pnpm dev                           # http://localhost:5173
```

## Worker

```bash
cd worker
# package.json written by hand, then:
pnpm add --save-exact @hono/node-server @neardefi/shade-agent-js@2.2.0 hono dotenv zod @near-js/providers@2.5.1 @near-js/types@2.5.1
pnpm add -D --save-exact typescript@5.9.3 @types/node@20.19.39 tsx vitest eslint @eslint/js typescript-eslint @neardefi/shade-agent-cli@2.4.0
pnpm typecheck && pnpm lint && pnpm test      # 47 tests, fake 1Click + fake vault, no network
pnpm build                                   # tsc -> dist/
pnpm dry-quote                               # read-only mainnet 1Click call: one dry:true quote, NEAR USDC -> Base USDC, 1 USDC (ran once, 2026-11-01)
pnpm dev                                     # local (insecure) worker; set DRY_RUN=true first
pnpm exec shade auth set near testnet create-new   # sponsor account for the agent (see worker/README.md)
pnpm exec shade plan && pnpm exec shade deploy     # TEE deploy; signs as vault owner via CLI credentials
```

Owner calls for the worker (1 yoctoNEAR each; `shade whitelist` / `shade deploy` approvals do not attach it, so they are disabled):

```bash
near contract call-function as-transaction <VAULT> whitelist_agent_for_local json-args '{"account_id":"<AGENT_ACCOUNT_ID>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config testnet sign-with-keychain send
near contract call-function as-transaction <VAULT> approve_measurements json-args '{"measurements":<MEASUREMENTS_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
near contract call-function as-transaction <VAULT> approve_ppids json-args '{"ppids":<PPIDS_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

Worker agent slot (A2, ADR-0003): the owner creates the `payroll` Tee agent before the worker can register (1 yoctoNEAR):

```bash
near contract call-function as-transaction <VAULT> add_agent json-args '{"id":"payroll","name":"Payroll","kind":"Tee","account_id":null,"public_key":null,"mandate":<MANDATE_JSON>}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
# payroll mandate example: {"daily_limit":"5000000","per_tx_limit":"2000000","approval_threshold":"1500000","allowed_chains":["base","sol","arb"],"recipients_mode":"Fixed","allowlist":[],"recipients":[0,1,2],"expires_at":null,"max_payments_per_day":10}
# if register_agent says the slot is bound to a live agent: near contract call-function as-transaction <VAULT> unbind_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
# payroll mandate example: {"daily_limit":"5000000","per_tx_limit":"2000000","approval_threshold":"1500000","allowed_chains":["base","sol","arb"],"recipients_mode":"Fixed","allowlist":[],"recipients":[0,1,2],"expires_at":null,"max_payments_per_day":10}
# if register_agent says the slot is bound to a live agent (no deposit):
near contract call-function as-transaction <VAULT> unbind_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

## SDK & MCP

```bash
# sdk/  (TypeScript SDK + key-agent scripts; no root workspace, each package has its own lockfile)
cd sdk
pnpm add --save-exact near-api-js@7.4.0 zod@4.6.7
pnpm add -D --save-exact typescript@5.9.3 @types/node@20.19.39 tsx@4.23.15 vitest@5.0.5 eslint@10.14.0 @eslint/js@10.0.1 typescript-eslint@8.72.1
pnpm typecheck && pnpm lint && pnpm test      # fake vault + fake 1Click, no network
pnpm build                                    # tsc -> dist/ (the MCP package links to it)

# Key agent (setup A). The dry run sends nothing and needs no key:
pnpm setup-key-agent -- --owner <OWNER> --vault <VAULT> --name procurement --mandate examples/mandate.procurement.json --dry-run
# Real run: OWNER_PRIVATE_KEY is read from the environment for this run only; the agent key is printed once.
OWNER_PRIVATE_KEY=ed25519:... pnpm setup-key-agent -- --owner <OWNER> --vault <VAULT> --name procurement --mandate examples/mandate.procurement.json   # add --confirm-mainnet --network mainnet for mainnet
OWNER_PRIVATE_KEY=ed25519:... pnpm revoke-key-agent -- --owner <OWNER> --vault <VAULT> --agent-id procurement --public-key ed25519:...

# mcp/
cd ../mcp
pnpm add --save-exact @modelcontextprotocol/server@2.4.0 zod@4.6.7 link:../sdk      # SDK linked by path (build ../sdk first)
pnpm add -D --save-exact @modelcontextprotocol/client@2.4.0 typescript@5.9.3 @types/node@20.19.39 tsx@4.23.15 vitest@5.0.5 eslint@10.14.0 @eslint/js@10.0.1 typescript-eslint@8.72.1
pnpm typecheck && pnpm lint && pnpm test && pnpm build
TREASURY_VAULT=<VAULT> TREASURY_NETWORK=testnet TREASURY_AGENT_ACCOUNT=<AGENT_ACCOUNT> node dist/index.js    # stdio server (read-only without TREASURY_AGENT_PRIVATE_KEY)
```

Schedule demo (owner, 1 yoctoNEAR; see worker/README.md "Schedule-based payroll"): `add_recipient`, then `add_schedule` with a `Once` schedule five minutes ahead:

```bash
START=$(( ($(date +%s) + 300) * 1000 ))
near contract call-function as-transaction <VAULT> add_schedule json-args "{\"schedule\":{\"recipient_id\":0,\"amount\":\"1000000\",\"frequency\":\"Once\",\"start_at\":\"$START\",\"end\":\"Never\",\"agent_id\":\"payroll\"}}" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```

## AI assistant

```bash
# worker/  (no new dependencies: plain fetch to NEAR AI Cloud, zod 4.6.7 already pinned)
cd worker
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # fake model server + fake RPC, no network, no key
pnpm exec vitest run test/ai                              # only the assistant tests (incl. docs/frequency-vectors.json)

# Live check (needs a real key in the environment; never commit it)
curl -s https://cloud-api.near.ai/v1/models | jq '.data[] | select(.owned_by=="nearai") | {id, supported_features}'
NEARAI_API_KEY=... AI_SESSION_SECRET=$(openssl rand -hex 32) pnpm dev     # without AI_SESSION_SECRET the /ai routes are not mounted
curl -s localhost:3000/ai/info
curl -s -X POST localhost:3000/ai/session/challenge        # sign {message, nonce, recipient} with the owner wallet (NEP-413), then POST /ai/session
curl -N -X POST localhost:3000/ai/chat -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"conversation_id":"c1","vault":"<VAULT>","owner_account":"<OWNER>","messages":[{"role":"user","content":"What do we pay this week?"}]}'
```

Worker TEE hardening (audit H1/M3): after the worker registered and its attestation was checked, pin the slot (1 yoctoNEAR); local mode on mainnet needs `ALLOW_INSECURE_LOCAL_MODE=true` in the worker and `allow_insecure_local_mode: true` in the vault's `new`:

```bash
near contract call-function as-transaction <VAULT> pin_agent json-args '{"agent_id":"payroll"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as <OWNER> network-config <NETWORK> sign-with-keychain send
```
