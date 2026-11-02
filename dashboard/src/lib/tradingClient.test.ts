import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, saveSession } from "./assistantClient";
import { WORKER_URL } from "./config";
import { confirmTradingRules, fetchTradingStatus, killTrading, parseKill, parseLog, parseTradingStatus, TradingHttpError } from "./tradingClient";
import { confirmationMessage, hashRuleSet, type RuleSetV1 } from "./tradingRules";

const RULES: RuleSetV1 = {
  version: 1,
  name: "HYPE dip buyer",
  pairs: ["HYPE/USDC"],
  limits: { max_position_usdc: "40", max_order_usdc: "10", daily_loss_stop_usdc: "5", max_orders_per_day: 3 },
  rules: [{ id: "dip", pair: "HYPE/USDC", when: { type: "price_change", window: "1d", op: "lte", pct: "-3" }, action: { side: "buy", size: { usdc: "10" }, order: { type: "ioc" } }, cooldown: "1d" }],
};
const VAULT = "vault.testnet";
const HL = "0xABCDEF0123456789abcdef0123456789ABCDEF01";
const STATUS = {
  enabled: true,
  state: "running",
  state_reason: null,
  state_detail: null,
  hl_network: "testnet",
  hl_account: HL,
  vault: VAULT,
  agent_id: "hl-trader",
  api_wallet: { address: "0x1111111111111111111111111111111111111111", approved: true, name: "agent-treasury valid_until 1", valid_until_ms: 5 },
  balances: { usdc_free: "12.5", usdc_total: "20", equity_usdc: "21", positions: [{ pair: "HYPE/USDC", base: "HYPE", size: "0.2", mid: "30", value_usdc: "6" }] },
  pnl: { today_usdc: "-1", total_usdc: "1", net_funded_usdc: "20", day_start_equity_usdc: "22" },
  limits: {
    effective: { max_position_usdc: "40", max_order_usdc: "10", daily_loss_stop_usdc: "5", max_orders_per_day: 3, price_band_bps: 100 },
    today: { orders: 1, loss_usdc: "1" },
    position_usdc: "6",
    vault: { status: "Active", remaining_today_usdc: "25", per_tx_limit_usdc: "25", payments_today: 1, max_payments_per_day: 2, expires_at_ms: null },
  },
  open_orders: [],
  active_rules: { hash: "ab", name: "HYPE dip buyer", confirmed_at_ms: 1, confirmed_by: "owner.testnet" },
  dead_man: { cancel_at_ms: null },
  perp_check: { ok: true, at_ms: 1 },
  last_tick_ms: 1,
  next_tick_ms: 2,
  warnings: ["w"],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parsers", () => {
  it("parses a full status and the disabled shape", () => {
    const s = parseTradingStatus(STATUS);
    expect(s).toMatchObject({ enabled: true, state: "running", hl_account: HL, balances: { usdc_free: "12.5" } });
    expect(parseTradingStatus({ enabled: false })).toEqual({ enabled: false });
  });
  it("rejects unknown states and garbage", () => {
    expect(parseTradingStatus({ ...STATUS, state: "yolo" })).toBeNull();
    expect(parseTradingStatus("x")).toBeNull();
  });
  it("tolerates missing nested objects", () => {
    const s = parseTradingStatus({ enabled: true, state: "not_configured" });
    expect(s).toMatchObject({ enabled: true, api_wallet: { approved: false }, open_orders: [], active_rules: null });
  });
  it("parses log entries and drops unknown kinds", () => {
    expect(parseLog({ entries: [{ at_ms: 1, kind: "order", detail: "d", oid: 3 }, { at_ms: 2, kind: "evil", detail: "x" }] })).toEqual([{ at_ms: 1, kind: "order", detail: "d", oid: 3 }]);
  });
  it("parses the kill result", () => {
    expect(parseKill({ state: "halted", cancelled_orders: 2, steps: { cancel_all: "ok", schedule_cancel: "failed" } })).toEqual({ state: "halted", cancelled_orders: 2, steps: { cancel_all: "ok", schedule_cancel: "failed" } });
  });
});

