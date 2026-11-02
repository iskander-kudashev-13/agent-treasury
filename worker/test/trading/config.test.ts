import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hardLimitsOf, loadConfig } from "../../src/config.js";

const base = { VAULT_CONTRACT_ID: "vault.testnet" };
const MASTER = "0xAbCdEf0123456789aBcDeF0123456789abCDEF01";
const on = {
  ...base,
  TRADING_ENABLED: "true",
  AI_SESSION_SECRET: "s".repeat(40),
  HL_MASTER_ADDRESS: MASTER,
  TRADER_NEAR_ACCOUNT_ID: "hl-trader.owner.testnet",
  TRADER_NEAR_PRIVATE_KEY: "ed25519:abc",
};
const bad = (env: Record<string, string>, re: RegExp): void => {
  expect(() => loadConfig(env)).toThrow(re);
};

describe("trading config defaults", () => {
  it("is off by default and every default is the safe one from the owner decisions", () => {
    const c = loadConfig(base);
    expect(c.TRADING_ENABLED).toBe(false);
    expect(c.HL_NETWORK).toBe("testnet");
    expect(c.TRADING_ALLOW_MAINNET).toBe(false);
    expect(hardLimitsOf(c)).toEqual({
      maxPositionUsdc: "50",
      maxOrderUsdc: "20",
      dailyLossUsdc: "10",
      maxOrdersPerDay: 20,
      allowedPairs: ["HYPE/USDC"],
      minPairVolumeUsdc: "1000000",
      priceBandBps: 100,
    });
    expect(c).toMatchObject({
      TRADING_TICK_SEC: 60,
      TRADING_DEADMAN_SEC: 180,
      TRADING_STATE_DIR: "./.trading",
      TRADER_AGENT_ID: "hl-trader",
      TRADING_TOPUP_ENABLED: true,
      TRADING_TOPUP_USDC: "20",
      TRADING_TOPUP_FLOOR_USDC: "10",
    });
    expect(c.TRADING_START_MS).toBeUndefined();
  });

  it("disabled trading ignores missing trading settings", () => {
    expect(() => loadConfig({ ...base, TRADING_ENABLED: "false" })).not.toThrow();
  });

  it("a complete enabled config loads", () => {
    const c = loadConfig(on);
    expect(c.TRADING_ENABLED).toBe(true);
    expect(c.HL_MASTER_ADDRESS).toBe(MASTER);
  });

  it("empty strings count as unset", () => {
    const c = loadConfig({ ...base, HL_MASTER_ADDRESS: "", TRADING_START_MS: "", HL_API_WALLET_PRIVATE_KEY: "" });
    expect(c.HL_MASTER_ADDRESS).toBeUndefined();
    expect(c.TRADING_START_MS).toBeUndefined();
  });
});

