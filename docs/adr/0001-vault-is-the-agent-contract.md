# ADR-0001: The vault is the Shade Agent contract (v2 attestation)

## Date
2026-11-01

## Status
Accepted

## Context
The brief (CLAUDE.md §3.1) describes `register_agent(attestation)` + `approve_codehash(hash)` — the Shade Agent **v1** model.
Current sources (read 2026-11-01):
- docs.near.org marks the Shade Agent Framework as no longer maintained as standalone tooling after 2026-04-19; docs moved to `NearDeFi/shade-agent-framework/docs`.
- v1 (`NearDeFi/shade-agent-js` 1.0.4, `shade-agent-cli` 1.0.2) READMEs state they contain known critical vulnerabilities and must not be used on mainnet.
- v2 (`NearDeFi/shade-agent-template` @816b75b, crate `shade-attestation = 0.2.0`, npm `@neardefi/shade-agent-js` 2.2.0, `@neardefi/shade-agent-cli` 2.4.0) replaces the code hash with **full measurements** (RTMRs, key-provider digest, app-compose hash which pins the docker image digest) plus an **approved PPID** list, and binds the attestation `report_data` to the agent's 64-hex implicit account.

## Options
1. **Vault = agent contract** (template v2 code merged into the vault). Agent's implicit account calls `request_payout` directly; vault runs `require_valid_agent()`.
   - Pros: one contract, one trust boundary, predecessor check is the whole auth story; no MPC / chain signatures needed (payout leaves NEAR through 1Click).
   - Cons: vault carries the attestation dependency (cannot build wasm on macOS → Docker builder).
2. Separate agent contract that forwards calls to the vault (predecessor = agent contract).
   - Pros: vault stays tiny. Cons: two contracts, cross-contract auth, more async failure modes.
3. Agent signs via chain signatures (template oracle pattern). Not needed: no foreign-chain transaction is signed by us.

## Decision
Option 1. `approve_codehash` is replaced by `approve_measurements` / `approve_ppids` (owner), `requires_tee` flag at init,
local mode = owner-whitelisted agent + mock measurements (development only, documented as not secure).

## Consequences
- Contract: template files (Apache-2.0) adapted under `contract/src/agent/`, attribution kept in file headers and README.
- Build: `docker run --rm -v "$(pwd)":/workspace pivortex/near-builder:latest cargo near build non-reproducible-wasm --no-abi`. Host `cargo test` works on macOS.
- Worker: `@neardefi/shade-agent-js` 2.x `ShadeClient` (`register`, `call`).
- Framework is unmaintained upstream → we pin exact versions and own the risk; documented in README "Known limitations".

## References
- https://github.com/NearDeFi/shade-agent-template (agent-contract/src)
- https://github.com/NearDeFi/shade-agent-framework/tree/main/docs
- https://crates.io/crates/shade-attestation
