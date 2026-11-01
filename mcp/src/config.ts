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

export function loadConfig(env: Record<string, string | undefined> = process.env): TreasuryClientConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new Error(`Invalid agent-treasury-mcp configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  if (e.ONECLICK_MODE === "simulated" && e.TREASURY_NETWORK !== "testnet") {
    throw new Error("Invalid agent-treasury-mcp configuration:\n  ONECLICK_MODE=simulated is only allowed with TREASURY_NETWORK=testnet");
  }
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
