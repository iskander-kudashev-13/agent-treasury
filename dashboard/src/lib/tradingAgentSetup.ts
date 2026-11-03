// Connect snippets for an AI-agent trading bot (ADR-0007 §7): the MCP server reads TRADING_WORKER_URL and TRADING_AGENT_TOKEN.
// Pure string builders. The token is a secret: these strings live only in React state of the Connect step and the clipboard.

export const MCP_SERVER_NAME = "agent-treasury-trading";
/** For JSON configs (no shell): the owner replaces it with the folder path. */
export const MCP_ENTRY = "/ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js";
/** For the shell command: run from the agent-treasury folder, the shell fills in the path. */
export const MCP_ENTRY_SHELL = '"$(pwd)/mcp/dist/index.js"';

export interface AgentConnectInput {
  workerUrl: string;
  token: string;
}

/** Shell-safe word: kept as is when it has only safe characters, otherwise single-quoted. */
const shellWord = (s: string): string => (/^[A-Za-z0-9_\-./:@=[\]]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The worker URL the MCP server should call: no trailing slash. */
export const normWorkerUrl = (u: string): string => u.trim().replace(/\/+$/, "");

/**
 * `claude mcp add …` (Claude Code), run from the agent-treasury folder. It starts with a space (zsh/bash with ignorespace keep it
 * out of history: the token is a secret) and first removes an older entry, so re-adding after a new key works.
 */
export function claudeCodeCommand(c: AgentConnectInput): string {
  const url = normWorkerUrl(c.workerUrl);
  return ` claude mcp remove ${MCP_SERVER_NAME} -s local 2>/dev/null; claude mcp add ${MCP_SERVER_NAME} -e ${shellWord(`TRADING_WORKER_URL=${url}`)} -e ${shellWord(`TRADING_AGENT_TOKEN=${c.token}`)} -- node ${MCP_ENTRY_SHELL}`;
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
