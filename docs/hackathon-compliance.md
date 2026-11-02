# NEAR HACKATHON compliance checklist

Checked on 2026-11-02 against branch `feat/kit-foundation` (HEAD `52c61da` plus uncommitted doc fixes listed at the end).
Sources: live https://nearhackathon.com/HACKATHON.md (fetched 2026-11-02), track prompts `06-security`, `04-business`,
`08-realworld` and `SUBMITTING.md` from https://github.com/nearai/near-hackathon-prompt-examples, `CLAUDE.md` §2.

Status: **OK** = met, with evidence. **GAP** = not met yet, the repo/agents can fix it. **NEEDS HUMAN** = only the human
can do or decide it.

## Live HACKATHON.md vs local copy

`diff HACKATHON.md <live>` on 2026-11-02 showed one difference: the live file adds an Ecosystem row
`| Gulf Labs | Invests in blockchain infrastructure |  | https://gulf-labs.com/ |  |` (live line 219). No rule, date, track
or API field changed. Local `HACKATHON.md` was replaced with the live copy (sha256
`f4c07981fca7511d56060962d831154160889b72c7c9f6c3ed962c6cd9712795`). Re-fetch before submitting (HACKATHON.md line 4).

## 1. Submission requirements

| # | Rule (source) | Status | Evidence / action |
|---|---|---|---|
| 1.1 | Repo public by 2026-11-14T23:59:00Z (HACKATHON.md "Start here" 2, Procedure 1) | **NEEDS HUMAN** | `gh repo view` → `"visibility":"PRIVATE"`, `https://github.com/iskander-kudashev-13/agent-treasury`. Only the human may make it public. |
| 1.2 | Judges must see the code (Procedure 1, Q-012) | **GAP** | `origin/main` contains only `c6144b6 Initial commit` (LICENSE). `feat/kit-foundation` (13 commits ahead of `main`) is not pushed: `git branch -a` shows no `origin/feat/kit-foundation`. Human reviews the diff → merge to `main` → push (CLAUDE.md §0 Git). |
| 1.3 | Demo post on X: says "built at NEAR HACKATHON", tags `@NEARProtocol` and `#NEARHackathon`, video attached (Start here 3, Procedure 2) | **NEEDS HUMAN** | Not posted. Draft checklist exists: `docs/demo-script.md:93`. Q-012: local-only demo needs a **video** (screenshots are not enough because judges cannot open the demo). |
| 1.4 | Submission once, POST `/api/applications` or form, only after the human confirms the printed payload (Procedure 3) | **NEEDS HUMAN** | Not submitted. Window 2026-11-01T00:00Z – 2026-11-14T23:59Z; outside it the API returns 403. Payload must not be committed (personal data). |
| 1.5 | Form fields decided by the human, not guessed (What the human decides) | **NEEDS HUMAN** | See "Questions for the human" below. Tracks currently declared in README: `security`, `business`, `realworld` (`README.md:9`); all three are valid ids. |
| 1.6 | Mainnet NEAR account for the prize payout (SUBMITTING.md) | **NEEDS HUMAN** | Must be created by the team; never invented by an agent. |
| 1.7 | Hosted demo is a plus, keep it up to 2026-11-18 (ideally 11-25) (Q-012) | **GAP** (optional) | No hosted dashboard. The dashboard is a static SPA (`dashboard/dist/`), so it can be hosted read-only against the testnet vault. |

## 2. README for AI screening (Procedure 1, Q-017, prompts README)

| # | Rule | Status | Evidence |
|---|---|---|---|
| 2.1 | What the product is and the problem | **OK** | `README.md:3-16` (intro + "Problem"). |
| 2.2 | "Do X → see Y" steps | **OK** | `README.md` Quickstart A–E (from line 74): every command has an expected output (test counts, view-call JSON, dashboard text, MCP stdout). |
| 2.3 | No marketing | **OK** | Plain technical tone; "Not done yet" table states gaps (`README.md` Status section). |
| 2.4 | How NEAR is used, named concretely (Tracks: "name them in the README") | **OK** | `README.md:18-27` table: vault contract, function-call keys, Shade Agent, 1Click, NEAR AI Cloud, wallet-selector — each with an honest status column. |
| 2.5 | Honesty about what was not run | **OK** | `README.md:24-26` and "Not done yet": no real TEE, no mainnet payout, NEAR AI not run live. |
| 2.6 | Paths a judge can run without keys/accounts | **OK** (fixed) | Paths A, B, C, D1 need no account or key. The README said "Paths A–D"; corrected to "A, B, C and D1" because D2 needs an owned testnet vault. |

