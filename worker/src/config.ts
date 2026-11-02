import { readFileSync } from "node:fs";
import { z } from "zod";
import { checkFundingConfig } from "./trading/funding.js";
import type { HardLimits } from "./trading/types.js";

/** Boolean env flag: only the literal strings "true" / "false" are accepted (no silent truthiness). */
const boolFlag = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
/** Human USDC decimal ("20", "0.5"): at most 6 decimals, same shape as the rules DSL. */
const decString = (def: string) => z.string().regex(/^\d+(\.\d{1,6})?$/, "expected a decimal number such as 20 or 0.5").default(def);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const baseEnvShape = z.object({
    NEAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
    /** The vault IS the Shade agent contract (docs/adr/0001). Replaces the template's AGENT_CONTRACT_ID. */
    VAULT_CONTRACT_ID: z.string().min(2),
    /** This worker is the TEE agent with this id (the owner pre-creates the slot with `add_agent`). */
    AGENT_ID: z.string().regex(/^[a-z0-9-]{1,32}$/).default("payroll"),
    NEAR_RPC_URL: z.preprocess(emptyToUndefined, z.url().optional()),
    SPONSOR_ACCOUNT_ID: optionalString,
    SPONSOR_PRIVATE_KEY: optionalString,
    /** `local` = no TEE, insecure development mode. `tee` = Phala/dstack (shade-agent-cli). */
    RUN_MODE: z.enum(["local", "tee"]).default("local"),
    LOOP_INTERVAL_MIN: z.coerce.number().positive().default(15),
    ONECLICK_BASE_URL: z.url().default("https://1click.chaindefuser.com"),
    ONECLICK_API_KEY: optionalString,
    /** `simulated` synthesizes quotes locally (1Click has no testnet). Refused on mainnet. */
    ONECLICK_MODE: z.enum(["live", "simulated"]).default("live"),
    /** Final status the simulated 1Click reports. */
    SIMULATED_OUTCOME: z.enum(["success", "refunded"]).default("success"),
    /** Default true: only dry quotes, never calls request_payout / report_payout_status. */
    DRY_RUN: boolFlag(true),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Bind address. Default localhost (audit L5); the Docker image sets 0.0.0.0. */
    HOST: z.string().min(1).default("127.0.0.1"),
    /** Bearer token for POST /run. Unset = the endpoint is disabled. */
    WORKER_ADMIN_TOKEN: optionalString,
    DASHBOARD_ORIGIN: z.string().default("http://localhost:5173"),
    HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    /** Max time to wait for a terminal 1Click status before leaving the payout `Sent` for the next run. */
    STATUS_POLL_TIMEOUT_MIN: z.coerce.number().positive().default(20),
    /** Mainnet + RUN_MODE=local (no TEE) is refused unless this is explicitly "true". */
    ALLOW_INSECURE_LOCAL_MODE: boolFlag(false),
    /** AI assistant (src/ai). Without a key, POST /ai/chat answers with an `error` event. */
    NEARAI_API_KEY: optionalString,
    NEARAI_MODEL: z.string().min(1).default("Qwen/Qwen3.6-35B-A3B-FP8"),
    NEARAI_BASE_URL: z.url().default("https://cloud-api.near.ai/v1"),
    /** HMAC secret for assistant session tokens (>= 32 chars). Unset = /ai routes are not mounted. */
    AI_SESSION_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    AI_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
    AI_MAX_MESSAGES: z.coerce.number().int().positive().default(30),
    AI_MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(4000),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
    /** Use the first X-Forwarded-For hop for rate limiting. Only behind a proxy you control. */
    AI_TRUST_PROXY: boolFlag(false),

    // ---- Hyperliquid spot trading (docs/adr/0005). Everything below is inert while TRADING_ENABLED=false. ----
    TRADING_ENABLED: boolFlag(false),
    HL_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
    /** Explicit opt-in for HL_NETWORK=mainnet (real money), like ALLOW_INSECURE_LOCAL_MODE. */
    TRADING_ALLOW_MAINNET: boolFlag(false),
    /** The owner's DEDICATED Hyperliquid account. Must equal the single `hypercore` allowlist entry of the trader mandate. */
    HL_MASTER_ADDRESS: z.preprocess(emptyToUndefined, z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected 0x + 40 hex").optional()),
    /** Tests only: otherwise the API wallet is generated into TRADING_STATE_DIR. */
    HL_API_WALLET_PRIVATE_KEY: z.preprocess(emptyToUndefined, z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x + 64 hex").optional()),
    TRADING_STATE_DIR: z.string().min(1).default("./.trading"),
    TRADER_AGENT_ID: z.string().regex(/^[a-z0-9-]{1,32}$/).default("hl-trader"),
    /** Key agent account of the trader and its function-call key (created by sdk/scripts/setup-key-agent.ts). */
    TRADER_NEAR_ACCOUNT_ID: optionalString,
    TRADER_NEAR_PRIVATE_KEY: optionalString,
    TRADING_TICK_SEC: z.coerce.number().int().min(15).max(600).default(60),
    /** Comma-separated HL spot display names, quote USDC. */
    TRADING_ALLOWED_PAIRS: z
      .string()
      .default("HYPE/USDC")
      .transform((v) => v.split(",").map((x) => x.trim()).filter((x) => x !== ""))
      .pipe(z.array(z.string().regex(/^[A-Za-z0-9]{1,16}\/USDC$/, "expected BASE/USDC")).min(1).max(3)),
    TRADING_MIN_PAIR_VOLUME_USDC: decString("1000000"),
    TRADING_HARD_MAX_POSITION_USDC: decString("50"),
    TRADING_HARD_MAX_ORDER_USDC: decString("20"),
    TRADING_HARD_DAILY_LOSS_USDC: decString("10"),
    TRADING_HARD_MAX_ORDERS_PER_DAY: z.coerce.number().int().min(1).max(50).default(20),
    /** Bots that are not archived (docs/adr/0006); the TRADING_HARD_* caps stay account totals whatever this is. */
    TRADING_MAX_BOTS: z.coerce.number().int().min(1).max(5).default(3),
    TRADING_PRICE_BAND_BPS: z.coerce.number().int().min(10).max(200).default(100),
    TRADING_DEADMAN_SEC: z.coerce.number().int().min(45).max(3600).default(180),
    TRADING_TOPUP_ENABLED: boolFlag(true),
    TRADING_TOPUP_USDC: decString("20"),
    TRADING_TOPUP_FLOOR_USDC: decString("10"),
    /** Baseline (ms epoch) for net_funded. Unset = the time of the first tick, persisted in meta.json. */
    TRADING_START_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().optional()),
});

const envSchema = baseEnvShape.superRefine((env, ctx) => {
    if (env.ONECLICK_MODE === "simulated" && env.NEAR_NETWORK !== "testnet") {
      ctx.addIssue({
        code: "custom",
        message: "ONECLICK_MODE=simulated is only allowed with NEAR_NETWORK=testnet",
        path: ["ONECLICK_MODE"],
      });
    }
    if (env.RUN_MODE === "local" && env.NEAR_NETWORK === "mainnet" && !env.ALLOW_INSECURE_LOCAL_MODE) {
      ctx.addIssue({
        code: "custom",
        message: "RUN_MODE=local on mainnet is INSECURE (no TEE); set ALLOW_INSECURE_LOCAL_MODE=true to accept that explicitly",
        path: ["RUN_MODE"],
      });
    }
    if (!env.DRY_RUN && (!env.SPONSOR_ACCOUNT_ID || !env.SPONSOR_PRIVATE_KEY)) {
      ctx.addIssue({
        code: "custom",
        message: "SPONSOR_ACCOUNT_ID and SPONSOR_PRIVATE_KEY are required when DRY_RUN=false",
        path: ["SPONSOR_ACCOUNT_ID"],
      });
    }
    if (env.TRADING_ENABLED) validateTrading(env, ctx);
});

type Env = z.infer<typeof baseEnvShape>;

/** Cross-field rules of the trading module. Only runs when TRADING_ENABLED=true. */
function validateTrading(env: Env, ctx: z.RefinementCtx): void {
  const bad = (path: string, message: string) => {
    ctx.addIssue({ code: "custom", message, path: [path] });
  };
  if (!env.AI_SESSION_SECRET) bad("AI_SESSION_SECRET", "TRADING_ENABLED=true requires AI_SESSION_SECRET (owner sessions protect the trading routes)");
  if (env.RUN_MODE === "tee") bad("TRADING_ENABLED", "trading is local-mode only for now: its hard limits are not part of the TEE measurements (ADR-0005)");
  if (!env.HL_MASTER_ADDRESS) bad("HL_MASTER_ADDRESS", "TRADING_ENABLED=true requires HL_MASTER_ADDRESS (the owner's dedicated Hyperliquid account)");
  if (env.HL_NETWORK === "mainnet" && env.HL_API_WALLET_PRIVATE_KEY)
    bad("HL_API_WALLET_PRIVATE_KEY", "HL_API_WALLET_PRIVATE_KEY is not accepted on mainnet: let the worker generate the API wallet (stored 0600 in TRADING_STATE_DIR) so the key never sits in env files");
  if (env.HL_NETWORK === "mainnet" && !env.TRADING_ALLOW_MAINNET)
    bad("HL_NETWORK", "HL_NETWORK=mainnet trades real money: set TRADING_ALLOW_MAINNET=true to accept that explicitly");
  if (env.TRADING_DEADMAN_SEC < 3 * env.TRADING_TICK_SEC) bad("TRADING_DEADMAN_SEC", "TRADING_DEADMAN_SEC must be at least 3 x TRADING_TICK_SEC");
  const micro = (v: string): bigint => {
    // Malformed values were already reported by the field schema; do not throw here.
    if (!/^\d+(\.\d{1,6})?$/.test(v)) return 0n;
    const [i = "0", f = ""] = v.split(".");
    return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, "0"));
  };
  if (micro(env.TRADING_HARD_MAX_ORDER_USDC) < 10_000_000n) bad("TRADING_HARD_MAX_ORDER_USDC", "must be at least 10 (Hyperliquid minimum order value)");
  if (micro(env.TRADING_HARD_MAX_POSITION_USDC) < micro(env.TRADING_HARD_MAX_ORDER_USDC)) bad("TRADING_HARD_MAX_POSITION_USDC", "must not be below TRADING_HARD_MAX_ORDER_USDC");
  if (micro(env.TRADING_HARD_DAILY_LOSS_USDC) <= 0n) bad("TRADING_HARD_DAILY_LOSS_USDC", "must be greater than 0");
  if (micro(env.TRADING_MIN_PAIR_VOLUME_USDC) <= 0n) bad("TRADING_MIN_PAIR_VOLUME_USDC", "must be greater than 0");
  if (env.TRADING_TOPUP_ENABLED) {
    if (!env.TRADER_NEAR_ACCOUNT_ID || !env.TRADER_NEAR_PRIVATE_KEY)
      bad("TRADER_NEAR_ACCOUNT_ID", "TRADER_NEAR_ACCOUNT_ID and TRADER_NEAR_PRIVATE_KEY are required while TRADING_TOPUP_ENABLED=true");
    const fundingErr = checkFundingConfig({ masterAddress: env.HL_MASTER_ADDRESS ?? "", topupUsdc: env.TRADING_TOPUP_USDC, floorUsdc: env.TRADING_TOPUP_FLOOR_USDC });
    if (fundingErr && env.HL_MASTER_ADDRESS) bad("TRADING_TOPUP_USDC", fundingErr);
  }
}

