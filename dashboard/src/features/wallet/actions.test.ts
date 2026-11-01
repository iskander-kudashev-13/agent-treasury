import { actionCreators } from "@near-wallet-selector/core";
import { describe, expect, it } from "vitest";
import { generateAgentKey } from "@/lib/keygen";
import { toWalletAction } from "./actions";

describe("toWalletAction", () => {
  const { publicKey } = generateAgentKey();
  it("builds every action type", () => {
    const acts = [
      toWalletAction(actionCreators, { type: "CreateAccount" }),
      toWalletAction(actionCreators, { type: "Transfer", yocto: "350000000000000000000000" }),
      toWalletAction(actionCreators, { type: "AddKeyFunctionCall", publicKey, receiverId: "v.near", methodNames: ["request_payment"], allowanceYocto: "250000000000000000000000" }),
      toWalletAction(actionCreators, { type: "AddKeyFullAccess", publicKey }),
      toWalletAction(actionCreators, { type: "FunctionCall", method: "add_agent", args: { id: "a" }, gas: "30000000000000", deposit: "1" }),
      toWalletAction(actionCreators, { type: "DeleteKey", publicKey }),
    ];
    expect(acts.map((a) => a.enum)).toEqual(["createAccount", "transfer", "addKey", "addKey", "functionCall", "deleteKey"]);
  });
});
