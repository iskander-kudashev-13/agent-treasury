/**
 * Browser client of the worker assistant API (worker/src/ai/route.ts): NEP-413 sign-in, `GET /ai/info`, and the SSE stream of
 * `POST /ai/chat`. No signing of transactions here; the model only ever returns typed proposals.
 */
import { VAULT_ID, WORKER_URL } from "./config";
import { parseProposal, type Proposal } from "./proposals";

/* ───────────── SSE parsing ───────────── */

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Incremental parser for text/event-stream (WHATWG): lines end in \n, \r\n or \r; a blank line dispatches the event;
 * `data:` lines are joined by \n; lines starting with ":" are comments; one leading space of a value is dropped.
 */
export function createSseParser(): { push: (chunk: string) => SseMessage[]; flush: () => SseMessage[] } {
  let buf = "";
  let event = "";
  let data: string[] = [];
  let sawCr = false;
  const out: SseMessage[] = [];
  const dispatch = () => {
    if (data.length > 0) out.push({ event: event || "message", data: data.join("\n") });
    event = "";
    data = [];
  };
  const line = (l: string) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const i = l.indexOf(":");
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? "" : l.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  };
  const drain = (): SseMessage[] => out.splice(0, out.length);
  return {
    push(chunk: string) {
      buf += chunk;
      let start = 0;
      for (let i = 0; i < buf.length; i++) {
        const ch = buf[i];
        if (sawCr && start === i && ch === "\n") {
          // "\n" right after a "\r" line end belongs to the same terminator
          sawCr = false;
          start = i + 1;
          continue;
        }
        sawCr = false;
        if (ch === "\n" || ch === "\r") {
          line(buf.slice(start, i));
          start = i + 1;
          sawCr = ch === "\r";
        }
      }
      buf = buf.slice(start);
      return drain();
    },
    flush() {
      if (buf) line(buf);
      buf = "";
      dispatch();
      return drain();
    },
  };
}

/* ───────────── events ───────────── */

export type DataKind = "table" | "number" | "upcoming";
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "malformed_proposal" }
  | { type: "question"; text: string; options: string[] }
  | { type: "data"; kind: DataKind; payload: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** SSE message -> typed event. Unknown or malformed events are dropped (null); proposals are validated. */
export function parseChatEvent(m: SseMessage): ChatEvent | null {
  let j: unknown;
  try {
    j = JSON.parse(m.data);
  } catch {
    return null;
  }
  if (!isObj(j)) return null;
  const type = typeof j.type === "string" ? j.type : m.event;
  switch (type) {
    case "text":
      return typeof j.delta === "string" ? { type, delta: j.delta } : null;
    case "proposal": {
      const p = parseProposal(j.proposal);
      return p ? { type, proposal: p } : { type: "malformed_proposal" };
    }
    case "question":
      return typeof j.text === "string"
        ? { type, text: j.text, options: Array.isArray(j.options) ? j.options.filter((o): o is string => typeof o === "string").slice(0, 8) : [] }
        : null;
    case "data":
      return j.kind === "table" || j.kind === "number" || j.kind === "upcoming" ? { type, kind: j.kind, payload: j.payload } : null;
    case "done":
      return { type };
    case "error":
      return { type, message: typeof j.message === "string" ? j.message : "The assistant failed" };
    default:
      return null;
  }
}

/* ───────────── HTTP ───────────── */

export class AssistantHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AssistantHttpError";
  }
}

async function failure(res: Response): Promise<AssistantHttpError> {
  let msg = `HTTP ${res.status}`;
  try {
    const j: unknown = await res.json();
    if (isObj(j) && typeof j.message === "string") msg = j.message;
  } catch {
    /* keep the status text */
  }
  return new AssistantHttpError(res.status, msg);
}

export interface AiInfo {
  model: string;
  provider: string;
  private: boolean;
  tier: string;
  attestation: {
    status: string;
    fetched_at: string;
    nonce_echoed: boolean;
    model_signing_address: string | null;
    gateway_signing_address: string | null;
    has_intel_quote: boolean;
    has_nvidia_payload: boolean;
    verify_url: string;
    note: string;
  } | null;
}

export function parseAiInfo(j: unknown): AiInfo | null {
  if (!isObj(j) || typeof j.model !== "string") return null;
  const a = isObj(j.attestation) ? j.attestation : null;
  const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    model: j.model,
    provider: typeof j.provider === "string" ? j.provider : "NEAR AI Cloud",
    private: j.private === true,
    tier: typeof j.tier === "string" ? j.tier : "unknown",
    attestation: a
      ? {
          status: typeof a.status === "string" ? a.status : "unknown",
          fetched_at: typeof a.fetched_at === "string" ? a.fetched_at : "",
          nonce_echoed: a.nonce_echoed === true,
          model_signing_address: s(a.model_signing_address),
          gateway_signing_address: s(a.gateway_signing_address),
          has_intel_quote: a.has_intel_quote === true,
          has_nvidia_payload: a.has_nvidia_payload === true,
          verify_url: typeof a.verify_url === "string" && a.verify_url.startsWith("https://") ? a.verify_url : "https://cloud.near.ai/verify",
          note: typeof a.note === "string" ? a.note : "",
        }
      : null,
  };
}

