/**
 * The assistant turn: model <-> tools loop. Yields the SSE events of UI_UPDATES.md §6.7.
 * The loop holds NO credentials except the NEAR AI key inside `model` and a read-only `view` function.
 */
import { toJson } from "./events.js";
import type { ChatEvent } from "./events.js";
import { ModelError, streamChat } from "./model.js";
import type { ModelClientConfig, ModelMessage, ModelToolCall } from "./model.js";
import { systemPrompt } from "./prompt.js";
import { TurnState } from "./proposals.js";
import type { ProposalContext } from "./proposals.js";
import type { Tool } from "./tools.js";
import { VaultReader } from "./views.js";
import type { ViewFn } from "./views.js";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDeps {
  model: ModelClientConfig;
  view: ViewFn;
  tools: Tool[];
  vault: string;
  network: string;
  now: () => number;
  usdcAsset: ProposalContext["usdcAsset"];
  /** Max model rounds per turn (each round may call several tools). */
  maxRounds?: number;
}

const MAX_TOOL_CALLS_PER_ROUND = 8;
const MAX_TOOL_RESULT_CHARS = 12_000;

function errorMessage(e: unknown): string {
  if (e instanceof ModelError) return e.message;
  return "Something went wrong while talking to the vault or the AI provider. Please try again.";
}

export async function* runChat(deps: ChatDeps, messages: ChatMessage[], ownerAccount: string, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const nowMs = deps.now();
  const ctx: ProposalContext = {
    reader: new VaultReader(deps.view),
    nowMs,
    // Grounding for addresses: only what the owner typed, never assistant text.
    userText: messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
    state: new TurnState(),
    usdcAsset: deps.usdcAsset,
  };
  const toolByName = new Map(deps.tools.map((t) => [t.name, t]));
  const specs = deps.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const convo: ModelMessage[] = [
    { role: "system", content: systemPrompt({ nowMs, vault: deps.vault, ownerAccount, network: deps.network }) },
    ...messages.map((m): ModelMessage => ({ role: m.role, content: m.content })),
  ];

  try {
    for (let round = 0; round < (deps.maxRounds ?? 6); round++) {
      let text = "";
      let calls: ModelToolCall[] = [];
      for await (const chunk of streamChat(deps.model, convo, specs, signal)) {
        if (chunk.kind === "text") {
          text += chunk.delta;
          yield { type: "text", delta: chunk.delta };
        } else {
          calls = chunk.calls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
        }
      }
      if (calls.length === 0) {
        yield { type: "done" };
        return;
      }

      convo.push({ role: "assistant", content: text || null, tool_calls: calls });
      let endTurn = false;
      for (const call of calls) {
        const tool = toolByName.get(call.function.name);
        let content: unknown;
        if (!tool) {
          content = { error: `Unknown tool '${call.function.name.slice(0, 60)}'` };
        } else {
          try {
            let args: unknown;
            try {
              args = JSON.parse(call.function.arguments || "{}");
            } catch {
              args = undefined;
            }
            if (args === undefined) {
              content = { error: "Arguments were not valid JSON" };
            } else {
              const r = await tool.execute(args, ctx);
              content = r.content;
              for (const ev of r.events ?? []) yield ev;
              if (r.endTurn) endTurn = true;
            }
          } catch (e) {
            if (signal.aborted) throw e;
            content = { error: "The tool failed (the vault could not be read or returned an unexpected shape). Tell the owner you could not read it; do not guess." };
          }
        }
        convo.push({ role: "tool", tool_call_id: call.id, content: toJson(content).slice(0, MAX_TOOL_RESULT_CHARS) });
      }
      if (endTurn) {
        yield { type: "done" };
        return;
      }
    }
    yield { type: "text", delta: "\n\nI could not finish this in one go. Please rephrase or split the request." };
    yield { type: "done" };
  } catch (e) {
    if (signal.aborted) {
      yield { type: "error", message: "The request timed out or was cancelled." };
      return;
    }
    yield { type: "error", message: errorMessage(e) };
  }
}
