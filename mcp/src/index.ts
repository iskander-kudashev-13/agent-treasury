#!/usr/bin/env node
/**
 * agent-treasury-mcp: stdio MCP server. stdout carries the protocol, so ALL logging goes to stderr.
 * Configuration: environment variables only (see README.md). Secrets are never logged.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createTreasuryClient } from "agent-treasury-sdk";
import { loadConfig } from "./config.js";
import { verifyRuntime } from "./startup.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await verifyRuntime(config);
  const client = createTreasuryClient(config);
  const server = buildServer(client);
  const shutdown = () => {
    client.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  console.error(
    `agent-treasury-mcp ready: vault=${config.vaultId} network=${config.network} agent=${config.agentAccountId} ` +
      `oneclick=${config.oneclick.mode} signing=${config.agentPrivateKey ? "enabled" : "DISABLED (read-only)"}`,
  );
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
