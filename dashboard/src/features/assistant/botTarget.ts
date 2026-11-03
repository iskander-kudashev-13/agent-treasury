import { BOT_ID_RE } from "@/lib/tradingClient";

/**
 * Which agent a rules card applies to. If the chat was opened for a specific agent ("Change rules") or for "new", the target is
 * fixed. If it was opened plainly, the worker falls back to the `default` agent, so the owner must choose explicitly (otherwise a
 * new strategy silently replaces the rules of an existing agent).
 */
export type BotChoice = "update" | "new";

export interface BotTarget {
  botId: string;
  /** Only for a bot that does not exist yet. */
  botName?: string;
}

/** True when the card needs an explicit choice: the chat had no target. */
export const needsBotChoice = (chatTarget: string | null): boolean => chatTarget === null;

/** A valid, unused bot id from a display name: lower-case letters, digits and "-", max 16 chars. */
export function makeBotId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 12)
      .replace(/-+$/g, "") || "bot";
  const used = new Set(taken);
  if (!used.has(base) && BOT_ID_RE.test(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`;
    if (!used.has(id) && BOT_ID_RE.test(id)) return id;
  }
  return `${base.slice(0, 8)}-${Date.now().toString(36).slice(-6)}`;
}

/**
 * The (bot id, name) to sign for. Null while the owner has not chosen (confirm stays disabled) or the new name is empty.
 * `proposed` is what the worker resolved for the proposal (`p.bot`); `chatTarget` is the assistant context's target.
 */
export function resolveBotTarget(args: {
  chatTarget: string | null;
  choice: BotChoice | null;
  proposed: { id: string; name: string; is_new: boolean } | null;
  newName: string;
  takenIds: readonly string[];
}): BotTarget | null {
  const { chatTarget, choice, proposed, newName, takenIds } = args;
  if (!needsBotChoice(chatTarget)) {
    const id = proposed?.id ?? "default";
    return proposed?.is_new ? { botId: id, botName: proposed.name } : { botId: id };
  }
  if (choice === null) return null;
  if (choice === "update") return { botId: proposed?.id ?? "default" };
  const name = newName.trim();
  if (!name) return null;
  return { botId: makeBotId(name, takenIds), botName: name.slice(0, 60) };
}
