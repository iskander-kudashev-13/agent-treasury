import { POLL_MS, VAULT_ID } from "@/lib/config";
export { vaultKeys } from "@/lib/useVault";

/** Same polling policy as `lib/useVault.ts`. */
export const POLL_MS_FOR_AGENTS = { refetchInterval: POLL_MS, enabled: VAULT_ID !== "", staleTime: POLL_MS / 2 } as const;
