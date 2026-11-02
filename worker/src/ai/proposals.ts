/**
 * Typed proposals (UI_UPDATES.md §6.3) and their server-side validation against FRESH contract state.
 *
 * A proposal is data only: `call` describes the owner transaction the dashboard may ask the wallet to sign.
 * Nothing in this module (or in src/ai at all) can sign or send a transaction. `call.method` / `call.args` follow
 * docs/adr/0003-agents-and-mandates.md and docs/adr/0004-schedules.md; schedule calls are `add_schedule({ schedule })` and
 * `update_schedule({ schedule_id, schedule })` as implemented in contract/src/owner.rs; they are built only in `calls` below.
 */
import { checkAddress, CHAINS, isTronName, normalizeChain, sameAddress, TRON_REFUSAL } from "./chains.js";
import type { EndRule, Frequency } from "./frequency.js";
import {
  describeEnd,
  describeFrequency,
  endToWire,
  formatDate,
  frequencyError,
  frequencyToWire,
  occurrences,
} from "./frequency.js";
import { formatUsdcHuman } from "./money.js";
import type { TradingRulesCard } from "./trading.js";
import type { Agent, Mandate, VaultReader } from "./views.js";

export interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface DiffRow {
  field: string;
  label: string;
  from: string;
  to: string;
}

export interface ProposalCall<M extends string = string, A = Record<string, unknown>> {
  method: M;
  args: A;
  /** yoctoNEAR as a decimal string. "1" for owner methods that require it, "0" for the ones documented as no-deposit. */
  deposit_yocto: "0" | "1";
  gas_tgas: number;
}

interface Base<T extends string, C extends ProposalCall> {
  /** Unique within one assistant turn ("p1", "p2", ...). */
  id: string;
  type: T;
  title: string;
  summary: string;
  /** Pause requests: the UI shows a red "Pause now" that signs immediately. */
  urgent?: true;
  /** Ids of proposals in the same batch that must be signed first (e.g. the AddRecipient a schedule refers to). */
  depends_on?: string[];
  diff?: DiffRow[];
  call: C;
  validation: Validation;
}

export type AddRecipientProposal = Base<
  "AddRecipient",
  ProposalCall<
    "add_recipient",
    { recipient: { label: string; destination_chain: string; destination_asset: string; destination_address: string } }
  >
> & { predicted_recipient_id: number | null };

type ScheduleArgs = {
  recipient_id: number;
  amount: string;
  frequency: ReturnType<typeof frequencyToWire>;
  start_at: string;
  end: ReturnType<typeof endToWire>;
  agent_id: string;
};

export type AddScheduleProposal = Base<"AddSchedule", ProposalCall<"add_schedule", { schedule: ScheduleArgs }>> & {
  /** Next payment dates (ms, UTC) so the card can show "next: 1 Dec, 1 Jan, 1 Feb". */
  next_dates: number[];
};
export type UpdateScheduleProposal = Base<"UpdateSchedule", ProposalCall<"update_schedule", { schedule_id: number; schedule: ScheduleArgs }>> & {
  next_dates: number[];
};
export type PauseScheduleProposal = Base<"PauseSchedule", ProposalCall<"pause_schedule", { schedule_id: number }>>;
export type EndScheduleProposal = Base<"EndSchedule", ProposalCall<"end_schedule", { schedule_id: number }>>;
export type UpdateMandateProposal = Base<"UpdateMandate", ProposalCall<"update_mandate", { agent_id: string; mandate: Mandate }>>;
export type PauseAgentProposal = Base<"PauseAgent", ProposalCall<"pause_agent", { agent_id: string }>>;
export type ResumeAgentProposal = Base<"ResumeAgent", ProposalCall<"resume_agent", { agent_id: string }>>;
export type PauseVaultProposal = Base<"PauseVault", ProposalCall<"pause", Record<string, never>>>;
export type ResumeVaultProposal = Base<"ResumeVault", ProposalCall<"resume", Record<string, never>>>;

