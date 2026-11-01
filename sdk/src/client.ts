import { normalizeChain, resolveUsdc, validateAddress } from "./chains.js";
import { SdkError, errMsg } from "./errors.js";
import { previewMandate } from "./mandate.js";
import { OneClickClient, OneClickError, isTerminal } from "./oneclick.js";
import type { QuoteRequest, QuoteResponse, StatusResponse } from "./oneclick.js";
import { SimulatedOneClick } from "./oneclick-simulated.js";
import { assertTestnetRpc } from "./chain-check.js";
import { checkRealQuote } from "./quote-check.js";
import { USDC_DECIMALS, formatUsdc, parseU128, parseUsdc, rescale } from "./units.js";
import { NearVaultPort } from "./vault.js";
import type { BudgetView, PayoutStatus, ReportedStatus, VaultPayout, VaultPort } from "./vault.js";

export type OneClickPort = Pick<OneClickClient, "getTokens" | "findToken" | "quote" | "submitDeposit" | "getStatus">;

export interface TreasuryClientConfig {
  vaultId: string;
  network: "mainnet" | "testnet";
  agentAccountId: string;
  /** The function-call key (ed25519:...). Without it the client is read-only. */
  agentPrivateKey?: string | undefined;
  /** Skips the `get_agent_by_account` lookup. */
  agentId?: string | undefined;
  rpcUrl?: string | undefined;
  oneclick: {
    baseUrl: string;
    /** Sent as `X-API-Key`. */
    apiKey?: string | undefined;
    /** Partner JWT, sent as `Authorization: Bearer`. */
    jwt?: string | undefined;
    mode: "live" | "simulated";
    /** Simulated mode only. */
    simulatedOutcome?: "success" | "refunded";
    timeoutMs?: number;
  };
  /** 1Click slippage in basis points. Default 100 (1%). */
  slippageBps?: number;
  /** Stop watching a payment after this long (default 3 h). */
  watchTimeoutMs?: number;
  /** Test/advanced seams. */
  deps?: {
    vault?: VaultPort;
    oneclick?: OneClickPort;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: (m: string) => void;
    /** Replaces the RPC `status` call used to verify the chain in simulated mode (tests). */
    fetchFn?: typeof fetch;
  };
}

export interface Destination {
  chain: string;
  address: string;
  label?: string;
}

export interface Budget {
  agentId: string;
  status: BudgetView["status"];
  remainingTodayUsdc: string;
  vaultRemainingTodayUsdc: string;
  perTxLimitUsdc: string;
  approvalThresholdUsdc: string;
  allowedChains: string[];
  recipientsMode: BudgetView["recipients_mode"];
  allowlist: Destination[];
  /** ISO timestamp, absent when the mandate does not expire. */
  expiresAt?: string;
  vaultPaused: boolean;
  vaultBalanceUsdc: string;
  minPaymentUsdc: string;
  paymentsLeftToday: number;
}

export interface PaymentRequest {
  chain: string;
  address: string;
  /** Decimal USDC string, e.g. "12.5". */
  amountUsdc: string;
  /** Untrusted free text, max 140 bytes. Stored and displayed, never interpreted. */
  memo?: string;
}

export interface PaymentQuote {
  ok: boolean;
  wouldRejectReason?: string;
  wouldRejectDetail?: string;
  needsApproval: boolean;
  estimatedFeeUsdc?: string;
  estimatedReceiveUsdc?: string;
  estimatedArrivalS?: number;
  /** Set when the 1Click dry quote failed (unsupported chain/asset, bad address, API error). */
  quoteError?: string;
}

export type PaymentOutcome =
  | { status: "rejected"; reason: string; detail: string }
  | { status: "pending_approval"; payoutId: string; depositExpiresAt: string; reason?: string }
  | { status: "submitted"; payoutId: string; nearTx?: string }
  /** `ft_transfer` failed and the reservation was released; nothing was spent. */
  | { status: "transfer_failed"; payoutId: string };

export interface PaymentStatus {
  payoutId: string;
  status: PayoutStatus;
  chain: string;
  address: string;
  amountUsdc: string;
  memo?: string;
  /** "scheduled" when the payout comes from a schedule (payroll), else "on_demand". */
  source: "scheduled" | "on_demand";
  nearTx?: string;
  intentsStatus?: string;
  destinationTx?: string;
}

