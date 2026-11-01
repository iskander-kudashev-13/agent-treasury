/**
 * Revokes a Key agent: vault.revoke_agent (terminal, immediate), then deletes its function-call key from the agent account.
 *
 *   OWNER_PRIVATE_KEY=ed25519:... pnpm revoke-key-agent -- --owner owner.testnet --vault vault.owner.testnet \
 *       --agent-id procurement --public-key ed25519:...
 *   ... --dry-run     # prints the planned transactions, sends nothing
 * Deleting the key needs a full-access key on the agent account (setup-key-agent.ts leaves the owner's key there).
 */
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import { ONE_YOCTO, OWNER_CALL_GAS, defaultRpc, planRevoke, printPlan, subAccountId, validateAgentId } from "./key-agent-plan.js";
import type { Network } from "./key-agent-plan.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    vault: { type: "string" },
    "agent-id": { type: "string" },
    account: { type: "string" },
    "public-key": { type: "string" },
    network: { type: "string", default: "testnet" },
    rpc: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "confirm-mainnet": { type: "boolean", default: false },
  },
});

function need(v: string | undefined, flag: string): string {
  if (!v) throw new Error(`missing --${flag}`);
  return v;
}

async function main(): Promise<void> {
  const owner = need(values.owner ?? process.env.OWNER_ACCOUNT_ID, "owner");
  const vault = need(values.vault, "vault");
  const agentId = need(values["agent-id"], "agent-id");
  validateAgentId(agentId);
  const publicKey = need(values["public-key"], "public-key");
  const network = values.network;
  if (network !== "testnet" && network !== "mainnet") throw new Error('--network must be "testnet" or "mainnet"');
  const net: Network = network;
  const account = values.account ?? subAccountId(agentId, owner);
  const plan = planRevoke({ network: net, owner, vault, agentId, account, publicKey });

  if (values["dry-run"]) {
    printPlan("revoke-key-agent", plan);
    return;
  }
  if (net === "mainnet" && !values["confirm-mainnet"]) throw new Error("mainnet requires --confirm-mainnet");
  const ownerKeyStr = process.env.OWNER_PRIVATE_KEY;
  if (!ownerKeyStr) throw new Error("set OWNER_PRIVATE_KEY (ed25519:...) in the environment for this run");
  const ownerKey = KeyPair.fromString(ownerKeyStr as KeyPairString);
  const provider = new JsonRpcProvider({ url: values.rpc ?? defaultRpc(net) });

  printPlan("revoke-key-agent", plan, (s) => {
    console.error(s);
  });
  // Revoke on the vault first: it is the authoritative, immediate kill switch.
  await new Account(owner, provider, ownerKey.toString()).callFunction({
    contractId: vault,
    methodName: "revoke_agent",
    args: { agent_id: agentId },
    gas: OWNER_CALL_GAS,
    deposit: ONE_YOCTO,
  });
  console.error("agent revoked in the vault");
  await new Account(account, provider, ownerKey.toString()).deleteKey(publicKey);
  console.error("access key deleted");
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
