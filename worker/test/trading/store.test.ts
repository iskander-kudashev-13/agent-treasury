import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { RulesConfirmer } from "../../src/trading/confirm.js";
import { type BotRegistry, openRegistry } from "../../src/trading/bots.js";
import { RulesStore } from "../../src/trading/store.js";
import type { ConfirmedRules, RuleSetV1 } from "../../src/trading/types.js";
import { baseRules, freshNear, makeCtx, ownerKeyPair, OWNER, PAIRS, tmpDir, VAULT } from "./fixtures.js";
import type { FakeNear } from "./fixtures.js";

let now = 1_800_000_000_000;
let dir: string;
let near: FakeNear;
let store: RulesStore;
let confirmer: RulesConfirmer;
let registry: BotRegistry;
/** Loads bot `default` as the engine does on every tick. */
const loadActive = async (ctx = makeCtx(near), st = store) => {
  const b = registry.get("default");
  return b === undefined ? ({ status: "none" } as const) : st.loadBot(b, ctx, { legacyV1Hash: registry.legacyV1()?.hash ?? null });
};

async function confirmRules(rules: RuleSetV1): Promise<ConfirmedRules> {
  const ch = await confirmer.challenge(rules);
  const signature = ownerKeyPair.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: VAULT, callbackUrl: null });
  return (await confirmer.confirm({ rules, account_id: OWNER, public_key: ownerKeyPair.publicKey, signature, nonce: ch.nonce })).env;
}
const file = (hash: string) => join(dir, "rules", `${hash}.json`);
const edit = (path: string, f: (j: Record<string, unknown>) => void) => {
  const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  f(j);
  writeFileSync(path, JSON.stringify(j));
};

beforeEach(() => {
  now = 1_800_000_000_000;
  dir = tmpDir();
  near = freshNear();
  store = new RulesStore(dir, () => now);
  registry = openRegistry(dir);
  confirmer = new RulesConfirmer({ ctx: makeCtx(near), store, registry, maxBots: 3, getPairInfo: () => Promise.resolve(PAIRS), now: () => now });
});

