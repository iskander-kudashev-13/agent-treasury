// Design-kit logic that is not styling: chain colors, the limit color rule, number/hash formatting for display.
// See design-kit/agent-treasury-design/design-system/DESIGN_SYSTEM.md §1.4, §1.5, §2.

export type Accent = "ok" | "warn" | "danger" | "info" | "neutral";

export const CHAIN_COLORS: Record<string, string> = {
  base: "#3B82F6",
  ethereum: "#94A3B8",
  eth: "#94A3B8",
  arbitrum: "#38BDF8",
  arb: "#38BDF8",
  solana: "#A78BFA",
  sol: "#A78BFA",
  tron: "#F87171",
  near: "#2ECC71",
};

const CHAIN_NAMES: Record<string, string> = {
  base: "Base",
  ethereum: "Ethereum",
  eth: "Ethereum",
  arbitrum: "Arbitrum",
  arb: "Arbitrum",
  solana: "Solana",
  sol: "Solana",
  tron: "Tron",
  near: "NEAR",
};

const FALLBACK_CHAIN_COLOR = "#8A93A3";

export const chainColor = (chain: string): string => CHAIN_COLORS[chain.trim().toLowerCase()] ?? FALLBACK_CHAIN_COLOR;
/** Display name; unknown codes pass through. The one chain-name map of the app. */
export const chainName = (chain: string): string => CHAIN_NAMES[chain.trim().toLowerCase()] ?? chain;

/** 1Click blockchain ids a mandate can allow (ADR-0003 §10), in picker order. */
export const CHAIN_OPTIONS = [
  { id: "base", label: "Base" },
  { id: "eth", label: "Ethereum" },
  { id: "arb", label: "Arbitrum" },
  { id: "sol", label: "Solana" },
  { id: "near", label: "NEAR" },
] as const;
export const CHAIN_IDS: readonly string[] = CHAIN_OPTIONS.map((c) => c.id);

/**
 * Limit color rule (§1.5): pct < 0.8 → green for the vault, neutral for an agent; 0.8 ≤ pct < 1 → amber; ≥ 1 → red.
 * `pct` is a fraction (0.5 = 50 %). Non-finite input is treated as 0.
 */
export function limitTone(pct: number, scope: "vault" | "agent" = "vault"): Accent {
  const p = Number.isFinite(pct) ? pct : 0;
  if (p >= 1) return "danger";
  if (p >= 0.8) return "warn";
  return scope === "vault" ? "ok" : "neutral";
}

export const ACCENT_HEX: Record<Accent, string> = {
  ok: "#2ECC71",
  warn: "#F5B544",
  danger: "#E5484D",
  info: "#8AB4FF",
  neutral: "#AEB5C1",
};

/** Clamp a fraction to [0, 1] for bar/ring geometry. */
export const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/** `12480.5` → `12,480.50` (USDC display: 2 decimals, en-US grouping). Pass already-decimal numbers, not raw u128. */
export const formatUsdc = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** First 6 + … + last 4 (§2). Short strings pass through unchanged. */
export const shortId = (s: string, head = 6, tail = 4): string => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);

/** Initials for avatars: "Maria Lopez" → "ML", "studio-kite.near" → "SK". */
export function initials(name: string): string {
  const words = name
    .replace(/\.(near|testnet)$/i, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const first = words[0]?.[0] ?? "?";
  const second = words[1]?.[0] ?? words[0]?.[1] ?? "";
  return (first + second).toUpperCase();
}

const AVATAR_PASTELS = ["#2A3A55", "#3A2F55", "#2F4A3E", "#4A3A2A", "#4A2F3A", "#2F454A"];
/** Stable soft background for an initials avatar. */
export function avatarColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_PASTELS[h % AVATAR_PASTELS.length] ?? AVATAR_PASTELS[0]!;
}
