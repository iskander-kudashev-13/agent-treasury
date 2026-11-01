import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { challengeMessage, nep413Digest } from "../src/ai/session.js";
import { createAiRouter } from "../src/ai/route.js";
import type { AiConfig } from "../src/ai/route.js";
import { AiInfo } from "../src/ai/info.js";
import type { ViewFn } from "../src/ai/views.js";

export const VAULT = "vault.test.near";
export const OWNER = "owner.test.near";
export const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // 1 Nov 2026 12:00 UTC
export const usdc = (n: number): string => (BigInt(n) * 1_000_000n).toString();
export const ADDR_MARIA = "0xAb12Ab12Ab12Ab12Ab12Ab12Ab12Ab12Ab12Ab12";

/** Fake vault state served through the `view` function (what NEAR RPC call_function would return). */
export class FakeChain {
  views: { method: string; args: Record<string, unknown> }[] = [];
  paused = false;
  nextRecipientId = 1;
  recipients: Record<string, unknown>[] = [
    { id: 0, label: "Alex", destination_chain: "base", destination_asset: "x", destination_address: "0x1111111111111111111111111111111111111111", last_paid_at_ms: null },
  ];
  schedules: Record<string, unknown>[] = [];
  agents: Record<string, unknown>[] = [
    agent("payroll", "Fixed", { recipients: [0], per_tx_limit: usdc(5000), daily_limit: usdc(10000), approval_threshold: usdc(1000), allowed_chains: ["base", "sol"] }),
    agent("ops-bot", "Open", { per_tx_limit: usdc(200), daily_limit: usdc(500), approval_threshold: usdc(100), allowed_chains: ["base"] }),
  ];
  payouts: Record<string, unknown>[] = [];
  rejections: Record<string, unknown>[] = [];
  /** "account|publicKey" -> kind, what RPC view_access_key would say. */
  accessKeys: Record<string, "full" | "limited"> = { [`${OWNER}|${ownerKey.publicKey}`]: "full" };

  view: ViewFn = (method, args) => {
    this.views.push({ method, args });
    const page = <T>(xs: T[]): T[] => xs.slice(Number(args.from_index ?? 0), Number(args.from_index ?? 0) + Number(args.limit ?? 50));
    switch (method) {
      case "get_contract_info":
        return Promise.resolve({ owner_id: OWNER, next_recipient_id: this.nextRecipientId, next_schedule_id: this.schedules.length });
      case "get_policy":
        return Promise.resolve({ daily_limit: usdc(20000), min_payment: usdc(1), paused: this.paused, overdue_grace_ms: "259200000" });
      case "get_balance":
        return Promise.resolve({ balance: usdc(3100), in_flight: "0", spent_today: "0", remaining_today: usdc(20000) });
      case "get_agents":
        return Promise.resolve(page(this.agents));
      case "get_agent":
        return Promise.resolve(this.agents.find((a) => a.id === args.agent_id) ?? null);
      case "get_recipients":
        return Promise.resolve(page(this.recipients));
      case "get_recipient":
        return Promise.resolve(this.recipients.find((r) => r.id === args.recipient_id) ?? null);
      case "get_schedules":
        return Promise.resolve(page(this.schedules.filter((s) => (!args.agent_id || s.agent_id === args.agent_id) && (args.recipient_id === undefined || s.recipient_id === args.recipient_id))));
      case "get_schedule":
        return Promise.resolve(this.schedules.find((s) => s.id === args.schedule_id) ?? null);
      case "get_upcoming":
        return Promise.resolve(
          this.schedules.map((s) => ({ schedule_id: s.id, recipient_id: s.recipient_id, agent_id: s.agent_id, amount: s.amount, due_at: s.next_due_at, will_need_approval: false })),
        );
      case "get_due":
        return Promise.resolve([]);
      case "get_payouts_count":
        return Promise.resolve(String(this.payouts.length));
      case "get_payouts":
        return Promise.resolve(page(this.payouts));
      case "get_rejections":
        return Promise.resolve(this.rejections);
      case "get_pending_approvals":
        return Promise.resolve([]);
      default:
        return Promise.reject(new Error(`fake chain: unexpected view ${method}`));
    }
  };
}

