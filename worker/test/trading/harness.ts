/** Shared wiring for service / route tests: FakeHl + fake vault + fake SDK client + real store, confirmer and wallet. */
import { Hono } from "hono";
import { signToken } from "../../src/ai/session.js";
import { RulesConfirmer } from "../../src/trading/confirm.js";
import type { Challenge } from "../../src/trading/confirm.js";
import type { VaultView } from "../../src/trading/engine/tick.js";
import { Funder } from "../../src/trading/funding.js";
import type { FundingClient } from "../../src/trading/funding.js";
import { FakeHl } from "../../src/trading/hl/fake.js";
import { createPairInfoProvider } from "../../src/trading/pairs.js";
import { createTradingRouter } from "../../src/trading/route.js";
import type { TradingRouteDeps } from "../../src/trading/route.js";
import { TradingService } from "../../src/trading/service.js";
import { RulesStore } from "../../src/trading/store.js";
import type { RuleSetV1 } from "../../src/trading/types.js";
import { ApiWalletManager } from "../../src/trading/wallet.js";
import { freshNear, HARD, HL_ACCOUNT, makeCtx, ownerKeyPair, OWNER, tmpDir, VAULT } from "./fixtures.js";

export const SECRET = "s".repeat(40);
export const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
export const TEST_KEY = `0x${"0".repeat(63)}7`;
export const ACCOUNT_LC = HL_ACCOUNT.toLowerCase();

/** An interval rule fires at confirm time: the simplest rule that places an order without candles. */
export const dcaRules = (): RuleSetV1 => ({
  version: 1,
  name: "DCA",
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "40", max_order_usdc: "12", daily_loss_stop_usdc: "5", max_orders_per_day: 3 },
  rules: [{ id: "dca", pair: "HYPE/USDC", when: { type: "interval", every: "1h" }, action: { side: "buy", size: { usdc: "12" }, order: { type: "ioc" } } }],
});

type Budget = Awaited<ReturnType<FundingClient["getBudget"]>>;
type Outcome = Awaited<ReturnType<FundingClient["requestPayment"]>>;

export class FakeSdkClient implements FundingClient {
  events: string[];
  budget: Budget = {
    agentId: "hl-trader",
    status: "Active",
    remainingTodayUsdc: "50",
    vaultRemainingTodayUsdc: "1000",
    perTxLimitUsdc: "25",
    approvalThresholdUsdc: "25",
    allowedChains: ["hypercore"],
    recipientsMode: "Allowlist",
    allowlist: [{ chain: "hypercore", address: ACCOUNT_LC, label: "Owner HL" }],
    vaultPaused: false,
    vaultBalanceUsdc: "500",
    minPaymentUsdc: "1",
    paymentsLeftToday: 2,
  };
  outcome: Outcome = { status: "submitted", payoutId: "7" };
  requests: { chain: string; address: string; amountUsdc: string }[] = [];
  watched: string[] = [];
  constructor(events: string[]) {
    this.events = events;
  }
  getBudget() {
    return Promise.resolve(structuredClone(this.budget));
  }
  requestPayment(req: Parameters<FundingClient["requestPayment"]>[0]) {
    this.events.push("requestPayment");
    this.requests.push(req);
    return Promise.resolve(this.outcome);
  }
  recent: { id: string; chain: string; address: string; createdAtMs: number; status: string }[] = [];
  recentError = false;
  listRecentPayouts() {
    return this.recentError ? Promise.reject(new Error("rpc")) : Promise.resolve(structuredClone(this.recent));
  }
  getPaymentStatus(id: string) {
    return Promise.resolve({ payoutId: id, status: "Sent" } as Awaited<ReturnType<FundingClient["getPaymentStatus"]>>);
  }
}

/** FakeHl whose reads can be held back to test overlapping ticks. */
export class GatedHl extends FakeHl {
  gate: Promise<void> | null = null;
  midsCalls = 0;
  override async getMids() {
    this.midsCalls += 1;
    if (this.gate) await this.gate;
    return super.getMids();
  }
}

export interface HarnessOpts {
  dir?: string;
  envKey?: string | undefined;
  topup?: boolean;
  proposer?: TradingRouteDeps["propose"];
}

