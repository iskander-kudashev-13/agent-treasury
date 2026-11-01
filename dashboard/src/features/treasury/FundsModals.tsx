import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { formatUsdc } from "@/lib/amount";
import { explorerTxUrl, USDC_ID, VAULT_ID } from "@/lib/config";
import { usdcGrouped } from "@/lib/amount";
import { buildDepositTx, checkAmount, DEFAULT_STORAGE_MIN_YOCTO, formatNear } from "@/lib/vaultFunds";
import { usdcKeys, useStorageMin, useStorageRegistered, useUsdcBalance } from "@/lib/useTrust";
import { vaultKeys } from "@/lib/useVault";
import { Button, Callout, Field, Input, Modal, SigningHint, useToast } from "@/kit";
import { useOwner } from "@/features/owner/OwnerProvider";
import { outcomeTxHash, useWallet } from "@/features/wallet/WalletProvider";

/** Deposit USDC into the vault: `ft_transfer_call` on the USDC contract, 1 yocto, empty msg. Any connected account may fund the vault. */
export function DepositModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { accountId, signIn, signAndSendTransactions } = useWallet();
  const toast = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const wallet = useUsdcBalance(accountId);
  const reg = useStorageRegistered(VAULT_ID);
  const storageMin = useStorageMin() ?? DEFAULT_STORAGE_MIN_YOCTO;

  const parsed = checkAmount(amount, wallet.data, "USDC in your wallet");
  const needsRegistration = reg.registered === false;
  const ready = USDC_ID !== "" && accountId !== null && parsed.raw !== null && reg.registered !== undefined && !busy;

  const submit = async () => {
    if (!parsed.raw || !accountId) return;
    setBusy(true);
    try {
      const tx = buildDepositTx({ usdcId: USDC_ID, vaultId: VAULT_ID, amount: parsed.raw, registerVaultYocto: needsRegistration ? storageMin : null });
      const out = (await signAndSendTransactions([tx])) as Parameters<typeof outcomeTxHash>[0];
      const hash = outcomeTxHash(out);
      toast({ text: `Deposit of ${usdcGrouped(parsed.raw)} USDC submitted`, accent: "ok", ...(hash ? { href: explorerTxUrl(hash) } : {}) });
      const refresh = () => {
        void qc.invalidateQueries({ queryKey: vaultKeys.all });
        void qc.invalidateQueries({ queryKey: usdcKeys.all });
      };
      refresh();
      setTimeout(refresh, 2000);
      setAmount("");
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(/reject|cancel|denied|declin/i.test(msg) ? { text: "Cancelled in wallet", accent: "neutral" } : { text: `Deposit: ${msg}`, accent: "danger", durationMs: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Deposit USDC"
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {accountId ? (
            <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void submit()}>
              Deposit
            </Button>
          ) : (
            <Button variant="primary" onClick={signIn}>
              Connect wallet
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {USDC_ID === "" && <Callout accent="warn">VITE_USDC_CONTRACT is not set, so deposits are unavailable.</Callout>}
        <Field
          label="Amount (USDC)"
          error={parsed.error}
          hint={accountId ? `Your wallet holds ${wallet.data === null ? "…" : usdcGrouped(wallet.data)} USDC.` : "Connect a wallet to see your USDC balance."}
        >
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button size="sm" disabled={wallet.data === null} onClick={() => wallet.data && setAmount(formatUsdc(wallet.data, 6))}>
                Max
              </Button>
            </div>
          )}
        </Field>
        {needsRegistration && (
          <Callout accent="warn">
            <strong>The vault is not registered on the USDC contract yet.</strong> A NEP-141 token only accepts transfers to registered accounts. This deposit will first register the vault (storage deposit of about {formatNear(storageMin)} NEAR, paid by you, one time) in the same transaction.
          </Callout>
        )}
        <p className="m-0 text-[13px]">
          Funds stay in your vault contract. Only policy-approved payouts can leave. You sign <span className="mono">ft_transfer_call</span> on the USDC contract with 1 yoctoNEAR.
        </p>
      </div>
    </Modal>
  );
}

/** Withdraw USDC from the vault to the owner (or another registered NEAR account). Always allowed, even when paused. */
export function WithdrawModal({ open, onClose, balance }: { open: boolean; onClose: () => void; balance: string | null }) {
  const { canAct, busy, act, ownerId } = useOwner();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const receiver = to.trim() || ownerId;
  const reg = useStorageRegistered(open ? receiver : null);
  const parsed = checkAmount(amount, balance, "vault balance");

  const submit = async () => {
    if (!parsed.raw) return;
    if (await act("withdraw", { amount: parsed.raw, receiver_id: to.trim() || null })) {
      setAmount("");
      setTo("");
      onClose();
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Withdraw USDC"
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!canAct || busy || parsed.raw === null} onClick={() => void submit()} title={canAct ? "1 yocto, 100 TGas (the contract needs at least 60)" : "Only the vault owner can withdraw"}>
            Withdraw
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Amount (USDC)" error={parsed.error} hint={balance !== null ? `Vault balance ${usdcGrouped(balance)} USDC.` : undefined}>
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button size="sm" disabled={balance === null} onClick={() => balance && setAmount(formatUsdc(balance, 6))}>
                Max
              </Button>
            </div>
          )}
        </Field>
        <Field label="Receiver" hint={`Default: the owner (${ownerId ?? "?"}).`}>
          {(a) => <Input {...a} mono value={to} onChange={(e) => setTo(e.target.value)} placeholder="optional NEAR account id" />}
        </Field>
        {receiver && reg.registered === false && <Callout accent="warn">{receiver} is not registered on the USDC contract, so the transfer would fail. Register it first.</Callout>}
        <p className="m-0 text-[13px]">Always allowed, even while the vault is paused. Money in flight and upcoming scheduled payments are not reserved: withdrawing may leave them underfunded.</p>
      </div>
    </Modal>
  );
}