## 3. Reproducibility

| # | Check | Status | Evidence |
|---|---|---|---|
| 3.1 | Path A from a **clean clone** of `feat/kit-foundation` | **OK** (README counts fixed) | `git clone --branch feat/kit-foundation` (HEAD `52c61da`), then the README loop with `pnpm install --frozen-lockfile`: sdk/mcp/worker/dashboard install, typecheck, lint, build all OK; tests sdk 80, mcp 17, worker **128**, dashboard **237** passed. Contract: `cargo fmt --check` OK, `clippy -D warnings` clean, `cargo test` **174 passed** (60 s). README said 165 / 110 / 234 (stale after `8d6c70a`); updated in `README.md` path A and Status. |
| 3.2 | Path B: live testnet vault answers | **OK** | Read-only RPC `get_contract_info` on `at-vault-11012309.testnet` (2026-11-02) → `"owner_id":"at-owner-11012309.testnet"`, `"requires_tee":false`, `"version":"0.1.0"`, matches `README.md:123`. |
| 3.3 | 1Click reachable read-only | **OK** | `GET https://1click.chaindefuser.com/v0/tokens` → HTTP 200. |
| 3.4 | Testnet vault stays up through judging (Q-012: until 2026-11-18, ideally 11-25) | **NEEDS HUMAN** | Keep `at-vault-11012309.testnet` funded and unchanged; values in path B are dated 2026-11-02 and drift with use. |
| 3.5 | No mainnet actions required for judges (Q-007, Q-010, CLAUDE.md §2) | **OK** | All paths are offline, testnet, or read-only mainnet 1Click (`pnpm dry-quote`, `dry: true`, no key). Testnet-only projects are eligible (Q-010). |
| 3.6 | `skills/` referenced in layout | **OK** (doc fixed) | Directory is empty and not tracked by git; README now says it is absent in a clone. |

## 4. License (Q-014, CLAUDE.md §2)

| # | Check | Status | Evidence |
|---|---|---|---|
| 4.1 | `LICENSE` file, MIT | **OK** | `LICENSE:1` "MIT License", `Copyright (c) 2026 Kudashev Iskander`; GitHub detects `"licenseInfo":{"key":"mit"}`. |
| 4.2 | Per-package fields | **OK / NEEDS HUMAN** | `contract/Cargo.toml:8` `license = "MIT"`; `sdk`, `mcp`, `dashboard` `package.json` → `MIT`; `worker/package.json` → `Apache-2.0` (since `b6fb0e6`). `worker/README.md:9` says Apache-2.0 only for template-derived files, MIT for the rest. The field over-declares Apache-2.0 for the whole package. Not changed (licensing decision): human picks `"MIT AND Apache-2.0"` (accurate SPDX expression) or keeps it. README License section now states the per-file split. |
| 4.3 | Upstream template license | **OK** | `gh api repos/NearDeFi/shade-agent-template` → `"spdx_id":"Apache-2.0"`; pinned commit `816b75b` (2026-06-09) exists. |
| 4.4 | Apache-2.0 §4(a) copy of the license, §4(d) NOTICE, upstream NOTICE "Retain this NOTICE file in full" | **OK** (fixed) | Was a GAP: no Apache license text or NOTICE in the repo. Added `third_party/shade-agent-template/LICENSE` and `NOTICE.txt` (verbatim from `816b75b`) and `third_party/shade-agent-template/README.md` listing derived files. |
| 4.5 | §4(b) modified files carry a change notice | **OK** | Headers: `contract/src/agent.rs:3-4`, `contract/src/lib.rs:480`, `Dockerfile.worker:1`, `worker/docker-compose.yaml:1`, `worker/deployment.yaml:1`, `worker/src/index.ts:2`, `worker/src/near.ts:2`. Upstream files have no SPDX/copyright headers to preserve (checked `agent-contract/src/lib.rs`, `internal/attestation.rs`, `Dockerfile`, `docker-compose.yaml` at `816b75b`). |
| 4.6 | Upstream `LICENSE-THIRD-PARTY.txt` | **OK** (judgement) | Covers the template's own npm/cargo dependencies (frontend etc.). This repo does not vendor them; its dependencies come from its own lockfiles. Not copied. |

