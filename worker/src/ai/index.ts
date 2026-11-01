import { JsonRpcProvider } from "@near-js/providers";
import type { Config } from "../config.js";
import { OneClickClient } from "../oneclick.js";
import type { OneClickPort } from "../payout-loop.js";
import { AiInfo } from "./info.js";
import { createAiRouter } from "./route.js";
import type { AiDeps } from "./route.js";

const defaultRpc = (network: Config["NEAR_NETWORK"]) => (network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com");

/** Wires the assistant: a READ-ONLY RPC provider (no keys, no signer) and the NEAR AI settings. */
export function createAiDeps(config: Config, oneclick: OneClickPort): AiDeps | undefined {
  if (!config.AI_SESSION_SECRET) {
    console.warn("AI assistant routes are NOT mounted: set AI_SESSION_SECRET (>= 32 chars) to enable /ai");
    return undefined;
  }
  const provider = new JsonRpcProvider({ url: config.NEAR_RPC_URL ?? defaultRpc(config.NEAR_NETWORK) }, { retries: 2, backoff: 2, wait: 500 });
  return {
    config: {
      apiKey: config.NEARAI_API_KEY,
      model: config.NEARAI_MODEL,
      baseUrl: config.NEARAI_BASE_URL,
      vault: config.VAULT_CONTRACT_ID,
      network: config.NEAR_NETWORK,
      rateLimitPerMin: config.AI_RATE_LIMIT_PER_MIN,
      maxMessages: config.AI_MAX_MESSAGES,
      maxMessageChars: config.AI_MAX_MESSAGE_CHARS,
      timeoutMs: config.AI_TIMEOUT_MS,
      trustProxy: config.AI_TRUST_PROXY,
      sessionSecret: config.AI_SESSION_SECRET,
    },
    view: (method, args) => provider.callFunction(config.VAULT_CONTRACT_ID, method, args),
    usdcAsset: async (chain) => {
      // Simulated 1Click (testnet reproduction) has no token list: synthesize an id it accepts.
      if (!(oneclick instanceof OneClickClient)) return `nep141:${chain}-usdc.omft.near`;
      const t = (await oneclick.getTokens()).find((x) => x.blockchain === chain && x.symbol.toUpperCase() === "USDC");
      return t?.assetId ?? null;
    },
    accessKey: async (accountId, publicKey) => {
      try {
        const k = await provider.viewAccessKey(accountId, publicKey);
        return k.permission === "FullAccess" ? "full" : "limited";
      } catch (e) {
        if (e instanceof Error && /unknown.?access.?key|does not exist|doesn.t exist/i.test(`${e.name} ${e.message} ${JSON.stringify((e as { type?: unknown }).type)}`)) return "none";
        throw e;
      }
    },
    info: new AiInfo({ baseUrl: config.NEARAI_BASE_URL, apiKey: config.NEARAI_API_KEY, model: config.NEARAI_MODEL }),
  };
}

export { createAiRouter };
export type { AiDeps };
