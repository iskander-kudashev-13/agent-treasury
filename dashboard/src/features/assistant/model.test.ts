import { describe, expect, it } from "vitest";
import { buildHistory, cardId, parseNumber, parseTable, parseUpcoming, signedIds, toBatchItems, type ChatItem } from "./model";
import { parseProposal } from "@/lib/proposals";

describe("buildHistory", () => {
  it("keeps user and assistant text, merges neighbours, drops cards", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "1", text: "Add Maria" },
      { kind: "text", id: "2", text: "Which chain?", streaming: false },
      { kind: "question", id: "3", text: "Base or Solana?", options: ["Base"], answered: true },
      { kind: "data", id: "4", dataKind: "number", payload: {} },
      { kind: "user", id: "5", text: "Base" },
      { kind: "notice", id: "6", text: "oops", tone: "error" },
    ];
    expect(buildHistory(items)).toEqual([
      { role: "user", content: "Add Maria" },
      { role: "assistant", content: "Which chain?\nBase or Solana?" },
      { role: "user", content: "Base" },
    ]);
  });
  it("starts with a user message and caps the length", () => {
    expect(buildHistory([{ kind: "text", id: "1", text: "hi", streaming: false }, { kind: "user", id: "2", text: "q" }])).toEqual([{ role: "user", content: "q" }]);
    const many: ChatItem[] = Array.from({ length: 80 }, (_, i) => ({ kind: i % 2 ? "text" : "user", id: String(i), text: `m${i}`, ...(i % 2 ? { streaming: false } : {}) }) as ChatItem);
    expect(buildHistory(many, 30).length).toBeLessThanOrEqual(30);
    expect(buildHistory(many, 30)[0]?.role).toBe("user");
  });
});

describe("toBatchItems", () => {
  const p = (id: string, deps: string[] = []) =>
    parseProposal({ id, type: "PauseVault", title: id, summary: "", depends_on: deps, call: { method: "pause", args: {} }, validation: { ok: true, errors: [], warnings: [] } })!;
  it("qualifies ids by turn and only takes queued cards", () => {
    const items: ChatItem[] = [
      { kind: "proposal", id: cardId(1, "p1"), turn: 1, proposal: p("p1"), calls: [{ method: "pause", args: {} }], status: "queued", edited: false, recipientId: null, hash: null },
      { kind: "proposal", id: cardId(1, "p2"), turn: 1, proposal: p("p2", ["p1"]), calls: [{ method: "pause", args: {} }], status: "queued", edited: false, recipientId: null, hash: null },
      { kind: "proposal", id: cardId(2, "p1"), turn: 2, proposal: p("p1"), calls: [{ method: "pause", args: {} }], status: "draft", edited: false, recipientId: null, hash: null },
      { kind: "proposal", id: cardId(2, "p2"), turn: 2, proposal: p("p2"), calls: [{ method: "pause", args: {} }], status: "signed", edited: false, recipientId: null, hash: "h" },
    ];
    const b = toBatchItems(items);
    expect(b.map((x) => x.id)).toEqual(["t1:p1", "t1:p2"]);
    expect(b[1]?.depends_on).toEqual(["t1:p1"]);
    expect([...signedIds(items)]).toEqual(["t2:p2"]);
  });
});

describe("edited cards", () => {
  it("depend on the card that creates their recipient", () => {
    const mk = (id: string, type: string, method: string, args: unknown) => parseProposal({ id, type, title: id, summary: "", call: { method, args }, validation: { ok: true, errors: [], warnings: [] } })!;
    const rec = mk("p1", "AddRecipient", "add_recipient", { recipient: { label: "M", destination_chain: "base", destination_asset: "a", destination_address: "0x1" } });
    const sch = mk("p2", "AddSchedule", "add_schedule", { schedule: { recipient_id: 5, amount: "1", frequency: "Once", start_at: "1", end: "Never", agent_id: "a" } });
    const items: ChatItem[] = [
      { kind: "proposal", id: "t1:p1", turn: 1, proposal: rec, calls: [{ method: "add_recipient", args: rec.call.args }], status: "queued", edited: false, recipientId: 5, hash: null },
      { kind: "proposal", id: "t1:p2", turn: 1, proposal: sch, calls: [{ method: "add_schedule", args: { schedule: { recipient_id: 5 } } }], status: "queued", edited: true, recipientId: null, hash: null },
    ];
    expect(toBatchItems(items)[1]?.depends_on).toEqual(["t1:p1"]);
    const other: ChatItem[] = [items[0]!, { ...(items[1] as Extract<ChatItem, { kind: "proposal" }>), calls: [{ method: "add_schedule", args: { schedule: { recipient_id: 2 } } }] }];
    expect(toBatchItems(other)[1]?.depends_on).toEqual([]);
  });
});

describe("answer payloads", () => {
  it("clips the table to 5 rows and 5 columns", () => {
    const t = parseTable({ title: "Spend", columns: ["a", "b", "c", "d", "e", "f"], rows: Array.from({ length: 9 }, () => ["1", "2", "3", "4", "5", "6"]) });
    expect(t?.columns).toHaveLength(5);
    expect(t?.rows).toHaveLength(5);
    expect(t?.rows[0]).toHaveLength(5);
    expect(parseTable({ columns: [], rows: [] })).toBeNull();
    expect(parseTable("x")).toBeNull();
  });
  it("numbers: only known sources link", () => {
    expect(parseNumber({ label: "Upcoming", value: "4 300", unit: "USDC", source: "upcoming" })?.source).toBe("upcoming");
    expect(parseNumber({ label: "x", value: "1", source: "https://evil.example" })?.source).toBeNull();
    expect(parseNumber({ label: "x" })).toBeNull();
  });
  it("upcoming list", () => {
    const u = parseUpcoming({ items: [{ schedule_id: 1, recipient_id: 2, untrusted_recipient_label: "<img src=x>", agent_id: "payroll", amount_usdc: "1500", due_at: "2026-12-01", will_need_approval: true }, 7], total_usdc: "1500", balance_usdc: "100", shortfall_usdc: "1400", days_over_vault_daily_limit: [{ date: "1 Dec", total_usdc: "1500" }] });
    expect(u?.items).toHaveLength(1);
    expect(u?.items[0]?.label).toBe("<img src=x>"); // kept as text; React escapes it
    expect(u?.shortfall).toBe("1400");
    expect(u?.overLimit).toHaveLength(1);
  });
});
