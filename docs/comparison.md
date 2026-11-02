# Comparison

How Agent Treasury relates to four products that come up in the same conversation. Research date: 2026-11-02, from
public pages only (linked). Product claims are the vendors' own; we did not test these products. "Not stated" means we
did not find it on the pages we read, not that the feature does not exist.

## Short version

| | Agent Treasury | Ping (pingpay.io) | HOT Pay | OutLayer | Rise (riseworks.io) |
|---|---|---|---|---|---|
| What it is | Vault contract that agents pay from under on-chain mandates | Payments layer on NEAR Intents (links, widgets, subscriptions, APIs) | Non-custodial merchant checkout | Verifiable off-chain compute (TEE) for NEAR | Hybrid fiat/crypto payroll and EOR company |
| Main direction of money | Outgoing: organisation → people on many chains | Mostly incoming (checkout, subscriptions) | Incoming (merchant receives) | Not a payments product | Outgoing payroll |
| Built on NEAR Intents | Yes (1Click API for delivery) | Yes, per its docs | Per a third-party article; its own page says "30+ chains" | Lists Intents swaps as a use case | Not stated |
| Per-agent spending rules enforced on-chain | Yes: per-tx, daily amount, daily count, allowed chains, allowlist / fixed recipients, approval threshold, expiry, pause | Not stated | Not stated | Not stated (compute, secrets, "payment keys" for metering) | Not stated |
| AI agent access | Function-call keys + MCP server; TEE agent via Shade Agent | "Payment Facilitator for AI Agents and API Monetization" | Not stated | Agents can call it for compute; agent wallets not stated | A "Rise MCP" page is linked; contents not read |
| Custody | Owner's own contract | Not verified | States it is not custodial | n/a | Company-operated; registered US Money Service Business |
| Compliance (KYC, tax forms) | None | Not stated | States no KYC | n/a | Yes, per its site (contractor onboarding, year-end forms, US payroll tax) |
| Maturity | Hackathon project, testnet only | Live product | Live product | Live service (third-party, by FastNEAR) | Live company; self-reported volume above $1B |

## Notes per product

**Ping / PingPay** ([docs](https://pingpay.gitbook.io/docs)). Lists payment links and embeddable widgets, intent-based
payments, chain-abstracted onramp, automated subscriptions, swaps, APIs/SDKs, and a payment facilitator for AI agents,
"powered by NEAR Intents". It is aimed at accepting payments. We found no description of payroll, batch payouts or
per-agent spending limits. A related hackathon project ("Ping subscription Shade Agent" on Devpost) uses a NEAR
contract plus a TEE worker on Phala, which is close to our worker design; we did not review it.
*Relation:* complementary. Ping helps a business get paid; Agent Treasury constrains how an agent pays out.

**HOT Pay** ([docs](https://hot-labs.gitbook.io/hot-pay)). Merchant checkout from HOT Labs: "accept crypto from 30+
chains", payer pays any token, merchant receives one token of choice, no platform fees, no KYC, payment links and
webhooks. Its page covers acceptance only; we found no payouts, payroll or agent policy features.
*Relation:* complementary (incoming vs outgoing).

**OutLayer** ([NEAR docs](https://docs.near.org/primitives/off-chain-compute/outlayer), [site](https://outlayer.fastnear.com/)).
Runs developer WASM inside Intel TDX enclaves and returns results with an attestation over code hash, input and output;
contracts call it through yield/resume or HTTPS. Features include VRF, encrypted secrets, MPC vaults and "Payment Keys"
(USDC metering for paid HTTPS endpoints). NEAR docs call it a third-party platform. It is infrastructure, not a treasury.
*Relation:* an alternative to Shade Agent / Phala for the TEE part of our worker. We did not evaluate it. Spending
policies in Agent Treasury live in the vault contract and would not change.

**Rise** ([site](https://www.riseworks.io/)). Global payroll for employees and contractors in 190+ countries (EOR,
contractor pay, US payroll), payouts in local currency, stablecoins or crypto, compliance paperwork, registered as a US
Money Service Business. Press releases report a Circle partnership and payroll volume above $1B (self-reported; not
verified). The site does not describe which chains it uses, its custody model or programmable spending rules.
*Relation:* Rise is a full payroll service with compliance; Agent Treasury does none of that. Agent Treasury is a
self-custodial rail where the payer keeps the funds in its own contract and lets an agent (not a payroll company) execute
payments under rules the payer sets. A team that needs tax and employment compliance needs something like Rise.

## What Agent Treasury does not do

- No KYC, tax, invoicing or employment compliance.
- No fiat on/off-ramp. USDC in, USDC out (via 1Click). Tron is refused because 1Click lists only USDT there.
- Not production-ready: testnet only, TEE mode not deployed, no real cross-chain payout yet (see README "Status").

## Sources

- Ping: https://pingpay.gitbook.io/docs , https://www.alchemy.com/dapps/pingpay-io , https://devpost.com/software/ping-subscription-shade-agent
- HOT Pay: https://hot-labs.gitbook.io/hot-pay , https://hot-labs.gitbook.io/hot-pay/quickstart
- OutLayer: https://docs.near.org/primitives/off-chain-compute/outlayer , https://outlayer.fastnear.com/
- Rise: https://www.riseworks.io/ , https://www.riseworks.io/blog/rise-surpasses-500-million-in-total-payroll-volume , https://news.bitcoin.com/rise-surpasses-1-billion-in-total-payroll-volume-cementing-its-leadership-in-hybrid-payroll
- Search results also mention NEAR Business (multisig treasury / payroll, said to launch 2026-10-20) in third-party blog posts; we did not verify it and did not compare it.
