import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentNote } from "@/features/trading/bot/AgentActivity";
import { claudeCodeCommand, MCP_ENTRY, mcpJson, workerUrlUsable } from "./tradingAgentSetup";
import type { LogEntry } from "./tradingClient";
import { AGENT_CODES, agentCodeText, agentDecisions, TRANSIENT_CODES } from "./tradingSkips";

const TOKEN = `atk1_purr-agent_${"aB3-_".repeat(8)}xyz`;

describe("connect snippets (ADR-0007 §7)", () => {
  it("Claude Code command is the ADR text", () => {
    expect(claudeCodeCommand({ workerUrl: "http://127.0.0.1:3000/", token: TOKEN })).toBe(
      `claude mcp add agent-treasury-trading -e TRADING_WORKER_URL=http://127.0.0.1:3000 -e TRADING_AGENT_TOKEN=${TOKEN} -- node ${MCP_ENTRY}`,
    );
  });
  it("quotes a worker URL with shell characters", () => {
    expect(claudeCodeCommand({ workerUrl: "https://w.example/a b", token: TOKEN })).toContain("'TRADING_WORKER_URL=https://w.example/a b'");
  });
  it("JSON config carries both env vars", () => {
    const j = JSON.parse(mcpJson({ workerUrl: "https://w.example", token: TOKEN })) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(j.mcpServers["agent-treasury-trading"]).toEqual({ command: "node", args: [MCP_ENTRY], env: { TRADING_WORKER_URL: "https://w.example", TRADING_AGENT_TOKEN: TOKEN } });
  });
  it("worker URL must be https or loopback http (the MCP server refuses others)", () => {
    expect(workerUrlUsable("https://w.example")).toBe(true);
    expect(workerUrlUsable("http://127.0.0.1:3000")).toBe(true);
    expect(workerUrlUsable("http://localhost:3000")).toBe(true);
    expect(workerUrlUsable("http://[::1]:3000")).toBe(true);
    expect(workerUrlUsable("http://192.168.1.5:3000")).toBe(false);
    expect(workerUrlUsable("")).toBe(false);
  });
});

describe("agent decisions", () => {
  const log: LogEntry[] = [
    { at_ms: 3, kind: "skip", detail: "MAX_ORDER: 100 > 12", source: "agent", code: "MAX_ORDER", note: "big buy" },
    { at_ms: 2, kind: "skip", detail: "COOLDOWN: x", rule_id: "dip" },
    { at_ms: 1, kind: "order", detail: "buy 14 PURR", source: "agent", note: "dip" },
    { at_ms: 0, kind: "skip", detail: "PAIR_NOT_IN_RULES: HYPE", source: "agent" },
  ];
  it("keeps only the agent's placed/refused entries, code from the field or the detail prefix", () => {
    expect(agentDecisions(log)).toEqual([
      { at_ms: 3, placed: false, code: "MAX_ORDER", note: "big buy" },
      { at_ms: 1, placed: true, code: null, note: "dip" },
      { at_ms: 0, placed: false, code: "PAIR_NOT_IN_RULES", note: null },
    ]);
  });
  it("every code has plain words, never the raw code", () => {
    for (const c of [...AGENT_CODES, ...TRANSIENT_CODES]) {
      const s = agentCodeText(c);
      expect(s).not.toContain(c);
      expect(s).not.toMatch(/^trading\./);
    }
    expect(agentCodeText("SOMETHING_NEW")).toBe("Refused by a safety check");
    expect(agentCodeText(null)).toBe("Refused by a safety check");
  });
});

describe("agent note rendering", () => {
  it("renders untrusted note text literally (no HTML)", () => {
    const html = renderToStaticMarkup(createElement(AgentNote, { note: "<img src=x onerror=alert(1)> **bold** [x](http://e)" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("**bold** [x](http://e)");
    expect(html).not.toContain("<a ");
  });
});
