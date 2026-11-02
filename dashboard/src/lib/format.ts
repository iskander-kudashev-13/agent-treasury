import { t } from "@/i18n";
export function formatTime(ms: string | number | null | undefined): string {
  if (ms === null || ms === undefined) return t("common.never");
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return t("common.now");
  return new Date(n).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
