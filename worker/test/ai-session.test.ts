import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nep413Digest, SESSION_TTL_MS, signToken, verifyToken } from "../src/ai/session.js";
import { FakeChain, FakeModelServer, NOW, OWNER, SECRET, VAULT, chat, clock, makeAi, newKey, ownerKey, signIn } from "./ai-fakes.js";

const model = new FakeModelServer();
let chain: FakeChain;
beforeAll(async () => {
  await model.start();
});
afterAll(() => {
  model.stop();
});
beforeEach(() => {
  chain = new FakeChain();
  model.rounds = [];
  model.requests = [];
  clock.t = NOW;
});

describe("NEP-413 owner session", () => {
  it("challenge shape", async () => {
    const res = await makeAi(chain, model).request("/ai/session/challenge", { method: "POST" });
    const j = (await res.json()) as { nonce: string; message: string; recipient: string; expires_at: number };
    expect(Buffer.from(j.nonce, "base64")).toHaveLength(32);
    expect(j).toMatchObject({ message: `Agent Treasury assistant session for ${VAULT}`, recipient: VAULT, expires_at: NOW + 5 * 60_000 });
  });

  it("valid signature -> token that /ai/chat accepts", async () => {
    const app = makeAi(chain, model);
    const s = await signIn(app);
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ account_id: OWNER, expires_at: NOW + SESSION_TTL_MS });
    model.rounds = [{ text: "hi" }];
    const r = await chat(app, "hello", {}, { authorization: `Bearer ${s.json.token}` });
    expect(r.status).toBe(200);
    expect(r.events.at(-1)?.event).toBe("done");
  });

  it("accepts a signature that covers a callbackUrl (redirect wallets)", async () => {
    expect((await signIn(makeAi(chain, model), { callbackUrl: "https://dash.example/cb" })).status).toBe(200);
  });

  it("rejects a signature made by a different key than the claimed public key", async () => {
    const other = newKey();
    chain.accessKeys[`${OWNER}|${ownerKey.publicKey}`] = "full";
    const s = await signIn(makeAi(chain, model), { key: other, claimedKey: ownerKey.publicKey });
    expect(s.status).toBe(401);
    expect(s.json.message).toContain("Invalid signature");
  });

  it("rejects a valid signature from a key that is not on the account", async () => {
    const k = newKey();
    expect((await signIn(makeAi(chain, model), { key: k })).status).toBe(401);
  });

  it("rejects a function-call key of the owner", async () => {
    const k = newKey();
    chain.accessKeys[`${OWNER}|${k.publicKey}`] = "limited";
    const s = await signIn(makeAi(chain, model), { key: k });
    expect(s.status).toBe(401);
    expect(s.json.message).toContain("full-access");
  });

  it("rejects a non-owner account even with a full-access key", async () => {
    const k = newKey();
    chain.accessKeys[`mallory.near|${k.publicKey}`] = "full";
    const s = await signIn(makeAi(chain, model), { key: k, accountId: "mallory.near" });
    expect(s.status).toBe(403);
  });

  it("rejects a signature for a different message/recipient", async () => {
    const app = makeAi(chain, model);
    const ch = (await (await app.request("/ai/session/challenge", { method: "POST" })).json()) as { nonce: string };
    const nonce = Buffer.from(ch.nonce, "base64");
    const signature = ownerKey.signNep413({ message: "something else", nonce, recipient: VAULT });
    const res = await app.request("/ai/session", { method: "POST", body: JSON.stringify({ accountId: OWNER, publicKey: ownerKey.publicKey, signature, nonce: ch.nonce }) });
    expect(res.status).toBe(401);
  });

  it("a nonce works once (replay rejected), even after a failed attempt", async () => {
    const app = makeAi(chain, model);
    const ch = (await (await app.request("/ai/session/challenge", { method: "POST" })).json()) as { nonce: string; message: string };
    const nonce = Buffer.from(ch.nonce, "base64");
    const body = JSON.stringify({ accountId: OWNER, publicKey: ownerKey.publicKey, signature: ownerKey.signNep413({ message: ch.message, nonce, recipient: VAULT }), nonce: ch.nonce });
    expect((await app.request("/ai/session", { method: "POST", body })).status).toBe(200);
    expect((await app.request("/ai/session", { method: "POST", body })).status).toBe(401);
  });

  it("an expired challenge is rejected", async () => {
    const app = makeAi(chain, model);
    const ch = (await (await app.request("/ai/session/challenge", { method: "POST" })).json()) as { nonce: string; message: string };
    clock.t = NOW + 5 * 60_000 + 1;
    const nonce = Buffer.from(ch.nonce, "base64");
    const res = await app.request("/ai/session", {
      method: "POST",
      body: JSON.stringify({ accountId: OWNER, publicKey: ownerKey.publicKey, signature: ownerKey.signNep413({ message: ch.message, nonce, recipient: VAULT }), nonce: ch.nonce }),
    });
    expect(res.status).toBe(401);
  });

  it("an unknown nonce is rejected", async () => {
    expect((await signIn(makeAi(chain, model), { nonce: Buffer.alloc(32, 7).toString("base64") })).status).toBe(401);
  });

  it("chat needs a valid, unexpired token", async () => {
    const app = makeAi(chain, model);
    expect((await chat(app, "hi", {}, {}, "none")).status).toBe(401);
    expect((await chat(app, "hi", {}, { authorization: "Bearer abc.def" })).status).toBe(401);
    const { token } = (await signIn(app)).json as { token: string };
    const tampered = `${token.slice(0, -2)}AA`;
    expect((await chat(app, "hi", {}, { authorization: `Bearer ${tampered}` })).status).toBe(401);
    clock.t = NOW + SESSION_TTL_MS + 1;
    expect((await chat(app, "hi", {}, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("a token for another vault or secret is rejected", () => {
    const t = signToken(SECRET, { sub: OWNER, vault: "other.near", iat: NOW, exp: NOW + 1000 });
    expect(verifyToken(SECRET, t, VAULT, NOW)).toBeNull();
    const ok = signToken(SECRET, { sub: OWNER, vault: VAULT, iat: NOW, exp: NOW + 1000 });
    expect(verifyToken(SECRET, ok, VAULT, NOW)?.sub).toBe(OWNER);
    expect(verifyToken("x".repeat(40), ok, VAULT, NOW)).toBeNull();
  });

  it("session ends when ownership changes", async () => {
    const app = makeAi(chain, model);
    const { token } = (await signIn(app)).json as { token: string };
    chain.view = (m, a) => (m === "get_contract_info" ? Promise.resolve({ owner_id: "new-owner.near" }) : FakeChain.prototype.view.call(chain, m, a));
    const app2 = makeAi(chain, model);
    expect((await chat(app2, "hi", {}, { authorization: `Bearer ${token}` })).status).toBe(403);
  });

  it("digest follows NEP-413 layout (tag, message, nonce, recipient, null callback)", () => {
    const d = nep413Digest({ message: "hi", nonce: new Uint8Array(32), recipient: "myapp.com" });
    expect(d).toHaveLength(32);
    expect(nep413Digest({ message: "hi", nonce: new Uint8Array(32), recipient: "myapp.com", callbackUrl: "x" }).equals(d)).toBe(false);
  });
});
