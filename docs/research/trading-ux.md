# Research: UX for the "Trading agent" page (onboarding, risk copy, rule authoring)

Date: 2026-11-02. Scope: how comparable products onboard users and explain strategy authoring, and what that means
for `/trading` (`dashboard/src/features/trading/*`). Builds on ADR-0005 §4, §6, §7 and the Rules DSL v1, and on
`docs/research/hyperliquid-trading.md` §B. No code was changed.

Owner feedback this answers: "not enough explanation", "creating the agent is not obvious, need an intro first",
"how to describe rules is not clear".

Source labels:
- **[docs]**: the vendor's own docs or help center, fetched on 2026-11-02.
- **[3rd]**: a third-party guide or review, fetched or seen in search results.
- **[unverified]**: from search snippets or memory only. Not checked against a primary page.

---

## 1. What the current page does (short audit)

- The page opens straight into `SetupCard` ("Set up the trading agent"), with env var names (`TRADING_ENABLED`,
  `HL_MASTER_ADDRESS`, `TRADER_NEAR_PRIVATE_KEY`) in the first screen. It never says what the bot is, where the money
  goes, or what the vault does and does not protect. The one honest line ("Funds on Hyperliquid can be lost through
  trading…") sits at the bottom of a card.
- There is no visible order of steps. Setup, bot wallet, rules, status and kill switch are separate cards, and the
  owner has to work out which one is blocking.
- The rules card says "Describe a strategy in plain words" and opens the assistant with `"Trade HYPE on Hyperliquid: "`.
  It gives no examples, no list of what the DSL supports, and no limits, so the owner has to guess what the model
  will accept.
- What is already good, and the redesign keeps it:
  - the deterministic English renderer (`describeBlocks`, never LLM text);
  - hash display and mismatch callouts;
  - a kill switch that shows the result of each step;
  - the "Vault limits (funding)" and "Trading limits (bot)" split.

---

## 2. Products surveyed

### 2.1 Venue-native bots (closest to us: HL API wallet)

**Senpi** (AI agents on Hyperliquid)
- **Onboarding:** "connect your Hyperliquid wallet" → choose an agent → "Authorize the agent to trade … on your
  behalf". Free trial, no card. You can paste any HL address first, "read-only until you say otherwise", and the AI
  ranks your trading "leaks" in dollars before you delegate anything. [docs] https://senpi.ai/skill.md ,
  https://trade.senpi.ai/trade-ai/hetu
- **Risk copy:** one sentence on each market page ("carries liquidation, funding, and strategy-mismatch risk").
  Each agent has a risk label (Conservative / Balanced / Aggressive). Trust claims are short and concrete:
  "trade-only permissions — it can never withdraw or transfer funds", "Senpi never holds your funds", "pause, switch,
  or fully revoke … no lockups". The fee split is "shown in the Senpi app before you delegate". [docs] same URLs
- **Strategy definition:** three ways.
  - 114 named templates (Hawk = breakouts, Hummingbird = trends, Weaver = mean reversion).
  - A plain-language builder: "Describe the trade you want". The example prompt states entry, stop and
    take-profit in one sentence: "Long ETH when it breaks the weekly high with strong volume".
  - Copy trading. [docs] https://senpi.ai/skill.md
- **Before start:** agent profile with historical performance, supported assets and tags. "deployed strategies only
  run rules you approved". [docs]
- **After start:** balances, positions, strategy results. Alerts for "a floor moved up, a stop hit, a signal". You
  can ask the agent about positions. [docs]

**Katoshi** (bot builder for HL)
- **Onboarding:** "+" → connect HL wallet → name the bot → create an API key on HL and paste its secret → "Activate
  Wallet" (a signature that also approves the builder-code fee). The account must already be funded. [docs]
  https://katoshi.gitbook.io/katoshi-docs/app/bots
- **Risk controls as fields:**
  - Min order size, which exists to meet HL's $10 minimum. Same constraint as ours.
  - Max order size. Their worked example: "a $10,000 signal … opens as a $1,000 position when the cap is $1,000".
  - Whitelisted coins and whitelisted IPs. [docs]
- **Strategy definition:** code-like expressions (`ta.crossunder(ta.rsi($$, 14), 30)`) plus a JSON signal payload, on
  a candle interval. Each trigger can be "run manually to see the calculated signal and response", which is a dry run
  of one rule. [docs]
- **Status:** mostly an on/off toggle per bot ("Disabled bots will stop all signals from executing"), plus logs. [docs]

**Hyperliquid's own API wallet page** (the step our owner must do by hand)
- **Flow:** account menu → More → API → enter a **name** → "Generate" → "Authorize API Wallet" → **Days Valid** (MAX =
  180) → "Authorize" (signed by the master).
  - Cornix warns "do not skip this button".
  - The account must hold funds first, or generation fails.
  - The page lists approved agents with name, address and "Valid Until", plus a revoke control.
  - [3rd] https://help.cornix.io/en/articles/11010094-how-to-create-api-keys-hyperliquid ,
    https://support.altrady.com/en/article/how-to-connect-your-hyperliquid-exchange-account-dquav0 ,
    https://chainstack.com/hyperliquid-agent-wallets-nonce-state-machine/
  - Button labels vary across guides ("Generate API Wallet", "Create API Key") [3rd].
  - **Our flow differs:** the bot already has an address, so the owner pastes *our* address instead of clicking
    Generate. That the HL UI accepts a pasted address is still **[verify]** in ADR-0005 §3.
- **Official docs:**
  - "API wallets are only used to sign".
  - Querying the agent address "leads to an empty result".
  - Approving a new unnamed wallet, or reusing a name, deregisters the old one.
  - Never reuse addresses: after pruning, "previously signed actions can be replayed".
  - [docs] https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Every third-party guide (Cornix, Altrady, Wick Hunter, AiCoin) is a **screenshot-per-step walkthrough** of this one
  page. Users get it wrong often enough that each bot vendor writes its own guide.

**Hummingbot** (open-source strategy framework)
- **Strategy definition:** the client prompts for a YAML config (`create --v2-config`) and starts it
  (`start --v2 <file>`). Scripts are "ideal for learning, testing, and prototyping"; controllers are for long-running
  deployments. [docs] https://hummingbot.org/strategies/
- The Dashboard adds credentials → configure → **backtest** → deploy → manage instances, "before deploying them
  live". The Streamlit dashboard is no longer maintained, and Condor replaces it. [docs] https://hummingbot.org/dashboard/
- **Lesson:** even a code-first tool puts *configure → backtest → deploy* in a fixed order and shows instances with
  live status.

### 2.2 Exchange and SaaS bot wizards

**Binance Spot Grid**
- Three setup modes: **AI** (parameters from recent price history), **Popular** (copy a preset ranked by ROI/PnL/
  runtime) and **Manual** (edit AI or Popular values). Advanced: trigger price and TP/SL. After creation: "Your order
  is successfully created" → the **Running** tab. [docs]
  https://www.binance.com/en/support/faq/95078b6293184bd79b56108092f337c1
- **Risk copy:** next to each mode, not on a separate page.
  - "there is no guarantee how long your grid strategy will run";
  - "these preset parameters do not guarantee to deliver the same results";
  - "You are solely responsible…". [docs]
- AI parameters are unavailable when the asset has too little history (futures grid FAQ). [docs]
  https://www.binance.com/en/support/faq/647b0dba72d145219688b04aa51405fc

**Pionex** (built-in bots)
- DCA Simple mode: pick a pair → "AI Strategy" → **Risk Preference** (Balanced vs Conservative, explained in one line
  each) → optional parameters → investment → Create → Confirm.
- Detail page after start: Investment, Total Profit, Arbitrage Profit, Trend PnL, APR, Current Price,
  Take-Profit Price, Rounds.
- Help articles show a historical backtest that includes **max drawdown (−52.84%)** next to APR. [docs]
  https://intercom.help/pionex/en/articles/14616344-dca-martingale-bot-simple-mode
- Grid AI 2.0 fills the parameters from a 7/30/180-day backtest and shows the max drawdown for that window.
  "AI 2.0 Backtest" pre-fills the fields. [docs] https://intercom.help/pionexus/en/articles/14319694-grid-trading-bot

**Bitget** (Spot Martingale/DCA, grid, copy)
- AI mode "recommends parameters with varying levels of risk based on the user's asset status and risk tolerance".
  Manual mode is for experienced users. [3rd/docs snippets] https://www.bitget.com/support/articles/12560603823363
- Plain warnings about lifecycle: "does not support a pause function … once terminated, cannot be resumed".
  [unverified, search snippet]
- Third-party tools tell users to create Bitget API keys "without withdrawal rights". [3rd] https://bitsgap.com/en-AU/crypto-trading-bot/bitget

**3Commas** (DCA/grid bot SaaS)
- Prerequisite: connect an exchange (API key + secret) in "My Exchanges". Then "Create Bot" → strategy type. DCA is
  pitched as the beginner option. [3rd] https://www.bitget.cloud/academy/3commas-bot-setup
- The settings page computes **how much capital the settings need** while you edit [3rd, TradingView script notes].
  The official help center did not come up in search, so the field list is **[unverified]**.
  https://3commas.io/cs/dca_bots

**Cryptohopper**
- Marketplace of strategies, templates and signals. A visual no-code "Strategy Designer" with 130+ indicators.
  Backtesting with a "Configuration finder". Paper trading on live data. [3rd, reviews only]
  https://gainium.io/review/cryptohopper , https://www.cryptoninjas.net/crypto/cryptohopper-review/
- **Lesson:** paper trading and templates lower the fear of the first start. Indicator-heavy designers are what *not*
  to copy for a 12-day DSL.

### 2.3 Agent wallets and policy UIs

**Coinbase Agentic Wallet / AgentKit**
- Install skills → agent authenticates by email OTP → fund → `npx awal status`. "Configurable caps per session and
  per transaction"; "Enforce limits before any transaction". [docs]
  https://docs.cdp.coinbase.com/agentic-wallet/cli/welcome.md
- The limits are the headline of the pitch ("Give agents spending power with per-session limits"). [docs]

**Giza ARMA** (autonomous yield agent)
- **Three steps:** a smart account is created as the deposit address → the user approves a USDC deposit, which also
  creates a session key → `activate`.
  - Deposit is 5 to 1,000 USDC in the initial phase.
  - Session keys "can only call approved protocol contracts … within approved time windows and up to specified
    limits" and expire.
  - Deactivation unwinds positions and revokes keys.
  - [docs] https://docs.gizatech.xyz/docs/getting-started , https://build.gizatech.xyz/concepts/smart-accounts
- **Lesson:** a short, numbered flow with hard min/max amounts stated up front, and an explicit "how to get out".

**Privy policies**
- Rules = conditions + ALLOW/DENY. "DENY actions take precedence"; "If no rules resolve, the policy will default to
  DENY".
- The examples are written as sentences: "ALLOW transfers of the native token to a set of allowlisted recipient
  addresses".
- The docs say what is *not* policy enforcement: compliance screening and simulation run outside the enclave.
- Policies can be managed in the dashboard, the SDK or the API. [docs] https://docs.privy.io/controls/policies/overview
- **Lesson:** state the default ("anything not listed is refused") and draw an explicit line around what the policy
  covers.

**Turnkey policies**
- JSON with `effect`, `consensus` and `condition` in a small expression language. "Almost all actions … are
  implicitly denied by default".
- Each policy has a **human `policyName`** that reads like a sentence ("Allow a single user to send transactions to
  <ADDRESS>"). [docs] https://docs.turnkey.com/concepts/policies/overview
- **Lesson:** the sentence-style name is the summary the owner reads. We already render one; make it the headline.

**Safe + Zodiac Roles**
- Role → **members** (who) → **targets** (which contracts, which functions, which arguments). The UI saves changes
  only after "Create Role" + sign.
- Advanced users keep permissions as config files (permissions-starter-kit). [docs]
  https://github.com/gnosisguild/zodiac-modifier-roles , https://zodiac-wiki.vercel.app/documentation/roles-modifier/roles-modifier-operator-tutorial
- **Lesson:** "who / what / within which limits" is a mental model owners already know from multisigs.

**Wayfinder**
- Agents ("shells") run multi-step plans in a simulation (virtual network) before executing, with "human
  confirmation in the loop when needed". [3rd] https://reports.tiger-research.com/p/wayfinder-eng
- Onboarding details were not found **[gap]**.

**Brian AI**
- Natural language ("swap 10 USDC for ETH on Base") → extracted intent parameters → ready-to-sign calldata. The
  confirm step is left to the calling app. [3rd] https://huggingface.co/spaces/brianknowsai/README/blob/main/README.md
- **Lesson:** the model output is a *structured proposal* and the human reviews and signs it. We do the same, so
  show the structure.

---

## 3. Patterns that matter for us

1. **A short numbered setup with the current step obvious.** Senpi (connect → choose → authorize), Giza (account →
   deposit → activate), Katoshi (+ → wallet → name → key → activate), Pionex (pair → AI → risk → amount → confirm),
   Hummingbot Dashboard (credentials → config → backtest → deploy). Nobody shows all cards at once to a new user.
2. **Trust claims in one concrete sentence each, plus one honest risk line.** Senpi ("trade-only… can never withdraw",
   "never holds your funds", "revoke anytime"); Binance and Pionex ("no guarantee…"); Privy (what is *not* policy
   enforcement). The risk line sits next to the action, not at the bottom of the page.
3. **A walkthrough of the venue's own approval page.** Cornix, Altrady, Wick Hunter and AiCoin each document HL's API
   page step by step: name, Days Valid = MAX, "do not skip Authorize", fund first. This is the most error-prone step
   in every HL bot, and ours adds "paste *our* address, not Generate".
4. **Templates first, free text second, raw config last.** Senpi (114 templates + a "describe the trade" builder),
   Binance (AI / Popular / Manual), Pionex (AI Strategy + risk preset), Cryptohopper (marketplace + designer),
   Hummingbot (configs for experts).
5. **Example prompts that name the full trade.** Senpi's example states entry, stop and profit-taking in one sentence.
   Users copy the shape of the example, so the examples teach the DSL.
6. **Limits as numbers with units and the reason behind them.** Katoshi (min order exists for HL's $10 minimum; a max
   order example in dollars), Giza (5–1,000 USDC), Coinbase (per-session and per-tx caps as the headline).
7. **A readable summary before commit: a sentence, not JSON.** Turnkey's sentence-like `policyName`, Binance's
   confirm dialog, 3Commas' "required funds" while you edit, Katoshi's "run manually to see the signal". The strong
   version is a **worst-case number**: Pionex shows max drawdown next to APR.
8. **A dry run before going live.** Pionex and Hummingbot (backtest), Cryptohopper (paper trading), Wayfinder
   (simulation), Katoshi (manual trigger run). We have no backtest. Our honest equivalent is "what would happen right
   now" for each rule with today's numbers (see §5.4).
9. **After start: a small set of numbers plus an event feed, and one off switch.** Pionex (8 metrics), Senpi (alerts
   for stop moved / hit / signal), Katoshi (toggle), Binance (Running tab).
10. **Default deny, said out loud.** Privy and Turnkey. Our version: "The bot does only what these rules say. Anything
    else (other coins, perps, withdrawals) is refused."

---

## 4. Recommended page structure

### 4.0 Layout

- **Not set up yet** (no `hl-trader` agent, or worker state `not_configured`): show the **Intro** in full, then the
  **Stepper** with step 1 open.
- **Set up, not running** (`awaiting_api_wallet` | `no_rules`, or no funds): show the Intro as one collapsed line
  ("How the trading agent works"), then the Stepper open on the first unfinished step.
- **Running / stopped_today / paused_onchain / halted / error:** show the **status header**, Status, Rules and
  Kill switch, with the Stepper collapsed to a single "Setup ✓ 6/6" row that can be expanded.
- Kill switch: always reachable once step 2 is done, pinned top-right of the status header.

Each step has a **state** (Done / Now / Blocked / Later), a **one-line why**, the **action**, and **how we check it**
("checks every 10 s").
- Done steps collapse to one line with what was set (for example "Bot wallet 0xab…cd approved, valid until 4 Nov").
- Steps are derived only from data the dashboard already reads: agents, mandate, `/trading/status` `state`, HL
  `extraAgents`, account trust.

### 4.1 Intro (honest, about 120 words, one diagram)

> **Trading agent**
> A bot that trades HYPE/USDC spot on Hyperliquid for you, using rules you write in plain words and sign.
>
> **How money moves**
> `Vault (NEAR)` → small top-ups through NEAR Intents → `your Hyperliquid account` ← the bot places orders here.
> Profits come back to the vault when you send them (manual, see "Bring money back").
>
> **What is protected**
> - The vault sends money only to *your* Hyperliquid account, at most {daily_limit} USDC a day, and you approve each
>   top-up. (The approval part appears only while `approval_threshold = 0`.)
> - The bot's key can place orders but cannot withdraw or send funds anywhere.
> - The bot trades only by the rules you signed. An AI turns your words into rules; it never places orders.
> - Hard caps the rules cannot exceed: {max_position} USDC position, {max_order} USDC per order, stop after
>   {loss_stop} USDC loss a day, spot only.
> - One button stops everything: cancels orders, halts the bot, pauses its vault access.
>
> **What is not protected**
> - You can lose what is on Hyperliquid through trading.
> - The bot's key works for your whole Hyperliquid account. Use a separate account that holds only this money.
> - Hyperliquid cannot limit the key to spot. The bot refuses perps and halts if it sees any, but a stolen key could
>   still open them.
> - The bot runs on this worker (local mode, not in a TEE yet).

Notes:
- Fill the numbers from the hard limits and mandate (status already exposes them). Never hard-code them in the copy.
- The "not protected" list mirrors README "What the vault does NOT protect" and audit H2. Keep both texts in sync.
- The diagram is three boxes and two arrows (inline SVG). No chart.

### 4.2 Stepper

**Step 1. Hyperliquid account**
- Why: "The bot trades in a Hyperliquid account you own. Use a new one only for the bot."
- What to show:
  - an input "Your Hyperliquid account address (0x…)";
  - checks: format, the account exists and is active on HL (`clearinghouseState` / spot balances non-empty or
    activation seen), and it is not the account they trade with by hand (a checkbox, "This account holds only money
    for the bot");
  - a link "How to create a second Hyperliquid account" [needs a HL doc link, verify].
- Blocked state: "This account is not active on Hyperliquid yet. Hyperliquid charges 1 USDC to activate an account;
  deposit a few USDC there first."
- Done: "Account 0x12…34 (mainnet)".

**Step 2. Create the agent in the vault**
- Why: "The vault gets a new agent, hl-trader, that may send money only to the account from step 1, within these
  limits."
- What to show:
  - the mandate as a sentence first: "hl-trader may send up to {per_tx} USDC per top-up, at most {daily} USDC and
    {n} top-ups a day, only to 0x12…34 on Hyperliquid, until {expires}. You approve each top-up."
  - then the editable fields (daily limit, per top-up, expiry);
  - testnet: one button "Create agent" (wallet tx);
  - mainnet: the CLI command block (M6 fix), with "Run this on your machine; the key is printed once and goes into
    the worker's .env".
- Blocked: "Only the vault owner can do this. Connect the owner wallet." / "Set VITE_WORKER_URL so the dashboard can
  reach the trading agent." (existing copy, moved here).
- Done: "Agent hl-trader active · expires in 47 h".

**Step 3. Approve the bot's wallet on Hyperliquid**
- Why: "The bot has its own key. Hyperliquid lets that key trade for your account, never withdraw."
- What to show:
  - the bot wallet address, large, with Copy;
  - the trust check result (existing `AccountTrustCallout`);
  - a numbered mini-guide:
    1. Open app.hyperliquid.xyz/API with the account from step 1.
    2. Paste this address (don't click Generate).
    3. Name: `agent-treasury` (shown, copyable, with `valid_until`).
    4. Days valid: 2 for this session (max 180).
    5. Click Authorize and sign.
  - a note: "Compare the first and last 4 characters with the worker console before you sign."
- Live check: "This page checks every 10 seconds and turns green once Hyperliquid lists the address."
- Warning if `other_approved_agents` is non-empty: "Hyperliquid lists N other API wallets on this account. Any of them
  can trade it. Remove the ones you don't use."
- Blocked: "The bot has not created its wallet yet. Start the worker with TRADING_ENABLED=true."
- Done: "Approved · valid until 4 Nov 18:00".

**Step 4. Fund the account**
- Why: "The bot asks the vault for a top-up when the Hyperliquid account has less than {floor} USDC. Each top-up is
  {per_tx} USDC."
- What to show:
  - HL free USDC now;
  - the vault funding left today;
  - the pending top-up (if any) with "Approve" linking to the approval (threshold 0) and the 1Click quote line ("you
    send 25 USDC, about 24.68 arrives on Hyperliquid");
  - the delivered amount once credited (`pnl.net_funded_usdc`).
- Copy: "Top-ups start on their own once the bot's wallet is approved. Approve the first one here."
- Blocked: "Top-ups are blocked: {extraWarnings.topup}" (already produced by the worker). / "The vault agent is
  paused: no more top-ups."
- Session rule (audit M3): "Wait until the top-up shows as credited before you sign rules." Show it as a check that
  turns green.
- Done: "Funded 24.68 USDC".
- Funding runs in `awaiting_api_wallet` and `no_rules` as well (`worker/src/trading/service.ts` funding note), so
  steps 3 and 4 can overlap. Keep the order 3 → 4 in the UI anyway, because the bot cannot trade without step 3.

**Step 5. Write the rules**
- Why: "Tell the bot when to buy and sell, in plain words. You check the rules and sign them; the bot follows only
  signed rules."
- What to show: the authoring panel in §5 (template chips, example prompts, "you can / cannot say", the textarea
  that sends to the assistant, the compiled preview, and the "Review & sign rules" button).
- Blocked:
  - "The assistant is switched off in this dashboard (VITE_AI_ENABLED)". Offer a fallback: "Paste rules JSON"
    validated by `parseRuleSet` (optional, small).
  - "Sign in as owner to write rules" (NEP-413 session).
- Done: "Rules 'HYPE dip buyer' signed · hash 3f2a…".

**Step 6. Running**
- A header pill with the worker state in plain words:

| state | pill | one line |
|---|---|---|
| `running` | Running | Checks the market every {tick} s. Next check in 23 s. |
| `no_rules` | Waiting for rules | The bot does not trade until you sign rules. |
| `awaiting_api_wallet` | Waiting for approval | Approve the bot's wallet on Hyperliquid (step 3). |
| `stopped_today` | Stopped for today | Lost {x} USDC today (limit {y}). Starts again at 00:00 UTC. |
| `paused_onchain` | Paused in vault | You paused hl-trader. Resume it on the Agents page to continue. |
| `halted` | Halted | {reason}. Sign a new rule set to start again. |
| `error` | Error | {message}. Orders auto-cancel {dead-man} if the bot stays down. |

- Four numbers: On Hyperliquid (USDC + HYPE at mid) · P&L vs funded · Loss today / stop · Orders today / max.
- An events feed in sentences, built from `log.jsonl` kinds. For example: "12:04 Rule dip: price −3.2% over 1 day →
  bought 12 USDC of HYPE at 31.42" / "12:05 Skipped rule tp: position would exceed 40 USDC" / "Top-up 25 USDC
  requested, waiting for your approval".
- Rules card: the readable summary (§5.5) and a "Change rules" button that returns to step 5.
- Kill switch: as now.

### 4.3 Copy rules

- Plain verbs, second person, no jargon at first mention.
- Define terms once, in a tooltip:
  - IOC = "fills now or is cancelled";
  - limit + ttl = "waits at your price, cancelled after N";
  - API wallet = "the bot's own key".
- Every limit is shown as a number with its unit and the reason, for example "min order 11 USDC (Hyperliquid needs
  10 after rounding)".
- One honest line per risky action. No "safe", "guaranteed", "risk-free".

---

## 5. Rules authoring help

### 5.1 Template chips (prefill the textarea; the user edits the numbers)

| Chip | Prefilled text |
|---|---|
| **DCA** | Buy 12 USDC of HYPE every day. Never hold more than 40 USDC. Stop for the day after losing 5 USDC. |
| **Buy the dip** | When HYPE falls 3% or more in a day, buy 15 USDC, at most once a day. Max position 45 USDC. Daily loss stop 5 USDC. |
| **Take profit** | When my HYPE position is up 8% or more, sell half of it, at most once a day. |
| **Stop loss** | If my HYPE position is down 10% or more, sell all of it. |
| **Dip + take profit** (combo) | Buy 12 USDC of HYPE when it drops 3% in a day (once a day). Sell half when my position is up 8%. Sell all if it is down 10%. Max position 40 USDC, stop after losing 5 USDC today, max 4 orders a day. |

Every chip ends with the limits sentence. The model then never has to invent `limits`, and the owner sees that limits
are part of every rule set.

### 5.2 Example prompts → DSL v1

All examples assume `pairs:["HYPE/USDC"]` and hard limits of 50 / 20 / 10. Prices are illustrative.

1. **"Buy 12 USDC of HYPE every day."**
   `{"when":{"type":"interval","every":"1d"},"action":{"side":"buy","size":{"usdc":"12"},"order":{"type":"ioc"}}}`
   - No cooldown (an interval rule uses `every`).
   - The first buy happens at signing.
2. **"Every week, buy 20 USDC of HYPE."**
   `interval every:"1w"`, buy `usdc:"20"` IOC. (20 = hard max order.)
3. **"When HYPE drops 3% or more over a day, buy 12 USDC. At most once a day."**
   `{"when":{"type":"price_change","window":"1d","op":"lte","pct":"-3"},…buy usdc 12 ioc…,"cooldown":"1d"}`
4. **"Every 4 hours, put a buy order for 15 USDC 2% below the price; cancel it after 4 hours if it doesn't fill."**
   `interval every:"4h"`, buy `usdc:"15"`, `order:{"type":"limit","offset_pct":"2","ttl":"4h"}`.
5. **"If HYPE is at or below 30 USDC, buy 15 USDC, at most every 4 hours."**
   `{"when":{"type":"price","op":"lte","usdc":"30"},…,"cooldown":"4h"}`
6. **"When my HYPE position is up 8%, sell half."**
   `{"when":{"type":"position_pnl","op":"gte","pct":"8"},"action":{"side":"sell","size":{"position_pct":"50"},"order":{"type":"ioc"}},"cooldown":"1d"}`
7. **"If my position is down 10%, sell everything."**
   `position_pnl lte "-10"`, sell `position_pct:"100"` IOC, cooldown `1h`.
8. **"When HYPE rises 5% in 4 hours, offer a quarter of my position 1% above the price for an hour."**
   `price_change window:"4h" op:"gte" pct:"5"`, sell `position_pct:"25"`, `limit offset_pct:"1" ttl:"1h"`, cooldown `4h`.
9. **"Sell all my HYPE if the price reaches 45."**
   `price op:"gte" usdc:"45"`, sell `position_pct:"100"` IOC, cooldown `1d`.
10. **Limits sentence: "Never hold more than 40 USDC of HYPE, max 15 USDC per order, stop for the day after losing
    5 USDC, at most 4 orders a day."**
    `limits:{"max_position_usdc":"40","max_order_usdc":"15","daily_loss_stop_usdc":"5","max_orders_per_day":4}`

Where the model must fill gaps, the dashboard shows the filled value **highlighted as "assumed"** in the preview. Keep
the list of defaults in the system prompt and in this doc in sync:
- cooldown defaults to the window, or `1d` for `price` / `position_pnl`;
- order type defaults to IOC;
- limits default to the chip values, never to the hard maximums.

### 5.3 "What you can say / what you can't" box

**You can say**
- **Coin:** HYPE (against USDC). More pairs only if the worker allows them.
- **When:**
  - the price moved up or down X% over 1 hour, 4 hours or 1 day;
  - the price is at or above/below a number;
  - every 1 hour, 4 hours, day or week;
  - my position is up/down X% (vs what the bot paid).
- **Do:**
  - buy N USDC worth;
  - sell N USDC worth or X% of what the bot holds;
  - now (fills now or is cancelled) or as a limit order X% away, cancelled after 15 min, 1 h, 4 h or 1 day.
- **How often:** at most once every 15 min / 1 h / 4 h / day / week, per rule.
- **Limits:** max position, max order, daily loss stop, max orders a day.
- Up to 5 rules, checked in order. At most 2 orders per check.

**You can't say (the bot will refuse)**
- Leverage, perps, shorting, or selling HYPE you don't hold. Spot only.
- Indicators (RSI, moving averages, volume), trailing stops, or "and / or" between two conditions. One condition per
  rule.
- Exact times ("every Monday at 9:00"). Intervals start when you sign.
- Orders under about 11 USDC (Hyperliquid's minimum is 10 after rounding), or above {max_order} USDC.
- More than {max_position} USDC held, or a loss stop above {loss_stop} USDC. Rules over a hard limit are rejected,
  not trimmed.
- Anything about moving money: top-ups, withdrawals, sending profits. The vault mandate controls that, not the rules.
- Coins bought by hand don't count toward "my position is up X%". Only the bot's own fills under these rules count.

### 5.4 Preview before signing ("what will happen")

We have no backtest, and inventing one would be dishonest. Show these instead, all computed by the dashboard from the
JSON plus live HL data:
- **One sentence per rule** (the renderer; see §5.5).
- **Right now:** for each rule, "would fire now: yes/no" with the current value. For example: "HYPE is −1.2% over
  1 day; this rule fires at −3%". For interval rules: "First buy happens when you sign (12 USDC)".
- **Worst case for today:** "At most {max_orders_per_day} orders, at most {max_position} USDC held. The bot stops for
  today after a {loss_stop} USDC loss. The vault can send at most {daily} USDC today."
- **Validation:** warnings in plain words (`ISSUE_TEXT`, `SIZE_NEAR_HL_MINIMUM`). Errors disable the sign button and
  name the rule.
- **Assumed values** highlighted (§5.2).
- **The signature line:** "You sign: rules_sha256 3f2a…91c0 for hl-trader on {vault}". Show the same message the
  wallet will show.

### 5.5 Showing compiled rules back

Upgrade `describeBlocks` output from "When: … / Do: … / Cooldown: …" to one sentence per rule, with the technical
lines on demand:

> **Rule 1 · dip** — When HYPE falls **3% or more over 1 day**, **buy 12 USDC** of HYPE right away. Then wait at least
> **1 day** before this rule can fire again.
>
> **Rule 2 · tp** — When the bot's HYPE position is **up 8% or more**, **sell 50%** of it right away. At most once a
> day.
>
> **Rule 3 · limit-buy** — **Every 4 hours**, place a buy for **15 USDC** at **2% below** the market price; cancel it
> if not filled within **4 hours**.
>
> **Always:** at most **40 USDC** of HYPE held (open buys count) · at most **15 USDC** per order · **stops for today
> after losing 5 USDC** · at most **4 orders a day** · only HYPE/USDC, only spot.

- Bold the numbers. They are what the owner checks.
- Keep `describeRules` (the flat lines) unchanged for the shared vectors in `docs/trading-rules-vectors.json`. Add the
  sentence renderer next to it, with its own vectors, so worker and dashboard stay byte-identical where they must.
- Optional "Show as JSON" toggle showing the canonical JSON and the hash. Good for the "security" judges.
- "right away" = IOC within ±{band}% of the market price. Spell that out in a tooltip, not in the sentence.

---

## 6. Open points

- That the HL web UI accepts a pasted external API-wallet address (step 3) is still **[verify]** (ADR-0005 §3). If it
  does not, step 3 needs the EIP-712 `approveAgent` fallback button.
- No HL doc link was found for creating a second account (step 1). One must be found or written.
- The 3Commas, Cryptohopper and Bitget details come from third-party reviews. They only support the general
  patterns; no specific design choice depends on them.
- The sentence renderer (§5.5) and the "right now" preview (§5.4) are new dashboard code: a small change, in
  dashboard only, with no interface change.
- The templates (§5.1) and "you can't say" box (§5.3) must stay consistent with the worker's `propose_trading_rules`
  system prompt. Put both lists in one shared file if possible.
