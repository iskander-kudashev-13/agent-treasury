/**
 * THE owner call table: every owner method of the vault contract, the deposit it needs and its gas.
 * Source of truth is `contract/src/*.rs`; `calls.contract-sync.test.ts` parses the Rust and fails when this file drifts
 * (a method requires exactly 1 yoctoNEAR iff its body calls `require_owner_one_yocto()`).
 * Components never hand-write deposit/gas: they call `useOwner().act(method, args)`.
 */
const TGAS = 10n ** 12n;
export const GAS_DEFAULT = (30n * TGAS).toString();
/** approve_payout (cross-contract 1Click transfer), credit_refund, sync_surplus. */
export const GAS_HEAVY = (100n * TGAS).toString();
/** withdraw: ft_transfer + callback. */
export const GAS_WITHDRAW = (60n * TGAS).toString();

/** Methods that must carry exactly 1 yoctoNEAR (full-access key / wallet confirmation required). */
export const ONE_YOCTO_METHODS = [
  // policy and funds
  "set_policy",
  "resume",
  "withdraw",
  "credit_refund",
  "sync_surplus",
  "withdraw_near",
  "force_settle_transfer",
  "set_storage_deposit_yocto",
  "propose_owner",
  "accept_owner", // not require_owner (the proposed owner calls it) but the contract demands exactly 1 yocto
  "update_contract", // raw wasm input; not buildable from JSON args, listed so the sync test covers it
  // recipients and schedules
  "add_recipient",
  "update_recipient",
  "remove_recipient",
  "add_schedule",
  "update_schedule",
  "resume_schedule",
  "end_schedule",
  "reset_schedule_failures",
  // payouts
  "approve_payout",
  // agents
  "add_agent",
  "update_mandate",
  "resume_agent",
  "revoke_agent",
  "unbind_agent",
  "pin_agent",
  "reset_agent_failures",
  // trust anchors
  "approve_measurements",
  "approve_ppids",
  "update_attestation_expiration_time",
  "whitelist_agent_for_local",
] as const;

/** Methods that need no deposit (they also work from a function-call key). `reject_payout` is conditional, see `buildCall`. */
export const NO_DEPOSIT_METHODS = [
  "pause",
  "pause_schedule",
  "remove_schedule",
  "reject_payout",
  "pause_agent",
  "remove_measurements",
  "remove_ppids",
  "remove_agent_from_whitelist_for_local",
] as const;

export type OwnerMethod = (typeof ONE_YOCTO_METHODS)[number] | (typeof NO_DEPOSIT_METHODS)[number];

const GAS_BY_METHOD: Partial<Record<OwnerMethod, string>> = {
  approve_payout: GAS_HEAVY,
  credit_refund: GAS_HEAVY,
  sync_surplus: GAS_HEAVY,
  withdraw: GAS_WITHDRAW,
};

export interface CallSpec {
  method: OwnerMethod;
  args: Record<string, unknown>;
  deposit: string;
  gas: string;
}

/**
 * Deposit and gas for an owner call. `reject_payout` needs 1 yocto when it skips a scheduled date. The contract skips by
 * default for scheduled payouts, so only an explicit `skip: false` is deposit-free; callers should always pass `skip`.
 */
export function buildCall(method: OwnerMethod, args: Record<string, unknown> = {}): CallSpec {
  const needsYocto = (ONE_YOCTO_METHODS as readonly string[]).includes(method) || (method === "reject_payout" && args.skip !== false);
  return { method, args, deposit: needsYocto ? "1" : "0", gas: GAS_BY_METHOD[method] ?? GAS_DEFAULT };
}

export const isOwnerMethod = (m: unknown): m is OwnerMethod =>
  typeof m === "string" && ((ONE_YOCTO_METHODS as readonly string[]).includes(m) || (NO_DEPOSIT_METHODS as readonly string[]).includes(m));

/* ───────────── planned calls (assistant proposals, payments forms) ───────────── */

