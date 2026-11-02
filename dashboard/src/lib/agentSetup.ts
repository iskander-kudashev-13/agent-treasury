// Pure planning for "Add agent": ids, sub-account naming, the transactions the wallet signs, and the connect snippets.
// Mirrors sdk/scripts/key-agent-plan.ts (same method list, allowance, add_agent args). No network, no secrets in plans.
import { t } from "@/i18n";
import type { TxAction, TxInput } from "./calls";
import type { Mandate } from "./types";

export const KEY_AGENT_METHODS = ["request_payment", "report_payout_status"] as const;
/** Gas allowance of the function-call key: 0.25 NEAR. */
export const ALLOWANCE_YOCTO = "250000000000000000000000";
/** Default balance of the new agent account: allowance + storage + margin (same as setup-key-agent.ts). */
export const DEFAULT_FUND_NEAR = "0.35";
export const ADD_AGENT_GAS = "30000000000000";
const YOCTO = 10n ** 24n;

/* ───────────── names ───────────── */

export const validateAgentName = (name: string): string | null => {
  const n = name.trim();
  if (n.length < 2) return t("as.nameShort");
  if (n.length > 32) return t("as.nameLong");
  return null;
};

/** "Procurement Bot!" -> "procurement-bot" (fits `^[a-z0-9-]{1,32}$`). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export function validateAgentId(id: string, existing: readonly string[] = []): string | null {
  if (!/^[a-z0-9-]{1,32}$/.test(id)) return t("as.idFormat");
  if (existing.includes(id)) return t("as.idTaken");
  return null;
}

/** One NEAR account-id part (no dots): the new sub-account prefix. */
export function validateAccountPrefix(prefix: string, owner: string): string | null {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(prefix)) return t("as.prefixFormat");
  if (prefix.length > 32) return t("as.prefixLong");
  if (`${prefix}.${owner}`.length > 64) return t("as.accountLong");
  return null;
}

export const subAccountId = (prefix: string, owner: string): string => `${prefix}.${owner}`;

/** Any valid NEAR account id (named or implicit). */
export const isNearAccountId = (s: string): boolean =>
  s.length >= 2 && s.length <= 64 && /^(?:[a-z0-9]+(?:[-_][a-z0-9]+)*\.)*[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(s);

/** 64 lowercase hex characters (the implicit account of an ed25519 key, i.e. a TEE agent's account). */
export const isImplicitAccount = (s: string): boolean => /^[0-9a-f]{64}$/.test(s);

/* ───────────── NEAR amounts ───────────── */

/** "0.35" NEAR -> yocto string. Throws on bad input. */
export function nearToYocto(input: string): string {
  const s = input.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(s)) throw new Error(t("as.nearInvalid", { value: input }));
  const [w = "0", f = ""] = s.split(".");
  return (BigInt(w) * YOCTO + BigInt(f.padEnd(24, "0"))).toString();
}

/** Minimum balance for a function-call-key account: cover at least a few payments' gas. */
export const MIN_FUND_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

export function validateFund(input: string): string | null {
  try {
    const y = BigInt(nearToYocto(input));
    if (y < MIN_FUND_YOCTO) return t("as.fundMin");
    if (y > 10n * YOCTO) return t("as.fundMax");
    return null;
  } catch {
    return t("as.fundFormat");
  }
}

/* ───────────── transactions ───────────── */

/** Wallet-agnostic action description; `features/wallet/actions.ts` turns these into wallet-selector actions. */
export type RawAction = TxAction;

export type RawTx = TxInput & { description: string };

export interface NewAgentInput {
  id: string;
  name: string;
  mandate: Mandate;
}

export interface KeyAgentPlanInput extends NewAgentInput {
  owner: string;
  vault: string;
  /** Sub-account prefix: the agent account becomes `<prefix>.<owner>`. */
  prefix: string;
  /** Public key of the freshly generated function-call key. */
  publicKey: string;
  fundNear: string;
  /** Optional full-access key for the owner (to be able to delete the agent key later). */
  ownerFullAccessKey?: string | null;
}

const addAgentCall = (args: Record<string, unknown>) =>
  ({ type: "FunctionCall", method: "add_agent", args, gas: ADD_AGENT_GAS, deposit: "1" }) as const;