export type Config = z.infer<typeof envSchema>;

/** The env hard limits of the trading module in the shape the rules validator and the engine use. */
export function hardLimitsOf(c: Config): HardLimits {
  return {
    maxPositionUsdc: c.TRADING_HARD_MAX_POSITION_USDC,
    maxOrderUsdc: c.TRADING_HARD_MAX_ORDER_USDC,
    dailyLossUsdc: c.TRADING_HARD_DAILY_LOSS_USDC,
    maxOrdersPerDay: c.TRADING_HARD_MAX_ORDERS_PER_DAY,
    allowedPairs: c.TRADING_ALLOWED_PAIRS,
    minPairVolumeUsdc: c.TRADING_MIN_PAIR_VOLUME_USDC,
    priceBandBps: c.TRADING_PRICE_BAND_BPS,
  };
}

/**
 * H1: in TEE mode the values that decide where money goes come from `tee.config.json`, which is baked into the image
 * (so the image digest, and therefore the TEE measurements, pin them). The compose file repeats them as literals.
 * Env values arrive encrypted and are NOT measured, so any env value that differs from the pinned one is refused.
 */
const teePinnedSchema = z.strictObject({
  NEAR_NETWORK: z.enum(["testnet", "mainnet"]),
  VAULT_CONTRACT_ID: z.string().min(2).refine((v) => !v.includes("REPLACE"), "tee.config.json still has a placeholder"),
  AGENT_ID: z.string().regex(/^[a-z0-9-]{1,32}$/),
  ONECLICK_BASE_URL: z.url(),
  ONECLICK_MODE: z.literal("live"),
  DRY_RUN: z.enum(["true", "false"]),
});
export type TeePinned = z.infer<typeof teePinnedSchema>;

