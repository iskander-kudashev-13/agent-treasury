import { view } from "@/lib/rpc";
import { credited } from "@/lib/twoPhase";
import type { BalanceView } from "@/lib/types";
import { TwoPhaseAction } from "@/features/payouts/TwoPhaseAction";

/** Credit tokens the vault holds beyond its tracked balance (plain ft_transfer deposits). Two-phase: see TwoPhaseAction. */
export function SurplusAction() {
  return (
    <TwoPhaseAction
      method="sync_surplus"
      args={{}}
      title="Credit untracked tokens"
      startLabel="Credit untracked tokens (step 1 of 2)"
      confirmLabel="Confirm credit"
      snapshot={async () => ({ balance: (await view<BalanceView>("get_balance")).balance })}
      isCredited={(b, a) => credited("surplus", b as { balance?: string }, a as { balance?: string })}
      doneText="Untracked tokens credited to the vault balance."
      notCreditedText="Nothing untracked was found, so nothing was credited. If you just sent tokens, wait for them to arrive and start over."
    />
  );
}
