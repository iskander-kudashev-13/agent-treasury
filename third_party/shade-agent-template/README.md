# NearDeFi/shade-agent-template — license and notice

Source: https://github.com/NearDeFi/shade-agent-template at commit `816b75bc0423addcbb3b1362026b33f2ddd5c973`.
License: Apache-2.0. `LICENSE` and `NOTICE.txt` in this directory are verbatim copies from that commit, kept as
Apache-2.0 §4(a) and §4(d) and the upstream NOTICE require for redistributed modified files.

Files in this repository derived from the template (each carries a header naming the source and stating it was modified):

| File | Derived from |
|---|---|
| `contract/src/agent.rs` | `agent-contract/src/{lib,owner,views}.rs`, `agent-contract/src/internal/{attestation,helpers}.rs` |
| `contract/src/lib.rs` (Shade Agent v2 trust-anchor section) | `agent-contract/src/lib.rs` |
| `worker/src/index.ts` | Hono app + ShadeClient bootstrap |
| `worker/src/near.ts` | registration plumbing |
| `worker/Dockerfile` | `Dockerfile` |
| `worker/docker-compose.yaml` | `docker-compose.yaml` |
| `worker/deployment.yaml` | `deployment.yaml` |

Upstream files carry no SPDX identifiers or copyright headers, so there were none to preserve. Everything else in this
repository is MIT (root `LICENSE`).