describe("trading config validation (fail fast)", () => {
  it("requires the owner-session secret, the master address and the trader key", () => {
    bad({ ...on, AI_SESSION_SECRET: "" }, /AI_SESSION_SECRET/);
    bad({ ...on, HL_MASTER_ADDRESS: "" }, /HL_MASTER_ADDRESS/);
    bad({ ...on, TRADER_NEAR_PRIVATE_KEY: "" }, /TRADER_NEAR_ACCOUNT_ID/);
    bad({ ...on, TRADER_NEAR_ACCOUNT_ID: "" }, /TRADER_NEAR_ACCOUNT_ID/);
  });
  it("the trader key is optional when top-ups are off", () => {
    expect(() => loadConfig({ ...on, TRADER_NEAR_ACCOUNT_ID: "", TRADER_NEAR_PRIVATE_KEY: "", TRADING_TOPUP_ENABLED: "false" })).not.toThrow();
  });
  it("refuses mainnet unless explicitly allowed", () => {
    bad({ ...on, HL_NETWORK: "mainnet" }, /TRADING_ALLOW_MAINNET/);
    expect(loadConfig({ ...on, HL_NETWORK: "mainnet", TRADING_ALLOW_MAINNET: "true" }).HL_NETWORK).toBe("mainnet");
    bad({ ...on, HL_NETWORK: "mainet" }, /HL_NETWORK/);
    bad({ ...on, TRADING_ALLOW_MAINNET: "yes" }, /TRADING_ALLOW_MAINNET/);
  });
  it("refuses tee mode (hard limits are not measured yet)", () => {
    // RUN_MODE=tee needs tee.config.json; the refusal comes from validateTrading, reached via the pinned file in tee-config tests
    bad({ ...on, RUN_MODE: "tee" }, /tee\.config\.json|local-mode only/);
  });
  it("malformed addresses and keys", () => {
    bad({ ...on, HL_MASTER_ADDRESS: "0x123" }, /HL_MASTER_ADDRESS/);
    bad({ ...on, HL_MASTER_ADDRESS: `0x${"g".repeat(40)}` }, /HL_MASTER_ADDRESS/);
    bad({ ...on, HL_API_WALLET_PRIVATE_KEY: "0xabc" }, /HL_API_WALLET_PRIVATE_KEY/);
  });
  it("numeric ranges", () => {
    bad({ ...on, TRADING_TICK_SEC: "14" }, /TRADING_TICK_SEC/);
    bad({ ...on, TRADING_TICK_SEC: "601" }, /TRADING_TICK_SEC/);
    bad({ ...on, TRADING_PRICE_BAND_BPS: "9" }, /TRADING_PRICE_BAND_BPS/);
    bad({ ...on, TRADING_PRICE_BAND_BPS: "201" }, /TRADING_PRICE_BAND_BPS/);
    bad({ ...on, TRADING_HARD_MAX_ORDERS_PER_DAY: "0" }, /TRADING_HARD_MAX_ORDERS_PER_DAY/);
    bad({ ...on, TRADING_HARD_MAX_ORDERS_PER_DAY: "51" }, /TRADING_HARD_MAX_ORDERS_PER_DAY/);
    bad({ ...on, TRADING_TICK_SEC: "abc" }, /TRADING_TICK_SEC/);
  });
  it("dead-man horizon must cover three ticks", () => {
    bad({ ...on, TRADING_TICK_SEC: "100", TRADING_DEADMAN_SEC: "299" }, /TRADING_DEADMAN_SEC/);
    expect(() => loadConfig({ ...on, TRADING_TICK_SEC: "100", TRADING_DEADMAN_SEC: "300" })).not.toThrow();
  });
  it("hard limits are decimals and consistent", () => {
    bad({ ...on, TRADING_HARD_MAX_ORDER_USDC: "9.99" }, /TRADING_HARD_MAX_ORDER_USDC/);
    bad({ ...on, TRADING_HARD_MAX_ORDER_USDC: "-1" }, /TRADING_HARD_MAX_ORDER_USDC/);
    bad({ ...on, TRADING_HARD_MAX_ORDER_USDC: "1e3" }, /TRADING_HARD_MAX_ORDER_USDC/);
    bad({ ...on, TRADING_HARD_MAX_POSITION_USDC: "15" }, /TRADING_HARD_MAX_POSITION_USDC/);
    bad({ ...on, TRADING_HARD_DAILY_LOSS_USDC: "0" }, /TRADING_HARD_DAILY_LOSS_USDC/);
    bad({ ...on, TRADING_MIN_PAIR_VOLUME_USDC: "0" }, /TRADING_MIN_PAIR_VOLUME_USDC/);
  });
  it("pairs: comma list of BASE/USDC, 1..3", () => {
    expect(hardLimitsOf(loadConfig({ ...on, TRADING_ALLOWED_PAIRS: "HYPE/USDC, PURR/USDC" })).allowedPairs).toEqual(["HYPE/USDC", "PURR/USDC"]);
    bad({ ...on, TRADING_ALLOWED_PAIRS: "HYPE/ETH" }, /TRADING_ALLOWED_PAIRS/);
    bad({ ...on, TRADING_ALLOWED_PAIRS: "" }, /TRADING_ALLOWED_PAIRS/);
    bad({ ...on, TRADING_ALLOWED_PAIRS: "A/USDC,B/USDC,C/USDC,D/USDC" }, /TRADING_ALLOWED_PAIRS/);
  });
  it("top-up size and floor", () => {
    bad({ ...on, TRADING_TOPUP_USDC: "1.5" }, /TRADING_TOPUP_USDC/);
    bad({ ...on, TRADING_TOPUP_FLOOR_USDC: "0" }, /TRADING_TOPUP_USDC|FLOOR/);
  });
  it("agent id format", () => {
    bad({ ...on, TRADER_AGENT_ID: "Hl Trader" }, /TRADER_AGENT_ID/);
  });
});

describe("trading with RUN_MODE=tee", () => {
  it("is refused: the hard limits are not part of the measurements", () => {
    const dir = mkdtempSync(join(tmpdir(), "tee-"));
    const p = join(dir, "tee.config.json");
    writeFileSync(p, JSON.stringify({ NEAR_NETWORK: "testnet", VAULT_CONTRACT_ID: "vault.testnet", AGENT_ID: "payroll", ONECLICK_BASE_URL: "https://1click.chaindefuser.com", ONECLICK_MODE: "live", DRY_RUN: "true" }));
    expect(() => loadConfig({ ...on, RUN_MODE: "tee" }, { teeConfigPath: p })).toThrow(/local-mode only/);
  });
});
