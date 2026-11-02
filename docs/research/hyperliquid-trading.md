# Research: spot trading agent on Hyperliquid, funded from the vault

Date: 2026-11-02. Scope: what Hyperliquid (HL) allows, how 1Click funds it, what similar products do, and the smallest
credible design for Agent Treasury. No code, no transactions. The only network calls were read-only: 1Click
`GET /v0/tokens`, 1Click `POST /v0/quote` with `dry: true`, and HL `POST /info` (`spotMeta`, `spotMetaAndAssetCtxs`).

How claims are marked:
- **[doc]**: stated in official docs (URL given).
- **[probe]**: seen in a read-only API call made today.
- **[3rd]**: third-party source only.
- **[unverified]**: inferred or not confirmed. Check before relying on it.

---

## Summary

1. **An HL API wallet can trade but cannot withdraw** to another address. This comes from the signing model and is
   confirmed by third-party sources. One catch: `agentSendAsset` lets the API wallet move funds between the account's
   own spot balance and perp balance. **HL cannot limit an API wallet to spot only**, so the API wallet could open
   leveraged perp positions. That limit can live only in our bot code.
2. **1Click funds HyperCore directly** [probe]. Asset `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` is
   HyperCore token 0 (USDC, 8 decimals). The recipient is a plain `0x…` EVM address. The money arrives in the HL
   **spot** USDC balance, which is also the trading balance for unified accounts [unverified that it lands in spot;
   inferred from the token being a spot token].
   - Fixed `withdrawFee` of **0.3153 USDC** per transfer.
   - Minimum input is about **2 USDC** (1.5 USDC is rejected).
   - Examples: 5 USDC in gives 4.684 out; 100 USDC in gives 99.67 out.
3. **Profits can return straight to NEAR through 1Click** (`hypercore → nep141 USDC`) [probe]: 100 USDC in gives 99.79
   out. This needs a `spotSend` to the 1Click deposit address, and only the **master** key can sign it. When the money
   arrives at the vault as a plain `ft_transfer`, the owner calls the existing `sync_surplus` to count it.
4. **The vault needs no contract change.** A Key or Tee agent gets a mandate with `allowed_chains = ["hypercore"]`, an
   allowlist containing only the owner's HL master address, and a daily limit. The SDK needs one small fix:
   `resolveUsdc("hypercore")` currently throws because 1Click lists two USDC tokens on `hypercore`.
5. **Testnet is usable for strategy development.** The faucet gives 1,000 mock USDC, but only to an address that has
   deposited on mainnet. One small real 1Click funding of the owner's address therefore unlocks testnet.
6. **SDK:** `@nktkas/hyperliquid` 0.33.3, typed TypeScript, about 663k downloads per month, needs Node 22.12+. Our
   worker image is `node:22-alpine`; check its minor version.
7. **What the vault cannot protect:** money that is already on HL. A leaked API key or a bad strategy can lose it
   through bad trades, including deliberate trades against an attacker's order on a thin market. The defences are small
   daily funding limits on the vault, bot-side risk limits, and a kill switch.

---

## A. Hyperliquid technical facts

### A1. API wallets (agent wallets)

