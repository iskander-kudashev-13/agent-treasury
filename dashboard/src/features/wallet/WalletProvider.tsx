import type { actionCreators as ActionCreators, FinalExecutionOutcome, SignedMessage, WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { TxInput } from "@/lib/calls";
import { NETWORK, VAULT_ID } from "@/lib/config";
import { toWalletAction } from "./actions";

/** One FunctionCall action. `deposit` / `gas` are decimal strings (yoctoNEAR / gas units), see `buildCall` in lib/calls.ts. Only used for non-owner calls (e.g. ft_transfer_call). */
export interface FunctionCallInput {
  method: string;
  args?: Record<string, unknown>;
  deposit?: string;
  gas?: string;
}
export interface CallMethodInput extends FunctionCallInput {
  /** Defaults to the vault. */
  receiverId?: string;
}
export interface SignMessageInput {
  message: string;
  /** NEP-413 recipient (e.g. the worker origin / app name). */
  recipient: string;
  /** 32 bytes; random when omitted. */
  nonce?: Uint8Array;
}

export interface WalletApi {
  /** Selector initialised and the persisted session restored (false for the first moments after load). */
  ready: boolean;
  accountId: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** Single FunctionCall transaction. Resolves with the outcome; browser-redirect wallets may leave the page instead. */
  callMethod: (input: CallMethodInput) => Promise<FinalExecutionOutcome | void>;
  /** Several transactions with any action types (FunctionCall, CreateAccount, Transfer, AddKey, DeleteKey), one wallet request. Prefer `useOwner().act/actBatch/actTxs`. */
  signAndSendTransactions: (txs: TxInput[]) => Promise<FinalExecutionOutcome[] | void>;
  /** NEP-413 message signing (assistant session). Throws if the connected wallet does not support it. */
  signMessage: (input: SignMessageInput) => Promise<SignedMessage | void>;
}

const DEFAULT_GAS = "30000000000000";
type Creators = typeof ActionCreators;
const toCallAction = (ac: Creators, c: FunctionCallInput) => ac.functionCall(c.method, c.args ?? {}, BigInt(c.gas ?? DEFAULT_GAS), BigInt(c.deposit ?? "0"));

/** Hash of the first transaction in an outcome (for explorer links). */
export const outcomeTxHash = (o: FinalExecutionOutcome | FinalExecutionOutcome[] | void): string | null => {
  const first = Array.isArray(o) ? o[0] : o;
  return first?.transaction?.hash ?? null;
};

interface Loaded {
  selector: WalletSelector;
  modal: WalletSelectorModal;
  ac: Creators;
}

// Module-level singleton: the selector must be created once per page load (StrictMode runs effects twice).
// The wallet libraries are imported dynamically so they land in their own chunk, off the first-paint path.
let selectorPromise: Promise<Loaded> | null = null;
function getSelector(): Promise<Loaded> {
  selectorPromise ??= (async () => {
    const [core, modalUi, myNear, meteor] = await Promise.all([
      import("@near-wallet-selector/core"),
      import("@near-wallet-selector/modal-ui"),
      import("@near-wallet-selector/my-near-wallet"),
      import("@near-wallet-selector/meteor-wallet"),
    ]);
    const selector = await core.setupWalletSelector({ network: NETWORK, modules: [myNear.setupMyNearWallet(), meteor.setupMeteorWallet()] });
    return { selector, modal: modalUi.setupModal(selector, { contractId: VAULT_ID, theme: "dark" }), ac: core.actionCreators };
  })();
  return selectorPromise;
}

const Ctx = createContext<WalletApi | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Loaded | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined;
    let alive = true;
    void getSelector().then((s) => {
      if (!alive) return;
      setState(s);
      sub = s.selector.store.observable.subscribe((st) => setAccountId(st.accounts.find((a) => a.active)?.accountId ?? null));
    });
    return () => {
      alive = false;
      sub?.unsubscribe();
    };
  }, []);

  const signIn = useCallback(() => state?.modal.show(), [state]);

  const signOut = useCallback(async () => {
    if (!state) return;
    const wallet = await state.selector.wallet();
    await wallet.signOut();
  }, [state]);

  const callMethod = useCallback(
    async ({ receiverId = VAULT_ID, ...call }: CallMethodInput) => {
      if (!state) throw new Error("Wallet is not ready");
      const wallet = await state.selector.wallet();
      return wallet.signAndSendTransaction({ receiverId, actions: [toCallAction(state.ac, call)] });
    },
    [state],
  );

  const signAndSendTransactions = useCallback(
    async (txs: TxInput[]) => {
      if (!state) throw new Error("Wallet is not ready");
      const wallet = await state.selector.wallet();
      return wallet.signAndSendTransactions({ transactions: txs.map((t) => ({ receiverId: t.receiverId, actions: t.actions.map((a) => toWalletAction(state.ac, a)) })) });
    },
    [state],
  );

  const signMessage = useCallback(
    async ({ message, recipient, nonce }: SignMessageInput) => {
      if (!state) throw new Error("Wallet is not ready");
      const wallet = await state.selector.wallet();
      if (!wallet.signMessage) throw new Error("This wallet does not support message signing (NEP-413)");
      return wallet.signMessage({ message, recipient, nonce: Buffer.from(nonce ?? crypto.getRandomValues(new Uint8Array(32))) });
    },
    [state],
  );

  const value = useMemo<WalletApi>(
    () => ({ ready: state !== null, accountId, signIn, signOut, callMethod, signAndSendTransactions, signMessage }),
    [state, accountId, signIn, signOut, callMethod, signAndSendTransactions, signMessage],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Wallet access for any component. Owner gating lives in `useOwner()` (features/owner). */
export function useWallet(): WalletApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet must be used inside <WalletProvider>");
  return c;
}
