/*
 * Registration plumbing derived from NearDeFi/shade-agent-template (Apache-2.0, https://github.com/NearDeFi/shade-agent-template):
 * ShadeClient.create, register loop, re-register every 6 days. Oracle logic removed; the vault is the agent contract
 * (docs/adr/0001). Modified for Agent Treasury.
 */
import { ShadeClient } from "@neardefi/shade-agent-js";
import { JsonRpcProvider } from "@near-js/providers";
import type { Config } from "./config.js";
import { NearVault } from "./vault.js";

/** Remembers the hash of the last transaction we signed, so `deposit/submit` can reference it (ShadeClient.call returns only the result). */
class RecordingProvider extends JsonRpcProvider {
  lastTxHash: string | undefined;

  override async sendTransactionUntil(...args: Parameters<JsonRpcProvider["sendTransactionUntil"]>) {
    const outcome = await super.sendTransactionUntil(...args);
    const tx: unknown = outcome.transaction;
    if (typeof tx === "object" && tx !== null && "hash" in tx && typeof tx.hash === "string") this.lastTxHash = tx.hash;
    return outcome;
  }
}

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
export const defaultRpc = (network: Config["NEAR_NETWORK"]) =>
  network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";

export interface AttestationSummary {
  composeHash: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
  osImageHash: string;
}

export interface RegistrationState {
  state: "not_started" | "pending" | "registered" | "skipped" | "error";
  lastAttemptAt?: string;
  registeredAt?: string;
  lastError?: string;
}

export interface AgentRuntime {
  accountId: string;
  vault: NearVault;
  registration: () => RegistrationState;
  /** `undefined` in local mode or when the dstack socket is unavailable. */
  attestation: () => Promise<AttestationSummary | undefined>;
  balanceNear: () => Promise<number>;
  startRegistration: () => void;
}

export async function createAgentRuntime(config: Config, log: (m: string) => void = console.log): Promise<AgentRuntime> {
  const provider = new RecordingProvider(
    { url: config.NEAR_RPC_URL ?? defaultRpc(config.NEAR_NETWORK) },
    { retries: 3, backoff: 2, wait: 1000 },
  );

  const agent = await ShadeClient.create({
    networkId: config.NEAR_NETWORK,
    agentContractId: config.VAULT_CONTRACT_ID,
    rpc: provider,
    ...(config.SPONSOR_ACCOUNT_ID && config.SPONSOR_PRIVATE_KEY
      ? { sponsor: { accountId: config.SPONSOR_ACCOUNT_ID, privateKey: config.SPONSOR_PRIVATE_KEY } }
      : {}),
    // Fixed agent account id for LOCAL mode only (insecure dev mode). In TEE the SDK derives keys inside dstack.
    ...(config.RUN_MODE === "local" && config.SPONSOR_PRIVATE_KEY ? { derivationPath: config.SPONSOR_PRIVATE_KEY } : {}),
  });
  log(`Agent account ID: ${agent.accountId()}`);

  let reg: RegistrationState = { state: "not_started" };
  const canSpend = Boolean(config.SPONSOR_ACCOUNT_ID && config.SPONSOR_PRIVATE_KEY);

  /**
   * `ShadeClient.register()` cannot be used here: it calls `register_agent({ attestation })` with a deposit and checks
   * `get_agent({ account_id })`, while this vault expects `register_agent({ agent_id, attestation })` without deposit
   * (ADR-0003 §1; the owner pre-creates the slot with `add_agent`). So we build the call ourselves from `getAttestation()`.
   */
  async function registerInSlot(): Promise<boolean> {
    const attestation = await agent.getAttestation();
    const ok: unknown = await agent.call({
      methodName: "register_agent",
      args: { agent_id: config.AGENT_ID, attestation },
      deposit: 0n,
      gas: 300_000_000_000_000n,
      waitUntil: "EXECUTED_OPTIMISTIC",
    });
    return ok === true;
  }

  async function registerOnce(): Promise<boolean> {
    reg = { ...reg, state: reg.state === "registered" ? "registered" : "pending", lastAttemptAt: new Date().toISOString() };
    try {
      const isWhitelisted = await agent.isWhitelisted();
      if (isWhitelisted === null || isWhitelisted) {
        if (await registerInSlot()) {
          reg = { state: "registered", lastAttemptAt: reg.lastAttemptAt, registeredAt: new Date().toISOString() };
          return true;
        }
      } else {
        reg = { ...reg, lastError: "agent account is not whitelisted by the vault owner (local mode)" };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const bound = msg.includes("Slot is bound to a live agent");
      reg = {
        ...reg,
        state: reg.state === "registered" ? "registered" : "error",
        lastError: bound
          ? `slot '${config.AGENT_ID}' is bound to another live agent account; the vault owner must call unbind_agent first (${msg})`
          : msg,
      };
      if (bound) log(`register_agent refused: ${reg.lastError}`);
    }
    return false;
  }

  function startRegistration(): void {
    if (config.DRY_RUN && !canSpend) {
      // Read-only dry run without a sponsor: nothing is signed, so no registration is needed.
      reg = { state: "skipped", lastError: "DRY_RUN without sponsor: registration skipped" };
      return;
    }
    void (async () => {
      try {
        if ((await agent.balance()) < 0.2 && canSpend) await agent.fund(0.3);
      } catch (e) {
        log(`funding failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Same loop as the template: retry until the agent is whitelisted (local) / attested (TEE).
      while (!(await registerOnce())) {
        log("Agent not registered yet; whitelist the agent account ID on the vault (local) or check the TEE attestation");
        await new Promise((r) => setTimeout(r, 10_000));
      }
      log("Agent registered");
      // Re-register every 6 days (attestation expires after 7).
      setInterval(() => {
        void registerOnce().then((ok) => {
          if (ok) log("Agent re-registered");
        });
      }, SIX_DAYS_MS);
    })();
  }

  const vault = new NearVault({
    view: (method, args) => provider.callFunction(config.VAULT_CONTRACT_ID, method, args),
    call: (method, args, opts) => agent.call({ methodName: method, args, gas: opts.gas, deposit: opts.deposit, waitUntil: "EXECUTED_OPTIMISTIC" }),
    takeLastTxHash: () => provider.lastTxHash,
  }, config.AGENT_ID);

  let attCache: { at: number; value: AttestationSummary | undefined } | undefined;
  return {
    accountId: agent.accountId(),
    vault,
    registration: () => reg,
    balanceNear: () => agent.balance(),
    attestation: async () => {
      if (config.RUN_MODE !== "tee") return undefined;
      if (attCache && Date.now() - attCache.at < 10 * 60_000) return attCache.value;
      let value: AttestationSummary | undefined;
      try {
        const t = (await agent.getAttestation()).tcb_info;
        value = { composeHash: t.compose_hash, rtmr0: t.rtmr0, rtmr1: t.rtmr1, rtmr2: t.rtmr2, rtmr3: t.rtmr3, osImageHash: t.os_image_hash };
      } catch {
        value = undefined;
      }
      attCache = { at: Date.now(), value };
      return value;
    },
    startRegistration,
  };
}