export function harness(o: HarnessOpts = {}) {
  const dir = o.dir ?? tmpDir();
  const clock = { t: T0 };
  const events: string[] = [];
  const near = freshNear();
  const hl = new GatedHl({ now: () => clock.t });
  hl.account = ACCOUNT_LC;
  const wallet = new ApiWalletManager({ stateDir: dir, envKey: "envKey" in o ? o.envKey : TEST_KEY, now: () => clock.t });
  const address = wallet.address();
  hl.setApprovedAgents(HL_ACCOUNT, [{ address, name: "agent-treasury valid_until", validUntilMs: T0 + 30 * 86_400_000 }]);
  hl.setBalances(HL_ACCOUNT, [{ coin: "USDC", total: "100", hold: "0" }]);
  const vault: { view: VaultView; down: boolean } = {
    view: { vaultPaused: false, status: "Active", remainingTodayUsdc: "50", perTxLimitUsdc: "25", paymentsToday: 0, maxPaymentsPerDay: 2, expiresAtMs: T0 + 30 * 86_400_000 },
    down: false,
  };
  const ctx = makeCtx(near);
  const store = new RulesStore(dir, () => clock.t);
  const client = new FakeSdkClient(events);
  const funder = o.topup === false ? null : new Funder(client, { enabled: true, masterAddress: HL_ACCOUNT, topupUsdc: "20", floorUsdc: "10", stateDir: dir, now: () => clock.t });
  const hlCreated: string[] = [];
  const service = new TradingService({
    settings: { vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", account: HL_ACCOUNT, hard: HARD, tickSec: 60, deadmanSec: 180, stateDir: dir },
    hl,
    createHl: (w) => {
      hlCreated.push(w.address);
      return hl;
    },
    wallet,
    store,
    confirmCtx: ctx,
    readVault: () => (vault.down ? Promise.reject(new Error("rpc down")) : Promise.resolve(vault.view)),
    funder,
    watchPayment: (id) => {
      client.watched.push(id);
      return { done: Promise.resolve({ kind: "reported" }) };
    },
    paymentStatus: (id) => client.getPaymentStatus(id),
    now: () => clock.t,
  });
  const pairs = createPairInfoProvider(() => service.hlPort(), { now: () => clock.t });
  const confirmer = new RulesConfirmer({ ctx, store, getPairInfo: () => pairs.getPairInfo(), deadManAvailable: () => service.deadManAvailable(), now: () => clock.t });
  const routeDeps: TradingRouteDeps = { service, confirmer, store, confirmCtx: ctx, sessionSecret: SECRET, vault: VAULT, trustProxy: true, now: () => clock.t, propose: o.proposer };
  const app = new Hono().route("/trading", createTradingRouter(routeDeps));

  const token = (sub: string = OWNER) => signToken(SECRET, { sub, vault: VAULT, iat: clock.t, exp: clock.t + 3_600_000 });
  const authed = (sub?: string): Record<string, string> => ({ authorization: `Bearer ${token(sub)}`, "content-type": "application/json", "x-forwarded-for": "9.9.9.9" });

  /** challenge -> sign -> confirm over HTTP, like the dashboard. Returns the confirm Response. */
  async function confirmOverHttp(rules: RuleSetV1, opts: { key?: typeof ownerKeyPair } = {}) {
    const chRes = await app.request("/trading/rules/challenge", { method: "POST", headers: authed(), body: JSON.stringify({ rules }) });
    const ch = (await chRes.json()) as Challenge;
    const key = opts.key ?? ownerKeyPair;
    const res = await app.request("/trading/rules/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" },
      body: JSON.stringify({
        rules,
        account_id: OWNER,
        public_key: key.publicKey,
        signature: key.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: VAULT, callbackUrl: null }),
        nonce: ch.nonce,
      }),
    });
    return res;
  }

  /** Confirm directly through the confirmer (no HTTP) and make the service aware. */
  async function confirmDirect(rules: RuleSetV1) {
    const ch = await confirmer.challenge(rules);
    const env = await confirmer.confirm({
      rules,
      account_id: OWNER,
      public_key: ownerKeyPair.publicKey,
      signature: ownerKeyPair.signNep413({ message: ch.message, nonce: Buffer.from(ch.nonce, "base64"), recipient: VAULT, callbackUrl: null }),
      nonce: ch.nonce,
    });
    await service.activated(env);
    return env;
  }

  return { dir, clock, events, near, hl, wallet, address, vault, store, client, funder, service, confirmer, app, routeDeps, token, authed, confirmOverHttp, confirmDirect, hlCreated };
}
