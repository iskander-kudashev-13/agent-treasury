// Look up one access key of the agent's account (Key agents): does it still exist, what can it do, how much gas allowance is left.
import { t } from "@/i18n";
import { rpcPost } from "./rpc";

export type AccessKeyInfo =
  | { state: "function-call"; allowanceYocto: string | null; receiverId: string; methods: string[] }
  | { state: "full-access" }
  | { state: "missing" };

interface RpcBody {
  result?: { permission?: unknown; error?: string };
  error?: { cause?: { name?: string }; data?: unknown; message?: string };
}

/** Pure: RPC response body -> state. Throws on anything that is not a clear answer. */
export function parseAccessKey(body: RpcBody): AccessKeyInfo {
  const err = body.error;
  if (err) {
    if (err.cause?.name === "UNKNOWN_ACCESS_KEY" || /does not exist|UNKNOWN_ACCESS_KEY/i.test(String(err.data ?? err.message ?? ""))) return { state: "missing" };
    throw new Error(String(err.data ?? err.message ?? t("net.rpcError")));
  }
  if (body.result?.error) {
    if (/does not exist/i.test(body.result.error)) return { state: "missing" };
    throw new Error(body.result.error);
  }
  const p = body.result?.permission;
  if (p === "FullAccess") return { state: "full-access" };
  const fc = (p as { FunctionCall?: { allowance?: string | null; receiver_id?: string; method_names?: string[] } } | undefined)?.FunctionCall;
  if (fc) return { state: "function-call", allowanceYocto: fc.allowance ?? null, receiverId: fc.receiver_id ?? "", methods: fc.method_names ?? [] };
  throw new Error(t("net.accessKeyUnexpected"));
}

export async function viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo> {
  const body = await rpcPost<RpcBody>({ jsonrpc: "2.0", id: "dashboard", method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey } });
  return parseAccessKey(body);
}

/** yocto -> "0.25" NEAR (up to 3 decimals). */
export function formatNear(yocto: string): string {
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = ((v % 10n ** 24n) / 10n ** 21n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
