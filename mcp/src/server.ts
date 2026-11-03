import { McpServer } from "@modelcontextprotocol/server";
import { createTools } from "./tools.js";
import type { ToolClient, ToolDef } from "./tools.js";
import { TRADING_INSTRUCTIONS, createTradingTools } from "./trading.js";
import type { TradingApi } from "./trading.js";

export const SERVER_NAME = "agent-treasury";
export const SERVER_VERSION = "0.1.0";

const TREASURY_INSTRUCTIONS =
  "Agent Treasury: pay from a shared USDC vault within an on-chain mandate. Amounts are in USDC. " +
  "A rejection is final; relay its detail to the user and never split amounts to bypass limits. " +
  "pending_approval means a human approves in the dashboard.";

/** Server instructions from the configured sections only (ADR-0007 section 6). */
export function instructionsFor(treasury: boolean, trading: boolean): string {
  return [...(treasury ? [TREASURY_INSTRUCTIONS] : []), ...(trading ? [TRADING_INSTRUCTIONS] : [])].join(" ");
}

/**
 * @param client  treasury SDK client, or null when the treasury section is not configured
 * @param trading worker API of one agent trading bot, or null when the trading section is not configured
 */
export function buildServer(client: ToolClient | null, trading: TradingApi | null = null): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructionsFor(client !== null, trading !== null) });
  const tools: ToolDef[] = [...(client !== null ? createTools(client) : []), ...(trading !== null ? createTradingTools(trading) : [])];
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.readOnly
          ? { readOnlyHint: true, openWorldHint: true }
          : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      },
      // The handler's parameter type is the tool's own schema; the SDK validates input against inputSchema before calling.
      (args: unknown) => t.handler(args as never),
    );
  }
  return server;
}
