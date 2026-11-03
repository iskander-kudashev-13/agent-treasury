// Connect snippets for an AI-agent trading bot (ADR-0007 §7): the MCP server reads TRADING_WORKER_URL and TRADING_AGENT_TOKEN.
// Pure string builders. The token is a secret: these strings live only in React state of the Connect step and the clipboard.

export const MCP_SERVER_NAME = "agent-treasury-trading";
export const MCP_ENTRY = "/ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js";

export interface AgentConnectInput {
  workerUrl: string;
  token: string;
}

/** Shell-safe word: kept as is when it has only safe characters, otherwise single-quoted. */
const shellWord = (s: string): string => (/^[A-Za-z0-9_\-./:@=[\]]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The worker URL the MCP server should call: no trailing slash. */
export const normWorkerUrl = (u: string): string => u.trim().replace(/\/+$/, "");

/** `claude mcp add …` (Claude Code). */
export function claudeCodeCommand(c: AgentConnectInput): string {
  const url = normWorkerUrl(c.workerUrl);
  return `claude mcp add ${MCP_SERVER_NAME} -e ${shellWord(`TRADING_WORKER_URL=${url}`)} -e ${shellWord(`TRADING_AGENT_TOKEN=${c.token}`)} -- node ${MCP_ENTRY}`;
}

/** `mcpServers` JSON (Claude Desktop, Cursor, any MCP client). */
export function mcpJson(c: AgentConnectInput): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { command: "node", args: [MCP_ENTRY], env: { TRADING_WORKER_URL: normWorkerUrl(c.workerUrl), TRADING_AGENT_TOKEN: c.token } } } },
    null,
    2,
  );
}

/** https, or http on this computer: the MCP server refuses anything else (no token over plain HTTP, ADR-0007 §6). */
export function workerUrlUsable(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}
