import { t } from "@/i18n";
import { RPC_URL, VAULT_ID } from "./config";

/** Read-only contract call over JSON-RPC (`query` / `call_function`). No wallet needed. */
export async function view<T>(method: string, args: Record<string, unknown> = {}, contractId = VAULT_ID): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "dashboard",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  if (!res.ok) throw new Error(t("net.rpcHttp", { status: res.status }));
  const json = (await res.json()) as { result?: { result?: number[]; error?: string }; error?: { data?: unknown; message?: string } };
  if (json.error) throw new Error(String(json.error.data ?? json.error.message ?? t("net.rpcError")));
  if (json.result?.error) throw new Error(json.result.error);
  const bytes = json.result?.result;
  if (!bytes) throw new Error(t("net.rpcEmpty"));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}
