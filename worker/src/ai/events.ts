import type { Proposal } from "./proposals.js";

/** SSE events of `POST /ai/chat`, exactly as UI_UPDATES.md §6.7. Each event is sent as `event: <type>` + `data: <this JSON>`. */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "proposal"; proposal: Proposal }
  | { type: "question"; text: string; options?: string[] }
  | { type: "data"; kind: "table" | "number" | "upcoming"; payload: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

/** JSON.stringify that turns bigint into decimal strings (U128 convention). */
export function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));
}
