import { describe, expect, it } from "vitest";
import { formatDay, agoText } from "./dates";

const T = Date.UTC(2026, 11, 1, 10, 0, 0); // Tue 1 Dec 2026
describe("formatDay", () => {
  it("weekday + short date, UTC", () => {
    expect(formatDay(T)).toBe("Tue 1 Dec");
    expect(formatDay(String(Date.UTC(2026, 10, 30, 23, 59)))).toBe("Mon 30 Nov");
  });
});
describe("agoText", () => {
  it("buckets", () => {
    expect(agoText(T - 10_000, T)).toBe("just now");
    expect(agoText(T - 12 * 60_000, T)).toBe("12 min ago");
    expect(agoText(T - 3 * 3_600_000, T)).toBe("3 h ago");
    expect(agoText(T - 30 * 3_600_000, T)).toBe("yesterday");
    expect(agoText(T - 5 * 86_400_000, T)).toBe("26 Nov");
    expect(agoText("0", T)).toBe("—");
  });
});