export type WatchOutcome =
  | { kind: "reported"; status: ReportedStatus; txHash?: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "error"; error: string };

export interface PaymentWatch {
  payoutId: string;
  done: Promise<WatchOutcome>;
  cancel(): void;
}

export interface TreasuryClient {
  getBudget(): Promise<Budget>;
  listAllowedRecipients(): Promise<Destination[]>;
  quotePayment(req: PaymentRequest): Promise<PaymentQuote>;
  requestPayment(req: PaymentRequest): Promise<PaymentOutcome>;
  getPaymentStatus(payoutId: string): Promise<PaymentStatus>;
  /** Polls 1Click in the background and calls `report_payout_status` on a terminal status. Idempotent per payout. */
  watchPayment(payoutId: string): PaymentWatch;
  /** Cancels all background watches. */
  stop(): void;
}

const MEMO_MAX_BYTES = 140;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MIN = 60_000;

function statusToReport(s: StatusResponse): { status: ReportedStatus; txHash: string | undefined } | undefined {
  const dest = s.swapDetails?.destinationChainTxHashes?.[0]?.hash;
  const origin = s.swapDetails?.originChainTxHashes?.[0]?.hash;
  switch (s.status) {
    case "SUCCESS":
      return { status: "Confirmed", txHash: dest };
    case "REFUNDED":
      return { status: "Refunded", txHash: origin };
    case "FAILED":
      return { status: "Failed", txHash: origin };
    default:
      return undefined;
  }
}

