# Security audit: Hyperliquid trading agent, pre-mainnet (2026-11-03)

Auditor: `security-auditor` agent, `near-contract-audit` skill (detectors in `references/{high,medium,low}-severity.md`
walked for the contract delta). Read-only: nothing was deployed, signed or sent on any network.

## Scope

| Area | Files |
|---|---|
| Contract delta (commit `8d6c70a`) | `contract/src/payment.rs` `report_payout_status`, `contract/src/agent.rs` `is_valid_tee_caller`; re-read `is_valid_deposit_address`, `evaluate_payment` threshold |
| Trading worker (uncommitted) | `worker/src/trading/**` (funding, wallet, confirm, store, route, service, index, engine/{tick,risk,pnl}, hl/nktkas), `worker/src/config.ts`, `app.ts`, `index.ts`, `worker/src/ai/{trading,tools,proposals}.ts`, `worker/.env.example` |
| SDK | `sdk/src/chains.ts` (pinned hip1 USDC), `quote-check.ts`, `client.ts` quote request, `sdk/examples/mandate.hl-trader.json` |
| Dashboard | `dashboard/src/features/trading/*`, `lib/trading{Client,Rules,View}.ts`, `lib/oneclickStatus.ts`, `lib/oneclickTokens.ts`, `features/agents/pendingKey.ts` |
| Image / secrets | `Dockerfile.worker`, `Dockerfile.worker.dockerignore`, `.gitignore`, every `.env*` in the tree (presence, mode, ignore status; values not read) |
| HL library | `@nktkas/hyperliquid` 0.33.3 in `worker/node_modules`: which exchange actions are L1 (agent-signable) |
| Docs | ADR-0002 (2026-11-02 amendment), ADR-0005 (T1–T16, owner decisions), `audit-2026-11-01.md`, `README.md`, `docs/commands.md` |

Evidence run locally: `pnpm exec vitest run test/trading` (19 files, 457 tests, green). One scratch test outside the repo
(`/private/tmp/claude-501/-Users-iskander-faggod-Desktop-agent-treasury/acaebd01-7007-45e2-b1ee-672f52efb453/scratchpad/killrace/killrace.test.ts`)
proves M1.

**Not checked:** HL server-side behaviour (whether HL actually accepts an API-wallet signature for `vaultTransfer`,
`scheduleCancel` trigger counting, the ledger delta type of a 1Click delivery), 1Click hip1 delivery, `cargo test` (not
re-run), fixes of the 2026-11-01 findings (not re-verified), dashboard pages outside trading, `pnpm audit` / `cargo audit`
(need network).

Overall: the bot's own code is careful. It has no perp path. Rules are signed and re-verified on every tick. The funding
destination comes from env and is checked against the mandate. Money math uses bigint. Tests are thorough. The real risks
are elsewhere:
1. The mandate allowlist does not bind where a Key agent's money actually goes.
2. Whoever holds the HL API key can do much more than "trade spot".
3. The kill switch has a race and depends on RPC.
4. There is no written mainnet plan.

---

## Critical

None found.

---

## High

### H1. The `hl-trader` allowlist does not pin the destination. A leaked trader NEAR key can send top-ups to any address, with no human check.

**Where:**
- `contract/src/payment.rs` `is_valid_deposit_address`: accepts any 64-hex implicit account that is not the token, the
  vault, the owner or a bound agent.
- `payment.rs:546` `amount > approval_threshold`: with threshold = per-tx = 25 (owner decision 2,
  `dashboard/src/lib/tradingView.ts` `buildTraderSetup` `threshold: i.perTx`), every top-up auto-executes.
- Known limitation 1 of the 2026-11-01 audit.

**Attack:**
1. Get the trader's function-call key. It sits in plain text in `worker/.env`, in the same process as the LLM-facing
   `/ai` and `/trading` HTTP routes. It is also generated in the browser and parked in `sessionStorage` by `SetupCard`
   (see M6).
