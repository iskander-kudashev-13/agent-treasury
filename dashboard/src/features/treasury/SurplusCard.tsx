import { useT } from "@/i18n";
import { view } from "@/lib/rpc";
import { credited } from "@/lib/twoPhase";
import type { BalanceView } from "@/lib/types";
import { TwoPhaseAction } from "@/features/payouts/TwoPhaseAction";

/** Credit tokens the vault holds beyond its tracked balance (plain ft_transfer deposits). Two-phase: see TwoPhaseAction. */
export function SurplusAction() {
  const t = useT();
  return (
    <TwoPhaseAction
      method="sync_surplus"
      args={{}}
      title={t("surplus.title")}
      startLabel={t("surplus.start")}
      confirmLabel={t("surplus.confirm")}
      snapshot={async () => ({ balance: (await view<BalanceView>("get_balance")).balance })}
      isCredited={(b, a) => credited("surplus", b as { balance?: string }, a as { balance?: string })}
      doneText={t("surplus.done")}
      notCreditedText={t("surplus.none")}
    />
  );
}
