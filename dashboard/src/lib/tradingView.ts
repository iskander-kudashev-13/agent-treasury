// Pure helpers of the Trading agent page (ADR-0005): setup form -> mandate, state wording, number formatting.
import type { Accent } from "@/kit/tokens";
import { normalizeAddress } from "./address";
import { DEFAULT_FORM, validateMandateForm } from "./mandateForm";
import type { TradingState } from "./tradingClient";
import type { Mandate } from "./types";

export const TRADER_AGENT_NAME = "Hyperliquid trader";
export const DEFAULT_DAILY_FUNDING = "50";
export const DEFAULT_TOPUP = "25";
/** 1Click minimum input is about 2 USDC (ADR-0005). */
export const MIN_TOPUP = 2;
export const MANDATE_DAYS = 30;

export interface SetupInput {
  master: string;
  daily: string;
  perTx: string;
}
export interface SetupCheck {
  errors: Partial<Record<keyof SetupInput, string>>;
  /** Canonical (lower-case) master address when valid. */
  master: string | null;
  mandate: Mandate | null;
}

/**
 * The `hl-trader` mandate of ADR-0005 §2: Allowlist with the owner's HL master as the only destination on `hypercore`,
 * per-tx = one top-up, at most 2 top-ups a day, top-ups at the per-tx size need no approval, expires in 30 days.
 * Validation is the wizard's `validateMandateForm`, so the contract rules are enforced in one place.
 */
export function buildTraderSetup(i: SetupInput, nowMs: number): SetupCheck {
  const errors: SetupCheck["errors"] = {};
  let master: string | null = null;
  if (i.master.trim() === "") errors.master = "Enter your Hyperliquid account address";
  else {
    try {
      master = normalizeAddress("hypercore", i.master);
      if (!/^0x[0-9a-f]{40}$/.test(master)) throw new Error("Invalid EVM address: expected 0x + 40 hex characters");
    } catch (e) {
      master = null;
      errors.master = e instanceof Error ? e.message : "Invalid address";
    }
  }
  const perTxN = Number(i.perTx);
  if (Number.isFinite(perTxN) && i.perTx.trim() !== "" && perTxN < MIN_TOPUP) errors.perTx = `At least ${MIN_TOPUP} USDC per top-up (the 1Click minimum)`;
  const res = validateMandateForm(
    {
      ...DEFAULT_FORM,
      daily: i.daily,
      perTx: i.perTx,
      threshold: i.perTx,
      maxPerDay: "2",
      chains: ["hypercore"],
      mode: "Allowlist",
      allowlist: [{ chain: "hypercore", address: master ?? "0x0000000000000000000000000000000000000000", label: "Owner HL" }],
      expiry: "30d",
    },
    { knownRecipients: new Set(), nowMs },
  );
  if (res.errors.daily) errors.daily = res.errors.daily;
  if (res.errors.perTx) errors.perTx ??= res.errors.perTx;
  const ok = Object.keys(errors).length === 0 && master !== null && res.mandate !== null;
  return { errors, master, mandate: ok ? res.mandate : null };
}

/* ───────────── state wording ───────────── */

export const STATE_INFO: Record<TradingState, { label: string; accent: Accent; hint: string }> = {
  not_configured: { label: "Not set up", accent: "neutral", hint: "The bot is not configured yet." },
  awaiting_api_wallet: { label: "Waiting for approval", accent: "warn", hint: "Approve the bot's API wallet on Hyperliquid to let it trade." },
  no_rules: { label: "No rules", accent: "warn", hint: "Describe a strategy to the assistant and confirm the rules." },
  running: { label: "Running", accent: "ok", hint: "The bot checks your rules every minute." },
  paused_onchain: { label: "Paused on the vault", accent: "warn", hint: "The vault agent is paused. Orders are cancelled. Resume the agent to continue." },
  stopped_today: { label: "Stopped for today", accent: "warn", hint: "The daily loss limit was reached. Trading resumes at 00:00 UTC." },
  halted: { label: "Halted", accent: "danger", hint: "Trading is stopped until you confirm new rules." },
  error: { label: "Error", accent: "danger", hint: "The bot hit an error and is retrying." },
};

const REASONS: Record<string, string> = {
  PERP_POSITION_DETECTED: "A perpetuals position or order was found on the account. The bot trades spot only, so it stopped and cancelled its orders. Close it in the Hyperliquid app and revoke the API wallet.",
  KILL: "You pressed the kill switch.",
};
export const reasonText = (reason: string | null, detail: string | null): string | null => {
  if (!reason && !detail) return null;
  return [reason ? (REASONS[reason] ?? reason) : null, detail].filter(Boolean).join(" ");
};

/* ───────────── numbers ───────────── */

const NUM_RE = /^-?\d+(\.\d+)?$/;
/** "12.3456" -> "12.35". Text in, text out (no float drift for display of decimal strings). Unknown input is returned as is. */
export function fmtDec(v: string, dp = 2): string {
  if (!NUM_RE.test(v)) return v;
  const neg = v.startsWith("-");
  const [int = "0", frac = ""] = (neg ? v.slice(1) : v).split(".");
  const scaled = BigInt(int) * 10n ** BigInt(dp) + BigInt(frac.padEnd(dp + 1, "0").slice(0, dp));
  const next = BigInt(frac.padEnd(dp + 1, "0").slice(dp, dp + 1)) >= 5n ? scaled + 1n : scaled; // round half up on magnitude
  const s = next.toString().padStart(dp + 1, "0");
  const whole = s.slice(0, s.length - dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = dp > 0 ? `${whole}.${s.slice(s.length - dp)}` : whole;
  return neg && next !== 0n ? `-${out}` : out;
}
export const fmtSigned = (v: string, dp = 2): string => {
  const t = fmtDec(v, dp);
  return t.startsWith("-") || !NUM_RE.test(v) || /^0(\.0+)?$/.test(t) ? t : `+${t}`;
};
export const pnlAccent = (v: string): Accent => (!NUM_RE.test(v) ? "neutral" : v.startsWith("-") && Number(v) !== 0 ? "danger" : Number(v) > 0 ? "ok" : "neutral");
/** Part of a decimal string as a fraction for progress bars (display only). */
export const ratio = (part: string, whole: string): number => {
  const a = Number(part);
  const b = Number(whole);
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? Math.max(0, a / b) : 0;
};

/* ───────────── Hyperliquid app ───────────── */

export const hlAppUrl = (network: "mainnet" | "testnet", path = "API"): string => `https://${network === "mainnet" ? "app.hyperliquid.xyz" : "app.hyperliquid-testnet.xyz"}/${path}`;
export const API_WALLET_DAYS = 30;
/** Name the owner gives the API wallet in the HL UI (ADR-0005 §3): the bot reads `valid_until` from it. */
export const apiWalletName = (nowMs: number, days = API_WALLET_DAYS): string => `agent-treasury valid_until ${nowMs + days * 86_400_000}`;