2. Call `request_payment(chain:"hypercore", address:<owner HL master>, amount:25, deposit_address:<attacker implicit
   account>)`. The vault checks only the *declared* address against the allowlist. The USDC goes straight to the
   attacker's NEAR account; 1Click is not involved.

**Impact:** up to `per_tx` 25 USDC per call, 50 USDC/day, 2 calls/day, for the whole mandate lifetime (30 days in the
plan, so up to 1500 USDC). The only other bound is the vault balance. The worker's "exactly one allowlist entry ==
HL_MASTER_ADDRESS" check protects only against the honest bot's own misconfiguration, not against a stolen key.

**Fix:**
- For the mainnet session (config, no code change):
  - fund the vault with only what the session needs (≤ 26 USDC);
  - vault `policy.daily_limit` ≤ 25 USDC;
  - mandate `daily_limit` 25, `max_payments_per_day` 1, `expires_at` ≤ now + 48 h;
  - `approval_threshold = 0`, so the single top-up goes through the dashboard's 1Click deposit check
    (`lib/oneclickStatus.ts`). That check rejects a deposit address unknown to 1Click or with a different recipient;
  - revoke `hl-trader` right after the session.
- Long term:
  - make `approval_threshold` default to 0 for Key agents whose mode is `Allowlist`/`Fixed`, or
  - allow only `Tee` agents to pay without approval (only attested code makes the declared destination meaningful).
- README: state that the allowlist pins the destination only for honest agent code.

### H2. Whoever holds the HL API wallet key controls everything on the master account. The protection is much weaker than "it can trade but cannot withdraw".

**Where:**
- ADR-0005 trust table ("HL API wallet protects withdrawals and sends to other addresses").
- `dashboard/src/features/trading/ApiWalletCard.tsx`: "It can trade but cannot withdraw or send funds".
- The key file is `TRADING_STATE_DIR/api-wallet.json`, mode 0600, in plain text.
- `@nktkas/hyperliquid` signs these as **L1 (agent-signable)** actions: `order`, `twapOrder`, `updateLeverage`,
  `agentSendAsset`, `agentSetAbstraction`, `vaultTransfer`, `createVault`, `subAccountTransfer`,
  `subAccountSpotTransfer`, `createSubAccount`, `spotDeploy`, `perpDeploy`, `gossipPriorityBid`, `borrowLend`,
  `userOutcome`, among others.

**Attack:** whoever holds the key (a leak, or a compromised local host, which in local mode is the same thing) can:
1. open leveraged perps, including on HIP-3 builder dexes, which the perp alarm does not see (T16);
2. move funds out by trading against the attacker's own orders on an illiquid spot or perp book;
3. `vaultTransfer` the USDC into an HL vault the attacker leads and trade it away there (**[verify]** that HL accepts an
   agent signature for it; the library signs it as an L1 action, the same type as orders);
4. destroy funds through deploy-auction or priority-bid actions.

The bot's code calls none of these (grep-clean; `HlExchangeApi = Pick<…, "order" | "cancel" | "scheduleCancel">`), but
the key can.

**Impact:** total loss of the HL master balance. The alarm, loss stop and position cap all run in the same process that
was compromised, so they bound only the honest bot.

**Fix:**
- For the session:
  - the dedicated master holds only the session amount;
  - set `valid_until` to 1–2 days (not 30);
  - revoke the API wallet on app.hyperliquid.xyz right after the kill drill;
  - add no other funds, sub-accounts or vault deposits to that account.
- Docs:
  - rewrite the ADR trust row and the dashboard sentence to say "cannot withdraw or send to another address
    directly; can lose or route away everything on the account through trading, perps and vault deposits";
  - add `vaultTransfer` and the burn actions to T4.
- v2: TEE for the trader, and a HIP-3 sweep over `perpDexs`.

---

## Medium

### M1. The kill switch races a running tick. After kill reports "halted, 0 orders cancelled", the tick can still place orders and push the dead-man timer from +6 s back to +180 s.

