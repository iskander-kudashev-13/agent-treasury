/** Parsing and display helpers for TEE trust anchors (approved measurements, PPIDs, local-mode whitelist). */
import { shortId } from "@/kit/tokens";

export interface Measurements {
  rtmrs: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string };
  key_provider_event_digest: string;
  app_compose_hash_payload: string;
}

const HEX = /^[0-9a-fA-F]+$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Parse the `<MEASUREMENTS_JSON>` the owner pasted (worker/README.md). Returns the value or a readable error. */
export function parseMeasurements(text: string): { value: Measurements; error: null } | { value: null; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { value: null, error: "Not valid JSON" };
  }
  if (!isObj(v) || !isObj(v.rtmrs)) return { value: null, error: 'Expected {"rtmrs":{...},"key_provider_event_digest":...,"app_compose_hash_payload":...}' };
  for (const k of ["mrtd", "rtmr0", "rtmr1", "rtmr2"]) {
    const x = v.rtmrs[k];
    if (typeof x !== "string" || !HEX.test(x)) return { value: null, error: `rtmrs.${k} must be a hex string` };
  }
  for (const k of ["key_provider_event_digest", "app_compose_hash_payload"]) {
    if (typeof v[k] !== "string" || !HEX.test(v[k])) return { value: null, error: `${k} must be a hex string` };
  }
  return { value: v as unknown as Measurements, error: null };
}

/** PPIDs are 16 bytes = 32 hex characters; accepts newline, comma or space separated input. */
export function parsePpids(text: string): { value: string[]; error: string | null } {
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return { value: [], error: null };
  const bad = parts.find((p) => !/^[0-9a-fA-F]{32}$/.test(p));
  if (bad) return { value: [], error: `"${shortId(bad, 10, 4)}" is not a PPID (32 hex characters)` };
  return { value: [...new Set(parts.map((p) => p.toLowerCase()))], error: null };
}

/** NEAR account id (loose check; the contract and the wallet validate precisely). */
export const isAccountId = (s: string): boolean => s.length >= 2 && s.length <= 64 && /^[a-z0-9]+([-_.][a-z0-9]+)*$/.test(s);

/** Short label for a measurement set: mrtd head. */
export function measurementLabel(m: unknown): string {
  const mrtd = isObj(m) && isObj(m.rtmrs) && typeof m.rtmrs.mrtd === "string" ? m.rtmrs.mrtd : null;
  return mrtd ? shortId(mrtd, 10, 6) : shortId(JSON.stringify(m), 16, 6);
}
