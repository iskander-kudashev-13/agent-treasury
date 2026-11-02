import { useT } from "@/i18n";
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
  const t = useT();
  const { accountId, signIn, signAndSendTransactions } = useWallet();
  const toast = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const wallet = useUsdcBalance(accountId);
  const reg = useStorageRegistered(VAULT_ID);
  const storageMin = useStorageMin() ?? DEFAULT_STORAGE_MIN_YOCTO;

  const parsed = checkAmount(amount, wallet.data, t("fund.whatWallet"));
  const needsRegistration = reg.registered === false;
  const ready = USDC_ID !== "" && accountId !== null && parsed.raw !== null && reg.registered !== undefined && !busy;

  const submit = async () => {
    if (!parsed.raw || !accountId) return;
    setBusy(true);
    try {
      const tx = buildDepositTx({ usdcId: USDC_ID, vaultId: VAULT_ID, amount: parsed.raw, registerVaultYocto: needsRegistration ? storageMin : null });
      const out = (await signAndSendTransactions([tx])) as Parameters<typeof outcomeTxHash>[0];
      const hash = outcomeTxHash(out);
      toast({ text: t("deposit.toast", { amount: usdcGrouped(parsed.raw) }), accent: "ok", ...(hash ? { href: explorerTxUrl(hash) } : {}) });
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
      toast(/reject|cancel|denied|declin/i.test(msg) ? { text: t("deposit.cancelledToast"), accent: "neutral" } : { text: t("deposit.errorToast", { msg }), accent: "danger", durationMs: 6000 });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={t("deposit.title")}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          {accountId ? (
            <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void submit()}>
              {t("treasury.deposit")}
            </Button>
          ) : (
            <Button variant="primary" onClick={signIn}>
              {t("common.connectWallet")}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {USDC_ID === "" && <Callout accent="warn">{t("deposit.usdcNotSet")}</Callout>}
        <Field
          label={t("deposit.amount")}
          error={parsed.error}
          hint={accountId ? t("deposit.walletHolds", { amount: wallet.data === null ? "…" : usdcGrouped(wallet.data) }) : t("deposit.connectToSee")}
        >
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button size="sm" disabled={wallet.data === null} onClick={() => wallet.data && setAmount(formatUsdc(wallet.data, 6))}>
                {t("deposit.max")}
              </Button>
            </div>
          )}
        </Field>
        {needsRegistration && (
          <Callout accent="warn">
            <strong>{t("deposit.notRegisteredTitle")}</strong> {t("deposit.notRegisteredBody", { near: formatNear(storageMin) })}
          </Callout>
        )}
        <p className="m-0 text-[13px]">
          {t("deposit.note", { method: "ft_transfer_call" })}
        </p>
      </div>
    </Modal>
  );
}

/** Withdraw USDC from the vault to the owner (or another registered NEAR account). Always allowed, even when paused. */
export function WithdrawModal({ open, onClose, balance }: { open: boolean; onClose: () => void; balance: string | null }) {
  const t = useT();
  const { canAct, busy, act, ownerId } = useOwner();
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const receiver = to.trim() || ownerId;
  const reg = useStorageRegistered(open ? receiver : null);
  const parsed = checkAmount(amount, balance, t("fund.whatVault"));

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
      title={t("withdraw.title")}
      footer={
        <>
          {busy && <SigningHint />}
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={!canAct || busy || parsed.raw === null} onClick={() => void submit()} title={canAct ? t("withdraw.gasTitle") : t("treasury.onlyOwnerWithdraw")}>
            {t("treasury.withdraw")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={t("deposit.amount")} error={parsed.error} hint={balance !== null ? t("withdraw.vaultBalance", { amount: usdcGrouped(balance) }) : undefined}>
          {(a) => (
            <div className="flex gap-2">
              <Input {...a} mono inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button size="sm" disabled={balance === null} onClick={() => balance && setAmount(formatUsdc(balance, 6))}>
                {t("deposit.max")}
              </Button>
            </div>
          )}
        </Field>
        <Field label={t("withdraw.receiver")} hint={t("withdraw.receiverHint", { owner: ownerId ?? "?" })}>
          {(a) => <Input {...a} mono value={to} onChange={(e) => setTo(e.target.value)} placeholder={t("withdraw.receiverPlaceholder")} />}
        </Field>
        {receiver && reg.registered === false && <Callout accent="warn">{t("withdraw.notRegistered", { receiver })}</Callout>}
        <p className="m-0 text-[13px]">{t("withdraw.note")}</p>
      </div>
    </Modal>
  );
}