export async function fetchAiInfo(signal?: AbortSignal): Promise<AiInfo> {
  const res = await fetch(`${WORKER_URL}/ai/info`, { headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!res.ok) throw await failure(res);
  const info = parseAiInfo(await res.json());
  if (!info) throw new Error("Unexpected /ai/info response");
  return info;
}

/* ───────────── session (NEP-413) ───────────── */

export interface AiSession {
  token: string;
  accountId: string;
  /** ms */
  expiresAt: number;
}

const SESSION_KEY = "at.ai.session";
let memory: AiSession | null = null;

/** `accountId` null = any account (the caller compares). */
const usable = (s: AiSession | null, accountId: string | null, now: number): s is AiSession => s !== null && (accountId === null || s.accountId === accountId) && s.expiresAt - now > 30_000;

/** Token lives in memory and (best effort) sessionStorage, never localStorage. */
export function loadSession(accountId: string | null, now = Date.now(), storage: Pick<Storage, "getItem" | "removeItem"> | null = safeStorage()): AiSession | null {
  if (usable(memory, accountId, now)) return memory;
  try {
    const raw = storage?.getItem(SESSION_KEY);
    if (raw) {
      const j: unknown = JSON.parse(raw);
      if (isObj(j) && typeof j.token === "string" && typeof j.accountId === "string" && typeof j.expiresAt === "number") {
        const s = { token: j.token, accountId: j.accountId, expiresAt: j.expiresAt };
        if (usable(s, accountId, now)) {
          memory = s;
          return s;
        }
      }
      storage?.removeItem(SESSION_KEY);
    }
  } catch {
    /* storage unavailable or corrupt: memory only */
  }
  memory = null;
  return null;
}

export function saveSession(s: AiSession, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  memory = s;
  try {
    storage?.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* memory only */
  }
}

export function clearSession(storage: Pick<Storage, "removeItem"> | null = safeStorage()): void {
  memory = null;
  try {
    storage?.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export interface SignMessageFn {
  (input: { message: string; recipient: string; nonce: Uint8Array }): Promise<{ accountId: string; publicKey: string; signature: string } | void>;
}

const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** challenge -> wallet signMessage -> session. Throws AssistantHttpError / Error with a user-readable message. */
export async function signInWithWallet(signMessage: SignMessageFn, accountId: string): Promise<AiSession> {
  const chRes = await fetch(`${WORKER_URL}/ai/session/challenge`, { method: "POST", headers: { Accept: "application/json" } });
  if (!chRes.ok) throw await failure(chRes);
  const ch: unknown = await chRes.json();
  if (!isObj(ch) || typeof ch.nonce !== "string" || typeof ch.message !== "string" || typeof ch.recipient !== "string") throw new Error("Unexpected challenge response");
  if (VAULT_ID && ch.recipient !== VAULT_ID) throw new Error("The worker serves a different vault than this dashboard");
  const signed = await signMessage({ message: ch.message, recipient: ch.recipient, nonce: b64ToBytes(ch.nonce) });
  if (!signed) throw new Error("The wallet did not return a signature (it may have redirected). Try again.");
  if (signed.accountId !== accountId) throw new Error("The wallet signed with a different account than the connected one");
  const res = await fetch(`${WORKER_URL}/ai/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accountId: signed.accountId, publicKey: signed.publicKey, signature: signed.signature, nonce: ch.nonce }),
  });
  if (!res.ok) throw await failure(res);
  const j: unknown = await res.json();
  if (!isObj(j) || typeof j.token !== "string" || typeof j.account_id !== "string" || typeof j.expires_at !== "number") throw new Error("Unexpected session response");
  const session = { token: j.token, accountId: j.account_id, expiresAt: j.expires_at };
  saveSession(session);
  return session;
}

/* ───────────── chat stream ───────────── */

export interface ChatRequest {
  conversation_id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  vault: string;
  owner_account: string;
}

/** Streams typed events. Throws AssistantHttpError on non-2xx (401 = sign in again). Abort with the signal. */
export async function* streamChat(token: string, body: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatEvent> {
  const res = await fetch(`${WORKER_URL}/ai/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw await failure(res);
  if (!res.body) throw new Error("The server sent no stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const msgs = done ? parser.flush() : parser.push(decoder.decode(value, { stream: true }));
      for (const m of msgs) {
        const ev = parseChatEvent(m);
        if (ev) yield ev;
      }
      if (done) return;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
