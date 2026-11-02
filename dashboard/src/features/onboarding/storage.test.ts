import { beforeEach, describe, expect, it, vi } from "vitest";
import { markOnboardingDone, onboardingDone } from "./storage";

describe("onboarding storage", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) });
  });
  it("remembers done", () => {
    expect(onboardingDone()).toBe(false);
    markOnboardingDone();
    expect(onboardingDone()).toBe(true);
  });
  it("treats broken storage as not done", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(onboardingDone()).toBe(false);
    expect(() => markOnboardingDone()).not.toThrow();
  });
});