describe("RulesStore", () => {
  it("empty store has no active rules", async () => {
    expect((await loadActive()).status).toBe("none");
    expect(store.history()).toEqual([]);
  });

  it("round trip across a new store instance", async () => {
    const env = await confirmRules(baseRules());
    const r = await loadActive(makeCtx(near), new RulesStore(dir));
    expect(r).toMatchObject({ status: "ok", confirmed: env, activatedAtMs: now });
  });

  it("refuses when the rules were edited (hash mismatch / invalid)", async () => {
    const env = await confirmRules(baseRules());
    edit(file(env.hash), (j) => ((j["rules"] as RuleSetV1).limits.max_order_usdc = "20"));
    const r = await loadActive();
    expect(r).toMatchObject({ status: "refused", code: "HASH_MISMATCH" });
  });

  it("refuses when rules AND hash AND message were rewritten but the signature is old", async () => {
    const env = await confirmRules(baseRules());
    const evil = baseRules();
    evil.limits.max_order_usdc = "20";
    const other = await new RulesConfirmer({ ctx: makeCtx(near), store: new RulesStore(tmpDir()), registry: openRegistry(tmpDir()), maxBots: 3, getPairInfo: () => Promise.resolve(PAIRS) }).challenge(evil);
    edit(file(env.hash), (j) => {
      j["rules"] = evil;
      j["hash"] = other.hash;
      j["message"] = other.message;
    });
    edit(join(dir, "bots.json"), (j) => {
      const b0 = (j["bots"] as { active_hash: string; hashes: { prefix: string; hash: string }[] }[])[0];
      if (b0) b0.active_hash = other.hash;
    });
    registry = openRegistry(dir);
    writeFileSync(file(other.hash), readFileSync(file(env.hash)));
    expect(await loadActive()).toMatchObject({ status: "refused", code: "BAD_SIGNATURE" });
  });

  it("refuses a signature/nonce/callback/message swap and a different signer", async () => {
    const env = await confirmRules(baseRules());
    const orig = readFileSync(file(env.hash), "utf8");
    for (const [k, v, code] of [
      ["callback_url", "https://evil.example", "BAD_SIGNATURE"],
      ["nonce", Buffer.alloc(32, 1).toString("base64"), "BAD_SIGNATURE"],
      ["message", "x", "MESSAGE_MISMATCH"],
      ["signature", Buffer.alloc(64, 1).toString("base64"), "BAD_SIGNATURE"],
    ] as const) {
      writeFileSync(file(env.hash), orig);
      edit(file(env.hash), (j) => (j[k] = v));
      expect(await loadActive()).toMatchObject({ status: "refused", code });
    }
    writeFileSync(file(env.hash), orig);
    expect((await loadActive()).status).toBe("ok");
  });

  it("refuses when the signer is no longer the owner or the key lost full access", async () => {
    await confirmRules(baseRules());
    near.owner = "someone.else.near";
    expect(await loadActive()).toMatchObject({ status: "refused", code: "NOT_OWNER" });
    near.owner = OWNER;
    near.keys[`${OWNER}|${ownerKeyPair.publicKey}`] = "limited";
    expect(await loadActive()).toMatchObject({ status: "refused", code: "NOT_FULL_ACCESS" });
    near.keys[`${OWNER}|${ownerKeyPair.publicKey}`] = "full";
    near.rpcDown = true;
    expect(await loadActive()).toMatchObject({ status: "refused", code: "RPC_ERROR" });
  });

  it("refuses rules that exceed hard limits tightened after confirmation", async () => {
    await confirmRules(baseRules());
    const ctx = makeCtx(near);
    const r = await loadActive({ ...ctx, hard: { ...ctx.hard, maxOrderUsdc: "5" } });
    expect(r).toMatchObject({ status: "refused", code: "RULES_INVALID" });
  });

  it("refuses a missing, malformed or swapped envelope; a malformed registry is an error, not a default", async () => {
    const env = await confirmRules(baseRules());
    writeFileSync(file(env.hash), "{not json");
    expect(await loadActive()).toMatchObject({ status: "refused", code: "ENVELOPE_MISSING" });
    writeFileSync(file(env.hash), "[]");
    expect(await loadActive()).toMatchObject({ status: "refused", code: "ENVELOPE_MALFORMED" });
    // pointer to a valid but different envelope
    const other = baseRules();
    other.name = "Other";
    const env2 = await confirmRules(other);
    (registry.get("default") as { active_hash: string | null }).active_hash = env.hash; // point at the first one again
    writeFileSync(file(env.hash), readFileSync(file(env2.hash)));
    expect(await loadActive(makeCtx(near), store)).toMatchObject({ status: "refused", code: "HASH_MISMATCH" });
    rmSync(file(env.hash));
    expect(await loadActive()).toMatchObject({ status: "refused", code: "ENVELOPE_MISSING" });
    writeFileSync(join(dir, "bots.json"), JSON.stringify({ version: 1, bots: [{ id: "../x", name: "x", created_at_ms: 1, archived_at_ms: null, active_hash: null, hashes: [] }], legacy_v1: null }));
    expect(() => openRegistry(dir)).toThrow(/bad bot id/);
  });

  it("history lists rule sets oldest first with supersede times; a new confirm becomes active", async () => {
    const a = await confirmRules(baseRules());
    now += 1000;
    const second = baseRules();
    second.name = "Second";
    const b = await confirmRules(second);
    expect(store.history()).toEqual([
      { hash: a.hash, name: "HYPE dip buyer", confirmed_at_ms: a.confirmed_at_ms, superseded_at_ms: b.confirmed_at_ms },
      { hash: b.hash, name: "Second", confirmed_at_ms: b.confirmed_at_ms, superseded_at_ms: null },
    ]);
    const r = await loadActive();
    expect(r.status === "ok" && r.confirmed.hash).toBe(b.hash);
  });
});