## 5. Disclosures (Q-005, Q-002, CLAUDE.md §2)

| # | Check | Status | Evidence |
|---|---|---|---|
| 5.1 | Templates | **OK** | `README.md` Disclosures: shade-agent-template @816b75b with the derived files; near/agent-skills used locally, not committed (`.gitignore` `.claude/skills/near-*/`). |
| 5.2 | Libraries vs manifests | **OK** | Every runtime dependency in `contract/Cargo.toml` (`near-sdk` 5.26.1, `shade-attestation` 0.2.0, `serde` 1.0.228, `hex` 0.4.3) and in `worker`, `sdk`, `mcp`, `dashboard` `package.json` is listed with the same version. Dev tooling is listed summarily (TypeScript 5.9.3, vitest 5.0.5, eslint, tsx); the dashboard dev plugins (`@vitejs/plugin-react`, `@tailwindcss/vite`, `eslint-plugin-react-hooks`, `globals`) fall under "Tooling … eslint" and exact versions are in `package.json`. |
| 5.3 | Fonts / external assets | **OK** (fixed) | Inter and JetBrains Mono from Google Fonts (`dashboard/index.html:9-11`, all `design-kit/**/canvas/*.dc.html`) were not disclosed. Added a "Fonts" line (OFL-1.1, loaded at runtime, not committed). |
| 5.4 | AI-generated code | **OK** | `README.md` Disclosures "AI-generated code": code, tests and docs written with Claude Code agents, reviewed by the author. |
| 5.5 | `design-kit/` origin | **OK** (fixed) | `design-kit/agent-treasury-design/README.md:30` says the `.dc.html` files are Claude Design canvas artboards. README now states the design kit was produced with Claude Design. |
| 5.6 | External services | **OK** | README lists FastNEAR RPC, 1Click, NEAR AI Cloud, Circle faucet. |
| 5.7 | Existing product on another chain (Q-002) | **OK** | README "Hackathon work and baseline": none. |
| 5.8 | Same person, second project (Q-015) | **NEEDS HUMAN** | If Iskander submits another project, each README must name the other one. |

## 6. Baseline / work done in the window (Q-001, Q-003, Q-004)

| # | Check | Status | Evidence |
|---|---|---|---|
| 6.1 | All code written in the window (from 2026-10-19) | **OK** | `git log --all`: first commit `c6144b6` 2026-11-01T16:08+03:00 (= 13:08 UTC, LICENSE only); all other commits 2026-11-01/02. |
| 6.2 | Branch/tags separating baseline (Q-003) | **OK** (not required) | No pre-hackathon code, so no baseline to separate; README "Hackathon work and baseline" states this. Optional: tag `hackathon-submission` on the submitted commit so judges see exactly what was submitted (human creates it). No tags exist now (`git tag` empty). |
| 6.3 | Commit timestamps | note | Commits `d67f338`…`36ed4dd` share one timestamp (2026-11-01T22:46:48+04:00) and three share 2026-11-02T21:50:16, i.e. history was squashed/re-committed. All inside the window; no action needed, but do not rewrite dates. |
| 6.4 | Old project as-is not allowed (Q-004) | **OK** | New repo. |

## 7. Secrets (HACKATHON.md "Never…", SUBMITTING.md, CLAUDE.md §2)

