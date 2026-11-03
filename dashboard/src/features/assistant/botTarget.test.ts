import { describe, expect, it } from "vitest";
import { makeBotId, needsBotChoice, resolveBotTarget } from "./botTarget";

const proposed = { id: "default", name: "default", is_new: false };

describe("resolveBotTarget", () => {
  it("requires a choice when the chat had no target", () => {
    expect(needsBotChoice(null)).toBe(true);
    expect(needsBotChoice("new")).toBe(false);
    expect(resolveBotTarget({ chatTarget: null, choice: null, proposed, newName: "ETH dip", takenIds: [] })).toBeNull();
  });
  it("update keeps the proposed bot", () => {
    expect(resolveBotTarget({ chatTarget: null, choice: "update", proposed, newName: "x", takenIds: [] })).toEqual({ botId: "default" });
  });
  it("create new makes a fresh id and name, never the existing one", () => {
    const r = resolveBotTarget({ chatTarget: null, choice: "new", proposed, newName: "Default", takenIds: ["default"] });
    expect(r).toEqual({ botId: "default-2", botName: "Default" });
  });
  it("create new needs a name", () => {
    expect(resolveBotTarget({ chatTarget: null, choice: "new", proposed, newName: "  ", takenIds: [] })).toBeNull();
  });
  it("explicit chat target needs no choice", () => {
    expect(resolveBotTarget({ chatTarget: "eth", choice: null, proposed: { id: "eth", name: "ETH", is_new: false }, newName: "", takenIds: [] })).toEqual({ botId: "eth" });
    expect(resolveBotTarget({ chatTarget: "new", choice: null, proposed: { id: "x", name: "X", is_new: true }, newName: "", takenIds: [] })).toEqual({ botId: "x", botName: "X" });
  });
});

describe("makeBotId", () => {
  it("slugs, caps and dedupes", () => {
    expect(makeBotId("ETH Dip Buyer / v2!", [])).toBe("eth-dip-buye");
    expect(makeBotId("Привет", [])).toBe("bot");
    expect(makeBotId("bot", ["bot", "bot-2"])).toBe("bot-3");
  });
});
