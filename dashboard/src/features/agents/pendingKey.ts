// A browser-redirect wallet leaves the page while the new agent is being signed, which would lose the one-time private key.
// The key is therefore parked in sessionStorage (this tab only, never sent anywhere) until the owner confirms they saved it.
const KEY = "agent-treasury:pending-key-agent";

export interface PendingKeyAgent {
  id: string;
  name: string;
  account: string;
  publicKey: string;
  secretKey: string;
}

export function savePending(p: PendingKeyAgent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode: the key stays in memory only */
  }
}

export function loadPending(): PendingKeyAgent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingKeyAgent>;
    return typeof p.id === "string" && typeof p.account === "string" && typeof p.secretKey === "string" && typeof p.publicKey === "string" ? { id: p.id, name: p.name ?? p.id, account: p.account, publicKey: p.publicKey, secretKey: p.secretKey } : null;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
