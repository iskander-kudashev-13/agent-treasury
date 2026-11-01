/**
 * AGENT_ACCESS 3.5 setup A: create a Key agent for a vault.
 *
 *   OWNER_PRIVATE_KEY=ed25519:... pnpm setup-key-agent -- --owner owner.testnet --vault vault.owner.testnet \
 *       --name procurement --mandate examples/mandate.procurement.json
 *   pnpm setup-key-agent -- --owner ... --vault ... --name procurement --mandate ... --dry-run   # no key needed, nothing sent
 *
 * What it does (3 transactions, see --dry-run):
 *   1. creates <name>.<owner> if absent (owner keeps a full-access key on it, so it can delete the agent key later)
 *   2. generates an ed25519 key pair LOCALLY and adds the public key as a function-call key
 *      (receiver = vault, methods request_payment + report_payout_status, allowance 0.25 NEAR)
 *   3. vault.add_agent (kind Key) with the mandate from the JSON file (1 yoctoNEAR)
 * The private key is printed ONCE to stdout. OWNER_PRIVATE_KEY is read from the environment only and never written anywhere.
 */
import { parseArgs } from "node:util";
import { Account, JsonRpcProvider, KeyPair, nearToYocto } from "near-api-js";
import type { KeyPairString } from "near-api-js";
import {
  ALLOWANCE_YOCTO,
  AGENT_METHODS,
  DEFAULT_FUND_NEAR,
  ONE_YOCTO,
  OWNER_CALL_GAS,
  defaultRpc,
  loadMandate,
  planSetup,
  printPlan,
  subAccountId,
  validateAgentId,
  validateSubAccountName,
} from "./key-agent-plan.js";
import type { Network } from "./key-agent-plan.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    vault: { type: "string" },
    name: { type: "string" },
    "agent-id": { type: "string" },
    "display-name": { type: "string" },
    mandate: { type: "string" },
    network: { type: "string", default: "testnet" },
    rpc: { type: "string" },
    fund: { type: "string", default: DEFAULT_FUND_NEAR },
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
  const name = need(values.name, "name");
  const network = values.network;
  if (network !== "testnet" && network !== "mainnet") throw new Error('--network must be "testnet" or "mainnet"');
  const net: Network = network;
  validateSubAccountName(name);
  if (!/^\d+(\.\d+)?$/.test(values.fund)) throw new Error("--fund must be a decimal NEAR amount");
  const fundNear = values.fund as `${number}`;
  const agentId = values["agent-id"] ?? name;
  validateAgentId(agentId);
  const mandate = loadMandate(need(values.mandate, "mandate"));
  const base = { network: net, owner, vault, name, agentId, displayName: values["display-name"] ?? name, mandate, fundNear: values.fund };

  if (values["dry-run"]) {
    printPlan("setup-key-agent", planSetup(base));
    return;
  }
  if (net === "mainnet" && !values["confirm-mainnet"]) throw new Error("mainnet requires --confirm-mainnet (this spends real NEAR)");
  const ownerKeyStr = process.env.OWNER_PRIVATE_KEY;
  if (!ownerKeyStr) throw new Error("set OWNER_PRIVATE_KEY (ed25519:...) in the environment for this run");
  const ownerKey = KeyPair.fromString(ownerKeyStr as KeyPairString);

  const agentKey = KeyPair.fromRandom("ed25519");
  const publicKey = agentKey.getPublicKey().toString();
  const account = subAccountId(name, owner);
  printPlan("setup-key-agent", planSetup({ ...base, publicKey }), (s) => {
    console.error(s);
  });

  const provider = new JsonRpcProvider({ url: values.rpc ?? defaultRpc(net) });
  const ownerAcc = new Account(owner, provider, ownerKey.toString());
  try {
    let exists = true;
    try {
      await provider.viewAccount({ accountId: account });
    } catch {
      exists = false;
    }
    if (!exists) {
      console.error(`creating ${account} ...`);
      await ownerAcc.createSubAccount({ accountOrPrefix: name, publicKey: ownerKey.getPublicKey(), nearToTransfer: nearToYocto(fundNear) });
    } else {
      console.error(`${account} already exists, reusing it`);
    }
    const sub = new Account(account, provider, ownerKey.toString());
    console.error("adding function-call key ...");
    await sub.addFunctionCallAccessKey({ publicKey: agentKey.getPublicKey(), contractId: vault, methodNames: [...AGENT_METHODS], allowance: ALLOWANCE_YOCTO });
    console.error("registering agent in the vault ...");
    await ownerAcc.callFunction({
      contractId: vault,
      methodName: "add_agent",
      args: { id: agentId, name: base.displayName, kind: "Key", account_id: account, public_key: publicKey, mandate },
      gas: OWNER_CALL_GAS,
      deposit: ONE_YOCTO,
    });
  } catch (e) {
    console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`The generated public key was ${publicKey}. If it was already added to ${account}, remove it with revoke-key-agent.ts --public-key ${publicKey}.`);
    process.exitCode = 1;
    return;
  }

  console.error("\n!!! The private key below is shown ONCE and stored nowhere. Put it in the agent's environment now (TREASURY_AGENT_PRIVATE_KEY).");
  console.error("!!! It can only call request_payment / report_payout_status on the vault; the mandate caps what it can spend.\n");
  console.log(`TREASURY_VAULT=${vault}`);
  console.log(`TREASURY_NETWORK=${net}`);
  console.log(`TREASURY_AGENT_ACCOUNT=${account}`);
  console.log(`TREASURY_AGENT_PRIVATE_KEY=${agentKey.toString()}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