/** The subset of owner methods the assistant may propose. Anything else coming from the worker is dropped. */
export const ASSISTANT_METHODS = [
  "add_recipient",
  "update_recipient",
  "remove_recipient",
  "add_schedule",
  "update_schedule",
  "pause_schedule",
  "resume_schedule",
  "end_schedule",
  "remove_schedule",
  "update_mandate",
  "pause_agent",
  "resume_agent",
  "pause",
  "resume",
] as const satisfies readonly OwnerMethod[];
export type AssistantMethod = (typeof ASSISTANT_METHODS)[number];

export const isAssistantMethod = (m: unknown): m is AssistantMethod => typeof m === "string" && (ASSISTANT_METHODS as readonly string[]).includes(m);

export interface PlannedCall<M extends OwnerMethod = OwnerMethod> {
  method: M;
  args: Record<string, unknown>;
}

/** 300 TGas per transaction, 30 TGas per call: keep one under the cap. */
export const MAX_ACTIONS_PER_TX = 9;

/** Split calls (order preserved) into transactions of at most MAX_ACTIONS_PER_TX actions. */
export function chunkCalls<T>(calls: T[], size = MAX_ACTIONS_PER_TX): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < calls.length; i += size) out.push(calls.slice(i, i + size));
  return out;
}

/** Plain-language one-liner for the review modal. Text from args is data: callers render it as plain text. */
export function describeCall(c: PlannedCall, names: { agent?: (id: string) => string; recipient?: (id: number) => string } = {}): string {
  const a = c.args;
  const agent = (v: unknown) => names.agent?.(String(v)) ?? String(v);
  const rec = (v: unknown) => names.recipient?.(Number(v)) ?? `recipient #${String(v)}`;
  switch (c.method) {
    case "add_recipient": {
      const r = a.recipient as { label?: string; destination_chain?: string } | undefined;
      return `Add recipient ${r?.label ?? "?"} (${r?.destination_chain ?? "?"})`;
    }
    case "update_recipient":
      return `Update ${rec(a.recipient_id)}`;
    case "remove_recipient":
      return `Remove ${rec(a.recipient_id)} from the address book`;
    case "add_schedule":
      return `Create a scheduled payment to ${rec((a.schedule as { recipient_id?: number } | undefined)?.recipient_id)}`;
    case "update_schedule":
      return `Update scheduled payment #${String(a.schedule_id)}`;
    case "pause_schedule":
      return `Pause scheduled payment #${String(a.schedule_id)}`;
    case "resume_schedule":
      return `Resume scheduled payment #${String(a.schedule_id)}`;
    case "end_schedule":
      return `End scheduled payment #${String(a.schedule_id)} (cannot be undone)`;
    case "remove_schedule":
      return `Delete ended scheduled payment #${String(a.schedule_id)}`;
    case "update_mandate":
      return `Change the mandate of ${agent(a.agent_id)}`;
    case "pause_agent":
      return `Pause ${agent(a.agent_id)}`;
    case "resume_agent":
      return `Resume ${agent(a.agent_id)}`;
    case "pause":
      return "Pause the whole vault (all agents stop paying)";
    case "resume":
      return "Resume the vault";
    default:
      return `${c.method.replace(/_/g, " ")}`;
  }
}

/* ───────────── generic transaction actions (wallet-agnostic) ───────────── */

/** Any action a transaction may carry. Amounts are decimal strings (yoctoNEAR / gas units). */
export type TxAction =
  | { type: "CreateAccount" }
  | { type: "Transfer"; yocto: string }
  | { type: "AddKeyFullAccess"; publicKey: string }
  | { type: "AddKeyFunctionCall"; publicKey: string; receiverId: string; methodNames: string[]; allowanceYocto: string }
  | { type: "DeleteKey"; publicKey: string }
  | { type: "FunctionCall"; method: string; args: Record<string, unknown>; gas: string; deposit: string };

/** One transaction: one receiver, one or more actions, one wallet approval. */
export interface TxInput {
  receiverId: string;
  /** One-line plain description (Review step), optional. */
  description?: string;
  actions: TxAction[];
}

/** The FunctionCall action for an owner call, with deposit/gas from the table. */
export function toTxAction(c: PlannedCall): TxAction {
  const s = buildCall(c.method, c.args);
  return { type: "FunctionCall", method: s.method, args: s.args, gas: s.gas, deposit: s.deposit };
}
