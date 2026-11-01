/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NEAR_NETWORK?: string;
  readonly VITE_NEAR_RPC?: string;
  readonly VITE_VAULT_CONTRACT?: string;
  readonly VITE_USDC_CONTRACT?: string;
  readonly VITE_WORKER_URL?: string;
  readonly VITE_AI_ENABLED?: string;
  readonly VITE_ONECLICK_BASE_URL?: string;
  /** @deprecated use VITE_NEAR_RPC */
  readonly VITE_NEAR_RPC_URL?: string;
  /** @deprecated use VITE_VAULT_CONTRACT */
  readonly VITE_VAULT_CONTRACT_ID?: string;
}
