/**
 * Shared planning code for setup-key-agent.ts / revoke-key-agent.ts (AGENT_ACCESS 3.5 setup A, ADR-0003 decision 8).
 * Pure functions: nothing here talks to the network or touches secrets, so `--dry-run` and the tests are safe.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";

export const AGENT_METHODS = ["request_payment", "report_payout_status"] as const;
/** Gas allowance of the function-call key: 0.25 NEAR in yocto. */
export const ALLOWANCE_YOCTO = 250_000_000_000_000_000_000_000n;
/** Initial balance of the sub-account: allowance + storage + margin. */
export const DEFAULT_FUND_NEAR = "0.35";
export const ONE_YOCTO = 1n;
export const OWNER_CALL_GAS = 30_000_000_000_000n;

const u128 = z.string().regex(/^\d+$/);
export const mandateSchema = z.strictObject({
  daily_limit: u128,
  per_tx_limit: u128,
  approval_threshold: u128,
  max_payments_per_day: z.number().int().min(1),
  allowed_chains: z.array(z.string().min(1)).min(1),
  recipients_mode: z.enum(["Allowlist", "Open"]),
  allowlist: z.array(z.strictObject({ chain: z.string(), address: z.string(), label: z.string().nullable().optional() })).default([]),
  recipients: z.array(z.number().int()).default([]),
  expires_at: u128.nullable().default(null),
});
export type MandateJson = z.infer<typeof mandateSchema>;

export function loadMandate(path: string): MandateJson {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read mandate file ${path}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const parsed = mandateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid mandate file ${path}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  const m = parsed.data;
  if (m.recipients_mode === "Allowlist" && m.allowlist.length === 0) throw new Error("recipients_mode Allowlist needs a non-empty allowlist");
  if (BigInt(m.per_tx_limit) > BigInt(m.daily_limit)) throw new Error("per_tx_limit is above daily_limit");
  return m;
}

const ACCOUNT_PART = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export function validateSubAccountName(name: string): void {
  if (!ACCOUNT_PART.test(name) || name.length > 32) throw new Error(`invalid sub-account name "${name}" (a-z, 0-9, - and _, max 32 chars)`);
}

export function validateAgentId(id: string): void {
  if (!/^[a-z0-9-]{1,32}$/.test(id)) throw new Error(`invalid agent id "${id}" (^[a-z0-9-]{1,32}$)`);
}

export type Network = "mainnet" | "testnet";

export interface SetupOptions {
  network: Network;
  owner: string;
  vault: string;
  name: string;
  agentId: string;
  displayName: string;
  mandate: MandateJson;
  fundNear: string;
  /** Set only when actually executing; the dry run shows a placeholder. */
  publicKey?: string;
}

export interface PlannedTx {
  signer: string;
  receiver: string;
  description: string;
  /** Shown to the human; never contains private keys. */
  details: unknown;
}

export const subAccountId = (name: string, owner: string): string => `${name}.${owner}`;

export function planSetup(o: SetupOptions): PlannedTx[] {
  const account = subAccountId(o.name, o.owner);
  const pk = o.publicKey ?? "<ed25519 public key generated locally at run time>";
  return [
    {
      signer: o.owner,
      receiver: account,
      description: `create sub-account ${account} if it does not exist (owner's public key as full-access key, ${o.fundNear} NEAR)`,
      details: { actions: ["CreateAccount", `Transfer ${o.fundNear} NEAR`, "AddKey(owner full access)"] },
    },
    {
      signer: account,
      receiver: account,
      description: `add function-call key restricted to ${o.vault}`,
      details: { public_key: pk, receiver_id: o.vault, method_names: [...AGENT_METHODS], allowance_yocto: ALLOWANCE_YOCTO.toString(), allowance_near: "0.25" },
    },
    {
      signer: o.owner,
      receiver: o.vault,
      description: "vault.add_agent (kind Key)",
      details: {
        method: "add_agent",
        deposit: "1 yoctoNEAR",
        gas: "30 TGas",
        args: { id: o.agentId, name: o.displayName, kind: "Key", account_id: account, public_key: pk, mandate: o.mandate },
      },
    },
  ];
}

export interface RevokeOptions {
  network: Network;
  owner: string;
  vault: string;
  agentId: string;
  account: string;
  publicKey: string;
}

export function planRevoke(o: RevokeOptions): PlannedTx[] {
  return [
    {
      signer: o.owner,
      receiver: o.vault,
      description: `vault.revoke_agent (terminal, immediate): ${o.agentId}`,
      details: { method: "revoke_agent", deposit: "1 yoctoNEAR", gas: "30 TGas", args: { agent_id: o.agentId } },
    },
    {
      signer: o.account,
      receiver: o.account,
      description: `delete access key ${o.publicKey} from ${o.account}`,
      details: { actions: [`DeleteKey(${o.publicKey})`] },
    },
  ];
}

export function printPlan(title: string, txs: PlannedTx[], out: (s: string) => void = (s) => {
    console.log(s);
  }): void {
  out(`# ${title} (DRY RUN: nothing is sent)`);
  txs.forEach((t, i) => {
    out(`\n${i + 1}. ${t.description}\n   signer: ${t.signer}   receiver: ${t.receiver}\n${JSON.stringify(t.details, null, 2).replace(/^/gm, "   ")}`);
  });
}

export function defaultRpc(network: Network): string {
  return network === "testnet" ? "https://test.rpc.fastnear.com" : "https://free.rpc.fastnear.com";
}
