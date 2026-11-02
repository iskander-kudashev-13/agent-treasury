import { beforeEach, describe, expect, it } from "vitest";
import { ConfirmError, RulesConfirmer } from "../../src/trading/confirm.js";
import type { Challenge } from "../../src/trading/confirm.js";
import { hashRuleSet } from "../../src/trading/rules/canonical.js";
import { RulesStore } from "../../src/trading/store.js";
import type { RuleSetV1 } from "../../src/trading/types.js";
import { newKey } from "../ai-fakes.js";
import { baseRules, freshNear, makeCtx, ownerKeyPair, OWNER, PAIRS, tmpDir, VAULT } from "./fixtures.js";
import type { FakeNear } from "./fixtures.js";

let now = 1_800_000_000_000;
let near: FakeNear;
let store: RulesStore;
let c: RulesConfirmer;
let pairsDown = false;
let pairsLive: typeof PAIRS = PAIRS;

beforeEach(() => {
  now = 1_800_000_000_000;
  near = freshNear();
  pairsDown = false;
  pairsLive = PAIRS;
  store = new RulesStore(tmpDir(), () => now);
  c = new RulesConfirmer({ ctx: makeCtx(near), store, getPairInfo: () => (pairsDown ? Promise.reject(new Error("hl")) : Promise.resolve(pairsLive)), now: () => now });
});

function sign(ch: Challenge, rules: RuleSetV1, o: { key?: typeof ownerKeyPair; account?: string; callback?: string | null; message?: string } = {}) {
  const key = o.key ?? ownerKeyPair;
  const nonce = Buffer.from(ch.nonce, "base64");
  return {
    rules,
    account_id: o.account ?? OWNER,
    public_key: key.publicKey,
    signature: key.signNep413({ message: o.message ?? ch.message, nonce, recipient: VAULT, callbackUrl: o.callback ?? null }),
    nonce: ch.nonce,
    ...(o.callback ? { callback_url: o.callback } : {}),
  };
}
async function fails(p: Promise<unknown>, code: string, status?: number) {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ConfirmError);
  expect((e as ConfirmError).code).toBe(code);
  if (status) expect((e as ConfirmError).status).toBe(status);
}

describe("challenge", () => {
  it("returns the exact ADR message, hash, recipient and 5 min expiry", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    expect(Buffer.from(ch.nonce, "base64")).toHaveLength(32);
    expect(ch.hash).toBe(hashRuleSet(rules));
    expect(ch.recipient).toBe(VAULT);
    expect(ch.expires_at).toBe(now + 5 * 60_000);
    expect(ch.message).toBe(
      ["Agent Treasury: activate trading rules", `vault: ${VAULT}`, "agent: hl-trader", "hl_network: testnet", "hl_account: 0xabcdef0123456789abcdef0123456789abcdef01", `rules_sha256: ${ch.hash}`].join("\n"),
    );
  });
  it("rejects invalid rules, over-limit rules and unreachable HL data", async () => {
    await fails(c.challenge({ nope: 1 }), "RULES_INVALID", 400);
    const over = baseRules();
    over.limits.max_order_usdc = "21";
    await fails(c.challenge(over), "RULES_INVALID", 400);
    pairsDown = true;
    await fails(c.challenge(baseRules()), "HL_UNAVAILABLE", 502);
  });
});

describe("confirm", () => {
  it("valid signature by the owner's full-access key: stored and active", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const env = await c.confirm(sign(ch, rules));
    expect(env).toMatchObject({ hash: ch.hash, account_id: OWNER, message: ch.message, callback_url: null, confirmed_at_ms: now });
    const loaded = await store.loadActive(makeCtx(near));
    expect(loaded.status).toBe("ok");
  });

  it("accepts a signed callback_url, rejects a swapped one and a non-http one", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const body = sign(ch, rules, { callback: "https://app.example/cb" });
    await fails(c.confirm({ ...body, callback_url: "https://evil.example/cb" }), "BAD_SIGNATURE", 401);
    const ch2 = await c.challenge(rules);
    await fails(c.confirm({ ...(sign(ch2, rules)), callback_url: "javascript:alert(1)" }), "BAD_REQUEST", 400);
    const ch3 = await c.challenge(rules);
    expect((await c.confirm(sign(ch3, rules, { callback: "https://app.example/cb" }))).callback_url).toBe("https://app.example/cb");
  });

  it("replay: a nonce works once, even after a failed attempt", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const body = sign(ch, rules);
    await c.confirm(body);
    await fails(c.confirm(body), "UNKNOWN_NONCE", 401);
    const ch2 = await c.challenge(rules);
    await fails(c.confirm({ ...(sign(ch2, rules, { key: newKey() })), public_key: ownerKeyPair.publicKey }), "BAD_SIGNATURE");
    await fails(c.confirm(sign(ch2, rules)), "UNKNOWN_NONCE");
  });

  it("expired and never-issued nonces", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    now += 5 * 60_000 + 1;
    await fails(c.confirm(sign(ch, rules)), "UNKNOWN_NONCE", 401);
    const forged = { ...(sign(ch, rules)), nonce: Buffer.alloc(32, 7).toString("base64") };
    await fails(c.confirm(forged), "UNKNOWN_NONCE");
  });

  it("different rules than the challenge was issued for", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    const other = baseRules();
    other.name = "Swapped";
    await fails(c.confirm(sign(ch, other)), "HASH_MISMATCH", 400);
  });

  it("wrong signed message (hash of other rules inside the message)", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    await fails(c.confirm(sign(ch, rules, { message: ch.message.replace(ch.hash, "0".repeat(64)) })), "BAD_SIGNATURE", 401);
  });

  it("function-call key, unknown key, non-owner", async () => {
    const rules = baseRules();
    near.keys[`${OWNER}|${ownerKeyPair.publicKey}`] = "limited";
    await fails(c.confirm(sign(await c.challenge(rules), rules)), "NOT_FULL_ACCESS", 401);
    const k = newKey();
    await fails(c.confirm(sign(await c.challenge(rules), rules, { key: k })), "NOT_FULL_ACCESS", 401);
    near.keys[`mallory.near|${k.publicKey}`] = "full";
    await fails(c.confirm(sign(await c.challenge(rules), rules, { key: k, account: "mallory.near" })), "NOT_OWNER", 403);
  });

  it("live pair data is re-checked at confirm time", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    pairsLive = {};
    await fails(c.confirm(sign(ch, rules)), "RULES_INVALID", 400);
  });

  it("RPC failure is a 502 and nothing is stored", async () => {
    const rules = baseRules();
    const ch = await c.challenge(rules);
    near.rpcDown = true;
    await fails(c.confirm(sign(ch, rules)), "RPC_ERROR", 502);
    near.rpcDown = false;
    expect((await store.loadActive(makeCtx(near))).status).toBe("none");
  });

  it("malformed bodies", async () => {
    await fails(c.confirm({ rules: baseRules(), account_id: 1, public_key: "x", signature: "y", nonce: "z" }), "BAD_REQUEST", 400);
    await fails(c.confirm({ rules: baseRules(), account_id: OWNER, public_key: "x", signature: "y", nonce: "short" }), "BAD_ENCODING", 400);
  });
});
