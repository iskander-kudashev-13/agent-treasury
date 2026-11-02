import { Fragment, useCallback, useSyncExternalStore, type ReactNode } from "react";
import { getLocale, LOCALE_LABELS, LOCALES, setLocale, subscribeLocale, t, template, type Locale, type MessageKey, type TFunction } from "./core";

function useLocaleStore(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/**
 * Re-mounts everything below it when the language changes. Many display strings are built in lib/ helpers
 * (`describeMandate`, `payoutStatusInfo`, …) and in memoised closures; a remount guarantees none of them stays stale.
 * Open forms/modals reset on a language switch (rare, deliberate action).
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useLocaleStore();
  return <Fragment key={locale}>{children}</Fragment>;
}

/** Current language + setter. */
export function useLocale(): [Locale, (l: Locale) => void] {
  return [useLocaleStore(), setLocale];
}

/** `const t = useT(); t("nav.treasury")`, `t("agents.count", { count: 3 })`. */
export function useT(): TFunction {
  const locale = useLocaleStore();
  // Stable identity per locale so it can sit in hook dependency lists.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useCallback<TFunction>((key, params) => t(key, params), [locale]);
}

/** EN / RU / UK segmented control for the header. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const [locale, set] = useLocale();
  return (
    <div role="group" aria-label={t("lang.label")} className={`inline-flex overflow-hidden rounded-input border border-line text-xs ${className ?? ""}`}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          title={LOCALE_LABELS[l].name}
          aria-pressed={locale === l}
          onClick={() => set(l)}
          className={`cursor-pointer px-2 py-1 ${locale === l ? "bg-surface-hover font-semibold text-ink" : "text-ink-muted hover:text-ink"}`}
        >
          {LOCALE_LABELS[l].short}
        </button>
      ))}
    </div>
  );
}

/**
 * Like `t()`, but placeholders may be React nodes: `rich("x.key", { id: <span className="mono">{id}</span> })`.
 * Use it where a translated sentence has styled or linked parts. Placeholder values are never parsed as markup.
 */
export function rich(key: MessageKey, params: Record<string, ReactNode>): ReactNode {
  const count = typeof params.count === "number" || typeof params.count === "string" ? params.count : undefined;
  const tpl = template(getLocale(), key, count === undefined ? undefined : { count });
  return tpl
    .split(/(\{\w+\})/g)
    .filter((part) => part !== "")
    .map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      const name = m?.[1];
      return <Fragment key={i}>{name !== undefined && name in params ? params[name] : part}</Fragment>;
    });
}
