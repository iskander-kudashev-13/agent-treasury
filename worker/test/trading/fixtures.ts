import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newKey, OWNER, VAULT } from "../ai-fakes.js";
import type { ConfirmCtx } from "../../src/trading/confirm.js";
import type { HardLimits, PairInfoMap, RuleSetV1 } from "../../src/trading/types.js";

interface Vectors {
  context: { hard: HardLimits; pairs: PairInfoMap };
  valid: { input: unknown }[];
}
const vectors = JSON.parse(readFileSync(new URL("../../../docs/trading-rules-vectors.json", import.meta.url), "utf8")) as Vectors;

export const HARD = vectors.context.hard;
export const PAIRS = vectors.context.pairs;
export const HL_ACCOUNT = "0xAbCdEf0123456789aBcDeF0123456789abCDEF01";
export const AGENT = "hl-trader";
export { OWNER, VAULT };

export const tmpDir = (): string => mkdtempSync(join(tmpdir(), "trading-"));
export const baseRules = (): RuleSetV1 => structuredClone((vectors.valid[0] as { input: unknown }).input as RuleSetV1);

export interface FakeNear {
  keys: Record<string, "full" | "limited">;
  owner: string;
  rpcDown: boolean;
}

export function makeCtx(near: FakeNear): ConfirmCtx {
  return {
    vault: VAULT,
    agentId: AGENT,
    hlNetwork: "testnet",
    hlAccount: HL_ACCOUNT,
    hard: HARD,
    accessKey: (acc, pk) => (near.rpcDown ? Promise.reject(new Error("rpc down")) : Promise.resolve(near.keys[`${acc}|${pk}`] ?? "none")),
    vaultOwner: () => (near.rpcDown ? Promise.reject(new Error("rpc down")) : Promise.resolve(near.owner)),
  };
}

export const ownerKeyPair = newKey();
export const freshNear = (): FakeNear => ({ keys: { [`${OWNER}|${ownerKeyPair.publicKey}`]: "full" }, owner: OWNER, rpcDown: false });
