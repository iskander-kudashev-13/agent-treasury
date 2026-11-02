/** Wires the trading module from the worker config (ADR-0005). Called by `index.ts` only when TRADING_ENABLED=true. */
import { createTreasuryClient } from "agent-treasury-sdk";
import { z } from "zod";
import { hardLimitsOf } from "../config.js";
import type { Config } from "../config.js";
import type { AiDeps } from "../ai/route.js";
import { VaultReader } from "../ai/views.js";
import type { TradingAuthoring } from "../ai/trading.js";
import { RulesConfirmer } from "./confirm.js";
import type { ConfirmCtx } from "./confirm.js";
import { Funder } from "./funding.js";
import type { FundingClient } from "./funding.js";
import { acquireStateDirLock } from "./lock.js";
import { createNktkasHl } from "./hl/nktkas.js";
import { createPairInfoProvider } from "./pairs.js";
import { createProposer } from "./propose.js";
import { createTradingRouter } from "./route.js";
import type { TradingRouteDeps } from "./route.js";
import { TradingService, vaultViewFromBudget } from "./service.js";
import { RulesStore } from "./store.js";
import { ApiWalletManager } from "./wallet.js";
import type { ApiWallet } from "./wallet.js";

export interface TradingModule {
  service: TradingService;
  /** Hard limits + pair data for the assistant tool; assign to `AiDeps.trading` before the app is created. */
  authoring: TradingAuthoring;
  routeDeps: TradingRouteDeps;
  /** Exclusive lock on TRADING_STATE_DIR; released on process exit. */
  release: () => void;
}