| Question | Answer | Source |
|---|---|---|
| What they are | "A master account can approve API wallets to sign on behalf of the master account or any of the sub-accounts." They only sign. Queries must use the master address; querying the agent address returns nothing. | [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets |
| Trade spot? | Yes. Orders are "L1 actions" (`sign_l1_action`), which an agent can sign. Spot uses asset id `10000 + spotIndex`. | [doc] exchange endpoint + Python SDK `signing.py` |
| Withdraw / send to others? | No. `withdraw3`, `usdSend`, `spotSend`, `sendAsset`, `usdClassTransfer` and `approveAgent` are **user-signed** EIP-712 actions (`HyperliquidTransaction:*`). They must be signed by the account's own key. | [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing ; https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/master/hyperliquid/utils/signing.py ; [3rd] https://www.dwellir.com/docs/hyperliquid/approveAgent , https://aegis-docs-1gi.pages.dev/api-keys/hyperliquid/ |
| Exception | `agentSendAsset`: "Similar to send asset, but can be signed by an agent. **Destination must match the source address.**" The agent can move funds between the account's own spot and perp balances (and DEXs), but not to anyone else. The agent can also stake (`Deposit into staking (agent)`) and change the account abstraction mode. | [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint |
| Spot-only restriction? | **None exists.** The same key can trade perps with leverage. | inferred from the docs above [unverified that no hidden scope exists] |
| How many | "An account can have 1 unnamed approved wallet and up to 3 named ones. And additional 2 named agents are allowed per subaccount." | [doc] exchange endpoint, "Approve an API wallet" ; https://hyperliquid.gitbook.io/hyperliquid-docs/trading/sub-accounts |
| Expiry | Optional: append `valid_until {timestamp}` to `agentName`; "at most 180 days in the future". The default expiry when it is omitted is not stated. | [doc] exchange endpoint [default: unverified] |
| How to approve | Master signs `{"type":"approveAgent","hyperliquidChain":"Mainnet","signatureChainId":"0xa4b1","agentAddress":"0x…","agentName":"bot valid_until 1790000000000","nonce":<ms>}`. You can also do it in the HL web app (API page). The account must already hold funds: unfunded accounts fail with "Must deposit before performing actions". | [doc] exchange endpoint, signing page [UI flow: unverified] |
| Revoke | Send a new `approveAgent` with the same name (or a new unnamed one) and a fresh address. This deregisters the old wallet. The HL app also has a remove button [unverified]. Never reuse an agent address: once it is pruned, "previously signed actions can be replayed". | [doc] nonces page |
| Pruning | When deregistered, when expired, or "the account that registered the agent no longer has funds". | [doc] nonces page |
| Nonces | Stored per **signer**: the 100 highest are kept. A new nonce must be above the smallest of those and never used before. It must also be within `(T − 2 days, T + 1 day)` of block time. Use ms timestamps from an atomic counter, and one API wallet per process. | [doc] nonces page |
| Sub-accounts | Need $100k of volume first. They are not usable for isolation on a fresh account. | [doc] sub-accounts page |
| Dead-man switch | `scheduleCancel` with `time` at least 5 s ahead cancels all open orders when the time arrives. Limited to 10 triggers per day. **Refused for accounts under $1M traded volume** (live, testnet 2026-11-03): `Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.` The engine then trades IOC only, see ADR-0005 "scheduleCancel volume gate". | [doc] exchange endpoint, [live] testnet |

### A2. Spot trading via API

- **Order action** [doc, exchange endpoint]: `{"type":"order","orders":[{"a":asset,"b":isBuy,"p":"px","s":"sz","r":false,"t":{"limit":{"tif":"Gtc"|"Ioc"|"Alo"}}}],"grouping":"na"}`
  - Trigger orders (`tp`/`sl`) also exist.
  - "Market" orders are IOC limit orders with a price cap.
  - Optional `cloid` (128-bit hex), `expiresAfter`, and `vaultAddress` (for sub-accounts and vaults).
  - In the UI there are also TWAP (minimum $100), scale and chase orders [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types
- **Asset ids** [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/asset-ids. Verified with `spotMeta` [probe]:

  | Pair | Spot index | Order asset id | Name in info / book | Notes |
  |---|---|---|---|---|
  | PURR/USDC | 0 | 10000 | `PURR/USDC` | mid ≈ 0.1108, 24h volume ≈ $1.1M (probe) |
  | HYPE/USDC | 107 | 10107 | `@107` | HYPE token 150, `szDecimals` 2, mid ≈ 84.24, 24h volume ≈ $84M (probe) |
  | USDC token | token 0 | — | — | tokenId `0x6d1e7cde53ba9467b783cb7c530ce054`, `weiDecimals` 8 |
  | Testnet HYPE/USDC | 1035 | 11035 | `@1035` | testnet USDC tokenId `0xeb62eee3685fc4c43992febcd9e75443` |

  Mainnet and testnet ids differ. Always read them from `spotMeta`; never hard-code them.
- **Tick and lot** [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size:
  - Price: at most 5 significant figures and at most `8 − szDecimals` decimals. Integer prices are always allowed.
  - Size: rounded to `szDecimals`.
  - Strip trailing zeros before signing.
- **Minimum order value: $10** (error "Order must have minimum value of $10.") [doc, exchange endpoint]. For HYPE at about $84, that is 0.12 HYPE.
- **Fees (spot, tier 0)** [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees:
  - Taker 0.070%, maker 0.040%.
  - HYPE staking gives a 5–40% discount.
  - The tier uses 14-day volume, with spot volume counted twice.
- **Rate limits** [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits:
  - Per IP: 1200 weight per minute. Exchange actions weigh `1 + floor(batch/40)`; `l2Book`, `allMids` and `spotClearinghouseState` weigh 2; most other info requests weigh 20.
  - Per address: 1 action per 1 USDC traded cumulatively, plus an initial buffer of 10,000. When limited, 1 request per 10 s.
  - Open orders: 1000 by default.
  - Unified account and portfolio margin modes are capped at 50k actions per day [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes.
  - A slow bot (one decision a minute) is far below every limit.
- **Account modes** [doc, account-abstraction-modes]:
  - Unified account (recommended): one USDC balance serves both spot and perps.
  - Standard: spot and perp balances are separate.
  - With unified, API reads show everything in `spotClearinghouseState`.
  - Under unified, spot USDC is also perp collateral, so a misbehaving key could open perps without any transfer. Under standard, it would first need `agentSendAsset` spot→perp, which the agent can also sign. **Neither mode blocks this.** Standard mode only makes it easier to detect.

### A3. Funding through 1Click (verified with dry quotes)

`GET /v0/tokens` lists three `hypercore` tokens [probe]:

| assetId | symbol | decimals | Meaning |
|---|---|---|---|
| `1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054` | USDC | 8 | HyperCore spot USDC (token 0). Matches HL `spotMeta`. **Use this one.** |
| `1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f` | USDC | 6 | Circle USDC contract on HyperEVM. Where it lands (HyperEVM vs Core) is **[unverified]**. Do not use. |
| `1cs_v1:hypercore:hip1:0x20b8c9d2f022ffd2aea4f7962b7b1d8b` | wNEAR | — | not needed |

The OpenAPI also lists a separate `hlevm` chain. https://1click.chaindefuser.com/docs/v0/openapi.yaml lists the
blockchains but has no hypercore-specific notes. I found no NEAR Intents doc page about Hyperliquid **[gap]**.

Dry quotes, NEAR USDC (`nep141:17208628…133a1`) → hip1 USDC, `EXACT_INPUT`, recipient `0x8ba1…BA72`, `refundTo` a NEAR account [probe, 2026-11-02]:

| amountIn (USDC) | amountOut | Note |
|---|---|---|
| 0.1 / 0.5 / 1.0 | — | "Amount is too low for the destination chain" |
| 1.5 | — | "Amount is too low, minimum is 131000000" (that is 1.31 USDC at 8 decimals, apparently a minimum *output*) |
| 2.0 | 1.684 | |
| 5 | 4.684 | `withdrawFee` 31530000 = 0.3153 USDC |
| 20 | 19.682 | |
| 100 | 99.666 | fee is fixed 0.3153 plus about 0.02% |
| control: 5 → Arbitrum USDC | 4.994 | `withdrawFee` 0.0053 |

- **Recipient format:** a 0x + 40-hex EVM address, which is the HL account address. `0x…dEaD` is rejected as "recipient
  is not valid" (also for Arbitrum), so 1Click blocks some known burn addresses.
- **`timeEstimate`:** 30 s.
- **Landing balance:** HL spot USDC [unverified; inferred from token type]. For unified accounts this is the trading
  balance anyway.
- **Activation fee** [doc] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/activation-gas-fee: "New
  HyperCore accounts require 1 quote token … of fees for the first transaction which has the new account as
  destination". Whether 1Click passes this on, or fails, for a never-used address is **[unverified]**. Use an
  owner address that is already active, or expect the first funding to arrive about 1 USDC short.
- **Practical sizing:** a funding below about 15 USDC loses more than 2% to the fixed fee. HL also needs at least $10
  per order. Suggested minimum top-up: **20 USDC**. Suggested demo amount: 20–30 USDC.

### A4. Returning profits

Two paths:

1. **Through 1Click, HyperCore → NEAR (recommended)** [probe]:
   - Dry quotes: `hip1 USDC → nep141 USDC`, 10 USDC gives 9.799 out, 100 USDC gives 99.788 out (`refundFee`
     0.3153, `timeEstimate` 35 s).
   - The master `spotSend`s USDC to the quote's `depositAddress`, which is presumably an HL address. **This deposit
     step is [unverified]**: no real quote was taken.
   - Recipient = the vault account; `refundTo` = the owner's HL address.
   - On NEAR, 1Click delivers with a plain `ft_transfer`, so the vault does not see it until the owner calls
     **`sync_surplus`**. That method already exists (`contract/src/owner.rs`).
2. **HL native withdraw to Arbitrum, then 1Click to NEAR:**
   - `withdraw3` is user-signed, so master only. "There is a $1 fee … approximately 5 minutes to finalize" [doc,
     exchange endpoint].
   - Then the Arbitrum USDC needs its own 1Click quote back to NEAR, which needs an Arbitrum wallet and ETH for gas.
     This path is slower, costs more and needs more wallets. Avoid it.

In both paths the **owner's EVM key signs**, never the trading bot. That is intended: profits leave HL only by a human
action. A later version could have the vault control the HL master account (see C, option 2).

### A5. Testnet

- API `https://api.hyperliquid-testnet.xyz` (`/info`, `/exchange`, `hyperliquidChain: "Testnet"`). `spotMeta` answers
  [probe].
- Faucet: "you need to have deposited on mainnet with the same address. Users who have deposited on mainnet may then
  receive 1,000 mock USDC" at https://app.hyperliquid-testnet.xyz/drip [doc]
  https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet
- Plan:
  1. Do one real 1Click mainnet funding (about 20 USDC) to the owner's HL address. This is also the M2-style real demo.
  2. Claim testnet USDC with the same address.
  3. Develop and run the strategy on testnet; flip the base URL for the demo.
- Testnet books are thin and prices differ from mainnet. Fills there do not reflect mainnet. Asset ids differ (see A2).

### A6. TypeScript SDK

| Package | Version / date | Activity | Verdict |
|---|---|---|---|
| `@nktkas/hyperliquid` | 0.33.3, published 2026-08-02; 63 versions since 2025-01 | ≈663k downloads/month (npm, Oct 2026) | **Use this.** Typed info, exchange and websocket clients. Takes a viem or ethers wallet (`privateKeyToAccount` works for an API wallet). Has `order`, `scheduleCancel`, `approveAgent`, `withdraw3`, testnet flag. Requires Node ≥ 22.12. Pin an exact version. https://github.com/nktkas/hyperliquid , https://nktkas.gitbook.io/hyperliquid |
| `hyperliquid` (nomeida) | 1.7.7, 2025-09-05 | ≈20k/month, no release for 14 months | Stale. Skip. |
| `hyperliquid-python-sdk` (official) | 0.24.0 on PyPI | official | Reference for signing details only; a second language in the worker is not worth it. |

The SDK version, the Node requirement and the downloads come from the npm registry API [probe]. I did not install it
or run its tests.

---

## B. Competitors and similar products

| Product | What it does | Custody / keys | Guardrails | UI pattern | Pricing |
|---|---|---|---|---|---|
| **Senpi** (trade.senpi.ai) | AI agents trade HL perps/spot for users | Non-custodial; "agents trade through a delegated permission on your Hyperliquid account", which is in effect an HL API wallet [3rd: own marketing pages] | Revoke or pause anytime; agent sets leverage and stops; no on-chain spend cap | Pick an agent, delegate, watch PnL | HL fees + performance fee on positive PnL [3rd] |
| **Katoshi** | Bot builder for HL (signals, TradingView webhooks, AI agents) | User creates an HL API key in their own account and pastes the *secret* into Katoshi, so Katoshi holds a trade-only key [3rd] https://katoshi.gitbook.io/katoshi-docs/app/bots | API key cannot withdraw; HL builder-code fee approval | Bot list, per-bot settings, logs | Builder-code fee per trade; fixed pricing for vault bots [3rd] https://katoshi.gitbook.io/katoshi-docs/app/pricing |
| **Axon CLI** (`@axon-trading/cli`) | Local daemon + LLM trading HL | Master stays in the user's wallet; "the daemon holds only an HL agent key (cannot withdraw)"; policy enforced in code, not by the LLM [3rd] https://www.pkgstats.com/pkg:@axon-trading/cli | Code-level policy | CLI | n/a |
| **HL native vaults** | Leader trades, depositors share PnL | Funds in the HL vault; leader trades | Leader must keep ≥5% ownership; profit share (commonly 10%); about 100 USDC to create [3rd] | HL vault page with PnL chart | Leader commission |
| **Wayfinder** | Agent platform incl. a perp agent on HyperCore; simulates multi-step plans before execution | Agent trades from a built-in wallet [3rd] https://reports.tiger-research.com/p/wayfinder-vnd | Simulation; details not public | Chat + "shells" | n/a |
| **Giza ARMA** | Autonomous stablecoin yield agent (Base etc.) | User's own ZeroDev smart account; agent gets **session keys** "limited to approved contracts, functions, limits, with time-bound expiration" [3rd] https://docs.gizatech.xyz/docs/core-features | On-chain session-key scope + expiry; revocable | Deposit, sign session key, activate; dashboard with APY | performance fee [unverified] |
| **Almanak** | Strategy agents (SDK, Python) for DeFi | Safe multisig per user per chain; agent runs through **Zodiac Roles** limited to listed contracts/functions; `permissions.json` generated from strategy code [3rd] https://platform.docs.almanak.co/deploy.html , https://docs.almanak.co/docs/agents | Contract/function allowlist on-chain | Strategy marketplace, vaults (ERC-7540, Lagoon) | n/a |
| **Theoriq (AlphaVault)** | Agent-allocated yield vaults | Fordefi MPC custody + TEE checks [3rd] https://fordefi.com/customer-stories/why-fordefi-is-theoriqs-differentiator-in-the-rwa-race | "Onchain policy limits"; planned staking/slashing for agents [3rd] https://crypto.news/interview-theoriq-ai-agents-accountable-yield-machines/ | Vault deposit page | n/a |
| **Coinbase Agentic Wallet / AgentKit** | Wallets for agents (CLI, MCP) | Coinbase MPC/enclave signs | Session caps and per-transaction caps checked before signing (policy engine is off-chain at Coinbase) [3rd] https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome.md | API/CLI | CDP pricing |
| **NEAR Mindshare Index Agent** | Shade Agent (TEE) that trades by Kaito mindshare via Chain Signatures + Intents | TEE-held keys | TEE attestation; no per-user mandate described | Showcase | free showcase [3rd] https://pages.near.org/?p=21707 |
| **Hey Anon** | DeFAI assistant | — | — | — | Nothing reliable found **[gap]** |

What these products have in common:
- Venue-native bots (Senpi, Katoshi, Axon) use the HL API wallet's "cannot withdraw" property and nothing else. They
  have no cap on how much money reaches the bot. Whatever sits on HL is at risk.
- Smart-account products (Giza, Almanak, Coinbase) cap *spending on one EVM chain*. They do not work for HyperCore,
  which is not EVM, and they do not fund across chains.
- None found combines a **treasury with on-chain per-agent mandates** (daily funding cap, allowlist = owner's own
  venue account, approval threshold, pause) with **a trade-only venue key**.

**Our differentiator, stated honestly:**
- One NEAR vault serves payroll agents and trading agents, each under its own on-chain mandate.
- The trading agent can only top up *the owner's own* HL account, at most X USDC per day. It never holds a key that can
  withdraw. Profits come back to the same vault through 1Click.
- The vault limits **how much can be put at risk per day**. It does **not** limit losses on HL.

### UI recommendations: "set up a trading agent in one screen"

1. **Fields (only these):**
   - **HL account address** (the owner's master `0x…`; becomes the only allowlist entry, chain `hypercore`).
   - **Daily funding limit** and **per-top-up amount** (USDC; vault mandate).
   - **Pair**: a dropdown filled from `spotMeta`, default HYPE/USDC; v1 allows one pair.
   - **Max position** (USDC notional).
   - **Daily loss stop** (USDC or %).
   - **Expiry** (mandate expiry; also used as the API wallet `valid_until`, max 180 days).

   Everything else is a default: slippage band 1%, order TIF, poll interval.
2. **One guided "Connect Hyperliquid" step instead of key handling.** The bot creates its API wallet itself (in the TEE
   or locally) and shows its *address*. The owner approves that address once: either the HL web app's API page or
   an "Approve on Hyperliquid" button that sends `approveAgent` through an injected EVM wallet. The owner never sees or
   pastes a private key. Show "Approved / expires in N days / not approved" from the HL `extraAgents` info request
   [unverified exact info type name].
3. **Strategy as a chosen template plus parameters, not a code editor.** Offer DCA, grid and threshold rebalance. The
   owner's own algorithm (written with Claude Code) is a module in the worker repo that implements the same interface.
   The dashboard shows its name and version hash.
4. **A status card with four numbers:**
   - HL balance (USDC + base asset at mid).
   - **PnL today and since start**: equity minus net funded. Net funded = vault payouts to HL minus returns. The vault
     payout log already has the "funded" number.
   - **Limits left**: vault daily funding left (from the mandate view) and loss-stop distance.
   - Open orders count.
5. **Open orders and fills tables** read from HL `openOrders` and `userFills` using the master address (not the agent
   address; see A1). Read-only, with a link to the HL explorer.
6. **One red kill switch** that does all of the following and shows each step's result:
   - (a) pause the agent's mandate on the vault (owner tx, NEAR wallet);
   - (b) the bot stops and cancels all orders; `scheduleCancel` also covers the case where the bot is dead;
   - (c) the owner revokes the API wallet: send `approveAgent` with the same name and a fresh dummy address, or use the
     HL app (EVM wallet);
   - (d) optional "sell to USDC and return to vault": master `spotSend` to a 1Click deposit address, then
     `sync_surplus`.

   Steps (c) and (d) need the EVM wallet; say so on the button.
7. **"Return profits" button** with the 1Click quote shown first ("you send 100 USDC from HL, the vault receives
   ≈99.79"). The same quote-check rule applies as for payouts.
8. **Show what is not protected** in one line under the card: "Funds on Hyperliquid can be lost through trading. The
   vault limits only how much is sent there per day."

---

## C. Recommended minimal architecture

```
owner NEAR wallet ──► Vault (existing)                      owner EVM wallet (Rabby/MetaMask)
                       agent "hl-trader" (Key or Tee)          │ approveAgent(bot addr, valid_until)
                       mandate: chains=[hypercore]             │ revoke / spotSend profits / withdraw
                         allowlist=[owner HL 0x…]              ▼
                         daily_limit, per_payment, expiry   Hyperliquid master account (owner HL 0x…)
                         approval_threshold                    ▲ spot USDC   ▲ orders (API wallet signs)
                              │ request_payment                │             │
                              ▼                                │             │
                       1Click NEAR USDC → hypercore hip1 USDC ─┘     trading bot (worker module)
                                                                       holds: NEAR key for request_payment
                                                                              HL API wallet key (trade only)
                                                                       runs: strategy + risk guard
profits: owner spotSend → 1Click deposit addr → NEAR USDC → vault (plain ft_transfer) → owner sync_surplus
```

### Components

1. **Vault: no contract change.**
   - Add an agent `hl-trader` with a mandate:
     - `allowed_chains = ["hypercore"]`;
     - `allowlist = [{chain: "hypercore", address: <owner HL master>}]`;
     - small `daily_limit` (e.g. 50 USDC) and `per_payment_limit` (e.g. 25);
     - `max_payments_per_day` 2–3;
     - `approval_threshold` at or below the per-payment limit if the owner wants to approve every top-up;
     - `expiry` set.
   - The agent's own funding requests reuse the existing `request_payment` path with the quote check.
   - The `hypercore` chain id and an EVM address already pass mandate validation; chains are free strings
     (`contract/src/agent.rs`). A contract test with a `hypercore` allowlist entry is still worth adding.
2. **SDK / worker changes (small):**
   - `sdk/src/chains.ts`: `resolveUsdc` throws "several USDC tokens" on `hypercore`. Pin the hip1 asset id for
     `hypercore`, or prefer `hip1` assets.
   - Add `hypercore` to `EVM_CHAINS` so addresses are validated.
   - Destination decimals are 8; the quote check must already handle `destDecimals`. Verify this.
   - Update the MCP tool description.
3. **Trading bot: a new worker module (TypeScript, `@nktkas/hyperliquid`).** Loop every 30–60 s:
   1. read the HL state for the master address (`spotClearinghouseState`, `openOrders`, mids);
   2. run the risk guard;
   3. ask the strategy for target orders;
   4. place IOC/GTC limit orders inside a ±1% band around mid;
   5. refresh `scheduleCancel` (now + 2–5 min) on every loop;
   6. when HL USDC falls below a floor and the daily funding has not been used up, call vault `request_payment` to
      top up.
4. **Where it runs:**
   - **For the deadline: local mode** with a fresh API wallet. It is honest, simple, and the HL key cannot withdraw.
   - **TEE (Phala via shade-agent-cli) as the target:** the API wallet key and the NEAR agent key are generated inside
     the enclave, and the vault binds the Tee slot by attestation. The catch: every strategy code change is a new image
     measurement to approve. Keep strategies as config, or accept re-approval.
   - TEE is M4 territory and should not block this feature.

### Trust boundaries and what each one stops

| Boundary | Enforced by | Stops | Does not stop |
|---|---|---|---|
| Vault mandate | NEAR contract | Bot or leaked NEAR key sending vault USDC anywhere but the owner's HL account, or more than the daily/per-payment limit; works while the owner is away | Losses after funds reach HL |
| HL API wallet | HL protocol (user-signed vs L1 actions) | Bot or leaked HL key withdrawing or sending funds to another address | **Perp trading with leverage** (via unified collateral or `agentSendAsset`), bad trades, deliberate trades against an attacker's order on an illiquid pair, staking moves |
| Bot risk guard | Our code (in TEE: attested code) | Pairs outside the allowlist, orders outside the ±band around mid, position above max, trading after the daily loss stop, any perp position (alarm, then flatten and stop) | A compromised host in local mode (it can bypass its own code) |
| `scheduleCancel` | HL protocol | Orders left open after the bot crashes | Positions already filled |
| Owner master key (EVM) | Owner's wallet | Everything else: revoke the API wallet, return funds, withdraw | Owner's own mistakes; it is a second wallet the owner must keep safe |

### What the vault cannot protect, and mitigations

- **Trading losses on HL.** Spot-only trading has no liquidation, so the worst case is losing what is on HL. But the
  key can trade perps (see A1), so the bot must refuse and alarm on any perp position. Mitigations:
  - small daily funding cap and a mandate expiry;
  - keep HL equity small: sweep profits back on a schedule (manual or button);
  - a daily loss stop in the bot: equity below start-of-day equity minus X means cancel all, stop, and report a
    "halted" status to the dashboard;
  - a max-position cap.
- **Leaked HL API key.** The attacker cannot withdraw, but can buy a token the attacker sells at a bad price on a thin
  pair, or open perps. Mitigations:
  - small exposure;
  - API wallet expiry of 7–30 days;
  - revoke on any suspicion;
  - fresh address per rotation (never reuse, per the docs).
- **The owner's EVM key is a second root of trust.** Recommend a hardware wallet.
  - **Option 2 (post-hackathon, strong story):** the vault itself controls the HL master address through NEAR Chain
    Signatures (MPC secp256k1 signing of the EIP-712 `approveAgent` / `spotSend` payloads). Then "return profits only
    to the vault" and "only these API wallets" become contract rules too.
  - This is too much for 12 days. Record it as future work [unverified feasibility details: EIP-712 hash signing via
    `v1.signer` is supported in principle].
- **Strategy code from an AI agent.**
  - The owner reviews and commits it.
  - The risk guard is separate code that strategies cannot change: it wraps the order submitter.
  - In TEE mode the measurement pins the reviewed code.

### Minimal demo plan (fits the deadline)

1. The owner's EVM address is activated on HL. The vault funds it with 20–30 USDC through 1Click (real mainnet, tiny
   amount; needs the owner's explicit OK).
2. Claim testnet USDC with the same address. Develop and run a DCA or grid strategy on testnet HYPE/USDC (`@1035`).
3. Approve a fresh API wallet (`valid_until` 30 days). Run one mainnet session with $10–20 orders on HYPE/USDC
   (`@107`, asset 10107).
4. Dashboard: HL balance, PnL vs funded, open orders, limits left, kill switch.
5. Show a rejected over-limit funding request and a rejected request to a non-allowlisted address (existing vault
   behaviour).

### Open risks / to verify before building

1. Where 1Click hip1 USDC actually lands (spot balance), and how the activation fee is handled for fresh addresses. Test
   with one 20 USDC transfer.
2. The deposit mechanics for HyperCore → NEAR (how the `depositAddress` is formatted, and whether a `spotSend` to it is
   detected). This needs one real non-dry quote and a small transfer.
3. The default API wallet expiry when `valid_until` is omitted, and the exact info request that lists approved agents.
4. Whether the HL web app's API page accepts an externally generated address. Otherwise the dashboard needs a small
   EIP-712 `approveAgent` signer through an injected EVM wallet.
5. The worker's Node version against `@nktkas/hyperliquid`'s Node ≥ 22.12 requirement.
6. Regulatory / ToS: HL geo-restrictions apply to the owner. That is not our call, but it is worth a line in the README.

---

## V0 spike results (2026-11-02, read-only)

Method: public `info` requests through `@nktkas/hyperliquid` 0.33.3 (`InfoClient` + `HttpTransport`, mainnet and
`isTestnet: true`), run through the real `NktkasHl` adapter (`worker/src/trading/hl/nktkas.ts`). Nothing was signed and no
order or exchange action was sent. Active accounts used for shape checks were taken from the public `recentTrades` of
`@107`.

| Item | Result |
|---|---|
| `spotMeta` / `spotMetaAndAssetCtxs` | **Confirmed.** `universe[i] = { tokens: [base, quote], name: "@<index>", index, isCanonical }`, `tokens[] = { name, szDecimals, weiDecimals, index, ... }`. Asset id = `10000 + universe.index`. Mainnet HYPE/USDC = `@107`, id 10107, `szDecimals` 2. Testnet HYPE/USDC = `@1035`, id 11035, `szDecimals` 2. `assetCtxs` carry `coin`, `midPx` (null on empty book) and `dayNtlVlm`. |
| `isCanonical` | **Surprise.** HYPE/USDC `@107` has `isCanonical: false` on mainnet (only legacy PURR/USDC is canonical). The adapter therefore must not require canonical. It drops a display name only when several non-canonical tokens share it. `HYPE/USDT0`, `HYPE/USDE`, `HYPE/USDH`, `KHYPE/USDC` exist next to it, so the pair allowlist must be matched by the full display name. |
| Display-name collisions | Mainnet: none for HYPE/USDC. Testnet has 1343 pairs and many duplicate token names, but `HYPE/USDC` is still unique. |
| Volume units | `dayNtlVlm` is in quote-token units. For `/USDC` pairs it is USDC. `HYPE/USDT0` volume is in USDT0, so the volume gate should only be applied to `/USDC` pairs (ADR already says quote USDC). Mainnet HYPE/USDC 24 h: about 85 M. |
| `allMids` | Spot keys are `@<index>` (and `PURR/USDC`), perps are bare tickers. Values are decimal strings. Mid from `allMids` and `midPx` from the asset ctx differ slightly by timing, so the engine should use one source (the adapter's `getMids`). |
| `candleSnapshot` for spot | **Confirmed** with `coin: "@107"`: returns `{ t, T, s: "@107", i, o, c, h, l, v, n }`, 1h and 1d both work, on mainnet and on testnet (`@1035`). The `price_change` trigger can use it. |
| `l2Book` for spot | Works with `coin: "@107"`. Testnet HYPE/USDC is not a usable price source: mid 9777.5, bid 8200, ask 11355 at the time of the test. The spread gate would (correctly) skip every tick there, so testnet runs need a pair with a sane book or the fake port. |
| Approved API wallets | **Confirmed.** Info request `extraAgents { user }` returns `[{ name, address, validUntil }]`. `validUntil` is a **millisecond** timestamp (for example 1797408899328) or null. `name` is the name given at approval (a plain string such as `"agent-treasury valid_until 1797408899328"`). Address is lower-case. Works for both networks. `HlPort.getApprovedAgents` maps it as `{ address, name | null, validUntilMs }`. |
| Ledger fields for `net_inflow` | **Partly confirmed.** `userNonFundingLedgerUpdates` returns `delta.type` values seen live: `send`, `spotTransfer`, `cStakingTransfer`, `deposit`, `withdraw`, `internalTransfer`, `accountClassTransfer` and others (see the library type). Transfers carry `user`, `destination`, `token` (can be `"USDC"` or `"USDC:0x..."`) and `amount`. The adapter counts USDC `spotTransfer`/`send`/`internalTransfer` by `destination`/`user` equals the account, plus `deposit`/`withdraw`, and ignores `accountClassTransfer`. **Not verified:** which `delta.type` a real 1Click HyperCore landing produces (probably a `spotTransfer` from a system address). This still needs the first 20 USDC mainnet top-up. |
| Perp state | `clearinghouseState` (default dex) gives `assetPositions[].position.{coin, szi}` and `marginSummary.accountValue`. Open perp orders come from `frontendOpenOrders` (anything whose coin is not `@N` and has no `/`). HIP-3 builder-dex positions need a `dex` argument and are **not** covered by the adapter. |
| Fills | `userFillsByTime { user, startTime }` returns at most 2000 rows per response and only the 10000 newest (paginate by last timestamp). `cloid` is present on live fills (verified 2026-11-03, see "Live testnet trade"); the engine still also matches fills by remembered order id. Rows have `cloid`, `fee`, `feeToken`. Buys pay the fee in the base token (for example `HYPE`), so the adapter converts to USDC at the fill price. **Ordering: not documented and not verifiable live yet.** The docs (info-endpoint, "Retrieve a user's fills by time") say only "Returns at most 2000 fills per response and only the 10000 most recent fills are available" (`userFills` says "most recent"). A read-only query on 2026-11-03 (testnet, `0x072994Aa1Bdb9886Ce04f6D42c6ee513fA92ab0d`, `startTime 1793600000000`) returned exactly one row, so order cannot be inferred. The adapter therefore accepts a full page only if it is ascending and starts at the cursor, else `FILLS_TRUNCATED`; re-check when an account with more than one fill exists. |
| `scheduleCancel` volume gate | **Confirmed live 2026-11-03** (testnet): refused with `Cannot set scheduled cancel time until enough volume traded. Required: $1000000. Traded: $0.` Same rule expected on mainnet. Handled by IOC-only mode (ADR-0005). |
| `scheduleCancel` trigger counting | **Not verified** (needs a signed action). Remains an ADR **[verify]** item: do not rely on 180 s refreshes every tick before checking on testnet. |
| HL UI accepts an external API wallet address | **Not verified** (needs the master wallet in a browser). Fallback D4 stays in the plan. |
| Order response shape | From the library types: `statuses[0]` is `{ resting: { oid } }`, `{ filled: { totalSz, avgPx, oid } }` or `{ error }`. The library **throws `ApiRequestError`** for any status carrying `error`, so "IOC found nothing" arrives as an exception with message "Order could not immediately match against any resting orders". The adapter maps it to `unfilled`. The exact live wording is **not verified**. |

### Node version
- `@nktkas/hyperliquid` 0.33.3 declares `engines.node >= 22.12.0`.
- `worker/Dockerfile` pins `node:22-alpine@sha256:92d51e5f...`. Docker Hub tag listing shows that digest is
  **`22.22.1-alpine` / `22.22.1-alpine3.23`** (checked 2026-11-02), so it satisfies >= 22.12. The check was by tag
  listing, not by running the image.
- `worker/package.json` still has no `engines` field (task W2 in the ADR asks for `>=22.12`; not changed here).

### Signer note
`ExchangeClient` accepts a viem local account, an ethers v5/v6 signer or a viem JSON-RPC account (`AbstractWallet`). viem is
**not** a direct dependency of the worker (it is only in the pnpm store through other packages). `createNktkasHl` therefore
takes the wallet as an argument; the code that builds the API-wallet account from the stored private key
(`wallet.ts`) must add `viem` (`privateKeyToAccount`) to `package.json`, or implement the small `AbstractViemLocalAccount`
interface itself (`address` + `signTypedData`).

## Live testnet trade (2026-11-03)

First real bot order on HL testnet (account `0x072994…ab0d`, API wallet `0x3B83…96e1`, rules hash `bb49a14c0945f933…`):
IOC buy 3 PURR/USDC with limit 4.6252 (band edge) filled at **4.5795** (best ask). `userFillsByTime` returns
`cloid: 0xbb49a14c0945f9330000000000000001` (rules-hash prefix + counter) and `oid`, so fill attribution by cloid works
live. The spot buy fee is charged in the base token (`fee 0.0021`, `feeToken PURR`), so the position is 2.9979 PURR.
Other live findings that day: `scheduleCancel` requires $1M traded volume ("Cannot set scheduled cancel time until
enough volume traded"), so the engine runs IOC-only without the dead-man switch; PURR has `szDecimals 0`, so a
12 USDC order at ≈4.6 rounds to 2 PURR = 9.25 USDC, below the 10 USDC minimum; the HL API page accepts an external
API-wallet address and takes `valid_until` from the name only when typed exactly, otherwise the default is 180 days.
