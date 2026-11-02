// Pure helpers of the Trading agent page (ADR-0005): setup form -> mandate, state wording, number formatting.
import { t } from "@/i18n";
import type { Accent } from "@/kit/tokens";
import { normalizeAddress } from "./address";
import { DEFAULT_FORM, validateMandateForm } from "./mandateForm";
import { TRADER_AGENT_ID, type TradingState } from "./tradingClient";
import type { AgentView, Mandate } from "./types";

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
  if (i.master.trim() === "") errors.master = t("trading.setup.enterMaster");
  else {
    try {
      master = normalizeAddress("hypercore", i.master);
      if (!/^0x[0-9a-f]{40}$/.test(master)) throw new Error(t("addr.badEvm"));
    } catch (e) {
      master = null;
      errors.master = e instanceof Error ? e.message : t("trading.setup.invalidAddress");
    }
  }
  const perTxN = Number(i.perTx);
  if (Number.isFinite(perTxN) && i.perTx.trim() !== "" && perTxN < MIN_TOPUP) errors.perTx = t("trading.setup.minTopup", { min: MIN_TOPUP });
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

const STATE_ACCENT: Record<TradingState, Accent> = {
  not_configured: "neutral",
  awaiting_api_wallet: "warn",
  no_rules: "warn",
  running: "ok",
  paused_onchain: "warn",
  stopped_today: "warn",
  halted: "danger",
  error: "danger",
};
/** Label and hint come from the dictionary in the current language (read at call time). */
export const stateInfo = (s: TradingState, p: { sec?: number; lost?: string; limit?: string } = {}): { label: string; accent: Accent; hint: string } => ({
  label: t(`trading.state.${s}`),
  accent: STATE_ACCENT[s],
  hint: t(`trading.hint.${s}`, { sec: p.sec ?? 60, lost: p.lost ?? "0", limit: p.limit ?? "0" }),
});