describe("HTTP client (mocked fetch)", () => {
  let calls: Array<{ path: string; init: RequestInit | undefined }>;
  const route = (handlers: Record<string, (init?: RequestInit) => Response>) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const path = url.slice(WORKER_URL.length); // independent of VITE_WORKER_URL in .env.local
        calls.push({ path, init });
        const h = handlers[path];
        return Promise.resolve(h ? h(init) : json({ type: "error", code: "nope", message: "no route" }, 404));
      }),
    );
  };
  beforeEach(() => {
    calls = [];
    saveSession({ token: "tok", accountId: "owner.testnet", expiresAt: Date.now() + 3_600_000 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
  });

  it("status 404 means trading is switched off", async () => {
    route({});
    expect(await fetchTradingStatus()).toEqual({ enabled: false });
  });
  it("other errors carry code and message", async () => {
    route({ "/trading/status": () => json({ type: "error", code: "boom", message: "bad" }, 502) });
    await expect(fetchTradingStatus()).rejects.toMatchObject({ status: 502, code: "boom", message: "bad" });
    await expect(fetchTradingStatus()).rejects.toBeInstanceOf(TradingHttpError);
  });
  it("kill sends the bearer token", async () => {
    route({ "/trading/kill": () => json({ state: "halted", cancelled_orders: 1, steps: { cancel_all: "ok", schedule_cancel: "ok" } }) });
    expect((await killTrading("tok", "test")).cancelled_orders).toBe(1);
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(calls[0]?.init?.body).toBe('{"reason":"test"}');
  });

  describe("confirmTradingRules", () => {
    const nonce = btoa("n".repeat(32));
    const setup = async (over: { message?: string; hash?: string; recipient?: string } = {}) => {
      const hash = await hashRuleSet(RULES);
      const message = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL, rulesSha256: hash });
      route({
        "/trading/status": () => json(STATUS),
        "/trading/rules/challenge": () => json({ nonce, message: over.message ?? message, recipient: over.recipient ?? VAULT, hash: over.hash ?? hash, expires_at: 1 }),
        "/trading/rules/confirm": () => json({ active: { rules: RULES, hash, message, signature: "s", public_key: "p", account_id: "owner.testnet", nonce, callback_url: null, confirmed_at_ms: 9 }, state: "running" }),
      });
      const signMessage = vi.fn(() => Promise.resolve({ accountId: "owner.testnet", publicKey: "ed25519:pk", signature: "sig" }));
      return { signMessage, hash, message };
    };

    it("signs the locally built message and posts the confirmation", async () => {
      const { signMessage, message } = await setup();
      const r = await confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT });
      expect(signMessage).toHaveBeenCalledWith(expect.objectContaining({ message, recipient: VAULT }));
      expect(r.state).toBe("running");
      expect(r.active?.confirmed_at_ms).toBe(9);
      const body = JSON.parse(String(calls.find((c) => c.path.endsWith("/confirm"))?.init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ account_id: "owner.testnet", public_key: "ed25519:pk", signature: "sig", nonce });
    });
    it("refuses (without asking the wallet) when the worker hashes differently", async () => {
      const { signMessage } = await setup({ hash: "0".repeat(64) });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT })).rejects.toThrow(/different hash/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses when the message differs from the ADR text", async () => {
      const { signMessage } = await setup({ message: "Agent Treasury: activate trading rules\nvault: evil" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT })).rejects.toThrow(/does not match/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses a challenge for another vault", async () => {
      const { signMessage } = await setup({ recipient: "evil.near" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT })).rejects.toThrow(/different vault/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses when the wallet signs with another account", async () => {
      const { signMessage } = await setup();
      signMessage.mockResolvedValueOnce({ accountId: "other.testnet", publicKey: "k", signature: "s" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT })).rejects.toThrow(/different account/);
      expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
    });
  });
});