**Where:** `worker/src/trading/service.ts` `kill()` mutates the halt and cancels orders, but a tick in flight runs
`runTick` on a `structuredClone` of the old state (`engine/tick.ts`). After `kill()` returns, that tick calls
`safeSchedule(now + deadmanSec)` and `placeSpotOrder`.

**Proof (scratch test, not in the repo):**
- result: `{"kill":{"state":"halted","cancelled_orders":0,…},"ordersAfterKill":1,"killScheduleCancelAt":T+6s,"lastScheduleCancelAt":T+180s,"stateAfter":"halted"}`
- setup: `harness()`, then the DCA rule confirmed, then a tick held at `getMids`, then `kill()`, then the gate released.

**Impact:**
- Up to 2 orders (≤ 2 × 20 USDC, IOC fills at once) after the owner pressed Stop, and the dashboard says all is well.
- A resting GTC order survives until the next tick, up to 60 s later.
- The demo's kill drill can show this.

**Fix:**
- Pass an `aborted()` callback into `runTick` that reads `this.state.halt`, and check it before `safeSchedule` and before
  each `placeSpotOrder`.
- In `kill()`, await the tick in flight (with a timeout), then cancel and `scheduleCancel(+6 s)` *again*.
- Add the scratch test to `test/trading/service.test.ts`.

### M2. The kill switch fails when NEAR RPC is down, or when the owner session has expired and the wallet cannot sign.

**Where:**
- `route.ts` `/kill` → `owner(c, true)`: fresh `contractInfo()` RPC on every call, 502 `RPC_ERROR` on failure.
- `KillSwitch.tsx` → `ensureSession` (1 h token, then a wallet `signMessage`, whose own verification also needs RPC
  for `view_access_key`).
- Step 2 (`pause_agent`) also needs RPC and the wallet.

**Impact:** during an RPC outage (the 429s seen on testnet) the owner cannot stop the bot through the dashboard. The
backups still work:
- HL revoke on app.hyperliquid.xyz;
- killing the process: the dead-man cancels orders within `TRADING_DEADMAN_SEC`, but positions stay.

**Fix:**
- `/kill` accepts a valid, unexpired HMAC token with the cached owner, or no owner check at all. Kill only restricts,
  so failing toward "stopped" is correct.
- Add a local CLI or signal path, e.g. `SIGUSR2`, or a `HALT` file in the state dir that the tick checks.
- README: "the real kill is revoking the API wallet on Hyperliquid".

### M3. The loss stop rests on an unverified ledger mapping, and the planned cross-check is missing.

**Where:**
- `hl/nktkas.ts` `getLedger` counts only `deposit`, `withdraw`, USDC `spotTransfer`/`send` and `internalTransfer`. The
  research says the delta type of a 1Click hip1 delivery has "not yet been observed".
- ADR-0005 promises that `net_funded` is "cross-checked against the vault's `Confirmed` payouts … warning on mismatch".
  No such code exists (grep `mismatch` in `trading/` finds only the funding mandate check).

**Impact:** if a 25 USDC top-up lands under another delta type, the equity jump looks like profit. On that day a real
loss of up to 25 + 10 USDC passes before `stopped_today`. It is bounded by the 50 USDC position cap.

**Fix:**
- For the session: do the top-up first, *before* signing any rules (ADR step 1). Check that `/trading/status`
  `pnl.net_funded_usdc` shows the amount received. If it shows 0, do not confirm rules.
- Code:
  - implement the vault cross-check;
  - fail closed: no orders while `net_funded` is below the sum of `Confirmed` `hl-trader` payouts minus fees.

### M4. No mainnet deployment plan exists. The ADR's testnet run and drills are not on record.

**Where:**
- `docs/commands.md` has no **[MAINNET]** section; the only mainnet entry is the dry quote.
- ADR-0005 test plan §2 asks for a 12 h testnet run plus kill / `pause_agent` / `kill -9` / manual-perp drills, recorded
  in `docs/commands.md`. None are recorded.
- README §"not done" lists the mainnet vault as not done.

