import { readFileSync } from "node:fs";
import { z } from "zod";

/** Boolean env flag: only the literal strings "true" / "false" are accepted (no silent truthiness). */
const boolFlag = (def: boolean) =>
  z
    .enum(["true", "false"])
    .default(def ? "true" : "false")
    .transform((v) => v === "true");

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().min(1).optional());

const envSchema = z
  .object({
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
    NEARAI_MODEL: z.string().min(1).default("z-ai/glm-5.3-flash"),
    NEARAI_BASE_URL: z.url().default("https://cloud-api.near.ai/v1"),
    /** HMAC secret for assistant session tokens (>= 32 chars). Unset = /ai routes are not mounted. */
    AI_SESSION_SECRET: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
    AI_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(10),
    AI_MAX_MESSAGES: z.coerce.number().int().positive().default(30),
    AI_MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(4000),
    AI_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
    /** Use the first X-Forwarded-For hop for rate limiting. Only behind a proxy you control. */
    AI_TRUST_PROXY: boolFlag(false),
  })
  .superRefine((env, ctx) => {
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
  });

export type Config = z.infer<typeof envSchema>;

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
