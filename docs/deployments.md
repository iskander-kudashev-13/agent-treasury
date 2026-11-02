# Deployments

| Network | Vault | Owner | Treasury token | Mode | Deployed |
|---|---|---|---|---|---|
| testnet | `at-vault-11012309.testnet` | `at-owner-11012309.testnet` | Circle testnet USDC `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` | local (no TEE, `allow_insecure_local_mode`) | 2026-11-01, tx `3G1RBFrsM3bH4hAPYCeyEWMBd3j5SugNS4t2TLFPj5jM` |

Code: wasm sha256 `cc55da8047e74d8ca6fef2721b835acb86cb7ba373ed1651f56eee9467b04e30` (branch `feat/kit-foundation`).
Policy at init: daily limit 1000 USDC, min payment 0.5 USDC, overdue grace 3 days, attestation validity 7 days.
Explorer: https://testnet.nearblocks.io/address/at-vault-11012309.testnet
