import { t } from "@/i18n";
import { RPC_URLS, VAULT_ID } from "./config";

/** Whether an RPC answer is worth retrying on another endpoint: rate limits, server errors, network failures. */
export function isRetryable(status: number | null, rpcErrorCode?: unknown): boolean {
  if (status === null) return true; // network error / CORS / timeout
  if (status === 429 || status >= 500) return true;
  return rpcErrorCode === -429; // FastNEAR answers some rate limits as HTTP 200 with a JSON-RPC error code -429
}

/** Delay before attempt `n` (1-based retries): 300, 700, 1500 ms (+ up to 200 ms jitter). */
export const backoffMs = (n: number, jitter = Math.random()): number => [300, 700, 1500, 2500][Math.min(n - 1, 3)]! + Math.floor(jitter * 200);

/** At most this many view calls in flight: a page fires dozens at load and public RPCs rate-limit bursts. */
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const queue: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => queue.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    queue.shift()?.();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ATTEMPTS = 4;

/**
 * POST a JSON-RPC body with the same endpoint rotation, concurrency cap and backoff as `view`. Returns the parsed JSON of the
 * first non-retryable answer (callers interpret `result` / `error` themselves).
 */
export async function rpcPost<T>(body: unknown, urls: readonly string[] = RPC_URLS): Promise<T> {
  const text = JSON.stringify(body);
  let last: Error = new Error(t("net.rpcError"));
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    let res: Response;
    try {
      res = await slot(() => fetch(urls[attempt % urls.length]!, { method: "POST", headers: { "content-type": "application/json" }, body: text }));
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!res.ok) {
      last = new Error(t("net.rpcHttp", { status: res.status }));
      if (isRetryable(res.status)) continue;
      throw last;
    }
    const json = (await res.json()) as T & { error?: { code?: number } };
    if (json.error && isRetryable(200, json.error.code)) {
      last = new Error(t("net.rpcError"));
      continue;
    }
    return json;
  }
  throw last;
}

/** Read-only contract call over JSON-RPC (`query` / `call_function`). No wallet needed. Retries rate limits on the next endpoint. */
export async function view<T>(method: string, args: Record<string, unknown> = {}, contractId = VAULT_ID, urls: readonly string[] = RPC_URLS): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "dashboard",
    method: "query",
    params: { request_type: "call_function", finality: "optimistic", account_id: contractId, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  });
  let last: Error = new Error(t("net.rpcError"));
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    const url = urls[attempt % urls.length]!;
    let res: Response;
    try {
      res = await slot(() => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }));
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!res.ok) {
      last = new Error(t("net.rpcHttp", { status: res.status }));
      if (isRetryable(res.status)) continue;
      throw last;
    }
    const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { code?: number; data?: unknown; message?: string } };
    if (json.error) {
      last = new Error(String(json.error.data ?? json.error.message ?? t("net.rpcError")));
      if (isRetryable(200, json.error.code)) continue;
      throw last;
    }
    if (json.result?.error) throw new Error(json.result.error);
    const bytes = json.result?.result;
    if (!bytes) throw new Error(t("net.rpcEmpty"));
    return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
  }
  throw last;
}
