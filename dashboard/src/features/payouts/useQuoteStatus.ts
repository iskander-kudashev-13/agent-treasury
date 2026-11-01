import { useQuery } from "@tanstack/react-query";
import { ONECLICK_URL } from "@/lib/config";
import { fetchOneClickStatus } from "@/lib/oneclickStatus";

/** 1Click `/v0/status` for a deposit address. Never cached across openings: the owner must see a fresh answer. */
export function useQuoteStatus(depositAddress: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["oneclick-status", ONECLICK_URL, depositAddress],
    queryFn: ({ signal }) => fetchOneClickStatus(depositAddress ?? "", ONECLICK_URL, { signal }),
    enabled: enabled && depositAddress !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
}
