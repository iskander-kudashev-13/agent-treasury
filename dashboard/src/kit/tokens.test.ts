import { describe, expect, it } from "vitest";
import { avatarColor, chainColor, chainName, clamp01, formatUsdc, initials, limitTone, shortId } from "./tokens";

describe("limitTone", () => {
  it("follows the 80 % / 100 % rule", () => {
    expect(limitTone(0)).toBe("ok");
    expect(limitTone(0.79)).toBe("ok");
    expect(limitTone(0.8)).toBe("warn");
    expect(limitTone(0.99)).toBe("warn");
    expect(limitTone(1)).toBe("danger");
    expect(limitTone(3)).toBe("danger");
  });
  it("uses neutral for agents under 80 %", () => {
    expect(limitTone(0.5, "agent")).toBe("neutral");
    expect(limitTone(0.9, "agent")).toBe("warn");
  });
  it("treats NaN as zero", () => expect(limitTone(Number.NaN)).toBe("ok"));
});

describe("formatting", () => {
  it("formats USDC with 2 decimals and grouping", () => expect(formatUsdc(12480.5)).toBe("12,480.50"));
  it("shortens long ids and keeps short ones", () => {
    expect(shortId("7f3a9c00000000e41b02")).toBe("7f3a9c…1b02");
    expect(shortId("abc")).toBe("abc");
  });
  it("clamps fractions", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("chains and avatars", () => {
  it("maps known chains case-insensitively and falls back", () => {
    expect(chainColor("Base")).toBe("#3B82F6");
    expect(chainName("sol")).toBe("Solana");
    expect(chainColor("dogechain")).toBe("#8A93A3");
    expect(chainName("dogechain")).toBe("dogechain");
    expect(chainName("arb")).toBe("Arbitrum");
    expect(chainColor("arb")).toBe(chainColor("arbitrum"));
    expect(chainName("NEAR")).toBe("NEAR");
  });
  it("builds initials", () => {
    expect(initials("Maria Lopez")).toBe("ML");
    expect(initials("studio-kite.near")).toBe("SK");
    expect(initials("bob")).toBe("BO");
    expect(initials("")).toBe("?");
  });
  it("picks a stable avatar color", () => expect(avatarColor("Maria")).toBe(avatarColor("Maria")));
});
