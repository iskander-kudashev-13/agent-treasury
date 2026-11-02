/*
 * Derived from NearDeFi/shade-agent-template (Apache-2.0): Hono app + ShadeClient bootstrap.
 * Oracle routes replaced by the Agent Treasury payout loop. Modified for Agent Treasury.
 */
import { serve } from "@hono/node-server";
import dotenv from "dotenv";
import { createAiDeps } from "./ai/index.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { assertTestnetRpc } from "./chain-check.js";
import { createAgentRuntime, defaultRpc } from "./near.js";
import { OneClickClient } from "./oneclick.js";
import { SimulatedOneClient } from "./oneclick-simulated.js";
import { PayoutLoop } from "./payout-loop.js";
import { createTradingModule } from "./trading/index.js";

if (process.env.NODE_ENV !== "production") dotenv.config();

const config = loadConfig();
if (config.RUN_MODE === "local") {
  console.warn("WARNING: RUN_MODE=local is an INSECURE development mode (no TEE, keys derived from SPONSOR_PRIVATE_KEY).");
  if (config.NEAR_NETWORK === "mainnet") {
    console.warn("\x1b[1;31mINSECURE LOCAL MODE ON MAINNET (ALLOW_INSECURE_LOCAL_MODE=true): no TEE guarantees, whoever holds SPONSOR_PRIVATE_KEY controls the agent.\x1b[0m");
  }
}
if (config.ONECLICK_MODE === "simulated") {
  // M4: the NEAR_NETWORK label is not enough; the RPC must really be a testnet RPC.
  await assertTestnetRpc(config.NEAR_RPC_URL ?? defaultRpc(config.NEAR_NETWORK), config.VAULT_CONTRACT_ID);
}
console.log(`mode=${config.RUN_MODE} network=${config.NEAR_NETWORK} dryRun=${config.DRY_RUN} vault=${config.VAULT_CONTRACT_ID} agent=${config.AGENT_ID}`);

const runtime = await createAgentRuntime(config);
const oneclick =
  config.ONECLICK_MODE === "simulated"
    ? new SimulatedOneClient({ outcome: config.SIMULATED_OUTCOME })
    : new OneClickClient({ baseUrl: config.ONECLICK_BASE_URL, apiKey: config.ONECLICK_API_KEY, timeoutMs: config.HTTP_TIMEOUT_MS });

const loop = new PayoutLoop({
  vault: runtime.vault,
  oneclick,
  settings: {
    dryRun: config.DRY_RUN,
    vaultId: config.VAULT_CONTRACT_ID,
    agentAccountId: runtime.accountId,
    slippageBps: 100,
    quoteTtlMs: 30 * 60_000,
    approvalQuoteTtlMs: 24 * 60 * 60_000,
    pollTimeoutMs: config.STATUS_POLL_TIMEOUT_MIN * 60_000,
    pollInitialMs: 5_000,
    pollMaxMs: 30_000,
    reconcileWindow: 50,
  },
});

const ai = createAiDeps(config, oneclick);
// Hyperliquid trading module: off unless TRADING_ENABLED=true (config validation guarantees AI_SESSION_SECRET then).
const trading = config.TRADING_ENABLED && ai ? createTradingModule(config, ai) : undefined;
if (trading && ai) {
  ai.trading = trading.authoring;
  console.warn(
    `TRADING ENABLED: hl=${config.HL_NETWORK} account=${config.HL_MASTER_ADDRESS} agent=${config.TRADER_AGENT_ID} api-wallet=${trading.service.status().api_wallet.address}`,
  );
  if (config.HL_NETWORK === "mainnet") console.warn("\x1b[1;31mHYPERLIQUID MAINNET (TRADING_ALLOW_MAINNET=true): real orders, local mode, no TEE.\x1b[0m");
}

const app = createApp({
  mode: config.RUN_MODE,
  network: config.NEAR_NETWORK,
  vaultId: config.VAULT_CONTRACT_ID,
  dryRun: config.DRY_RUN,
  oneclickMode: config.ONECLICK_MODE,
  agentAccountId: runtime.accountId,
  agentId: config.AGENT_ID,
  loop,
  budget: () => runtime.vault.getAgentBudget(),
  rejections: (n) => runtime.vault.getRejections(n),
  schedules: async () => {
    const now = Date.now();
    const [due, upcoming] = await Promise.all([runtime.vault.getDue(now), runtime.vault.getUpcoming(now, now + 7 * 86_400_000, 50)]);
    return { due: due.length, upcoming: upcoming.slice(0, 5) };
  },
  registration: runtime.registration,
  attestation: runtime.attestation,
  adminToken: config.WORKER_ADMIN_TOKEN,
  dashboardOrigin: config.DASHBOARD_ORIGIN,
  ai,
  ...(trading ? { trading: trading.routeDeps } : {}),
});

runtime.startRegistration();
// The server starts right away; payout runs wait for registration (dry runs only read, so they may start at once).
loop.schedule(config.LOOP_INTERVAL_MIN * 60_000, () => config.DRY_RUN || runtime.registration().state === "registered");

trading?.service.start();

console.log(`Server starting on port ${config.PORT}...`);
serve({ fetch: app.fetch, port: config.PORT });