const REASON_CODES = [
  "PERP_POSITION_DETECTED", "KILL", "KILLED", "SCHEDULE_CANCEL_FAILED", "DEADMAN_VOLUME_GATED", "LIMIT_NEEDS_DEADMAN", "FILLS_TRUNCATED", "NO_MID_FOR_POSITION",
  "EQUITY_DROP", "NO_DAY_SNAPSHOT", "STATE_WRITE_FAILED", "HL_READ_FAILED", "VAULT_STATUS_UNAVAILABLE", "DAILY_LOSS_STOP", "API_WALLET_NOT_APPROVED",
  "API_WALLET_EXPIRING", "PAIR_LOW_VOLUME", "STALE_DATA",
] as const;
/** Plain words for a worker state reason code; an unknown code is shown as is in a generic sentence. The worker's detail text follows. */
export const reasonText = (reason: string | null, detail: string | null): string | null => {
  if (!reason && !detail) return null;
  const known = reason !== null && (REASON_CODES as readonly string[]).includes(reason);
  return [reason ? (known ? t(`trading.reason.${reason as (typeof REASON_CODES)[number]}`) : t("trading.reason.generic", { code: reason })) : null, detail].filter(Boolean).join(" ");
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
/**
 * The API wallet is short-lived on purpose (audit 2026-11-03 H2): whoever holds its key can trade perps, move funds between
 * spot and perp and more on the master account, so it should expire within the session and be revoked after it.
 */
export const API_WALLET_HOURS = 47;
/** Name the owner gives the API wallet in the HL UI (ADR-0005 §3): the bot reads `valid_until` from it. */
export const apiWalletName = (nowMs: number, hours = API_WALLET_HOURS): string => `agent-treasury valid_until ${nowMs + hours * 3_600_000}`;

/* ───────────── which HL account is the owner's? (audit M7) ───────────── */

export type AccountTrust =
  | { kind: "ok"; account: string }
  /** The worker reports an account that is not the one the on-chain mandate pays. */
  | { kind: "mismatch"; reported: string; onchain: string }
  /** The chain cannot vouch for any account: no agent, or not exactly one `hypercore` allowlist entry. */
  | { kind: "unverified"; reason: string };

/** The single `hypercore` address of the trader's on-chain allowlist (lower case), or null. */
export function trustedHlAccount(trader: AgentView | null): string | null {
  if (!trader) return null;
  // Same rule as the worker (funding.ts): exactly one allowlist entry, on hypercore, mode Allowlist, allowed_chains [hypercore].
  const m = trader.mandate;
  const only = m.allowlist.length === 1 ? m.allowlist[0] : undefined;
  if (m.recipients_mode !== "Allowlist" || !only || only.chain.toLowerCase() !== "hypercore") return null;
  if (m.allowed_chains.length !== 1 || m.allowed_chains[0]?.toLowerCase() !== "hypercore") return null;
  return only.address.toLowerCase();
}

/** The worker is not trusted for where money goes: compare its `hl_account` with the vault's mandate allowlist. */
export function checkHlAccount(reported: string, trader: AgentView | null): AccountTrust {
  if (!trader) return { kind: "unverified", reason: t("trading.trust.noAgent") };
  const onchain = trustedHlAccount(trader);
  if (onchain === null) return { kind: "unverified", reason: t("trading.trust.noSingle") };
  const rep = reported.trim().toLowerCase();
  return rep === onchain ? { kind: "ok", account: onchain } : { kind: "mismatch", reported: rep, onchain };
}

/* ───────────── mainnet: the key is made by the CLI, not the browser (audit M6) ───────────── */

export const SESSION_LIMIT_USDC = "25";
/** 47 h from the moment the command runs: inside the 48 h limit of the session decision. */
export const SESSION_EXPIRY_MS = 47 * 3_600_000;

export interface MainnetCommandInput {
  owner: string;
  vault: string;
  master: string;
  /** Sub-account prefix of the agent account. */
  name: string;
  fundNear: string;
}

/** The session mandate (ADR-0005 session decision): threshold 0, 25/25 USDC, 1 payment a day, <= 48 h, one HL address. */
export function sessionMandateScript(master: string): string {
  const mandate = `{
  "daily_limit": "25000000",
  "per_tx_limit": "25000000",
  "approval_threshold": "0",
  "max_payments_per_day": 1,
  "allowed_chains": ["hypercore"],
  "recipients_mode": "Allowlist",
  "allowlist": [{ "chain": "hypercore", "address": "${master}", "label": "Owner HL" }],
  "recipients": [],
  "expires_at": "$(( $(date +%s) * 1000 + ${SESSION_EXPIRY_MS} ))"
}`;
  return `cat > mandate.hl-trader.session.json <<EOF\n${mandate}\nEOF`;
}

/**
 * The exact commands for a mainnet Key agent: the owner key is read from the near-cli credentials file (or typed silently),
 * never pasted inline (shell history), and a --dry-run precedes the real run.
 */
export function mainnetKeyAgentCommands(i: { owner: string; vault: string; name: string; agentId: string; displayName: string; fundNear: string; mandateFile: string; mandateScript: string }): string {
  const args = `--owner ${i.owner} --vault ${i.vault} --name ${i.name} --agent-id ${i.agentId} --display-name "${i.displayName}" --network mainnet --fund ${i.fundNear} --mandate ${i.mandateFile}`;
  return `cd sdk && pnpm install
${i.mandateScript}
# 1. dry run: prints the 3 transactions, sends nothing, needs no key
pnpm setup-key-agent ${args} --dry-run
# 2. your owner key, from the near-cli credentials file (or: read -rs OWNER_PRIVATE_KEY && export OWNER_PRIVATE_KEY)
export OWNER_PRIVATE_KEY="$(jq -r .private_key ~/.near-credentials/mainnet/${i.owner}.json)"
# 3. the real run
pnpm setup-key-agent ${args} --confirm-mainnet`;
}

/** The exact commands to create `hl-trader` on mainnet. The private key is printed once by the script, never by the dashboard. */
export function mainnetSetupCommands(i: MainnetCommandInput): string {
  return mainnetKeyAgentCommands({
    owner: i.owner,
    vault: i.vault,
    name: i.name,
    agentId: TRADER_AGENT_ID,
    displayName: TRADER_AGENT_NAME,
    fundNear: i.fundNear,
    mandateFile: "mandate.hl-trader.session.json",
    mandateScript: sessionMandateScript(i.master),
  });
}
