export function formatTime(ms: string | number | null | undefined): string {
  if (ms === null || ms === undefined) return "never";
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "now";
  return new Date(n).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
