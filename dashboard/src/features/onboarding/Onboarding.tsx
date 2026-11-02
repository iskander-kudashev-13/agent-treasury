import { useT } from "@/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useWallet } from "@/features/wallet/WalletProvider";
import { Button, Icons, Logo } from "@/kit";
import { markOnboardingDone, onboardingDone, ONBOARDING_OPEN_EVENT } from "./storage";

const STEPS = ["what", "wallet", "money", "agent"] as const;
type Step = (typeof STEPS)[number];

const ART: Record<Step, ReactNode> = {
  what: <Logo size={88} />,
  wallet: <Icons.KeyRound size={64} className="text-ok" />,
  money: <Icons.ArrowDown size={64} className="text-ok" />,
  agent: <Icons.ShieldCheck size={64} className="text-ok" />,
};

/** Short, skippable welcome flow. Shown on the first visit; reopen from Settings. Progress is not stored, only done/skipped. */
export function Onboarding() {
  const t = useT();
  const navigate = useNavigate();
  const { accountId, signIn, ready } = useWallet();
  const [open, setOpen] = useState(() => !onboardingDone());
  const [i, setI] = useState(0);
  useEffect(() => {
    const on = () => {
      setI(0);
      setOpen(true);
    };
    window.addEventListener(ONBOARDING_OPEN_EVENT, on);
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  if (!open) return null;
  const step = STEPS[i]!;
  const last = i === STEPS.length - 1;
  function finish(to?: string) {
    markOnboardingDone();
    setOpen(false);
    if (to) navigate(to);
  }
  return (
    <div role="dialog" aria-modal="true" aria-label={t("onb.title")} className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-4 backdrop-blur">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center">
        <div className="flex size-40 items-center justify-center rounded-full border border-line bg-surface">{ART[step]}</div>
        <h2 className="m-0 text-2xl font-semibold">{t(`onb.${step}.title`)}</h2>
        <p className="m-0 text-lg text-ink-muted">{t(`onb.${step}.text`)}</p>
        <div className="flex gap-2" aria-hidden="true">
          {STEPS.map((s, n) => (
            <span key={s} className={`size-2 rounded-full ${n === i ? "bg-ok" : "bg-line-strong"}`} />
          ))}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {step === "wallet" && !accountId && (
            <Button variant="primary" size="lg" disabled={!ready} onClick={signIn}>{t("common.connectWallet")}</Button>
          )}
          {step === "money" && <Button variant="primary" size="lg" onClick={() => finish("/?deposit=1")}>{t("treasury.deposit")}</Button>}
          {step === "agent" && <Button variant="primary" size="lg" onClick={() => finish("/agents/new")}>{t("page.addAgent")}</Button>}
          {!last ? (
            <Button size="lg" onClick={() => setI(i + 1)}>{t("common.next")}</Button>
          ) : (
            <Button size="lg" onClick={() => finish("/")}>{t("onb.finish")}</Button>
          )}
        </div>
        <Button variant="ghost" onClick={() => finish()}>{t("onb.skip")}</Button>
      </div>
    </div>
  );
}
