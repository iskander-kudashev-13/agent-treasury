import { describe, expect, it } from "vitest";
import { credited, secondsLeft } from "./twoPhase";

describe("secondsLeft", () => {
  it("counts down 60 s plus margin and floors at 0", () => {
    expect(secondsLeft(0, 0)).toBe(63);
    expect(secondsLeft(0, 30_500)).toBe(33);
    expect(secondsLeft(0, 63_000)).toBe(0);
    expect(secondsLeft(0, 99_000)).toBe(0);
  });
});
describe("credited", () => {
  it("refund: flag flips", () => {
    expect(credited("refund", { refundCredited: false }, { refundCredited: true })).toBe(true);
    expect(credited("refund", { refundCredited: false }, { refundCredited: false })).toBe(false);
  });
  it("surplus: balance grows", () => {
    expect(credited("surplus", { balance: "5" }, { balance: "9" })).toBe(true);
    expect(credited("surplus", { balance: "5" }, { balance: "5" })).toBe(false);
  });
});