export function agent(id: string, mode: "Fixed" | "Allowlist" | "Open", m: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: id,
    kind: "Tee",
    account_id: null,
    status: "Active",
    mandate: { daily_limit: usdc(1000), per_tx_limit: usdc(1000), approval_threshold: usdc(100), allowed_chains: ["base"], recipients_mode: mode, allowlist: [], recipients: [], expires_at: null, max_payments_per_day: 10, ...m },
    open_approvals: 0,
  };
}

export function monthlySchedule(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    recipient_id: 0,
    amount: usdc(500),
    frequency: { Monthly: { day: 1 } },
    start_at: String(Date.UTC(2026, 11, 1)),
    end: "Never",
    agent_id: "payroll",
    status: "Active",
    last_paid_at: null,
    paid_count: 0,
    created_at: String(NOW),
    next_due_at: String(Date.UTC(2026, 11, 1)),
    open_payout: null,
    failed_attempts: 0,
    ...over,
  };
}

// --- fake NEAR AI Cloud ---------------------------------------------------------------------------------------

export interface ScriptedCall {
  name: string;
  args: unknown;
}
export type Round = { text?: string; calls?: ScriptedCall[] };

/** OpenAI-compatible fake: plays one scripted round per `POST /chat/completions` and records the requests. */
export class FakeModelServer {
  rounds: Round[] = [];
  requests: { auth: string | undefined; body: { messages: { role: string; content: string | null; tool_calls?: unknown }[]; tools: { function: { name: string } }[]; model: string } }[] = [];
  status = 200;
  ownedBy = "nearai";
  attestationHits = 0;
  private server: ServerType | undefined;
  url = "";

  async start(): Promise<void> {
    const app = new Hono();
    app.get("/v1/models", (c) => c.json({ data: [{ id: "test-model", owned_by: this.ownedBy }] }));
    app.get("/v1/attestation/report", (c) => {
      this.attestationHits++;
      const nonce = c.req.query("nonce");
      return c.json({
        gateway_attestation: { signing_address: "0xgw", request_nonce: nonce },
        model_attestations: [{ signing_address: "0xmodel", request_nonce: nonce, intel_quote: "q", nvidia_payload: "{}" }],
      });
    });
    app.post("/v1/chat/completions", async (c) => {
      this.requests.push({ auth: c.req.header("authorization"), body: await c.req.json<FakeModelServer["requests"][number]["body"]>() });
      if (this.status !== 200) return c.text("nope", this.status as 401);
      const round = this.rounds.shift() ?? { text: "(script exhausted)" };
      const enc = new TextEncoder();
      const chunk = (delta: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
      const body = new ReadableStream<Uint8Array>({
        start(ctl) {
          if (round.text) for (const w of round.text.match(/.{1,6}/gs) ?? []) ctl.enqueue(chunk({ content: w }));
          (round.calls ?? []).forEach((call, i) => {
            const args = JSON.stringify(call.args);
            ctl.enqueue(chunk({ tool_calls: [{ index: i, id: `call_${i}`, function: { name: call.name, arguments: args.slice(0, 10) } }] }));
            ctl.enqueue(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(10) } }] }));
          });
          ctl.enqueue(enc.encode("data: [DONE]\n\n"));
          ctl.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    });
    await new Promise<void>((resolve) => {
      this.server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        this.url = `http://127.0.0.1:${info.port}/v1`;
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
  }
}

export const SECRET = "s".repeat(40);
export const clock = { t: NOW };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Encode(b: Uint8Array): string {
  let n = BigInt("0x" + Buffer.from(b).toString("hex"));
  let out = "";
  while (n > 0n) {
    out = `${B58[Number(n % 58n)] ?? ""}${out}`;
    n /= 58n;
  }
  return "1".repeat(b.findIndex((x) => x !== 0) < 0 ? b.length : b.findIndex((x) => x !== 0)) + out;
}

export interface TestKey {
  publicKey: string;
  signNep413: (p: { message: string; nonce: Buffer; recipient: string; callbackUrl?: string | null }) => string;
}
export function newKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    publicKey: `ed25519:${base58Encode(raw)}`,
    signNep413: (p) => sign(null, nep413Digest(p), privateKey).toString("base64"),
  };
}
export const ownerKey = newKey();

