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

/** The exact NEP-413 message the owner signs (ADR-0005 "NEP-413 confirmation message"). */
export function confirmationMessage(p: {
  vault: string;
  agentId: string;
  hlNetwork: "mainnet" | "testnet";
  hlAccount: string;
  rulesSha256: string;
}): string {
  return [
    "Agent Treasury: activate trading rules",
    `vault: ${p.vault}`,
    `agent: ${p.agentId}`,
    `hl_network: ${p.hlNetwork}`,
    `hl_account: ${p.hlAccount.toLowerCase()}`,
    `rules_sha256: ${p.rulesSha256}`,
  ].join("\n");
}