| # | Check | Status | Evidence |
|---|---|---|---|
| 7.1 | `git log -p --all` (62 186 lines) for NEAR private keys | **OK** | `ed25519:` strings ≥ 30 chars: two, both harmless — `ed25519:3kR9vY2mQ8xTn4LpZsB7wHcE1dFj6GuA5oNq0Xi` (fake UI sample, contains `0`, not valid base58) and `ed25519:6E8s…KEtp` (44 chars = a public key, in a contract test). No 88-char secret keys. `secp256k1:` none. |
| 7.2 | JWTs, API keys, PEM, cloud tokens | **OK** | `eyJ….…` none; `sk-…` none; `AKIA`, `ghp_`, `github_pat_`, `xox?-` none; `BEGIN … PRIVATE KEY` none. Assignments `*_KEY=`/`SECRET=`/`TOKEN=` with values: only placeholders (`ed25519:...`, `ed25519:SECRET` in a test, `$(openssl rand -hex 32)`). |
| 7.3 | `.env` files ever committed | **OK** | Files ever added matching `.env`: only `.env.example`, `dashboard/.env.example`, `mcp/.env.example`, `sdk/.env.example`, `worker/.env.example`. |
| 7.4 | Local secret files ignored | **OK** | `git check-ignore -v`: `worker/.env` (`.gitignore:2`), `mcp/.env.claudeagent` (`.gitignore:3` `.env.*`), `dashboard/.env.local` (`dashboard/.gitignore:5`). The private-key and token values in these files do not occur in history or the tracked tree (only public values such as account ids and the USDC contract do). |
| 7.5 | Working tree | **OK** | `git status --ignored`: untracked only `docs/STATUS.md` (no key patterns); ignored: `.env` files, `node_modules`, `dist`, `target`, `.claude/skills/`, `.playwright-mcp/`, `.DS_Store`. `.claude/settings.json` (tracked) holds only `enabledPlugins`. |
| 7.6 | Personal data / submission payload not committed | **OK** | No email address or submission payload in tracked files (`git grep` for `@gmail`, `requestId` hits only `HACKATHON.md` examples). |

## 8. Env templates and .gitignore

| # | Check | Status | Evidence |
|---|---|---|---|
| 8.1 | `worker/.env.example` | **OK** | Covers every key in the zod schema `worker/src/config.ts:14-56` (28 names). |
| 8.2 | `dashboard/.env.example` | **OK** | Covers every `VITE_*` used in `dashboard/src`; legacy fallbacks `VITE_VAULT_CONTRACT_ID`, `VITE_NEAR_RPC_URL` are documented on its last line. |
| 8.3 | `mcp/.env.example` | **OK** (fixed) | `mcp/src/config.ts:19,21` read `ONECLICK_API_KEY` and `SIMULATED_OUTCOME`, missing from the template; added as commented optional lines. |
| 8.4 | `sdk/.env.example` | **OK** | `OWNER_ACCOUNT_ID`, `OWNER_PRIVATE_KEY` (commented) = all env read by `sdk/scripts`. |
| 8.5 | Root `.env.example` | **OK** (fixed) | Pointed only to worker/dashboard templates; now lists all four. `PHALA_API_KEY` there is for `shade-agent-cli` (tee mode). |
| 8.6 | `contract/` needs no env | **OK** | Contract builds/tests without env. |
| 8.7 | `.gitignore` coverage | **OK** | `.env`, `.env.*` (+`!.env.example`), `*.pem`, `*-key.json`, `.near-credentials/`, `target/`, `node_modules/`, `dist/`, `*.log`, `.claude/settings.local.json`, `.claude/worktrees/`, `.playwright-mcp/`, `.DS_Store`. Nothing added. |
| 8.8 | Worker CORS default vs dashboard dev port | OK | Fixed 2026-11-02: default `DASHBOARD_ORIGIN=http://localhost:5173` in `worker/src/config.ts` and `worker/.env.example`. |

## 9. Tracks and NEAR technology (Tracks table, track prompts, Q-011)

Hints and prompt requirements are not mandatory (Q-011: "Own contract on NEAR that fits the track is enough").