**Impact:** the exact `new` arguments will be improvised under time pressure: `owner_id`, mainnet USDC token,
`policy.daily_limit`, `requires_tee` / `allow_insecure_local_mode`, `attestation_expiration_time_ms`. So will the vault's
USDC `storage_deposit`, the mandate JSON and the teardown. The previous audit's L2 (`new()` validates nothing) makes a
typo there permanent.

**Fix:** before the session, write and review a numbered **[MAINNET]** runbook:
1. Accounts: a vault account with its own full-access key; the owner is a separate account, ideally a hardware wallet.
2. Deploy plus `new` in one transaction, with `--locked` (audit L10) and tiny policy values.
3. USDC `storage_deposit`, then a deposit of ≤ 26 USDC.
4. `hl-trader` created with `sdk/scripts/setup-key-agent.ts --confirm-mainnet` (see M6), with the H1 mandate.
5. Worker `.env` diff, with `TRADING_ALLOW_MAINNET=true` and `HL_NETWORK=mainnet`.
6. The drills, with expected outputs.
7. Teardown:
   - `/trading/kill`;
   - `revoke_agent hl-trader`;
   - HL API wallet revoked;
   - `withdraw` of any rest;
   - optional return of profits plus two-phase `sync_surplus`.

   Also decide whether a payroll local-mode agent is whitelisted on this vault at all (see L6). Run the testnet drills
   first, or record why they were skipped.

### M5. Nothing stops two workers from sharing one state dir.

**Where:** `service.ts`, `funding.ts`, `wallet.ts`: plain files, atomic renames, no exclusive lock.

**Impact:**
- `pnpm dev` and `docker compose up` (or two terminals) on the same `.trading` both tick. Both place orders: order
  counts and loss stop are per process, so the effective limits double.
- Both refresh the dead-man timer, and the HL nonces of one API wallet collide.
- The funding `attempt` marker has a read-check-write window, so a duplicate top-up is possible. The contract still
  caps it at `max_payments_per_day`.

**Fix:** take an exclusive lock at start (`openSync(join(dir, "lock"), "wx")` with the pid; refuse if the pid is
alive) and release it on exit.

### M6. In the dashboard flow the trader NEAR key is created in the browser, which is not what the ADR says.

**Where:**
- `dashboard/src/features/trading/SetupCard.tsx` (`generateAgentKey()`, `savePending()` → `sessionStorage`, then
  shown as an `.env` snippet).
- ADR-0005 §1 says the key is created by `sdk/scripts/setup-key-agent.ts`.

**Impact:** an XSS or a malicious dependency in the dashboard bundle can read the key during setup. Combined with H1,
that means theft up to the mandate limits. The 2026-11-01 audit (dashboard XSS row) assumed that "funds only move with
the owner's signature". That no longer holds once the dashboard has seen an agent key.

**Fix:**
- For mainnet, create `hl-trader` with the CLI script; the dashboard only takes a public key, as the wizard's "existing
  key" path already does.
- Otherwise, update the ADR and the trust table.
- Keep `worker/.env` at mode 0600 (it is).

### M7. The dashboard trusts the worker's word on which HL account to fund and which API wallet to approve. The phishing-style risk is approving the wrong wallet.

**Where:**
- `tradingClient.ts` confirm flow: the message uses `status.hl_account` and `status.agent_id` from the
  unauthenticated `/trading/status`.
- `ApiWalletCard` shows `status.api_wallet.address` as the address to paste into HL.
- The engine never warns about *other* approved agents on the master.
- `rotateApiWallet` deletes the old key but cannot revoke it on HL, and the UI does not show the old address to revoke.

**Impact:**
- A wrong `VITE_WORKER_URL`, a stale worker or an untrusted LAN host can show an attacker's address. The owner then
  approves an attacker API wallet on the master, which gives the attacker full H2 powers.
- After a rotation, the old address can stay approved for up to 180 days unnoticed.

**Fix:**
- Compare `status.hl_account` with the on-chain `get_agent_budget("hl-trader").allowlist[0].address` and refuse on
  mismatch.
