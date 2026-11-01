import { describe, expect, it } from "vitest";
import { rejectionsToday, sortAgents, stateOf, trustOf } from "./agentView";
import type { AgentView, Rejection } from "./types";

const m = { daily_limit: "1", per_tx_limit: "1", approval_threshold: "0", allowed_chains: ["base"], recipients_mode: "Open" as const, allowlist: [], recipients: [], expires_at: null, max_payments_per_day: 1 };
const agent = (p: Partial<AgentView> = {}): AgentView => ({
  id: "a", name: "A", kind: "Key", account_id: "a.near", public_key: "ed25519:9Hk2abcdefghijkpQ", account_pinned: false, mandate: m, status: "Active", spent_today: "0", day_index: "1", created_at: "1", last_request_at: null, failed_transfers: 0, open_approvals: 0, tee: null, ...p,
});
const tee = { measurements: { rtmrs: { mrtd: "7f3a000000000000c21" } }, ppid: "p", valid_until_ms: "1", valid: true, reasons: [] };

describe("trustOf / stateOf", () => {
  it("key agent", () => {
    expect(trustOf(agent()).line).toMatch(/^Key · ed25519:9Hk2/);
    expect(stateOf(agent())).toBe("active");
  });
  it("unregistered TEE slot waits", () => {
    const a = agent({ kind: "Tee", account_id: null, public_key: null });
    expect(trustOf(a)).toMatchObject({ tone: "warn", registered: false, line: "TEE · waiting for registration" });
    expect(stateOf(a)).toBe("waiting");
  });
  it("registered TEE is verified only while valid", () => {
    const ok = agent({ kind: "Tee", account_id: "ab", tee });
    expect(trustOf(ok)).toMatchObject({ tone: "ok" });
    expect(trustOf(ok).line).toMatch(/^TEE · verified 7f3a/);
    expect(trustOf(agent({ kind: "Tee", account_id: "ab", tee: { ...tee, valid: false, reasons: ["ExpiredAttestation"] } })).tone).toBe("warn");
  });
  it("paused and revoked win", () => {
    expect(stateOf(agent({ status: "Paused" }))).toBe("paused");
    expect(stateOf(agent({ status: "Revoked", kind: "Tee", account_id: null }))).toBe("revoked");
  });
});

describe("helpers", () => {
  it("sorts revoked last", () => {
    const l = sortAgents([agent({ id: "x", status: "Revoked", created_at: "1" }), agent({ id: "y", created_at: "3" }), agent({ id: "z", created_at: "2" })]);
    expect(l.map((a) => a.id)).toEqual(["z", "y", "x"]);
  });
  it("counts rejections of today only", () => {
    const now = Date.UTC(2026, 10, 1, 12);
    const r = (agent_id: string, at: number): Rejection => ({ agent_id, at: String(at), reason: "X", detail: "", chain: "base", address: "0x", amount: "1" });
    expect(rejectionsToday([r("a", now - 1000), r("a", now - 86_400_000), r("b", now)], "a", now)).toBe(1);
  });
});
