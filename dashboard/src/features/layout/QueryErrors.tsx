import { useT } from "@/i18n";
import { Button, Callout } from "@/kit";

export interface ErrorSource {
  label: string;
  error: string | null;
  refresh?: () => Promise<void>;
}

/**
 * One red callout for the failed views of a page (wrong contract id, RPC down). Without it a failed view looks like an
 * empty one ("No payouts yet"). Renders nothing while everything loads fine.
 */
export function QueryErrors({ sources }: { sources: ErrorSource[] }) {
  const t = useT();
  const failed = sources.filter((s) => s.error !== null);
  if (failed.length === 0) return null;
  const msg = failed[0]!.error;
  return (
    <Callout
      accent="danger"
      action={
        <Button size="sm" onClick={() => void Promise.all(failed.map((f) => f.refresh?.()))}>
          {t("common.retry")}
        </Button>
      }
    >
      {t("err.couldntLoad", { what: failed.map((f) => f.label).join(", "), msg: msg ?? "" })}
    </Callout>
  );
}
