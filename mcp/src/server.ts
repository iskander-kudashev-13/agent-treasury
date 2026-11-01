import { McpServer } from "@modelcontextprotocol/server";
import { createTools } from "./tools.js";
import type { ToolClient } from "./tools.js";

export const SERVER_NAME = "agent-treasury";
export const SERVER_VERSION = "0.1.0";

const INSTRUCTIONS =
  "Agent Treasury: pay from a shared USDC vault within an on-chain mandate. Amounts are in USDC. " +
  "A rejection is final; relay its detail to the user and never split amounts to bypass limits. " +
  "pending_approval means a human approves in the dashboard.";

export function buildServer(client: ToolClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  for (const t of createTools(client)) {
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
