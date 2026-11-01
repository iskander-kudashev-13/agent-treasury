// Display logic for an agent: trust line, state, spend, "today" counters. Pure and unit-tested.
import { shortId } from "@/kit/tokens";
import type { AgentView, Rejection } from "./types";

export type TrustTone = "ok" | "warn" | "neutral";
export interface Trust {
  kind: "tee" | "key";
  /** Shield green only when registered with a valid attestation. */
  tone: TrustTone;
  /** "TEE · verified 7f3a…c21" / "TEE · waiting for registration" / "Key · ed25519:9Hk2…pQ" */
  line: string;
  registered: boolean;
}

const json = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** Short fingerprint of the attested measurements (mrtd when present, else the whole object). */
export function measurementsLabel(m: unknown): string {
  const mrtd = (m as { rtmrs?: { mrtd?: string } } | null)?.rtmrs?.mrtd;
  return shortId(mrtd ?? json(m), 8, 6);
}

export function trustOf(a: AgentView): Trust {
  if (a.kind === "Key") return { kind: "key", tone: "neutral", registered: true, line: `Key · ${a.public_key ? shortId(a.public_key, 12, 4) : (a.account_id ?? "no account")}` };
  if (!a.tee || !a.account_id) return { kind: "tee", tone: "warn", registered: false, line: "TEE · waiting for registration" };
  if (!a.tee.valid) return { kind: "tee", tone: "warn", registered: true, line: `TEE · attestation not valid · ${measurementsLabel(a.tee.measurements)}` };
  return { kind: "tee", tone: "ok", registered: true, line: `TEE · verified ${measurementsLabel(a.tee.measurements)}` };
}

export type RowState = "active" | "paused" | "revoked" | "waiting";
/** Status shown on the pill. A TEE slot that nobody has registered yet is "waiting", not "active". */
export function stateOf(a: AgentView): RowState {
  if (a.status === "Revoked") return "revoked";
  if (a.status === "Paused") return "paused";
  if (a.kind === "Tee" && (!a.tee || !a.account_id)) return "waiting";
  return "active";
}

/** Expired mandate (still "Active" on chain, but every request is refused). */
export const isExpired = (a: AgentView, nowMs: number): boolean => a.mandate.expires_at !== null && Number(a.mandate.expires_at) < nowMs;

/** Revoked last, then by creation time (oldest first). */
export function sortAgents<T extends AgentView>(agents: readonly T[]): T[] {
  const rank = (a: AgentView) => (a.status === "Revoked" ? 1 : 0);
  return [...agents].sort((x, y) => rank(x) - rank(y) || Number(x.created_at) - Number(y.created_at));
}

export const startOfUtcDay = (nowMs: number): number => nowMs - (nowMs % 86_400_000);

export function rejectionsToday(rejections: readonly Rejection[], agentId: string, nowMs: number): number {
  const from = startOfUtcDay(nowMs);
  return rejections.filter((r) => r.agent_id === agentId && Number(r.at) >= from).length;
}

/** Display ratio inputs for `SpendBar` (floats only for display). */
export function spendNumbers(a: AgentView): { spent: number; limit: number } {
  return { spent: Number(a.spent_today) / 1e6, limit: Number(a.mandate.daily_limit) / 1e6 };
}

/** Recipient names for the mandate sentence. */
export function recipientNames(list: ReadonlyArray<{ id: number; label: string }>): Map<number, string> {
  return new Map(list.map((r) => [r.id, r.label]));
}
