# Changelog

One line per working session.

- 2026-11-01 — Toolchain (Rust 1.99, wasm32, cargo-near, near-cli-rs), NEAR agent skills, project agents and CLAUDE.md workflow; repo skeleton; vault contract started (M1).
- 2026-11-01 — Contract v1 (single agent, 105 tests) → v2 multi-agent mandates per AGENT_ACCESS.md + ADR-0003; worker (37 tests, simulated 1Click for testnet), dashboard (23 tests), SDK + MCP in progress.
- 2026-11-01 — UI_UPDATES.md: schedules as their own entity in the contract (ADR-0004, frequency.rs + 240 shared date vectors), overdue → owner approval; dashboard ported to Vite SPA; AI assistant backend (worker /ai/chat) started.
- 2026-11-01 — Design kit (dashboard/src/kit) from design-kit/agent-treasury-design: Tailwind v4 theme, components, /kit.html showcase; app not migrated yet.
- 2026-11-01 — Security audit (0 critical; all H/M/L1 fixed: 1-yocto on irreversible owner actions, pin_agent, rebind rejects approvals, explicit local-mode flag, two-phase surplus/refund credit, pinned TEE config, real-chain check for simulated 1Click, quote check before Approve); contract 163 tests; dashboard screens built on the design kit (Treasury, Agents + wizard, Payments + schedules, Payouts, Policy, Assistant panel with NEP-413 session).
- 2026-11-02 — Testnet e2e parts 1–2 (local mode, simulated 1Click): payout 0 Confirmed; worker fixes (shade-agent-js numKeys in local mode, agent top-up 1 NEAR); Payments UX: Pay once vs Recurring, local time with UTC hint, Type filter.
