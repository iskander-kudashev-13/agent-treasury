/**
 * Canonical JSON and hash of a rule set (ADR-0005). The owner signs `rules_sha256`, so this must be byte-for-byte
 * reproducible by the dashboard: keys sorted by UTF-16 code unit order (default JS sort) at every level, no whitespace,
 * UTF-8 output, `undefined` members omitted (optional keys are omitted when unset), decimals stay the strings they are
 * (no re-formatting: "10" and "10.0" are different rule sets with different hashes).
 */
import { createHash } from "node:crypto";
import type { RuleSetV1 } from "../types.js";

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) {
      if (o[k] !== undefined) out[k] = sortKeys(o[k]);
    }
    return out;
  }
  return v;
}

/** Canonical JSON text. Pass a validated rule set (see `parseRuleSet`); non-finite numbers throw. */
export function canonicalize(rules: RuleSetV1): string {
  const json = JSON.stringify(sortKeys(rules));
  if (typeof json !== "string") throw new Error("cannot canonicalize");
  return json;
}

/** hex(sha256(utf8(canonical))) */
export function hashCanonical(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function hashRuleSet(rules: RuleSetV1): string {
  return hashCanonical(canonicalize(rules));
}

/**
 * The exact NEP-413 message the owner signs. With `botId` it is the v2 message of ADR-0006 (a `bot:` line after `agent:`); without
 * it, the v1 message of ADR-0005, which the worker accepts only for the migrated bot `default` (see confirm.ts).
 * With `mode: "agent"` it is the v3 message of ADR-0007: a different header and a `mode:` line, so a DSL signature and an agent
 * signature can never stand in for each other. v3 always names the bot; `mode` without `botId` throws.
 */
export function confirmationMessage(p: {
  vault: string;
  agentId: string;
  hlNetwork: "mainnet" | "testnet";
  hlAccount: string;
  rulesSha256: string;
  botId?: string;
  mode?: "agent";
}): string {
  if (p.mode !== undefined) {
    if (p.botId === undefined) throw new Error("confirmationMessage: an agent-mode message needs botId");
    return [
      "Agent Treasury: activate AI agent trading limits",
      `vault: ${p.vault}`,
      `agent: ${p.agentId}`,
      `bot: ${p.botId}`,
      "mode: agent",
      `hl_network: ${p.hlNetwork}`,
      `hl_account: ${p.hlAccount.toLowerCase()}`,
      `rules_sha256: ${p.rulesSha256}`,
    ].join("\n");
  }
  return [
    "Agent Treasury: activate trading rules",
    `vault: ${p.vault}`,
    `agent: ${p.agentId}`,
    ...(p.botId === undefined ? [] : [`bot: ${p.botId}`]),
    `hl_network: ${p.hlNetwork}`,
    `hl_account: ${p.hlAccount.toLowerCase()}`,
    `rules_sha256: ${p.rulesSha256}`,
  ].join("\n");
}