export const DEFAULT_TEE_CONFIG_PATH = "tee.config.json";

export function loadTeePinned(path: string = DEFAULT_TEE_CONFIG_PATH): TeePinned {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`RUN_MODE=tee requires ${path} baked into the image: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const parsed = teePinnedSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export interface LoadConfigOptions {
  teeConfigPath?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, opts: LoadConfigOptions = {}): Config {
  let effective = env;
  if (env.RUN_MODE === "tee") {
    const pinned = loadTeePinned(opts.teeConfigPath);
    const conflicts: string[] = [];
    for (const [key, value] of Object.entries(pinned)) {
      const given = env[key];
      if (given !== undefined && given !== "" && given !== value) conflicts.push(`${key} (env '${given}' != pinned '${value}')`);
    }
    // The RPC endpoint is not pinned by the image either: a TEE worker always uses the SDK default for its network.
    if (env.NEAR_RPC_URL) conflicts.push("NEAR_RPC_URL (not allowed in tee mode)");
    if (conflicts.length > 0) {
      throw new Error(`Refusing to start: environment overrides values pinned by tee.config.json: ${conflicts.join(", ")}`);
    }
    effective = { ...env, ...pinned };
    delete effective.NEAR_RPC_URL;
  }
  const parsed = envSchema.safeParse(effective);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid worker configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
