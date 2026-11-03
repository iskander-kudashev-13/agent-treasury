#!/usr/bin/env node
/**
 * agent-treasury-mcp: stdio MCP server. stdout carries the protocol, so ALL logging goes to stderr.
 * Configuration: environment variables only (see README.md). Secrets (the NEAR key, the trading agent token) are never logged.
 * Two optional sections: treasury payments (TREASURY_*) and one agent-driven trading bot (TRADING_*, docs/adr/0007).
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createTreasuryClient } from "agent-treasury-sdk";
import { loadConfig } from "./config.js";
import { verifyRuntime } from "./startup.js";
import { buildServer } from "./server.js";
import { createTradingApi } from "./trading.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.treasury !== null) await verifyRuntime(config.treasury);
  const client = config.treasury !== null ? createTreasuryClient(config.treasury) : null;
  const trading = config.trading !== null ? createTradingApi({ workerUrl: config.trading.workerUrl, token: config.trading.token }) : null;
  const server = buildServer(client, trading);
  const shutdown = () => {
    client?.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  const t = config.treasury;
  const parts = [
    t !== null
      ? `treasury=enabled vault=${t.vaultId} network=${t.network} agent=${t.agentAccountId} oneclick=${t.oneclick.mode} signing=${t.agentPrivateKey ? "enabled" : "DISABLED (read-only)"}`
      : "treasury=disabled",
    // Never the token: only the bot id it names.
    config.trading !== null ? `trading=enabled bot=${config.trading.botId}` : "trading=disabled",
  ];
  console.error(`agent-treasury-mcp ready: ${parts.join(" ")}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