export function createTreasuryClient(cfg: TreasuryClientConfig): TreasuryClient {
  if (cfg.oneclick.mode === "simulated" && cfg.network !== "testnet") {
    throw new SdkError("CONFIG", 'oneclick.mode "simulated" is only allowed with network "testnet" (it fakes cross-chain delivery)');
  }
  const now = cfg.deps?.now ?? Date.now;
  const sleep = cfg.deps?.sleep ?? defaultSleep;
  const log = cfg.deps?.log ?? ((m: string) => {
    console.error(m);
  });
  const slippageBps = cfg.slippageBps ?? 100;
  const watchTimeoutMs = cfg.watchTimeoutMs ?? 180 * MIN;

  const vault: VaultPort =
    cfg.deps?.vault ??
    new NearVaultPort({
      vaultId: cfg.vaultId,
      network: cfg.network,
      agentAccountId: cfg.agentAccountId,
      agentPrivateKey: cfg.agentPrivateKey,
      rpcUrl: cfg.rpcUrl,
    });
  const canSign = cfg.deps?.vault !== undefined || Boolean(cfg.agentPrivateKey);
  const oneclickBase: OneClickPort =
    cfg.deps?.oneclick ??
    (cfg.oneclick.mode === "simulated"
      ? new SimulatedOneClick({ outcome: cfg.oneclick.simulatedOutcome ?? "success", log, now })
      : new OneClickClient({ baseUrl: cfg.oneclick.baseUrl, apiKey: cfg.oneclick.apiKey, jwt: cfg.oneclick.jwt, timeoutMs: cfg.oneclick.timeoutMs, now }));

  // Simulated mode: verify once (lazily, before the first 1Click use) that the RPC really is testnet.
  let chainVerified: Promise<void> | undefined;
  const verifyChain = (): Promise<void> => {
    chainVerified ??= assertTestnetRpc({ network: cfg.network, rpcUrl: cfg.rpcUrl, ...(cfg.deps?.fetchFn ? { fetchFn: cfg.deps.fetchFn } : {}) });
    return chainVerified;
  };
  const rawOneclick = oneclickBase;
  const guarded: OneClickPort =
    cfg.oneclick.mode === "simulated" && cfg.deps?.oneclick === undefined
      ? {
          getTokens: async () => (await verifyChain(), rawOneclick.getTokens()),
          findToken: async (a) => (await verifyChain(), rawOneclick.findToken(a)),
          quote: async (r) => (await verifyChain(), rawOneclick.quote(r)),
          submitDeposit: async (a) => (await verifyChain(), rawOneclick.submitDeposit(a)),
          getStatus: async (a) => (await verifyChain(), rawOneclick.getStatus(a)),
        }
      : rawOneclick;
  const oneclick = guarded;

  let agentIdCache = cfg.agentId;
  let infoCache: { treasuryToken: string } | undefined;
  const watches = new Map<string, { watch: PaymentWatch; cancelled: { v: boolean } }>();

  async function agentId(): Promise<string> {
    if (agentIdCache) return agentIdCache;
    const a = await vault.getAgentByAccount(cfg.agentAccountId);
    if (!a) throw new SdkError("NOT_FOUND", `account ${cfg.agentAccountId} is not an agent of vault ${cfg.vaultId}`);
    agentIdCache = a.id;
    return a.id;
  }

  async function treasuryAsset(): Promise<string> {
    infoCache ??= { treasuryToken: (await vault.getContractInfo()).treasury_token };
    return `nep141:${infoCache.treasuryToken}`;
  }

  async function budgetView(): Promise<BudgetView> {
    return vault.getAgentBudget(await agentId());
  }

  function parseRequest(req: PaymentRequest) {
    const chain = normalizeChain(req.chain);
    const address = validateAddress(chain, req.address);
    const amount = parseUsdc(req.amountUsdc);
    if (req.memo !== undefined && Buffer.byteLength(req.memo, "utf8") > MEMO_MAX_BYTES) {
      throw new SdkError("INVALID_INPUT", `memo is longer than ${MEMO_MAX_BYTES} bytes`);
    }
    return { chain, address, amount };
  }

  /** Resolves origin (vault's USDC on NEAR) and destination assets, both taken from /v0/tokens. */
  async function resolveAssets(chain: string) {
    const originAsset = await treasuryAsset();
    const origin = await oneclick.findToken(originAsset);
    if (!origin) throw new SdkError("UNSUPPORTED_ASSET", `the vault's token ${originAsset} is not listed by 1Click /v0/tokens`);
    if (origin.decimals !== USDC_DECIMALS) throw new SdkError("UNSUPPORTED_ASSET", `vault token has ${origin.decimals} decimals, expected ${USDC_DECIMALS}`);
    const dest = resolveUsdc(await oneclick.getTokens(), chain, originAsset);
    return { originAsset, destAsset: dest.assetId, destDecimals: dest.decimals };
  }

  function quoteRequest(a: { originAsset: string; destAsset: string; amount: bigint; address: string; dry: boolean; deadlineMs: number }): QuoteRequest {
    return {
      dry: a.dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: slippageBps,
      originAsset: a.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: a.destAsset,
      amount: a.amount.toString(),
      refundTo: cfg.vaultId,
      refundType: "ORIGIN_CHAIN",
      recipient: a.address,
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(a.deadlineMs).toISOString(),
    };
  }

  async function getBudget(): Promise<Budget> {
    const b = await budgetView();
    return {
      agentId: b.agent_id,
      status: b.status,
      remainingTodayUsdc: formatUsdc(parseU128(b.remaining_today)),
      vaultRemainingTodayUsdc: formatUsdc(parseU128(b.vault_remaining_today)),
      perTxLimitUsdc: formatUsdc(parseU128(b.per_tx_limit)),
      approvalThresholdUsdc: formatUsdc(parseU128(b.approval_threshold)),
      allowedChains: b.allowed_chains,
      recipientsMode: b.recipients_mode,
      allowlist: b.allowlist.map(toDestination),
      ...(b.expires_at !== null ? { expiresAt: new Date(Number(b.expires_at)).toISOString() } : {}),
      vaultPaused: b.vault_paused,
      vaultBalanceUsdc: formatUsdc(parseU128(b.balance)),
      minPaymentUsdc: formatUsdc(parseU128(b.min_payment)),
      paymentsLeftToday: Math.max(0, b.max_payments_per_day - b.payments_today),
    };
  }

  async function listAllowedRecipients(): Promise<Destination[]> {
    const b = await budgetView();
    return b.recipients_mode === "Allowlist" ? b.allowlist.map(toDestination) : [];
  }

  async function quotePayment(req: PaymentRequest): Promise<PaymentQuote> {
    const { chain, address, amount } = parseRequest(req);
    const budget = await budgetView();
    const preview = previewMandate(budget, { chain, address, amount, nowMs: now() });
    if (preview.wouldReject) {
      return { ok: false, wouldRejectReason: preview.wouldReject.reason, wouldRejectDetail: preview.wouldReject.detail, needsApproval: false };
    }
    try {
      const { originAsset, destAsset, destDecimals } = await resolveAssets(chain);
      const resp = await oneclick.quote(quoteRequest({ originAsset, destAsset, amount, address, dry: true, deadlineMs: now() + 30 * MIN }));
      const out = rescale(BigInt(resp.quote.amountOut), destDecimals, USDC_DECIMALS);
      const fee = amount > out ? amount - out : 0n;
      return {
        ok: true,
        needsApproval: preview.needsApproval,
        estimatedFeeUsdc: formatUsdc(fee),
        estimatedReceiveUsdc: formatUsdc(out),
        ...(resp.quote.timeEstimate !== undefined ? { estimatedArrivalS: resp.quote.timeEstimate } : {}),
      };
    } catch (e) {
      if (e instanceof SdkError || e instanceof OneClickError) return { ok: false, needsApproval: preview.needsApproval, quoteError: errMsg(e) };
      throw e;
    }
  }

  async function requestPayment(req: PaymentRequest): Promise<PaymentOutcome> {
    const { chain, address, amount } = parseRequest(req);
    if (!canSign) throw new SdkError("NO_SIGNING_KEY", "no agentPrivateKey configured: this client is read-only");

    const budget = await budgetView();
    // The preview is NOT used to short-circuit: the contract is authoritative and logs rejections for the owner.
    // It only decides how long the deposit address must stay valid.
    const needsApproval = amount > parseU128(budget.approval_threshold);
    const { originAsset, destAsset } = await resolveAssets(chain);
    const startedAt = now();
    const deadlineMs = startedAt + (needsApproval ? 24 * 60 * MIN : 30 * MIN);

    let resp: QuoteResponse;
    try {
      resp = await oneclick.quote(quoteRequest({ originAsset, destAsset, amount, address, dry: false, deadlineMs }));
    } catch (e) {
      throw new SdkError("ONECLICK_ERROR", `1Click quote failed: ${errMsg(e)}`);
    }
    const problems = checkRealQuote(resp, {
      originAsset,
      destinationAsset: destAsset,
      recipient: address,
      amount: amount.toString(),
      refundTo: cfg.vaultId,
      nowMs: now(),
    });
    const depositAddress = resp.quote.depositAddress;
    if (problems.length > 0 || depositAddress === undefined) {
      throw new SdkError("QUOTE_CHECK_FAILED", `1Click quote rejected before signing: ${problems.join("; ")}`);
    }
    // Always sent: the contract requires it above the approval threshold (INVALID_REQUEST otherwise).
    const depositExpiresAtMs = Date.parse(resp.quote.deadline ?? "");
    if (Number.isNaN(depositExpiresAtMs)) throw new SdkError("QUOTE_CHECK_FAILED", "quote.deadline is not a valid timestamp");

    const { result, txHash } = await vault.requestPayment({
      chain,
      address,
      amount: amount.toString(),
      memo: req.memo,
      depositAddress,
      depositExpiresAtMs,
    });

    if ("Rejected" in result) return { status: "rejected", reason: result.Rejected.reason, detail: result.Rejected.detail };
    if ("PendingApproval" in result) {
      return { status: "pending_approval", payoutId: result.PendingApproval.payout_id, depositExpiresAt: new Date(depositExpiresAtMs).toISOString(), ...(result.PendingApproval.reason !== undefined ? { reason: result.PendingApproval.reason } : {}) };
    }
    if ("TransferFailed" in result) return { status: "transfer_failed", payoutId: result.TransferFailed.payout_id };

    const payoutId = result.Submitted.payout_id;
    if (txHash !== undefined) {
      try {
        await oneclick.submitDeposit({ txHash, depositAddress, nearSenderAccount: cfg.vaultId });
      } catch (e) {
        log(`deposit/submit failed (non-fatal): ${errMsg(e)}`);
      }
    }
    watchPayment(payoutId, depositAddress);
    return { status: "submitted", payoutId, ...(txHash !== undefined ? { nearTx: txHash } : {}) };
  }

  async function ownPayout(payoutId: string): Promise<VaultPayout> {
    if (!/^\d+$/.test(payoutId)) throw new SdkError("INVALID_INPUT", "payoutId must be a numeric string");
    const p = await vault.getPayout(payoutId);
    // Other agents' payments are invisible to this agent.
    if (!p || p.agent_id !== (await agentId())) throw new SdkError("NOT_FOUND", `payout ${payoutId} not found for this agent`);
    return p;
  }

  async function getPaymentStatus(payoutId: string): Promise<PaymentStatus> {
    const p = await ownPayout(payoutId);
    const out: PaymentStatus = {
      payoutId: p.id,
      status: p.status,
      chain: p.chain,
      address: p.address,
      amountUsdc: formatUsdc(parseU128(p.amount)),
      source: p.schedule_id !== null && p.schedule_id !== undefined ? "scheduled" : "on_demand",
      ...(p.memo !== null ? { memo: p.memo } : {}),
      ...(p.tx_hash !== null ? { nearTx: p.tx_hash } : {}),
    };
    // An approved payment executes after the original request returned; make sure somebody reports its final status.
    if (p.status === "Sent" && canSign) watchPayment(p.id, p.deposit_address ?? undefined);
    if (p.deposit_address !== null && p.status !== "PendingApproval" && p.status !== "Rejected") {
      try {
        const s = await oneclick.getStatus(p.deposit_address);
        out.intentsStatus = s.status;
        const dest = s.swapDetails?.destinationChainTxHashes?.[0]?.hash;
        if (dest !== undefined) out.destinationTx = dest;
      } catch {
        // best effort: 1Click may not know the deposit yet
      }
    }
    return out;
  }

  function watchPayment(payoutId: string, knownDepositAddress?: string): PaymentWatch {
    const existing = watches.get(payoutId);
    if (existing) return existing.watch;
    const cancelled = { v: false };
    const done = runWatch(payoutId, knownDepositAddress, cancelled).finally(() => {
      watches.delete(payoutId);
    });
    const watch: PaymentWatch = {
      payoutId,
      done,
      cancel: () => {
        cancelled.v = true;
      },
    };
    watches.set(payoutId, { watch, cancelled });
    return watch;
  }

  async function runWatch(payoutId: string, known: string | undefined, cancelled: { v: boolean }): Promise<WatchOutcome> {
    try {
      const deadline = now() + watchTimeoutMs;
      let depositAddress = known;
      if (depositAddress === undefined) {
        depositAddress = (await ownPayout(payoutId)).deposit_address ?? undefined;
        if (depositAddress === undefined) return { kind: "error", error: `payout ${payoutId} has no deposit address` };
      }
      let delay = 5_000;
      while (!cancelled.v && now() < deadline) {
        let term: ReturnType<typeof statusToReport>;
        try {
          const s = await oneclick.getStatus(depositAddress);
          term = isTerminal(s.status) ? statusToReport(s) : undefined;
        } catch (e) {
          // 404 right after the deposit and transient errors are normal: keep polling.
          log(`status poll for payout ${payoutId}: ${errMsg(e)}`);
        }
        if (term) return await report(payoutId, term);
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), 60_000);
      }
      return cancelled.v ? { kind: "cancelled" } : { kind: "timeout" };
    } catch (e) {
      return { kind: "error", error: errMsg(e) };
    }
  }

  async function report(payoutId: string, term: { status: ReportedStatus; txHash: string | undefined }): Promise<WatchOutcome> {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await vault.reportPayoutStatus({ payoutId, status: term.status, txHash: term.txHash });
        return { kind: "reported", status: term.status, ...(term.txHash !== undefined ? { txHash: term.txHash } : {}) };
      } catch (e) {
        last = errMsg(e);
        log(`report_payout_status for ${payoutId} failed (attempt ${attempt + 1}): ${last}`);
        await sleep(2_000 * (attempt + 1));
      }
    }
    return { kind: "error", error: `report_payout_status failed: ${last}` };
  }

  return {
    getBudget,
    listAllowedRecipients,
    quotePayment,
    requestPayment,
    getPaymentStatus,
    watchPayment: (payoutId) => watchPayment(payoutId),
    stop: () => {
      for (const w of watches.values()) w.cancelled.v = true;
    },
  };
}

function toDestination(d: { chain: string; address: string; label?: string | null | undefined }): Destination {
  return { chain: d.chain, address: d.address, ...(d.label ? { label: d.label } : {}) };
}
