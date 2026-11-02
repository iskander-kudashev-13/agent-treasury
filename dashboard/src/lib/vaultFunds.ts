/** Deposit / withdraw helpers for the Treasury modals. No signing here: these only build call payloads and validate input. */
import { t } from "@/i18n";
import { parseUsdc } from "./amount";
import type { TxInput } from "./calls";

type FunctionCallAction = Extract<TxInput["actions"][number], { type: "FunctionCall" }>;

const TGAS = 10n ** 12n;
export const GAS_FT_TRANSFER_CALL = (100n * TGAS).toString();
export const GAS_STORAGE_DEPOSIT = (30n * TGAS).toString();
/** NEP-145 minimum for most tokens (0.00125 NEAR); the real value is read from `storage_balance_bounds` when available. */
export const DEFAULT_STORAGE_MIN_YOCTO = "1250000000000000000000";

export interface AmountResult {
  raw: string | null;
  error: string | null;
}

/** Parse a USDC amount typed by the user and check 0 < amount <= max (raw units). */
export function checkAmount(input: string, max: string | null, what = t("fund.whatBalance")): AmountResult {
  if (input.trim() === "") return { raw: null, error: null };
  let raw: string;
  try {
    raw = parseUsdc(input);
  } catch (e) {
    return { raw: null, error: e instanceof Error ? e.message : t("amount.invalidShort") };
  }
  if (BigInt(raw) === 0n) return { raw: null, error: t("amount.zero") };
  if (max !== null && BigInt(raw) > BigInt(max)) return { raw: null, error: t("amount.exceeds", { what }) };
  return { raw, error: null };
}


/**
 * Fund the vault: `ft_transfer_call(receiver_id = vault, amount, msg = "")` with exactly 1 yoctoNEAR on the USDC contract.
 * The vault's `ft_on_transfer` ignores `msg`. When the vault is not registered on the token yet, a `storage_deposit`
 * (registration_only) goes first in the same transaction, paid by the sender.
 */
export function buildDepositTx(opts: { usdcId: string; vaultId: string; amount: string; registerVaultYocto?: string | null }): { receiverId: string; actions: FunctionCallAction[] } {
  const actions: FunctionCallAction[] = [];
  if (opts.registerVaultYocto) {
    actions.push({ type: "FunctionCall", method: "storage_deposit", args: { account_id: opts.vaultId, registration_only: true }, deposit: opts.registerVaultYocto, gas: GAS_STORAGE_DEPOSIT });
  }
  actions.push({ type: "FunctionCall", method: "ft_transfer_call", args: { receiver_id: opts.vaultId, amount: opts.amount, msg: "" }, deposit: "1", gas: GAS_FT_TRANSFER_CALL });
  return { receiverId: opts.usdcId, actions };
}

/** NEP-145 `storage_balance_of` result: null = not registered. */
export const isRegistered = (storage: { total?: string } | null | undefined): boolean => storage !== null && storage !== undefined;

/** yoctoNEAR -> "0.00125" (trailing zeros trimmed). */
export function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const whole = (v / 10n ** 24n).toString();
  const frac = (v % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 8)}` : whole;
}

/** "1.5" NEAR -> yocto string; throws on invalid input. */
export function parseNear(input: string): string {
  const s = input.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(t("amount.enterNear"));
  const [w = "0", f = ""] = s.split(".");
  return (BigInt(w) * 10n ** 24n + BigInt(f.padEnd(24, "0"))).toString();
}
