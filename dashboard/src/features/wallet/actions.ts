import { PublicKey } from "@near-js/crypto";
import type { actionCreators } from "@near-wallet-selector/core";
import type { TxAction } from "@/lib/calls";

type Creators = typeof actionCreators;

/** wallet-agnostic `TxAction` -> wallet-selector action. */
export function toWalletAction(ac: Creators, a: TxAction) {
  switch (a.type) {
    case "CreateAccount":
      return ac.createAccount();
    case "Transfer":
      return ac.transfer(BigInt(a.yocto));
    case "AddKeyFullAccess":
      return ac.addKey(PublicKey.from(a.publicKey), ac.fullAccessKey());
    case "AddKeyFunctionCall":
      return ac.addKey(PublicKey.from(a.publicKey), ac.functionCallAccessKey(a.receiverId, a.methodNames, BigInt(a.allowanceYocto)));
    case "DeleteKey":
      return ac.deleteKey(PublicKey.from(a.publicKey));
    case "FunctionCall":
      return ac.functionCall(a.method, a.args, BigInt(a.gas), BigInt(a.deposit));
  }
}