- Tell the owner to compare the API-wallet address with the `TRADING ENABLED … api-wallet=` line in the worker console
  before approving.
- Add a status warning when `extraAgents` lists any address other than ours.
- After a rotation, show "revoke 0x… on Hyperliquid".

---

## Low / hardening

- **L1. The approval check ignores the destination asset.** `lib/oneclickStatus.ts` checks recipient, refundTo, amounts
  and deadline, but not `quoteRequest.destinationAsset`. A hypercore payout could be quoted to the erc20 (HyperEVM) USDC
  or to another chain at the same `0x`. The owner's key controls those too, so this is a mis-delivery, not theft.
  *Fix:* compare with `findUsdcAsset(tokens, chain)` (hip1 for hypercore).
- **L2. Expiry defaults disagree.**
  - `sdk/examples/mandate.hl-trader.json` has `"expires_at": null`; ADR §2 says 30 days.
  - `ApiWalletCard` recommends 30 days; ADR test plan §3 says 7 days.

  For the session use ≤ 48 h for both.
- **L3. A comment overclaims.** `confirm.ts` `offlinePairInfo` says "live volume … enforced again by the engine on
  every tick". `runTick` never checks volume. This is harmless while only HYPE/USDC is allowed. Either fix the comment
  or add the check.
- **L4. Signed rule sets never expire.**
  - Every stored envelope stays valid forever: the nonce is checked only at confirm, not on load.
  - The message carries no time.
  - Anyone who can write the state dir can re-activate any older signed rule set (`active.json`) or clear a halt
    (`engine-state.json`). In local mode the host is trusted anyway.

  *Fix (v2):* add `confirmed_at` and `valid_until` lines to the NEP-413 message, and refuse superseded hashes.
- **L5. Status is public and the server listens on all interfaces.** `GET /trading/status` is public, and
  `@hono/node-server` listens on all interfaces by default. The status shows the account, the API-wallet address and
  balances. `state_detail` carries raw error text (up to 600 chars), which could include an RPC URL with an API key.
  *Fix:* bind `127.0.0.1` in local mode; scrub URLs from error text.
- **L6. Local mode turns "attested TEE agent" into "whitelisted dev account" (commit `8d6c70a`).** On a vault with
  `allow_insecure_local_mode`, the payroll worker's local account (derived from `SPONSOR_PRIVATE_KEY`) counts as
  `is_valid_tee_caller`. It may mark every Key agent's `Sent` payouts `Confirmed`/`Refunded`/`Failed`. The right also
  ignores the TEE agent's mandate `expires_at` (already noted in `docs/STATUS.md`). This is annotation only:
  `credit_refund` and `sync_surplus` read the real `ft_balance_of`. *Fix:* also require
  `!mandate expired`; document that on local-mode vaults this right belongs to the operator.
- **L7. A testnet key file is world-readable.** `mcp/.env.claudeagent` is mode 0644 and holds a testnet agent key. It
  is gitignored, and STATUS says to delete it after the test. Do so, and remove the key from the `~/.claude.json` MCP
  entry.
- **L8. The perp alarm under unified or portfolio margin.** In those modes `marginSummary.accountValue` may include spot
  USDC, so the alarm can trip on a healthy account. That is a safe failure. Keep the dedicated master in standard mode
  and document it next to T16.
- **L9. Top-ups run before any rules exist.** Funding is allowed in `awaiting_api_wallet` and `no_rules`, so up to the
  daily limit can pile up on HL before any rule is signed. Acceptable, but for the session use one top-up only
  (`max_payments_per_day` 1, or `TRADING_TOPUP_ENABLED=false` after the first).
- **L10. Docs are missing.** README, `docs/architecture.md`, `docs/demo-script.md` and `CHANGELOG.md` have no trading
  section (ADR task X1). Before submission, see "Known limitations" below.

---

## Checked and fine