export type Proposal =
  | AddRecipientProposal
  | AddScheduleProposal
  | UpdateScheduleProposal
  | PauseScheduleProposal
  | EndScheduleProposal
  | UpdateMandateProposal
  | PauseAgentProposal
  | ResumeAgentProposal
  | PauseVaultProposal
  | ResumeVaultProposal
  /** No contract `call`: the owner signs a NEP-413 message in the dashboard (ADR-0005). */
  | TradingRulesCard;

export type ProposalType = Proposal["type"];

const OWNER_GAS_TGAS = 30;

/** The only place where owner-call shapes are built. */
const calls = {
  addRecipient: (a: AddRecipientProposal["call"]["args"]): AddRecipientProposal["call"] => ({ method: "add_recipient", args: a, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
  addSchedule: (a: ScheduleArgs): AddScheduleProposal["call"] => ({ method: "add_schedule", args: { schedule: a }, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
  updateSchedule: (id: number, a: ScheduleArgs): UpdateScheduleProposal["call"] => ({ method: "update_schedule", args: { schedule_id: id, schedule: a }, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
  pauseSchedule: (id: number): PauseScheduleProposal["call"] => ({ method: "pause_schedule", args: { schedule_id: id }, deposit_yocto: "0", gas_tgas: OWNER_GAS_TGAS }),
  endSchedule: (id: number): EndScheduleProposal["call"] => ({ method: "end_schedule", args: { schedule_id: id }, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
  updateMandate: (agentId: string, mandate: Mandate): UpdateMandateProposal["call"] => ({ method: "update_mandate", args: { agent_id: agentId, mandate }, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
  pauseAgent: (id: string): PauseAgentProposal["call"] => ({ method: "pause_agent", args: { agent_id: id }, deposit_yocto: "0", gas_tgas: OWNER_GAS_TGAS }),
  resumeAgent: (id: string): ResumeAgentProposal["call"] => ({ method: "resume_agent", args: { agent_id: id }, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
  pauseVault: (): PauseVaultProposal["call"] => ({ method: "pause", args: {}, deposit_yocto: "0", gas_tgas: OWNER_GAS_TGAS }),
  resumeVault: (): ResumeVaultProposal["call"] => ({ method: "resume", args: {}, deposit_yocto: "1", gas_tgas: OWNER_GAS_TGAS }),
};

/** Strips control characters and caps the length. Everything that came from chain state is untrusted text. */
export function cleanText(s: string, max = 60): string {
  // eslint-disable-next-line no-control-regex
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function shortAddress(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// --- per-turn state ---------------------------------------------------------------------------------------------

interface PendingRecipient {
  proposalId: string;
  label: string;
  chain: string;
  address: string;
}

/** State shared by the tools of one assistant turn (a "what the batch will look like" overlay on chain state). */
export class TurnState {
  constructor(
    /** Target of `propose_trading_rules`, from the request (`trading_bot`): a bot id, "new", or absent (legacy clients). */
    readonly tradingBot?: string,
  ) {}
  readonly proposals: Proposal[] = [];
  /** Rejected `propose_trading_rules` attempts in this turn (bounds the fix-and-retry loop). */
  tradingFailures = 0;
  readonly pendingRecipients = new Map<number, PendingRecipient>();
  readonly mandateOverrides = new Map<string, { mandate: Mandate; proposalId: string }>();
  private counter = 0;
  nextId(): string {
    this.counter += 1;
    return `p${this.counter}`;
  }
}

export interface ProposalContext {
  reader: VaultReader;
  nowMs: number;
  /** Concatenated text of the USER messages of this conversation (to ground addresses). Never assistant/tool text. */
  userText: string;
  state: TurnState;
  /** 1Click USDC `assetId` for a chain (from `/v0/tokens`), or `null` when none exists. */
  usdcAsset: (chain: string) => Promise<string | null>;
}

/** `refusal`: the request is not a proposal at all (nothing is emitted; the text goes back to the model). */
export type BuildResult = { proposal: Proposal; refusal?: undefined } | { proposal?: undefined; refusal: string };

function finish(errors: string[], warnings: string[]): Validation {
  return { ok: errors.length === 0, errors, warnings };
}

async function agentWithOverride(ctx: ProposalContext, id: string): Promise<{ agent: Agent | null; mandate: Mandate | null; overrideBy?: string }> {
  const agent = await ctx.reader.agent(id);
  if (!agent) return { agent: null, mandate: null };
  const o = ctx.state.mandateOverrides.get(id);
  return o ? { agent, mandate: o.mandate, overrideBy: o.proposalId } : { agent, mandate: agent.mandate };
}

// --- AddRecipient -----------------------------------------------------------------------------------------------

export interface AddRecipientInput {
  label: string;
  chain: string;
  address: string;
}

export async function buildAddRecipient(ctx: ProposalContext, input: AddRecipientInput): Promise<BuildResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const label = cleanText(input.label, 64);
  const chain = normalizeChain(input.chain);
  if (!label) errors.push("Name is empty");
  if (isTronName(input.chain)) errors.push(TRON_REFUSAL);
  else if (!chain) errors.push(`Unsupported chain '${cleanText(input.chain, 20)}'. Supported: ${Object.keys(CHAINS).join(", ")}`);

  const check = chain ? checkAddress(chain, input.address) : { ok: false, normalized: input.address.trim() };
  if (chain && !check.ok) errors.push(check.error ?? "Invalid address");
  if (check.ok && "warning" in check && check.warning) warnings.push(check.warning);

  // Injection guard: an address that the owner never typed in this conversation must not become a card.
  const typed = ctx.userText.toLowerCase();
  if (!typed.includes(input.address.trim().toLowerCase())) {
    return {
      refusal:
        "Refused: this address does not appear in the owner's own messages. Only addresses the owner typed can be proposed. Ask the owner for the address.",
    };
  }

  let asset = "";
  if (chain && check.ok) {
    try {
      const a = await ctx.usdcAsset(chain);
      if (a) asset = a;
      else errors.push(`1Click lists no USDC token on ${CHAINS[chain]?.label ?? chain}`);
    } catch {
      errors.push("Could not load the token list from 1Click to find the USDC asset; try again shortly");
    }
  }
  let predicted: number | null = null;
  if (chain && check.ok) {
    const existing = (await ctx.reader.recipients()).find((r) => r.destination_chain === chain && sameAddress(chain, r.destination_address, check.normalized));
    if (existing) warnings.push(`Already in the address book as #${existing.id} (${cleanText(existing.label)}); you may not need a new recipient`);
    const info = await ctx.reader.contractInfo();
    const base = info.next_recipient_id ?? Math.max(-1, ...(await ctx.reader.recipients()).map((r) => r.id)) + 1;
    if (info.next_recipient_id === undefined) warnings.push("The vault does not report next_recipient_id; the predicted recipient id may be wrong");
    predicted = base + ctx.state.pendingRecipients.size;
  }

  const id = ctx.state.nextId();
  if (predicted !== null && chain && check.ok) ctx.state.pendingRecipients.set(predicted, { proposalId: id, label, chain, address: check.normalized });
  const chainLabel = chain ? (CHAINS[chain]?.label ?? chain) : cleanText(input.chain, 20);
  return {
    proposal: {
      id,
      type: "AddRecipient",
      title: "New recipient",
      summary: `${label} · ${chainLabel} ${shortAddress(check.normalized)}`,
      predicted_recipient_id: predicted,
      call: calls.addRecipient({
        recipient: {
          label,
          destination_chain: chain ?? input.chain.trim().toLowerCase(),
          destination_asset: asset,
          destination_address: check.normalized,
        },
      }),
      validation: finish(errors, warnings),
    },
  };
}

// --- schedules --------------------------------------------------------------------------------------------------

interface ScheduleDraft {
  recipientId: number;
  amount: bigint;
  frequency: Frequency;
  startAt: number;
  end: EndRule;
  agentId: string;
  paidCount: number;
}

interface ScheduleCheck {
  errors: string[];
  warnings: string[];
  nextDates: number[];
  agent: Agent | null;
  recipientLabel: string;
  recipientChain: string;
  recipientAddress: string;
  dependsOn: string[];
}

async function validateSchedule(ctx: ProposalContext, d: ScheduleDraft): Promise<ScheduleCheck> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const dependsOn: string[] = [];

  if (d.amount <= 0n) errors.push("Amount must be greater than 0");

  const fErr = frequencyError(d.frequency, d.end);
  if (fErr) errors.push(fErr);

  // Dates: next three unpaid occurrences from now (or from the start if it is in the future).
  let nextDates: number[] = [];
  if (!fErr) {
    const from = Math.max(ctx.nowMs, d.startAt);
    nextDates = occurrences(d.frequency, d.startAt, d.end, d.paidCount, from, from + 5 * 366 * 86_400_000, 3);
    if (nextDates.length === 0) {
      errors.push(d.frequency.type === "Once" ? "The date is in the past" : "The end rule leaves no payment in the future");
    }
    if (d.startAt < ctx.nowMs && d.frequency.type !== "Once" && d.paidCount === 0) {
      warnings.push("The start date is in the past; occurrences that already passed will be due immediately and need your approval");
    }
  }

  // Recipient (existing, or one that an AddRecipient card in this batch will create).
  let recipientLabel = "";
  let recipientChain = "";
  let recipientAddress = "";
  const existing = await ctx.reader.recipient(d.recipientId);
  const pending = ctx.state.pendingRecipients.get(d.recipientId);
  if (existing) {
    recipientLabel = cleanText(existing.label);
    recipientChain = existing.destination_chain;
    recipientAddress = existing.destination_address;
  } else if (pending) {
    recipientLabel = pending.label;
    recipientChain = pending.chain;
    recipientAddress = pending.address;
    dependsOn.push(pending.proposalId);
    warnings.push(`Recipient #${d.recipientId} is created by the "New recipient" card in this batch; sign that one first`);
  } else {
    errors.push(`Recipient #${d.recipientId} does not exist`);
  }

  // Agent and mandate compatibility (ADR-0004 §4).
  const { agent, mandate, overrideBy } = await agentWithOverride(ctx, d.agentId);
  if (!agent || !mandate) {
    errors.push(`Agent '${cleanText(d.agentId, 32)}' does not exist`);
  } else {
    if (overrideBy) dependsOn.push(overrideBy);
    const name = cleanText(agent.name);
    if (agent.status === "Revoked") errors.push(`${name} is revoked and cannot be assigned`);
    if (agent.status === "Paused") warnings.push(`${name} is paused; it will not pay until resumed`);
    if (recipientChain) {
      if (!mandate.allowed_chains.includes(recipientChain)) errors.push(`${name} cannot pay on ${recipientChain} (chain not in its mandate)`);
      if (mandate.recipients_mode === "Fixed" && !mandate.recipients.includes(d.recipientId)) {
        errors.push(`${name} can't pay this recipient (not in its mandate)`);
      }
      if (mandate.recipients_mode === "Allowlist" && !mandate.allowlist.some((x) => x.chain === recipientChain && sameAddress(recipientChain, x.address, recipientAddress))) {
        errors.push(`${name} can't pay this recipient (destination not in its allowlist)`);
      }
    }
    const perTx = BigInt(mandate.per_tx_limit);
    if (d.amount > perTx) errors.push(`Amount exceeds ${name}'s per-payment limit (${formatUsdcHuman(perTx)} USDC)`);
    if (d.amount > BigInt(mandate.daily_limit)) errors.push(`Amount exceeds ${name}'s daily limit (${formatUsdcHuman(BigInt(mandate.daily_limit))} USDC)`);
    if (d.amount > BigInt(mandate.approval_threshold) && d.amount <= perTx) {
      warnings.push(`Above ${name}'s approval threshold (${formatUsdcHuman(BigInt(mandate.approval_threshold))} USDC): each payment will wait for your approval`);
    }
    if (mandate.expires_at !== null && nextDates[0] !== undefined && Number(mandate.expires_at) < nextDates[0]) {
      warnings.push(`${name}'s mandate expires (${formatDate(Number(mandate.expires_at), true)}) before the first payment`);
    }
  }

  const policy = await ctx.reader.policy();
  const minPayment = BigInt(policy.min_payment);
  if (d.amount > 0n && d.amount < minPayment) errors.push(`Amount is below the vault's minimum payment (${formatUsdcHuman(minPayment)} USDC)`);
  if (d.amount > BigInt(policy.daily_limit)) errors.push(`Amount exceeds the vault's daily limit (${formatUsdcHuman(BigInt(policy.daily_limit))} USDC)`);

  return { errors, warnings, nextDates, agent, recipientLabel, recipientChain, recipientAddress, dependsOn };
}

function scheduleArgs(d: ScheduleDraft): ScheduleArgs {
  return {
    recipient_id: d.recipientId,
    amount: d.amount.toString(),
    frequency: frequencyToWire(d.frequency),
    start_at: String(d.startAt),
    end: endToWire(d.end),
    agent_id: d.agentId,
  };
}

function scheduleSummary(d: ScheduleDraft, c: ScheduleCheck): string {
  const dates = c.nextDates.map((t) => formatDate(t)).join(", ");
  const dest = c.recipientChain ? ` → ${CHAINS[c.recipientChain]?.label ?? c.recipientChain} ${shortAddress(c.recipientAddress)}` : "";
  return [
    `${c.recipientLabel || `Recipient #${d.recipientId}`} · ${formatUsdcHuman(d.amount)} USDC${dest}`,
    `${describeFrequency(d.frequency, d.startAt)} · from ${formatDate(d.startAt, true)} · ${describeEnd(d.end)}`,
    `Paid by ${c.agent ? cleanText(c.agent.name) : cleanText(d.agentId, 32)}${dates ? ` · next: ${dates}` : ""}`,
  ].join("\n");
}

export interface AddScheduleInput {
  recipientId: number;
  amount: bigint;
  frequency: Frequency;
  startAt: number;
  end: EndRule;
  agentId: string;
}

export async function buildAddSchedule(ctx: ProposalContext, input: AddScheduleInput): Promise<BuildResult> {
  const d: ScheduleDraft = { ...input, paidCount: 0 };
  const c = await validateSchedule(ctx, d);
  const proposal: AddScheduleProposal = {
    id: ctx.state.nextId(),
    type: "AddSchedule",
    title: "New scheduled payment",
    summary: scheduleSummary(d, c),
    next_dates: c.nextDates,
    call: calls.addSchedule(scheduleArgs(d)),
    validation: finish(c.errors, c.warnings),
    ...(c.dependsOn.length ? { depends_on: [...new Set(c.dependsOn)] } : {}),
  };
  return { proposal };
}

export interface UpdateScheduleInput {
  scheduleId: number;
  amount?: bigint;
  frequency?: Frequency;
  startAt?: number;
  end?: EndRule;
  agentId?: string;
}

export async function buildUpdateSchedule(ctx: ProposalContext, input: UpdateScheduleInput): Promise<BuildResult> {
  const cur = await ctx.reader.schedule(input.scheduleId);
  if (!cur) return { refusal: `Schedule #${input.scheduleId} does not exist` };
  const d: ScheduleDraft = {
    recipientId: cur.recipient_id,
    amount: input.amount ?? cur.amount,
    frequency: input.frequency ?? cur.frequency,
    startAt: input.startAt ?? cur.start_at,
    end: input.end ?? cur.end,
    agentId: input.agentId ?? cur.agent_id,
    paidCount: cur.paid_count,
  };
  const c = await validateSchedule(ctx, d);
  const errors = [...c.errors];
  if (cur.status === "Ended") errors.push("This schedule has ended and cannot be edited");
  if (cur.open_payout !== null) errors.push("This schedule has a payout in progress or waiting for approval; try again after it settles");

  const diff: DiffRow[] = [];
  const row = (field: string, label: string, from: string, to: string): void => {
    if (from !== to) diff.push({ field, label, from, to });
  };
  row("amount", "Amount", `${formatUsdcHuman(cur.amount)} USDC`, `${formatUsdcHuman(d.amount)} USDC`);
  row("frequency", "Frequency", describeFrequency(cur.frequency, cur.start_at), describeFrequency(d.frequency, d.startAt));
  row("start_at", "Starts", formatDate(cur.start_at, true), formatDate(d.startAt, true));
  row("end", "Ends", describeEnd(cur.end), describeEnd(d.end));
  row("agent_id", "Paid by", cur.agent_id, d.agentId);
  if (diff.length === 0) errors.push("Nothing changes: the requested values equal the current ones");

  const proposal: UpdateScheduleProposal = {
    id: ctx.state.nextId(),
    type: "UpdateSchedule",
    title: `Edit scheduled payment #${cur.id}`,
    summary: scheduleSummary(d, c),
    diff,
    next_dates: c.nextDates,
    call: calls.updateSchedule(cur.id, scheduleArgs(d)),
    validation: finish(errors, c.warnings),
    ...(c.dependsOn.length ? { depends_on: [...new Set(c.dependsOn)] } : {}),
  };
  return { proposal };
}

async function scheduleLabel(ctx: ProposalContext, recipientId: number): Promise<string> {
  const r = await ctx.reader.recipient(recipientId);
  return r ? cleanText(r.label) : `recipient #${recipientId}`;
}

export async function buildPauseSchedule(ctx: ProposalContext, scheduleId: number): Promise<BuildResult> {
  const s = await ctx.reader.schedule(scheduleId);
  if (!s) return { refusal: `Schedule #${scheduleId} does not exist` };
  const errors: string[] = [];
  if (s.status === "Paused") errors.push("This schedule is already paused");
  if (s.status === "Ended") errors.push("This schedule has already ended");
  return {
    proposal: {
      id: ctx.state.nextId(),
      type: "PauseSchedule",
      title: `Pause scheduled payment #${s.id}`,
      summary: `${await scheduleLabel(ctx, s.recipient_id)} · ${formatUsdcHuman(s.amount)} USDC · ${describeFrequency(s.frequency, s.start_at)}\nNo payments until you resume it.`,
      call: calls.pauseSchedule(s.id),
      validation: finish(errors, []),
    },
  };
}

export async function buildEndSchedule(ctx: ProposalContext, scheduleId: number): Promise<BuildResult> {
  const s = await ctx.reader.schedule(scheduleId);
  if (!s) return { refusal: `Schedule #${scheduleId} does not exist` };
  const errors: string[] = [];
  const warnings: string[] = [];
  if (s.status === "Ended") errors.push("This schedule has already ended");
  warnings.push("Ending is permanent: an ended schedule cannot be resumed");
  return {
    proposal: {
      id: ctx.state.nextId(),
      type: "EndSchedule",
      title: `End scheduled payment #${s.id}`,
      summary: `${await scheduleLabel(ctx, s.recipient_id)} · ${formatUsdcHuman(s.amount)} USDC · ${describeFrequency(s.frequency, s.start_at)}\nPaid ${s.paid_count} time${s.paid_count === 1 ? "" : "s"} so far.`,
      call: calls.endSchedule(s.id),
      validation: finish(errors, warnings),
    },
  };
}

// --- mandate ----------------------------------------------------------------------------------------------------

export interface UpdateMandateInput {
  agentId: string;
  dailyLimit?: bigint;
  perTxLimit?: bigint;
  approvalThreshold?: bigint;
  allowedChains?: string[];
  maxPaymentsPerDay?: number;
  /** `null` removes the expiry. */
  expiresAt?: number | null;
  addRecipientIds?: number[];
  removeRecipientIds?: number[];
}

export async function buildUpdateMandate(ctx: ProposalContext, input: UpdateMandateInput): Promise<BuildResult> {
  const { agent, mandate: cur } = await agentWithOverride(ctx, input.agentId);
  if (!agent || !cur) return { refusal: `Agent '${cleanText(input.agentId, 32)}' does not exist` };
  const name = cleanText(agent.name);
  const errors: string[] = [];
  const warnings: string[] = [];
  const dependsOn: string[] = [];
  const prevOverride = ctx.state.mandateOverrides.get(input.agentId);
  if (prevOverride) dependsOn.push(prevOverride.proposalId);
  if (agent.status === "Revoked") errors.push(`${name} is revoked; its mandate cannot be changed`);

  const next: Mandate = { ...cur, allowed_chains: [...cur.allowed_chains], recipients: [...cur.recipients] };
  const diff: DiffRow[] = [];
  const usdc = (u: bigint): string => `${formatUsdcHuman(u)} USDC`;
  const money = (field: "daily_limit" | "per_tx_limit" | "approval_threshold", label: string, to: bigint | undefined): void => {
    if (to === undefined) return;
    const from = BigInt(cur[field]);
    if (from === to) return;
    next[field] = to.toString();
    diff.push({ field, label, from: usdc(from), to: usdc(to) });
    if (to > from) warnings.push(`${label} goes up: ${name} will be able to spend more`);
  };
  money("daily_limit", "Daily limit", input.dailyLimit);
  money("per_tx_limit", "Per-payment limit", input.perTxLimit);
  money("approval_threshold", "Approval threshold", input.approvalThreshold);

  if (input.maxPaymentsPerDay !== undefined && input.maxPaymentsPerDay !== cur.max_payments_per_day) {
    if (!Number.isInteger(input.maxPaymentsPerDay) || input.maxPaymentsPerDay < 0) errors.push("Max payments per day must be a non-negative whole number");
    next.max_payments_per_day = input.maxPaymentsPerDay;
    diff.push({ field: "max_payments_per_day", label: "Max payments per day", from: String(cur.max_payments_per_day), to: String(input.maxPaymentsPerDay) });
    if (input.maxPaymentsPerDay > cur.max_payments_per_day) warnings.push(`Max payments per day goes up: ${name} will be able to make more payments`);
  }

  if (input.allowedChains) {
    const chains = [...new Set(input.allowedChains.map((c) => normalizeChain(c) ?? c.trim().toLowerCase()))].filter(Boolean);
    for (const c of chains) if (!(c in CHAINS)) warnings.push(`Chain '${cleanText(c, 20)}' is not one the assistant knows; check the spelling`);
    if (chains.length === 0) errors.push("At least one chain must stay allowed");
    if (chains.join(",") !== cur.allowed_chains.join(",")) {
      next.allowed_chains = chains;
      diff.push({ field: "allowed_chains", label: "Allowed chains", from: cur.allowed_chains.join(", ") || "none", to: chains.join(", ") });
      if (chains.some((c) => !cur.allowed_chains.includes(c))) warnings.push(`Allowed chains grow: ${name} will be able to pay on more chains`);
    }
  }

  if (input.expiresAt !== undefined) {
    const from = cur.expires_at === null ? null : Number(cur.expires_at);
    if (from !== input.expiresAt) {
      next.expires_at = input.expiresAt === null ? null : String(input.expiresAt);
      diff.push({ field: "expires_at", label: "Expires", from: from === null ? "never" : formatDate(from, true), to: input.expiresAt === null ? "never" : formatDate(input.expiresAt, true) });
      if (input.expiresAt === null) warnings.push(`${name}'s mandate will no longer expire`);
      else if (input.expiresAt < ctx.nowMs) errors.push("The expiry date is in the past");
    }
  }

  const add = input.addRecipientIds ?? [];
  const remove = input.removeRecipientIds ?? [];
  if ((add.length > 0 || remove.length > 0) && cur.recipients_mode !== "Fixed") {
    errors.push(`${name} is in ${cur.recipients_mode} mode; the recipients list only applies to Fixed mode`);
  } else {
    for (const id of add) {
      const exists = (await ctx.reader.recipient(id)) !== null;
      const pend = ctx.state.pendingRecipients.get(id);
      if (!exists && !pend) errors.push(`Recipient #${id} does not exist`);
      if (pend) dependsOn.push(pend.proposalId);
      if (!next.recipients.includes(id)) next.recipients.push(id);
    }
    next.recipients = next.recipients.filter((id) => !remove.includes(id));
    if (next.recipients.join(",") !== cur.recipients.join(",")) {
      diff.push({ field: "recipients", label: "Recipients", from: cur.recipients.map((i) => `#${i}`).join(", ") || "none", to: next.recipients.map((i) => `#${i}`).join(", ") || "none" });
    }
  }

  if (diff.length === 0) errors.push("Nothing changes: the requested values equal the current ones");
  if (BigInt(next.per_tx_limit) > BigInt(next.daily_limit)) errors.push("Per-payment limit cannot exceed the daily limit");
  if (BigInt(next.approval_threshold) > BigInt(next.per_tx_limit)) {
    warnings.push("Approval threshold is above the per-payment limit, so no payment will ever wait for approval");
  }

  // What would stop working for this agent's existing schedules?
  if (errors.length === 0) {
    const mine = (await ctx.reader.schedules({ agent_id: agent.id })).filter((s) => s.status === "Active");
    const tooBig = mine.filter((s) => s.amount > BigInt(next.per_tx_limit)).length;
    if (tooBig > 0) warnings.push(`${tooBig} active scheduled payment(s) exceed the new per-payment limit and will be rejected`);
    const overThreshold = mine.filter((s) => s.amount > BigInt(next.approval_threshold) && s.amount <= BigInt(next.per_tx_limit)).length;
    if (overThreshold > 0 && BigInt(next.approval_threshold) < BigInt(cur.approval_threshold)) {
      warnings.push(`${overThreshold} active scheduled payment(s) will now wait for your approval`);
    }
    if (cur.recipients_mode === "Fixed") {
      const orphaned = mine.filter((s) => !next.recipients.includes(s.recipient_id)).length;
      if (orphaned > 0) warnings.push(`${orphaned} active scheduled payment(s) use recipients no longer in the mandate`);
    }
  }

  const id = ctx.state.nextId();
  if (errors.length === 0) ctx.state.mandateOverrides.set(agent.id, { mandate: next, proposalId: id });
  return {
    proposal: {
      id,
      type: "UpdateMandate",
      title: `Change ${name}'s mandate`,
      summary: diff.map((r) => `${r.label}: ${r.from} → ${r.to}`).join("\n") || "No changes",
      diff,
      call: calls.updateMandate(agent.id, next),
      validation: finish(errors, warnings),
      ...(dependsOn.length ? { depends_on: [...new Set(dependsOn)] } : {}),
    },
  };
}

// --- pause / resume ---------------------------------------------------------------------------------------------

export async function buildPauseAgent(ctx: ProposalContext, agentId: string): Promise<BuildResult> {
  const agent = await ctx.reader.agent(agentId);
  if (!agent) return { refusal: `Agent '${cleanText(agentId, 32)}' does not exist` };
  const errors: string[] = [];
  if (agent.status === "Paused") errors.push(`${cleanText(agent.name)} is already paused`);
  if (agent.status === "Revoked") errors.push(`${cleanText(agent.name)} is revoked`);
  return {
    proposal: {
      id: ctx.state.nextId(),
      type: "PauseAgent",
      title: `Pause ${cleanText(agent.name)}`,
      summary: `${cleanText(agent.name)} will stop requesting payments immediately. You can resume it at any time.`,
      urgent: true,
      call: calls.pauseAgent(agent.id),
      validation: finish(errors, []),
    },
  };
}

export async function buildResumeAgent(ctx: ProposalContext, agentId: string): Promise<BuildResult> {
  const agent = await ctx.reader.agent(agentId);
  if (!agent) return { refusal: `Agent '${cleanText(agentId, 32)}' does not exist` };
  const errors: string[] = [];
  if (agent.status === "Active") errors.push(`${cleanText(agent.name)} is already active`);
  if (agent.status === "Revoked") errors.push(`${cleanText(agent.name)} is revoked and cannot be resumed`);
  return {
    proposal: {
      id: ctx.state.nextId(),
      type: "ResumeAgent",
      title: `Resume ${cleanText(agent.name)}`,
      summary: `${cleanText(agent.name)} will be able to pay again within its mandate.`,
      call: calls.resumeAgent(agent.id),
      validation: finish(errors, []),
    },
  };
}

export async function buildPauseVault(ctx: ProposalContext): Promise<BuildResult> {
  const policy = await ctx.reader.policy();
  return {
    proposal: {
      id: ctx.state.nextId(),
      type: "PauseVault",
      title: "Pause the vault",
      summary: "All agents stop paying immediately. Your own withdrawals still work.",
      urgent: true,
      call: calls.pauseVault(),
      validation: finish(policy.paused ? ["The vault is already paused"] : [], []),
    },
  };
}

export async function buildResumeVault(ctx: ProposalContext): Promise<BuildResult> {
  const policy = await ctx.reader.policy();
  return {
    proposal: {
      id: ctx.state.nextId(),
      type: "ResumeVault",
      title: "Resume the vault",
      summary: "Agents can pay again within their mandates.",
      call: calls.resumeVault(),
      validation: finish(policy.paused ? [] : ["The vault is not paused"], []),
    },
  };
}
