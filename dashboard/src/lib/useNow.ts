import { useEffect, useState } from "react";

/** Current time in ms, refreshed every `everyMs` (relative times and overdue flags stay correct on a page left open). */
export function useNow(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}
