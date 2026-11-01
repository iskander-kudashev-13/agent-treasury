import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("formats future and past", () => {
    expect(relativeTime(now + 4 * 86_400_000 + 5, now)).toBe("in 4 days");
    expect(relativeTime(now + 3_600_000, now)).toBe("in 1 hour");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 days ago");
    expect(relativeTime(now + 12 * 60_000, now)).toBe("in 12 minutes");
    expect(relativeTime(now + 1000, now)).toBe("just now");
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(String(now - 12 * 60_000), now)).toBe("12 minutes ago");
  });
});
