import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { stripLeadingDashDash, loadMandate, planRevoke, planSetup, printPlan, validateSubAccountName } from "../scripts/key-agent-plan.js";

const mandate = loadMandate(join(import.meta.dirname, "../examples/mandate.procurement.json"));

describe("key agent setup plan", () => {
  const plan = planSetup({ network: "testnet", owner: "owner.testnet", vault: "vault.owner.testnet", name: "procurement", agentId: "procurement", displayName: "Procurement", mandate, fundNear: "0.35" });

  it("creates the sub-account, adds a restricted key, then add_agent with 1 yocto", () => {
    expect(plan.map((t) => [t.signer, t.receiver])).toEqual([
      ["owner.testnet", "procurement.owner.testnet"],
      ["procurement.owner.testnet", "procurement.owner.testnet"],
      ["owner.testnet", "vault.owner.testnet"],
    ]);
    expect(plan[1]?.details).toMatchObject({
      receiver_id: "vault.owner.testnet",
      method_names: ["request_payment", "report_payout_status"],
      allowance_near: "0.25",
    });
    expect(plan[2]?.details).toMatchObject({ method: "add_agent", deposit: "1 yoctoNEAR", args: { kind: "Key", account_id: "procurement.owner.testnet", mandate } });
  });

  it("contains no private key material", () => {
    const lines: string[] = [];
    printPlan("t", plan, (s) => lines.push(s));
    expect(lines.join("\n")).not.toMatch(/private/i);
  });

  it("revoke plan: revoke_agent then delete_key", () => {
    const r = planRevoke({ network: "testnet", owner: "owner.testnet", vault: "v.testnet", agentId: "procurement", account: "procurement.owner.testnet", publicKey: "ed25519:abc" });
    expect(r[0]?.details).toMatchObject({ method: "revoke_agent", deposit: "1 yoctoNEAR" });
    expect(r[1]?.description).toMatch(/delete access key ed25519:abc/);
  });
});

describe("mandate file validation", () => {
  const write = (o: unknown) => {
    const p = join(mkdtempSync(join(tmpdir(), "mandate-")), "m.json");
    writeFileSync(p, JSON.stringify(o));
    return p;
  };
  const ok = { daily_limit: "10", per_tx_limit: "5", approval_threshold: "5", max_payments_per_day: 5, allowed_chains: ["base"], recipients_mode: "Open" };

  it("accepts a minimal Open mandate and fills defaults", () => {
    expect(loadMandate(write(ok))).toMatchObject({ allowlist: [], recipients: [], expires_at: null });
  });
  it.each([
    ["float amounts", { ...ok, daily_limit: "1.5" }],
    ["per-tx above daily", { ...ok, per_tx_limit: "11" }],
    ["Fixed mode", { ...ok, recipients_mode: "Fixed" }],
    ["empty Allowlist", { ...ok, recipients_mode: "Allowlist" }],
    ["zero max_payments_per_day", { ...ok, max_payments_per_day: 0 }],
    ["unknown field", { ...ok, extra: 1 }],
  ])("rejects %s", (_n, m) => {
    expect(() => loadMandate(write(m))).toThrow();
  });
  it("validates sub-account names", () => {
    expect(() => {
      validateSubAccountName("procurement");
    }).not.toThrow();
    expect(() => {
      validateSubAccountName("Bad.Name");
    }).toThrow();
  });
});

describe("hl-trader session mandate example (audit 2026-11-03 H1)", () => {
  const path = join(import.meta.dirname, "../examples/mandate.hl-trader.session.json");
  it("is rejected until expires_at is replaced", () => {
    expect(() => loadMandate(path)).toThrow(/expires_at/);
  });
  it("has the session limits once expires_at is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-"));
    const f = join(dir, "m.json");
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(f, JSON.stringify({ ...raw, expires_at: String(Date.now() + 48 * 3_600_000) }));
    expect(loadMandate(f)).toMatchObject({ approval_threshold: "0", daily_limit: "25000000", per_tx_limit: "25000000", max_payments_per_day: 1, allowed_chains: ["hypercore"], recipients_mode: "Allowlist" });
  });
});

describe("pnpm `--` passthrough", () => {
  it("strips one leading --", () => {
    expect(stripLeadingDashDash(["--", "--owner", "a"])).toEqual(["--owner", "a"]);
    expect(stripLeadingDashDash(["--owner", "a"])).toEqual(["--owner", "a"]);
  });
  it("both scripts accept the forms (dry-run, nothing sent)", () => {
    for (const script of ["setup-key-agent", "revoke-key-agent"]) {
      const base = script === "setup-key-agent"
        ? ["--owner", "o.testnet", "--vault", "v.o.testnet", "--name", "x", "--mandate", join(import.meta.dirname, "../examples/mandate.procurement.json"), "--dry-run"]
        : ["--owner", "o.testnet", "--vault", "v.o.testnet", "--agent-id", "x", "--public-key", "ed25519:11111111111111111111111111111111", "--dry-run"];
      for (const args of [base, ["--", ...base]]) {
        const r = spawnSync("pnpm", ["exec", "tsx", `scripts/${script}.ts`, ...args], { cwd: join(import.meta.dirname, ".."), encoding: "utf8", env: { ...process.env, OWNER_PRIVATE_KEY: "" } });
        expect(r.stderr).not.toMatch(/ERR_PARSE_ARGS/);
        expect(r.status).toBe(0);
      }
    }
  }, 60_000);
});
