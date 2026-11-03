import { z } from "zod";
import type { TreasuryClientConfig } from "agent-treasury-sdk";

const empty = (v: unknown) => (v === "" ? undefined : v);
const optional = z.preprocess(empty, z.string().min(1).optional());

const envSchema = z.object({
  TREASURY_VAULT: z.string().min(2),
  TREASURY_NETWORK: z.enum(["mainnet", "testnet"]),
  TREASURY_AGENT_ACCOUNT: z.string().min(2),
  /** The function-call key. Without it only the read-only tools work. */
  TREASURY_AGENT_PRIVATE_KEY: optional,
  /** Optional: skips the get_agent_by_account lookup. */
  TREASURY_AGENT_ID: optional,
  NEAR_RPC: z.preprocess(empty, z.url().optional()),
  ONECLICK_BASE_URL: z.url().default("https://1click.chaindefuser.com"),
  /** 1Click partner JWT (`Authorization: Bearer`). `ONECLICK_API_KEY` is sent separately as `X-API-Key`; set either or both. */
  ONECLICK_JWT: optional,
  ONECLICK_API_KEY: optional,
  ONECLICK_MODE: z.enum(["live", "simulated"]).default("live"),
  SIMULATED_OUTCOME: z.enum(["success", "refunded"]).default("success"),
});

/** ADR-0007 section 3: `atk1_<bot_id>_<43 base64url chars>`. */
export const AGENT_TOKEN_RE = /^atk1_([a-z0-9][a-z0-9-]{0,15})_([A-Za-z0-9_-]{43})$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The trading section (ADR-0007 section 6): one bot's agent token and the worker that executes its orders. */
export interface TradingConfig {
  workerUrl: string;
  token: string;
  /** Bot id taken from the token (for the startup line; the worker reads it from the token itself). */
  botId: string;
}

export interface McpConfig {
  /** Present iff TREASURY_VAULT is set (payments from the vault). */
  treasury: TreasuryClientConfig | null;
  /** Present iff TRADING_AGENT_TOKEN is set (agent-driven trading bot). */
  trading: TradingConfig | null;
}

const fail = (lines: string[]): never => {
  throw new Error(`Invalid agent-treasury-mcp configuration:\n${lines.map((l) => `  ${l}`).join("\n")}`);
};

function loadTreasury(env: Record<string, string | undefined>): TreasuryClientConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) fail(parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`));
  const e = (parsed as { data: z.infer<typeof envSchema> }).data;
  if (e.ONECLICK_MODE === "simulated" && e.TREASURY_NETWORK !== "testnet") fail(["ONECLICK_MODE=simulated is only allowed with TREASURY_NETWORK=testnet"]);
  return {
    vaultId: e.TREASURY_VAULT,
    network: e.TREASURY_NETWORK,
    agentAccountId: e.TREASURY_AGENT_ACCOUNT,
    agentPrivateKey: e.TREASURY_AGENT_PRIVATE_KEY,
    agentId: e.TREASURY_AGENT_ID,
    rpcUrl: e.NEAR_RPC,
    oneclick: {
      baseUrl: e.ONECLICK_BASE_URL,
      apiKey: e.ONECLICK_API_KEY,
      jwt: e.ONECLICK_JWT,
      mode: e.ONECLICK_MODE,
      simulatedOutcome: e.SIMULATED_OUTCOME,
    },
  };
}

/** Error messages never include the token value. */
function loadTrading(env: Record<string, string | undefined>, token: string): TradingConfig {
  const m = AGENT_TOKEN_RE.exec(token);
  if (m?.[1] === undefined) fail(["TRADING_AGENT_TOKEN: not an agent token (expected atk1_<bot>_<key> as shown once by the dashboard)"]);
  const raw = empty(env["TRADING_WORKER_URL"]);
  if (typeof raw !== "string") return fail(["TRADING_WORKER_URL: required when TRADING_AGENT_TOKEN is set"]);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return fail(["TRADING_WORKER_URL: not a URL"]);
  }
  // No token over plain HTTP, except to this machine.
  const okScheme = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!okScheme) fail(["TRADING_WORKER_URL: must be https://, or http:// to 127.0.0.1, localhost or [::1] (the token must not travel over plain HTTP)"]);
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") fail(["TRADING_WORKER_URL: no credentials, query or fragment"]);
  return { workerUrl: raw.replace(/\/+$/, ""), token, botId: (m as RegExpExecArray)[1] as string };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const treasury = empty(env["TREASURY_VAULT"]) !== undefined ? loadTreasury(env) : null;
  const token = empty(env["TRADING_AGENT_TOKEN"]);
  const trading = typeof token === "string" ? loadTrading(env, token) : null;
  if (treasury === null && trading === null)
    fail(["nothing to serve: set TREASURY_VAULT (+ TREASURY_NETWORK, TREASURY_AGENT_ACCOUNT) for payments, and/or TRADING_AGENT_TOKEN + TRADING_WORKER_URL for a trading bot"]);
  return { treasury, trading };
}