**Contract delta (`8d6c70a`)**
- `report_payout_status`:
  - who may call: owner, the creator's current non-revoked account, or an Active TEE agent with a valid registration,
    and that last case only for payouts of `Key` agents;
  - status moves only from `Sent` to a terminal status; the same status again is a no-op;
  - `tx_hash` length is capped;
  - no promise, no balance field touched.

  Detectors: owner-check ok; reentrancy, unsaved-changes and unsafe-math not applicable. A false `Confirmed` only blocks
  `credit_refund` for that payout, and `sync_surplus` recovers (as stated in the ADR-0002 amendment).
- `is_valid_tee_caller` requires `kind == Tee`, `Active`, a bound `account_id == caller`, and `agent_tee_reasons` empty
  (expiry, measurements, PPID, local whitelist).

**Funding (`funding.ts`)**
- Amount and destination come only from env. The live budget is re-read before every call and must hold exactly one
  `hypercore` allowlist entry equal to `HL_MASTER_ADDRESS`, with `allowed_chains ⊆ [hypercore]`.
- Funding runs only in `running`/`no_rules`/`awaiting_api_wallet`, so halted, stopped and paused all block it.
- The `attempt` marker is persisted before signing; an ambiguous submission stays blocked for 2 h; back-off survives
  restarts; nothing is split or retried in a loop.
- SDK quote: `refundTo = vault`, `recipient` = master, `recipientType DESTINATION_CHAIN`, no `msg`, hip1 asset pinned
  and resolved from `/v0/tokens`.

**Rules and confirmation**
- An LLM cannot widen limits or change the destination:
  - the DSL has no destination;
  - limits are rejected above the env hard limits;
  - the engine also takes `min(hard, signed)`;
  - the funding size and destination are env-only.

  Prompt injection can at worst propose aggressive rules inside the hard limits. The owner sees them through the
  dashboard's own renderer and hash (`tradingRules.ts`), which refuses on a hash or message mismatch before the wallet
  is asked.
- NEP-413 confirm:
  - the challenge needs an owner bearer, so a third party cannot get a nonce;
  - the 32-byte nonce is bound to the rules hash and consumed before verification; TTL 5 min; at most 200 pending;
  - the message binds vault, agent, HL network and HL account; recipient = vault;
  - the signer must be a full-access key of the current owner;
  - everything is re-verified on every tick-load, so a change of owner drops the rules.

  Replay of a confirmation across processes or restarts is impossible, because the pending map is in memory.

**HL adapter and engine**
- Spot only:
  - the exchange surface is `order`/`cancel`/`scheduleCancel`;
  - asset id ≥ 10000 *and* must be a known spot pair, so HIP-3 ids (≥ 100000) are refused too;
  - look-alike token names are dropped unless canonical.
- Perp alarm: positions, open perp orders including `dex:` coins, or account value > 1 halt and cancel; the halt is
  sticky across restarts.
- The dead-man is refreshed before any order, and no order is placed if it fails.
- Price band and spread check; rounding to the safe side; size never resized.
- Position cap counts open buys; daily order count; stale data blocks orders.
- On-chain pause, revoke or expiry cancels orders and blocks.

**Secrets, logs, image**
- API-wallet key: `node:crypto` randomness, file 0600 in a 0700 dir, a loose mode is refused. `toJSON` and `inspect`
  show only the address. Retired addresses are never regenerated.
- No `console.*` prints keys. Config errors print paths and messages, not values.
- `.trading/` and `.env*` are gitignored. `worker/.env` is 0600. No secret was ever committed: the git history touches
  only `.env.example` files.
- `Dockerfile.worker`: base pinned by digest, pnpm pinned, `--frozen-lockfile`, prod deps only, allow-list
  `.dockerignore` (no `.env`, no `.trading`), `USER node`.
- New deps exact-pinned (`@nktkas/hyperliquid` 0.33.3, `viem` 2.57.13), `save-exact`.
- Trading refuses `RUN_MODE=tee`. `HL_NETWORK=mainnet` needs `TRADING_ALLOW_MAINNET=true`. `simulated` 1Click is refused
  on NEAR mainnet.
- The owner session token lives in `sessionStorage`, not `localStorage`.

