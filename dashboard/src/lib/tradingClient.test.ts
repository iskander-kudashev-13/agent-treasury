import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, saveSession } from "./assistantClient";
import { VAULT_ID, WORKER_URL } from "./config";
import {
  confirmTradingRules,
  fetchTradingLog,
  fetchTradingStatus,
  killBot,
  killTrading,
  parseAgentAccess,
  parseAgentToken,
  parseBotDetail,
  parseBotFill,
  parseBotSummary,
  parseKill,
  parseLog,
  parseProposedRules,
  parseTradingRulesProposal,
  parseTradingStatus,
  recordStop,
  revokeAgentToken,
  stoppedSince,
  TradingHttpError,
  withOwnerSession,
} from "./tradingClient";
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
  dead_man: { cancel_at_ms: null, available: null },
  perp_check: { ok: true, at_ms: 1 },
  last_tick_ms: 1,
  next_tick_ms: 2,
  warnings: ["w"],
  other_approved_agents: [{ address: "0x2222222222222222222222222222222222222222", name: "old", valid_until_ms: 9 }],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("parsers", () => {
  it("parses a full status and the disabled shape", () => {
    const s = parseTradingStatus(STATUS);
    expect(s).toMatchObject({ enabled: true, state: "running", hl_account: HL, balances: { usdc_free: "12.5" } });
    expect(parseTradingStatus({ enabled: false })).toEqual({ enabled: false });
  });
  it("tolerates the new pnl fields being absent (older worker) and reads them when present", () => {
    expect(parseTradingStatus(STATUS)).toMatchObject({ pnl: { fees_usdc: "0", external_outflow_usdc: "0", untracked_delta_usdc: "0", funded_by_vault_usdc: "0" } });
    const s = parseTradingStatus({ ...STATUS, pnl: { total_usdc: "1", fees_usdc: "0.2", external_outflow_usdc: "3", untracked_delta_usdc: "-1", funded_by_vault_usdc: "25", external_inflow_usdc: "4" } });
    expect(s).toMatchObject({ pnl: { fees_usdc: "0.2", external_outflow_usdc: "3", untracked_delta_usdc: "-1", funded_by_vault_usdc: "25", external_inflow_usdc: "4" } });
  });
  it("parses other approved agents defensively", () => {
    expect(parseTradingStatus(STATUS)).toMatchObject({ other_approved_agents: [{ address: "0x2222222222222222222222222222222222222222", name: "old", valid_until_ms: 9 }] });
    expect(parseTradingStatus({ ...STATUS, other_approved_agents: [1, { name: "x" }] })).toMatchObject({ other_approved_agents: [] });
    expect(parseTradingStatus({ enabled: true, state: "running" })).toMatchObject({ other_approved_agents: [] });
  });
  it("reads dead_man.available when present and leaves it null on older workers", () => {
    expect(parseTradingStatus(STATUS)).toMatchObject({ dead_man: { available: null } });
    expect(parseTradingStatus({ ...STATUS, dead_man: { cancel_at_ms: null, available: false } })).toMatchObject({ dead_man: { available: false } });
    expect(parseTradingStatus({ enabled: true, state: "running" })).toMatchObject({ dead_man: { available: null } });
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

describe("parsers, ADR-0007 fields", () => {
  it("agent_trading: null on older workers, parsed when present", () => {
    expect(parseTradingStatus(STATUS)).toMatchObject({ agent_trading: null });
    expect(parseTradingStatus({ ...STATUS, agent_trading: { enabled: true, max_orders_per_day: 10, min_order_interval_sec: 10, token_ttl_hours: 72 } })).toMatchObject({ agent_trading: { enabled: true, max_orders_per_day: 10, token_ttl_hours: 72 } });
    expect(parseTradingStatus({ ...STATUS, agent_trading: { enabled: "yes" } })).toMatchObject({ agent_trading: { enabled: false } });
  });
  it("log entries: source, code and note", () => {
    const [e] = parseLog({ entries: [{ at_ms: 1, kind: "skip", detail: "MAX_ORDER: x", source: "agent", code: "MAX_ORDER", note: "n".repeat(300) }] });
    expect(e).toMatchObject({ source: "agent", code: "MAX_ORDER" });
    expect(e?.note).toHaveLength(200);
    const [f] = parseLog({ entries: [{ at_ms: 1, kind: "skip", detail: "d", source: "x", code: "<b>", note: 5 }] });
    expect(f?.source).toBeUndefined();
    expect(f?.code).toBeUndefined();
    expect(f?.note).toBeUndefined();
  });
  it("bot kind defaults to rules; agent access and fill note", () => {
    expect(parseBotSummary({ id: "a", name: "A", state: "running" })?.kind).toBe("rules");
    expect(parseBotSummary({ id: "a", name: "A", state: "running", kind: "agent" })?.kind).toBe("agent");
    expect(parseBotSummary({ id: "a", name: "A", state: "running", kind: "weird" })?.kind).toBe("rules");
    const d = parseBotDetail({ bot: { id: "a", state: "halted", kind: "agent" }, kind: "agent", agent: { connected: true, token_id: "0123abcd", issued_at_ms: 1, expires_at_ms: 2, last_used_ms: null } });
    expect(d).toMatchObject({ kind: "agent", agent: { connected: true, token_id: "0123abcd", last_used_ms: null } });
    expect(parseBotDetail({ bot: { id: "a", state: "running" } })).toMatchObject({ kind: "rules", agent: null });
    expect(parseAgentAccess({ connected: "true", token_id: "nothex!!" })).toMatchObject({ connected: false, token_id: null });
    expect(parseBotFill({ side: "buy", price: "1", size: "2", note: "why" })?.note).toBe("why");
    expect(parseBotFill({ side: "buy", price: "1", size: "2" })?.note).toBeNull();
  });
  it("parseAgentToken checks the format and the bot", () => {
    const tok = `atk1_b1_${"a-_Z".repeat(10)}xyz`;
    expect(parseAgentToken({ token: tok, token_id: "deadbeef", issued_at_ms: 1, expires_at_ms: 2 }, "b1")).toMatchObject({ token: tok, token_id: "deadbeef" });
    expect(parseAgentToken({ token: tok, issued_at_ms: 1, expires_at_ms: 2 }, "b2")).toBeNull();
    expect(parseAgentToken({ token: tok }, "b1")).toBeNull();
    expect(parseAgentToken(null, "b1")).toBeNull();
  });
  it("assistant proposals with a mode key are refused (AI may never create agent mode)", () => {
    const base = { id: "p1", type: "TradingRules", title: "t", summary: "s", hash: "a".repeat(64), validation: { ok: true, errors: [], warnings: [] } };
    expect(parseTradingRulesProposal({ ...base, rules: RULES })).not.toBeNull();
    expect(parseTradingRulesProposal({ ...base, rules: { ...RULES, mode: "agent", rules: [] } })).toBeNull();
    expect(parseTradingRulesProposal({ ...base, rules: { ...RULES, mode: "rules" } })).toBeNull();
    expect(parseProposedRules({ rules: { ...RULES, mode: "agent" } })).toEqual([]);
    expect(parseProposedRules({ rules: RULES })).toHaveLength(1);
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

  it("withOwnerSession signs in again inline on 401 and retries once", async () => {
    let n = 0;
    route({
      "/trading/kill": (init) => {
        n++;
        const auth = (init?.headers as Record<string, string>).Authorization;
        return auth === "Bearer fresh" ? json({ state: "halted", cancelled_orders: 0, steps: { cancel_all: "ok", schedule_cancel: "ok" } }) : json({ code: "UNAUTHORIZED", message: "expired" }, 401);
      },
      "/ai/session/challenge": () => json({ nonce: btoa("n".repeat(32)), message: "m", recipient: VAULT_ID }),
      "/ai/session": () => json({ token: "fresh", account_id: "owner.testnet", expires_at: Date.now() + 3_600_000 }),
    });
    const signMessage = vi.fn(() => Promise.resolve({ accountId: "owner.testnet", publicKey: "ed25519:pk", signature: "sig" }));
    const r = await withOwnerSession("owner.testnet", signMessage, (t) => killTrading(t));
    expect(r.state).toBe("halted");
    expect(n).toBe(2);
    expect(signMessage).toHaveBeenCalledTimes(1);
  });
  it("withOwnerSession does not loop on a second 401", async () => {
    route({
      "/trading/kill": () => json({ code: "UNAUTHORIZED", message: "no" }, 401),
      "/ai/session/challenge": () => json({ nonce: btoa("n".repeat(32)), message: "m", recipient: VAULT_ID }),
      "/ai/session": () => json({ token: "fresh", account_id: "owner.testnet", expires_at: Date.now() + 3_600_000 }),
    });
    const signMessage = vi.fn(() => Promise.resolve({ accountId: "owner.testnet", publicKey: "k", signature: "s" }));
    await expect(withOwnerSession("owner.testnet", signMessage, (t) => killTrading(t))).rejects.toMatchObject({ status: 401 });
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  describe("confirmTradingRules", () => {
    const nonce = btoa("n".repeat(32));
    const setup = async (over: { message?: string; hash?: string; recipient?: string; botId?: string | null; isNew?: boolean } = {}) => {
      const hash = await hashRuleSet(RULES);
      const message = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL, rulesSha256: hash, botId: "default" });
      route({
        "/trading/status": () => json(STATUS),
        "/trading/rules/challenge": () => json({ nonce, message: over.message ?? message, recipient: over.recipient ?? VAULT, hash: over.hash ?? hash, expires_at: 1, ...(over.botId === null ? {} : { bot_id: over.botId ?? "default", is_new: over.isNew ?? false }) }),
        "/trading/rules/confirm": () => json({ active: { rules: RULES, hash, message, signature: "s", public_key: "p", account_id: "owner.testnet", nonce, callback_url: null, confirmed_at_ms: 9 }, state: "running" }),
      });
      const signMessage = vi.fn(() => Promise.resolve({ accountId: "owner.testnet", publicKey: "ed25519:pk", signature: "sig" }));
      return { signMessage, hash, message };
    };

    it("signs the locally built message and posts the confirmation", async () => {
      const { signMessage, message } = await setup();
      const r = await confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false });
      expect(signMessage).toHaveBeenCalledWith(expect.objectContaining({ message, recipient: VAULT }));
      expect(r.state).toBe("running");
      expect(r.active?.confirmed_at_ms).toBe(9);
      const body = JSON.parse(String(calls.find((c) => c.path.endsWith("/confirm"))?.init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ account_id: "owner.testnet", public_key: "ed25519:pk", signature: "sig", nonce });
    });
    it("sends bot_id/bot_name in the challenge and bot_id in the confirmation", async () => {
      const { signMessage } = await setup();
      await confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", botName: "Dip", expectNew: false });
      const ch = JSON.parse(String(calls.find((c) => c.path.endsWith("/challenge"))?.init?.body)) as Record<string, unknown>;
      expect(ch).toMatchObject({ bot_id: "default", bot_name: "Dip" });
      const body = JSON.parse(String(calls.find((c) => c.path.endsWith("/confirm"))?.init?.body)) as Record<string, unknown>;
      expect(body.bot_id).toBe("default");
    });
    it("refuses (without asking the wallet) when the worker answers for another bot", async () => {
      const { signMessage } = await setup({ botId: "dip-buyer" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/dip-buyer/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses (without asking the wallet) a 'new agent' choice when the worker says the agent already exists (MM1)", async () => {
      const { signMessage } = await setup({ isNew: false });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", botName: "Dip", expectNew: true })).rejects.toThrow(/already exists/);
      expect(signMessage).not.toHaveBeenCalled();
      expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
    });
    it("refuses (without asking the wallet) an 'update' choice when the worker says the agent is new (MM1/ML5)", async () => {
      const { signMessage } = await setup({ isNew: true });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/does not exist yet/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("signs when the worker's is_new matches the choice (new)", async () => {
      const { signMessage } = await setup({ isNew: true });
      await confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", botName: "Dip", expectNew: true });
      expect(signMessage).toHaveBeenCalledTimes(1);
    });
    it("refuses a challenge without is_new (older worker): the choice cannot be verified", async () => {
      const { signMessage } = await setup();
      route({
        "/trading/status": () => json(STATUS),
        "/trading/rules/challenge": () => json({ nonce, message: "x", recipient: VAULT, hash: "0".repeat(64), bot_id: "default" }),
      });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow();
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses a v1 message (worker without bots) for any bot but default", async () => {
      const { signMessage } = await setup({ botId: null });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "dca-2", expectNew: false })).rejects.toThrow(/dca-2/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses a v2 message when the bot line is missing or wrong", async () => {
      const hash = await hashRuleSet(RULES);
      const v1 = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL, rulesSha256: hash });
      const { signMessage } = await setup({ message: v1 });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/does not match/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses (without asking the wallet) when the worker hashes differently", async () => {
      const { signMessage } = await setup({ hash: "0".repeat(64) });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/different hash/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses when the message differs from the ADR text", async () => {
      const { signMessage } = await setup({ message: "Agent Treasury: activate trading rules\nvault: evil" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/does not match/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses (without asking the wallet) when the worker's HL account is not the one the vault pays", async () => {
      const { signMessage } = await setup();
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: "0x" + "11".repeat(20), botId: "default", expectNew: false })).rejects.toThrow(/vault pays/);
      expect(signMessage).not.toHaveBeenCalled();
      expect(calls.some((c) => c.path.includes("challenge"))).toBe(false);
    });
    it("refuses when the chain names no single HL account", async () => {
      const { signMessage } = await setup();
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: null, botId: "default", expectNew: false })).rejects.toThrow(/cannot be verified/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses a challenge for another vault", async () => {
      const { signMessage } = await setup({ recipient: "evil.near" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/different vault/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses when the wallet signs with another account", async () => {
      const { signMessage } = await setup();
      signMessage.mockResolvedValueOnce({ accountId: "other.testnet", publicKey: "k", signature: "s" });
      await expect(confirmTradingRules(RULES, { accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "default", expectNew: false })).rejects.toThrow(/different account/);
      expect(calls.some((c) => c.path.endsWith("/confirm"))).toBe(false);
    });
  });

  describe("confirmTradingRules, AI-agent mode (ADR-0007)", () => {
    const nonce = btoa("n".repeat(32));
    const AGENT: RuleSetV1 = { version: 1, mode: "agent", name: "PURR agent", pairs: ["PURR/USDC"], limits: { max_position_usdc: "25", max_order_usdc: "12", daily_loss_stop_usdc: "3", max_orders_per_day: 6 }, rules: [] };
    const TOKEN = `atk1_purr-agent_${"A".repeat(43)}`;
    const issued = { token: TOKEN, token_id: "0123abcd", issued_at_ms: 1000, expires_at_ms: 2000 };
    const deps = (signMessage: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) => ({ accountId: "owner.testnet", signMessage, vault: VAULT, trustedHlAccount: HL, botId: "purr-agent", botName: "PURR agent", expectNew: true, ...over }) as Parameters<typeof confirmTradingRules>[1];
    const setup = async (over: { mode?: string | null; message?: string; agentToken?: unknown; rules?: RuleSetV1 } = {}) => {
      const rules = over.rules ?? AGENT;
      const hash = await hashRuleSet(rules);
      const message = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL, rulesSha256: hash, botId: "purr-agent", ...(rules.mode ? { mode: "agent" as const } : {}) });
      route({
        "/trading/status": () => json({ ...STATUS, agent_trading: { enabled: true, max_orders_per_day: 10, min_order_interval_sec: 10, token_ttl_hours: 72 } }),
        "/trading/rules/challenge": () => json({ nonce, message: over.message ?? message, recipient: VAULT, hash, expires_at: 1, bot_id: "purr-agent", is_new: true, ...(over.mode === null ? {} : { mode: over.mode ?? (rules.mode ? "agent" : "rules") }) }),
        "/trading/rules/confirm": () =>
          json({
            bot: { id: "purr-agent", name: "PURR agent", state: "running", kind: rules.mode ? "agent" : "rules" },
            active: { rules, hash, message, signature: "s", public_key: "p", account_id: "owner.testnet", nonce, callback_url: null, confirmed_at_ms: 9 },
            state: "running",
            agent_token: over.agentToken === undefined ? (rules.mode ? issued : null) : over.agentToken,
          }),
      });
      const signMessage = vi.fn(() => Promise.resolve({ accountId: "owner.testnet", publicKey: "ed25519:pk", signature: "sig" }));
      return { signMessage, message };
    };

    it("signs the v3 message and returns the agent token once", async () => {
      const { signMessage, message } = await setup();
      expect(message.split("\n")[0]).toBe("Agent Treasury: activate AI agent trading limits");
      const r = await confirmTradingRules(AGENT, deps(signMessage));
      expect(signMessage).toHaveBeenCalledWith(expect.objectContaining({ message }));
      expect(r.agent_token).toEqual(issued);
      expect(r.bot?.kind).toBe("agent");
      const ch = JSON.parse(String(calls.find((c) => c.path.endsWith("/challenge"))?.init?.body)) as { rules: RuleSetV1 };
      expect(ch.rules.mode).toBe("agent");
    });
    it("never writes the token to web storage", async () => {
      const writes: string[] = [];
      const fake = () => ({ getItem: () => null, setItem: (k: string, v: string) => void writes.push(`${k}=${v}`), removeItem: () => undefined, key: () => null, clear: () => undefined, length: 0 });
      vi.stubGlobal("localStorage", fake());
      vi.stubGlobal("sessionStorage", fake());
      const { signMessage } = await setup();
      const r = await confirmTradingRules(AGENT, deps(signMessage));
      expect(r.agent_token?.token).toBe(TOKEN);
      expect(writes.some((w) => w.includes(TOKEN))).toBe(false);
    });
    it("requires agent_token in agent mode (after signing, the limits are active but unusable without it)", async () => {
      const { signMessage } = await setup({ agentToken: null });
      await expect(confirmTradingRules(AGENT, deps(signMessage))).rejects.toThrow(/key/);
    });
    it("refuses a token for another bot or with a bad format", async () => {
      for (const bad of [{ ...issued, token: `atk1_other_${"A".repeat(43)}` }, { ...issued, token: "atk1_purr-agent_short" }, { ...issued, expires_at_ms: 1 }]) {
        const { signMessage } = await setup({ agentToken: bad });
        await expect(confirmTradingRules(AGENT, deps(signMessage))).rejects.toThrow(/key/);
      }
    });
    it("refuses (without asking the wallet) a challenge whose mode differs", async () => {
      const { signMessage } = await setup({ mode: "rules" });
      await expect(confirmTradingRules(AGENT, deps(signMessage))).rejects.toThrow(/different kind/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses (without asking the wallet) a v2 message for an agent mandate", async () => {
      const hash = await hashRuleSet(AGENT);
      const v2 = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL, rulesSha256: hash, botId: "purr-agent" });
      const { signMessage } = await setup({ message: v2 });
      await expect(confirmTradingRules(AGENT, deps(signMessage))).rejects.toThrow(/does not match/);
      expect(signMessage).not.toHaveBeenCalled();
    });
    it("refuses a v3 message for a rules bot, and returns agent_token null for rules bots", async () => {
      const rules = { ...RULES, name: "PURR rules", pairs: ["PURR/USDC"], rules: RULES.rules.map((r) => ({ ...r, pair: "PURR/USDC" })) };
      const hash = await hashRuleSet(rules);
      const v3 = confirmationMessage({ vault: VAULT, agentId: "hl-trader", hlNetwork: "testnet", hlAccount: HL, rulesSha256: hash, botId: "purr-agent", mode: "agent" });
      const bad = await setup({ rules, message: v3 });
      await expect(confirmTradingRules(rules, deps(bad.signMessage))).rejects.toThrow(/does not match/);
      expect(bad.signMessage).not.toHaveBeenCalled();
      const ok = await setup({ rules, agentToken: issued });
      const r = await confirmTradingRules(rules, deps(ok.signMessage));
      expect(r.agent_token).toBeNull();
    });
    it("accepts a challenge without a mode field (the message check still binds the mode)", async () => {
      const { signMessage } = await setup({ mode: null });
      expect((await confirmTradingRules(AGENT, deps(signMessage))).agent_token?.token).toBe(TOKEN);
    });
    it("revokeAgentToken posts to the revoke route with the owner token", async () => {
      route({ "/trading/bots/purr-agent/agent-token/revoke": () => json({ bot_id: "purr-agent", revoked: true }) });
      expect(await revokeAgentToken("tok", "purr-agent")).toEqual({ bot_id: "purr-agent", revoked: true });
      expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
      expect(calls[0]?.init?.method).toBe("POST");
      await expect(revokeAgentToken("tok", "Bad_Id")).rejects.toThrow();
    });
    it("fetchTradingLog can filter by bot", async () => {
      route({ "/trading/log?limit=20&bot=purr-agent": () => json({ entries: [] }) });
      expect(await fetchTradingLog("tok", 20, undefined, "purr-agent")).toEqual([]);
    });
  });

  describe("stops are remembered for open rule cards (MM2)", () => {
    it("killTrading and killBot record the stop even before the worker answers", async () => {
      route({ "/trading/kill": () => json({ state: "halted", cancelled_orders: 0, steps: { cancel_all: "ok", schedule_cancel: "ok", state_saved: "ok", tick_wait: "ok" } }), "/trading/bots/zed/kill": () => json({ bot_id: "zed", state: "halted", cancelled_orders: 0, steps: { cancel: "ok", state_saved: "ok" } }) });
      const t = Date.now();
      await killBot("tok", "zed");
      expect(stoppedSince("zed", t)).toBe(true);
      expect(stoppedSince("other-bot", t)).toBe(false);
      await killTrading("tok");
      expect(stoppedSince("other-bot", t)).toBe(true);
    });
    it("recordStop(all) concerns every agent, recordStop(id) only that one, and only for cards that started before it", () => {
      const t0 = 8_000_000_000_000_000;
      expect(stoppedSince("alpha", t0)).toBe(false);
      recordStop("alpha", t0 + 5);
      expect(stoppedSince("alpha", t0)).toBe(true);
      expect(stoppedSince("beta", t0)).toBe(false);
      expect(stoppedSince("alpha", t0 + 6)).toBe(false); // a card created after the Stop is a deliberate re-creation
      recordStop(null, t0 + 10);
      expect(stoppedSince("beta", t0)).toBe(true);
      expect(stoppedSince("beta", t0 + 11)).toBe(false);
    });
  });
});
