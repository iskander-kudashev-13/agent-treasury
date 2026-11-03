# Deployments

| Network | Vault | Owner | Treasury token | Mode | Deployed |
|---|---|---|---|---|---|
| testnet | `at-vault-11012309.testnet` | `at-owner-11012309.testnet` | Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | local (no TEE, `allow_insecure_local_mode`) | 2026-11-01, tx `3G1RBFrsM3bH4hAPYCeyEWMBd3j5SugNS4t2TLFPj5jM` |

Code: wasm sha256 `cc55da8047e74d8ca6fef2721b835acb86cb7ba373ed1651f56eee9467b04e30` (branch `feat/kit-foundation`).
Policy at init: daily limit 1000 USDC, min payment 0.5 USDC, overdue grace 3 days, attestation validity 7 days.
Explorer: https://testnet.nearblocks.io/address/at-vault-11012309.testnet

| testnet (trading tests) | `at-trade-11030006.testnet` | `at-owner-11012309.testnet` | Circle testnet USDC `3e2210e1…b8af` | local (`allow_insecure_local_mode`), daily limit 100 USDC | 2026-11-03, wasm sha256 `28c60d888d558d3a8d1d4aa9990fbccad416a17a8ed6b600a7e0c5d6196bc04c` |

Key agent `hl-trader` (`hl-trader.at-owner-11012309.testnet`) on `at-trade-11030006.testnet`: Allowlist `hypercore` +
owner's HL testnet account, 25 USDC/tx, 50/day, 2/day, approval threshold 25, expires 7 days after 2026-11-03.
Separate from `at-vault-11012309.testnet`, which stays unchanged for judging.

## Mainnet (demo session, 2026-11-03)

| Network | Vault | Owner | Treasury token | Mode | Deployed |
|---|---|---|---|---|---|
| mainnet | `vault.agenthack.near` | `agenthack.near` | Circle USDC `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | `requires_tee: true` (trading-only; key agents only) | 2026-11-03, tx `4boaQ13jBNQso26SCZ8YAF9RPd5Xz6X1FR16CXawtrJg` |

Code: reproducible build (`cargo near build reproducible-wasm`), wasm sha256
`dc7682ebb4dd96662c363d5718b1a5e867128f488bac8d12dd74d25ee58e7386`, 1,033,464 bytes, contract last changed in `8d6c70a`.
Policy at init: daily limit 25 USDC, min payment 2 USDC, overdue grace 3 days, attestation validity 7 days.
Account created with 11.5 NEAR (tx `4fzHhtUaHXE232bQL3YNE79FoU9FxWNAZbsTL7WXUjT9`); registered on USDC (tx
`7tacpqGHXbZSo8DkgnpR5F9UjA6d4TLXrahXp2iXHADG`); owner deposit 21.9 USDC (tx `EENZEMfPmFPabQ9P1CqqcAwRGUrTfF875QzFAwfVu8Cy`).
Owner funding arrived through NEAR Intents 1Click: 22 USDC on Arbitrum (tx
`0xc762fe9b36b088bd91285be2da3a0f4e7c9c8e77191cbe7e4bfa5d2f4a0914fb`) → 21.993669 USDC on NEAR to `agenthack.near`
(tx `XzyqfEnvkaZnAdj7Fgy8er5YDDkLPx9Bj4SLCa8KnPn`).
Explorer: https://nearblocks.io/address/vault.agenthack.near

### Mainnet trading session, 2026-11-03 (observed)

- Key agent `hl-trader.agenthack.near` (pubkey `ed25519:EB79tsJTx5zLrdmNkzpKb22v5i8hpUPzs6G5pRt3dKgk`): Allowlist `hypercore`
  `0x072994Aa1Bdb9886Ce04f6D42c6ee513fA92ab0d`, 20 USDC/day and per payment, 1/day, threshold 0, expires 2026-11-05 12:25 UTC.
- HL API wallet `0xCEB4d3978251633EBA50fE4FA233edc94c1A1E49`, approved with the plain name `agent-treasury` (owner's choice:
  HL set 90 days); removed by the owner after the session (`extraAgents` → `[]`).
- Top-up payout 0: 20 USDC vault → 1Click → **19.68086 USDC** on Hyperliquid in ~80 s (NEAR tx
  `APgBkRE9VRSohcrBPGSJRAGyp2kzcanHvdtYEP29dQz5`, HL tx `0x16bd4eb2de1649b377ec40411d83b4055e7286f570b3c5370f917dd41c390249`).
  Audit M3 answered: the landing is an HL `userNonFundingLedgerUpdates` entry of type **`send`** (spot USDC from 1Click's HL
  account `0x6b9e773128f453f5c2c60935ee2de2cbc5390a24`); the worker counted it as `external_inflow`, `net_funded_usdc` =
  19.68086. The vault payout stayed `Sent` (nobody reports the terminal status on a `requires_tee` vault without a TEE worker).
- AI-agent bot `claude-hype` (ADR-0007, HYPE/USDC, order 12 / position 25 / loss 2 / 10 a day) over MCP: buy 0.12 HYPE @ 85.932
  filled (cloid `0xa277ef4740ed65b4…0001`); sell 100% refused `MIN_NOTIONAL` (fee taken in HYPE leaves 0.1199 → 0.11 lot,
  9.37 USDC < 10); buy 100 USDC refused `MAX_ORDER`; PURR (prompt injection) refused `PAIR_NOT_ALLOWED`; Stop → token
  revoked → `AGENT_UNAUTHORIZED`.
- Rules bot `hype-daily` (rules compiled by NEAR AI from plain words): buy 0.12 HYPE @ 85.69 at confirm (cloid
  `0x8d0b7dea3634814f…0002`).
- Kill all: both bots `halted` (`KILLED`), `hl-trader` `Paused` on the vault, 0 open orders. Left on HL: 0.2398 HYPE + 0.46 USDC
  (owner's account); vault 1.90 USDC.