| Track | Hints / prompt asks | Status | Evidence |
|---|---|---|---|
| `security` | spending limits, policy engine, sandboxed wallets; function-call keys; TEE attestation | **OK** (TEE partial) | Mandate checks in the vault; key agents use function-call keys restricted to `request_payment`/`report_payout_status` with the key limits explained (`README.md:23`, Security model). Attack demo: rejections `RECIPIENT_NOT_ALLOWED`, `PER_TX_LIMIT_EXCEEDED` on testnet (`README.md` path B / Status). TEE attestation code exists but ran only in local mode (`requires_tee: false`). Prompt's "prompt-injected agent script with log" exists only as tests/docs (`worker/test/ai-chat.test.ts`, `docs/architecture.md`), not as a standalone script. |
| `business` | AI agents, NEAR Intents, Chain Signatures; kill switch; public ledger | **OK** (Intents partial) | Agents + mandates, kill switch = `pause`, payout/rejection log in the dashboard. 1Click integration built; no real cross-chain payout yet (`README.md:25`). Chain Signatures not used. |
| `realworld` | stablecoins, NEAR Intents, meta transactions; payroll | **OK** (Intents partial) | USDC NEP-141 payroll with schedules. Meta transactions not used; no CSV export. |
| all | Real 1Click mainnet payout (Q-007: mainnet, dev accounts, tiny amounts) | **NEEDS HUMAN** | Not done; needs the human's explicit go-ahead for the exact mainnet actions (CLAUDE.md §2). Strongly helps `business`/`realworld` and the demo video. |

## 10. Dates

| Item | Value | Status |
|---|---|---|
| Hackathon start | 2026-11-01T00:00:00Z | repo started 2026-11-01 13:08 UTC — OK |
| Submission deadline | 2026-11-14T23:59:00Z (same in `CLAUDE.md:67`) | 12 days left on 2026-11-02 |
| Judging / results | 2026-11-16 / by 2026-11-18 | keep testnet vault and any hosted demo up until at least 11-18 |

## Fixes made in this pass (uncommitted)

- `HACKATHON.md` — synced to the live file (one Ecosystem row added).
- `third_party/shade-agent-template/{LICENSE,NOTICE.txt,README.md}` — new: verbatim upstream Apache-2.0 license and NOTICE, derived-file list.
- `README.md` — Disclosures: link to `third_party/`, Fonts line, design-kit made with Claude Design; License: per-file split and the `worker/package.json` note; Repo layout: `skills/` absent in a clone, `third_party/`; Quickstart: "Paths A, B, C and D1" need no account; test counts updated to the clean-clone run (contract 174, worker 128, dashboard 237).
- `mcp/.env.example` — `ONECLICK_API_KEY`, `SIMULATED_OUTCOME`.
- `.env.example` — lists all four package templates.

## Questions and actions for the human

1. Review and merge `feat/kit-foundation` into `main`, push, and make the repo public before 2026-11-14T23:59Z (judges see `main`; today `origin/main` has only LICENSE).
2. `worker/package.json` `"license"`: keep `Apache-2.0`, or change to `"MIT AND Apache-2.0"`?
3. Optional: create tag `hackathon-submission` on the commit you submit (no `pre-hackathon` tag needed: no baseline code).
4. Mainnet: approve (or not) the exact steps for one tiny real 1Click payout from a mainnet demo vault, and whether to run the worker on Phala (M4).
5. Record the demo video and publish the X post (built at NEAR HACKATHON, `@NEARProtocol`, `#NEARHackathon`, video attached; optional `@NearLegion`, `@NearBuilders`). Draft: `docs/demo-script.md`.
6. Optional: host the dashboard (static) against the testnet vault until at least 2026-11-18.
7. Submission fields to decide: project name (2-80), team lead name (2-80), contact email, team size (`1` presumably), tracks (README says `security`, `business`, `realworld`; confirm), mainnet NEAR payout account, public repo URL, X post URL, "what we built" text (20-2000 chars), and consent to: "I agree that the organizers may use these details to review our submission and contact us about this hackathon."
8. Are you submitting another project (Q-015)? If yes, both READMEs must name each other.
9. Keep `at-vault-11012309.testnet` and its state unchanged through judging, or update README path B values after the last change.
