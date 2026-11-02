const KEY = "at.onboarding";
const OPEN_EVENT = "at:onboarding-open";

/** True once the welcome flow was finished or skipped. Storage failures count as "not done" (it just shows again). */
export function onboardingDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "done";
  } catch {
    return false;
  }
}
export function markOnboardingDone(): void {
  try {
    localStorage.setItem(KEY, "done");
  } catch {
    /* storage unavailable: session-only */
  }
}
export const reopenOnboarding = (): void => void window.dispatchEvent(new Event(OPEN_EVENT));
export const ONBOARDING_OPEN_EVENT = OPEN_EVENT;