/** Runs challenge + session like the dashboard. `key` signs; `claimed` is the public key sent to the server. */
export async function signIn(
  app: Hono,
  o: { accountId?: string; key?: TestKey; claimedKey?: string; callbackUrl?: string; nonce?: string } = {},
): Promise<{ status: number; json: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ch = (await (await app.request("/ai/session/challenge", { method: "POST", headers: { "x-forwarded-for": "5.5.5.5" } })).json()) as { nonce: string; message: string; recipient: string };
  const key = o.key ?? ownerKey;
  const nonce = Buffer.from(o.nonce ?? ch.nonce, "base64");
  const signature = key.signNep413({ message: ch.message, nonce, recipient: ch.recipient, callbackUrl: o.callbackUrl ?? null });
  const res = await app.request("/ai/session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "5.5.5.5" },
    body: JSON.stringify({ accountId: o.accountId ?? OWNER, publicKey: o.claimedKey ?? key.publicKey, signature, nonce: o.nonce ?? ch.nonce, ...(o.callbackUrl ? { callbackUrl: o.callbackUrl } : {}) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
export { challengeMessage };

const tokens = new WeakMap<Hono, string>();

export function makeAi(chain: FakeChain, model: FakeModelServer, over: Partial<AiConfig> = {}) {
  const config: AiConfig = {
    apiKey: "test-key",
    model: "test-model",
    baseUrl: model.url,
    vault: VAULT,
    network: "testnet",
    rateLimitPerMin: 100,
    maxMessages: 10,
    maxMessageChars: 500,
    timeoutMs: 10_000,
    trustProxy: true,
    sessionSecret: SECRET,
    ...over,
  };
  const info = new AiInfo({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
  const router = createAiRouter({
    config,
    view: chain.view,
    info,
    now: () => clock.t,
    usdcAsset: (c) => Promise.resolve(c === "tron" ? null : `nep141:${c}-usdc.omft.near`),
    accessKey: (acc, pk) => Promise.resolve(chain.accessKeys[`${acc}|${pk}`] ?? "none"),
  });
  return new Hono().route("/ai", router);
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown> & { type: string };
}

export async function chat(app: Hono, content: string | { role: string; content: string }[], over: Record<string, unknown> = {}, headers: Record<string, string> = {}, auth: "auto" | "none" = "auto") {
  if (auth === "auto" && !headers.authorization) {
    let t = tokens.get(app);
    if (!t) {
      t = (await signIn(app)).json.token as string;
      tokens.set(app, t);
    }
    headers = { ...headers, authorization: `Bearer ${t}` };
  }
  const messages = typeof content === "string" ? [{ role: "user", content }] : content;
  const res = await app.request("/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4", ...headers },
    body: JSON.stringify({ conversation_id: "c1", messages, vault: VAULT, owner_account: OWNER, ...over }),
  });
  const text = await res.text();
  const events: SseEvent[] = [];
  if (res.headers.get("content-type")?.includes("text/event-stream")) {
    for (const block of text.split("\n\n")) {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev && data) events.push({ event: ev, data: JSON.parse(data) as SseEvent["data"] });
    }
  }
  return { status: res.status, events, json: res.headers.get("content-type")?.includes("json") ? (JSON.parse(text) as Record<string, unknown>) : undefined };
}