export function createTradingModule(config: Config, ai: AiDeps): TradingModule {
  const hard = hardLimitsOf(config);
  const master = config.HL_MASTER_ADDRESS;
  if (!master) throw new Error("HL_MASTER_ADDRESS is required"); // config validation already guarantees it
  const hlNetwork = config.HL_NETWORK;

  // One worker per state dir (audit M5). Throws TradingLockedError, so trading never starts twice.
  const lock = acquireStateDirLock(config.TRADING_STATE_DIR);
  process.once("exit", () => { lock.release(); });
  // Release on SIGINT/SIGTERM too (docker stop); otherwise the lock outlives the process.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      lock.release();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }

  const wallet = new ApiWalletManager({ stateDir: config.TRADING_STATE_DIR, envKey: config.HL_API_WALLET_PRIVATE_KEY });
  // `service` is created below; the adapter only calls this when an order is signed, long after the constructor returned.
  const serviceRef: { current?: { deadManAvailable(): boolean } } = {};
  const createHl = (w: ApiWallet) => createNktkasHl({ network: hlNetwork, wallet: w.signer(), deadManAvailable: () => serviceRef.current?.deadManAvailable() ?? false });
  const hl = createHl(wallet.load());

  const reader = new VaultReader(ai.view);
  const confirmCtx: ConfirmCtx = {
    vault: config.VAULT_CONTRACT_ID,
    agentId: config.TRADER_AGENT_ID,
    hlNetwork,
    hlAccount: master.toLowerCase(),
    hard,
    accessKey: ai.accessKey,
    // Deliberately uncached: the engine re-verifies the owner on every tick.
    vaultOwner: async () => (await reader.contractInfo()).owner_id,
  };
  const store = new RulesStore(config.TRADING_STATE_DIR);

  // Key agent `hl-trader`: its own function-call key, restricted on-chain to request_payment / report_payout_status.
  const traderKey = config.TRADER_NEAR_PRIVATE_KEY;
  const traderAccount = config.TRADER_NEAR_ACCOUNT_ID;
  const client =
    traderAccount && traderKey
      ? createTreasuryClient({
          vaultId: config.VAULT_CONTRACT_ID,
          network: config.NEAR_NETWORK,
          agentAccountId: traderAccount,
          agentPrivateKey: traderKey,
          agentId: config.TRADER_AGENT_ID,
          ...(config.NEAR_RPC_URL ? { rpcUrl: config.NEAR_RPC_URL } : {}),
          oneclick: {
            baseUrl: config.ONECLICK_BASE_URL,
            apiKey: config.ONECLICK_API_KEY,
            mode: config.ONECLICK_MODE,
            simulatedOutcome: config.SIMULATED_OUTCOME,
            timeoutMs: config.HTTP_TIMEOUT_MS,
          },
        })
      : null;
  const recentPayoutSchema = z.array(
    z.looseObject({ id: z.string(), chain: z.string(), address: z.string(), status: z.string(), created_at_ms: z.string().regex(/^\d+$/) }),
  );
  // The SDK client plus one raw vault view: the trader's own newest payouts (to reconcile a top-up of unknown outcome).
  const fundingClient: FundingClient | null = client && {
    getBudget: () => client.getBudget(),
    requestPayment: (r) => client.requestPayment(r),
    getPaymentStatus: (id) => client.getPaymentStatus(id),
    listRecentPayouts: async () => {
      const count = z.number().int().nonnegative().parse(await ai.view("get_agent_payouts_count", { agent_id: config.TRADER_AGENT_ID }));
      const limit = 25;
      const rows = recentPayoutSchema.parse(await ai.view("get_payouts", { from_index: Math.max(0, count - limit), limit, agent_id: config.TRADER_AGENT_ID }));
      return rows.map((r) => ({ id: r.id, chain: r.chain, address: r.address, status: r.status, createdAtMs: Number(r.created_at_ms) }));
    },
  };
  const funder =
    fundingClient && config.TRADING_TOPUP_ENABLED
      ? new Funder(fundingClient, {
          enabled: true,
          masterAddress: master,
          topupUsdc: config.TRADING_TOPUP_USDC,
          floorUsdc: config.TRADING_TOPUP_FLOOR_USDC,
          stateDir: config.TRADING_STATE_DIR,
        })
      : null;

  const service = new TradingService({
    settings: {
      vault: config.VAULT_CONTRACT_ID,
      agentId: config.TRADER_AGENT_ID,
      hlNetwork,
      account: master,
      hard,
      tickSec: config.TRADING_TICK_SEC,
      deadmanSec: config.TRADING_DEADMAN_SEC,
      stateDir: config.TRADING_STATE_DIR,
      startMs: config.TRADING_START_MS,
      maxBots: config.TRADING_MAX_BOTS,
    },
    hl,
    createHl,
    wallet,
    store,
    confirmCtx,
    readVault: async () => vaultViewFromBudget(await ai.view("get_agent_budget", { agent_id: config.TRADER_AGENT_ID }), config.TRADER_AGENT_ID),
    funder,
    watchPayment: client ? (id) => client.watchPayment(id) : undefined,
    paymentStatus: client ? (id) => client.getPaymentStatus(id) : undefined,
  });
  serviceRef.current = service;

  const pairs = createPairInfoProvider(() => service.hlPort());
  const authoring: TradingAuthoring = { hard, pairs, deadManAvailable: () => service.deadManAvailable(), bots: { registry: service.registry, maxBots: config.TRADING_MAX_BOTS } };
  const confirmer = new RulesConfirmer({ ctx: confirmCtx, store, registry: service.registry, maxBots: config.TRADING_MAX_BOTS, getPairInfo: () => pairs.getPairInfo(), deadManAvailable: () => service.deadManAvailable(), writeBlocked: () => service.writeBlockedReason() });
  const secret = config.AI_SESSION_SECRET;
  if (!secret) throw new Error("AI_SESSION_SECRET is required"); // config validation already guarantees it
  const routeDeps: TradingRouteDeps = {
    service,
    confirmer,
    store,
    confirmCtx,
    sessionSecret: secret,
    vault: config.VAULT_CONTRACT_ID,
    trustProxy: config.AI_TRUST_PROXY,
    proposeLimitPerMin: config.AI_RATE_LIMIT_PER_MIN,
    propose: createProposer(ai, authoring),
  };
  return { service, authoring, routeDeps, release: () => { lock.release(); } };
}

export { createTradingRouter };
