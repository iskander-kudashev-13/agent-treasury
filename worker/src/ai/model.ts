/**
 * Minimal OpenAI-compatible streaming chat client for NEAR AI Cloud (`POST {base}/chat/completions`, SSE).
 * Plain fetch on purpose (no SDK dependency): the docs (https://docs.near.ai/cloud/guides/openai-compatibility.md)
 * only require base URL + bearer key, and `tools` / `stream` are standard OpenAI Chat Completions.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ModelToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ModelToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ModelChunk = { kind: "text"; delta: string } | { kind: "tool_calls"; calls: ModelToolCall[] };

export interface ModelClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Stable codes the dashboard translates. The message is the English fallback. */
export type ModelErrorCode = "AI_NO_CREDITS" | "AI_BAD_REQUEST" | "AI_BAD_KEY" | "AI_RATE_LIMITED" | "AI_UNAVAILABLE" | "AI_ERROR";

export class ModelError extends Error {
  constructor(
    message: string,
    readonly code: ModelErrorCode = "AI_ERROR",
  ) {
    super(message);
  }
}

/** Maps a provider HTTP status to a code and an English message. Never includes the provider body (it may echo request details). */
export function modelErrorFromStatus(status: number): ModelError {
  if (status === 402) return new ModelError("NEAR AI account has no credits or spending limit (cloud.near.ai → Billing)", "AI_NO_CREDITS");
  // 400: the request itself was refused (e.g. a tool schema the provider cannot validate). The provider body is not echoed.
  if (status === 400) return new ModelError("The AI provider refused the request as malformed (HTTP 400); this is a worker bug, not a key or credit problem", "AI_BAD_REQUEST");
  if (status === 401 || status === 403) return new ModelError("The NEAR AI key was rejected: check NEARAI_API_KEY in the worker environment", "AI_BAD_KEY");
  if (status === 429) return new ModelError("The AI provider is rate limiting requests: try again in a minute", "AI_RATE_LIMITED");
  if (status >= 500) return new ModelError(`The AI provider is unavailable right now (HTTP ${status}): try again later`, "AI_UNAVAILABLE");
  return new ModelError(`The AI provider answered HTTP ${status}`, "AI_ERROR");
}

const chunkSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        delta: z
          .looseObject({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.looseObject({
                  index: z.number().int().optional(),
                  id: z.string().nullish(),
                  function: z.looseObject({ name: z.string().nullish(), arguments: z.string().nullish() }).optional(),
                }),
              )
              .nullish(),
          })
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
});

/** Streams one model round: text deltas as they arrive, then (if any) the complete tool calls. */
export async function* streamChat(
  cfg: ModelClientConfig,
  messages: ModelMessage[],
  tools: ToolSpec[],
  signal: AbortSignal,
): AsyncGenerator<ModelChunk> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", Authorization: `Bearer ${cfg.apiKey}`, "X-Request-Id": randomUUID() },
      body: JSON.stringify({ model: cfg.model, messages, tools, tool_choice: "auto", stream: true, max_tokens: 4096 }),
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ModelError(`Could not reach the AI provider (${e instanceof Error ? e.message : "network error"})`, "AI_UNAVAILABLE");
  }
  if (!res.ok || !res.body) {
    throw modelErrorFromStatus(res.status);
  }

  const acc = new Map<number, { id: string; name: string; args: string }>();
  const decoder = new TextDecoder();
  let buf = "";
  const handle = (line: string): ModelChunk | undefined => {
    if (!line.startsWith("data:")) return undefined;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return undefined;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return undefined;
    }
    const parsed = chunkSchema.safeParse(json);
    const delta = parsed.success ? parsed.data.choices?.[0]?.delta : undefined;
    if (!delta) return undefined;
    for (const [i, tc] of (delta.tool_calls ?? []).entries()) {
      const idx = tc.index ?? i;
      const cur = acc.get(idx) ?? { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      acc.set(idx, cur);
    }
    return delta.content ? { kind: "text", delta: delta.content } : undefined;
  };

  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      const out = handle(line);
      if (out) yield out;
    }
  }
  const tail = handle(buf.replace(/\r$/, ""));
  if (tail) yield tail;

  if (acc.size > 0) {
    const calls = [...acc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]): ModelToolCall => ({ id: c.id || `call_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
    yield { kind: "tool_calls", calls };
  }
}
