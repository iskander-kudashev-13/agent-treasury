// Browser-side ed25519 key generation for Key agents (AGENT_ACCESS §3.5 setup A). The private key never leaves this tab.
import { KeyPair } from "@near-js/crypto";

export interface AgentKey {
  /** "ed25519:<base58>" */
  publicKey: string;
  /** "ed25519:<base58>" — show once, never persist. */
  secretKey: string;
}

export function generateAgentKey(): AgentKey {
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), secretKey: kp.toString() };
}

export const isEd25519PublicKey = (s: string): boolean => /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(s.trim());