/** Setup A: one transaction creates `<prefix>.<owner>` with the function-call key, a second registers the agent in the vault. */
export function planKeyAgentCreate(i: KeyAgentPlanInput): RawTx[] {
  const account = subAccountId(i.prefix, i.owner);
  const create: RawAction[] = [
    { type: "CreateAccount" },
    { type: "Transfer", yocto: nearToYocto(i.fundNear) },
    { type: "AddKeyFunctionCall", publicKey: i.publicKey, receiverId: i.vault, methodNames: [...KEY_AGENT_METHODS], allowanceYocto: ALLOWANCE_YOCTO },
  ];
  if (i.ownerFullAccessKey) create.push({ type: "AddKeyFullAccess", publicKey: i.ownerFullAccessKey });
  return [
    {
      receiverId: account,
      description: t("as.txCreateAccount", { account, near: i.fundNear }),
      actions: create,
    },
    {
      receiverId: i.vault,
      description: t("as.txRegister", { id: i.id }),
      actions: [addAgentCall({ id: i.id, name: i.name.trim(), kind: "Key", account_id: account, public_key: i.publicKey, mandate: i.mandate })],
    },
  ];
}

/** Setup B: an existing account and key; only `add_agent`. */
export function planKeyAgentExisting(i: NewAgentInput & { vault: string; accountId: string; publicKey: string | null }): RawTx[] {
  return [
    {
      receiverId: i.vault,
      description: t("as.txRegisterExisting", { id: i.id, account: i.accountId }),
      actions: [addAgentCall({ id: i.id, name: i.name.trim(), kind: "Key", account_id: i.accountId, public_key: i.publicKey, mandate: i.mandate })],
    },
  ];
}

/** TEE slot: no code hash and no account known in advance (ADR-0003 §1); an implicit account may be pinned. */
export function planTeeSlot(i: NewAgentInput & { vault: string; pinnedAccount: string | null }): RawTx[] {
  return [
    {
      receiverId: i.vault,
      description: i.pinnedAccount ? t("as.txTeePinned", { id: i.id, account: i.pinnedAccount }) : t("as.txTee", { id: i.id }),
      actions: [addAgentCall({ id: i.id, name: i.name.trim(), kind: "Tee", account_id: i.pinnedAccount, public_key: null, mandate: i.mandate })],
    },
  ];
}

/** Second revoke step for Key agents: remove its function-call key. Must be signed by an account with a full-access key on the agent account. */
export function planDeleteAgentKey(account: string, publicKey: string): RawTx {
  return { receiverId: account, description: t("as.txDeleteKey", { key: publicKey, account }), actions: [{ type: "DeleteKey", publicKey }] };
}

/* ───────────── connect snippets ───────────── */

export interface ConnectInput {
  vault: string;
  network: string;
  account: string;
  privateKey: string;
}

export const envSnippet = (c: ConnectInput): string =>
  `TREASURY_VAULT=${c.vault}\nTREASURY_NETWORK=${c.network}\nTREASURY_AGENT_ACCOUNT=${c.account}\nTREASURY_AGENT_PRIVATE_KEY=${c.privateKey}\n`;

/** `.mcp.json` / claude_desktop_config.json body (mcp/README.md). The path is a placeholder the user fills in. */
export function mcpConfig(c: ConnectInput, key: string | "env"): string {
  return JSON.stringify(
    {
      mcpServers: {
        "agent-treasury": {
          command: "node",
          args: ["/ABSOLUTE/PATH/TO/agent-treasury/mcp/dist/index.js"],
          env: {
            TREASURY_VAULT: c.vault,
            TREASURY_NETWORK: c.network,
            TREASURY_AGENT_ACCOUNT: c.account,
            TREASURY_AGENT_PRIVATE_KEY: key === "env" ? "${TREASURY_AGENT_PRIVATE_KEY}" : key,
          },
        },
      },
    },
    null,
    2,
  );
}

/** near-cli-rs command to delete the agent key, for when the dashboard wallet can't sign for the agent account. */
export const deleteKeyCommand = (account: string, publicKey: string, network: string): string =>
  `near account delete-key ${account} ${publicKey} network-config ${network} sign-with-keychain send`;

export function downloadEnv(c: ConnectInput): void {
  const url = URL.createObjectURL(new Blob([envSnippet(c)], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${c.account}.env`;
  a.click();
  URL.revokeObjectURL(url);
}