**Owner lock-out**
- NEAR: the trading module adds no owner-facing contract surface. `withdraw` still ignores pause and agents.
- HL: the API wallet cannot `approveAgent`, `withdraw3`, `usdSend`/`spotSend` or change the master key, so the owner
  can always revoke it and withdraw with the master EVM key.

---

## Go / no-go for the tiny mainnet session

**Conditional GO** once these blockers are closed. Each one is config or docs, apart from the optional M1 fix.

1. **[M4] Write and review the [MAINNET] runbook** in `docs/commands.md`: exact `new` args, the token, funding ≤ 26 USDC,
   the mandate, the drills, the teardown. The owner confirms each command.
2. **[H1] Session mandate and vault:**
   - vault funded ≤ 26 USDC;
   - `policy.daily_limit` ≤ 25;
   - `hl-trader`: `per_tx` 25, `daily` 25, `max_payments_per_day` 1, `expires_at` ≤ 48 h, `approval_threshold` 0;
   - so the one top-up is checked against 1Click in the dashboard before the owner approves it.

   This changes owner decision 2 for this session only and needs the owner's OK.
3. **[H2, M7] HL hygiene:**
   - a dedicated, already-active master in standard mode, holding only the session amount;
   - API wallet `valid_until` ≤ 48 h;
   - before approving, compare the address with the worker console line;
   - revoke it on HL right after the kill drill.
4. **[M3]** Top-up first. Confirm rules only after `/trading/status` shows `net_funded_usdc` ≈ the delivered amount.
5. **[M5, L5]** Exactly one worker process on that state dir, reachable on localhost only.
6. **[M6]** Create `hl-trader` with `sdk/scripts/setup-key-agent.ts --confirm-mainnet`, not the dashboard key generator.

Strongly recommended before the demo recording: fix **M1**, the kill race (small change plus the scratch test), and
**M2** (`/kill` without a fresh RPC owner check). Until then, run the kill drill as: Stop trading, wait one tick, then
revoke on HL.

Worst-case loss with these settings: about 26 USDC (vault balance) plus whatever sits on the HL master, which is the same
money. Without them: up to 50 USDC/day for 30 days through a leaked trader key (H1), plus the whole HL balance (H2).

---

## Known limitations (for the README, stated plainly)

1. **The allowlist pins the declared destination, not the real one.** For Key agents, `hl-trader` included, the vault
   cannot see where a deposit address pays. A stolen agent key can send up to its limits to any NEAR account. Only an
   approval (with the dashboard's 1Click check) or TEE-attested code closes this.
2. **Funds on Hyperliquid are not protected by the vault.** The vault limits only how much is sent there per day. The
   bot's API wallet cannot withdraw directly. But anyone holding its key can lose or route away the whole HL balance
   through trading, leveraged perps (HIP-3 perps are not detected), wash trades or vault deposits.
3. **The trader runs in local mode, with no TEE.** Limits, alarm and loss stop are code on the operator's machine. A
   compromised host can skip them. Keys sit in plain files (`worker/.env`, `.trading/api-wallet.json`).
4. **The kill switch** halts the bot and pauses top-ups, but positions stay open. The authoritative stop is revoking the
   API wallet on app.hyperliquid.xyz with the master key. Dashboard kill needs the worker and NEAR RPC to be reachable.
5. **Rules are owner-signed (NEP-413) and kept in worker storage, not on-chain.** The proof is the signed envelope plus
   the `cloid` prefix in HL history.
6. **The loss stop depends on reading HL ledger inflows.** Top-ups must show up as inflows, or the daily loss figure is
   wrong for that day.
7. **Profits do not flow back to the vault automatically.** The return is manual (HL `spotSend` → 1Click → vault, then
   the two-phase `sync_surplus`).
8. **Reporting on local-mode vaults.** On a vault with insecure local mode, the whitelisted dev worker may annotate
   Key agents' payout statuses. Annotation only.
9. **The owner's HL master EVM key is a second root of trust,** next to the NEAR owner key. Use hardware wallets for
   both.
