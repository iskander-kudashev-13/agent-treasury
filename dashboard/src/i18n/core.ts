/**
 * Tiny typed i18n core (no dependencies). `en.ts` is the source of truth for keys; `ru.ts` / `uk.ts` are typed
 * `Record<MessageKey, Message>`, so a missing or extra key fails `pnpm typecheck`.
 *
 * Outside React (lib/ helpers that build display strings) call `t()`; inside components call `useT()` (same function,
 * but the provider re-mounts the tree when the language changes, so nothing renders stale text).
 */
import { en } from "./en";
import { ru } from "./ru";
import { uk } from "./uk";

export const LOCALES = ["en", "ru", "uk"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const STORAGE_KEY = "at.locale";

/** Language names are shown in their own language everywhere (never translated). */
export const LOCALE_LABELS: Record<Locale, { short: string; name: string }> = {
  en: { short: "EN", name: "English" },
  ru: { short: "RU", name: "Русский" },
  uk: { short: "UK", name: "Українська" },
};

export type MessageKey = keyof typeof en;
/** CLDR plural forms. English needs `one`/`other`; Russian and Ukrainian also `few`/`many`. `other` is always required. */
export interface PluralMessage {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}
export type Message = string | PluralMessage;
export type Messages = Record<MessageKey, Message>;
export type Params = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: Params) => string;

export const DICTIONARIES: Record<Locale, Messages> = { en, ru, uk };

export const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** Browser language -> supported locale: ru / uk by language prefix, everything else English. */
export function detectLocale(languages: readonly string[] | undefined = typeof navigator === "undefined" ? undefined : navigator.languages?.length ? navigator.languages : [navigator.language]): Locale {
  for (const l of languages ?? []) {
    const p = l.toLowerCase().split("-")[0];
    if (p === "ru" || p === "uk") return p;
    if (p === "en") return "en";
  }
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null; // storage blocked (private mode, sandboxed iframe): language is session-only
  }
}

function writeStoredLocale(l: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* storage unavailable: language is session-only */
  }
}

let current: Locale = readStoredLocale() ?? detectLocale();
if (typeof document !== "undefined") document.documentElement.lang = current;
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;

/** Switch language, remember it, notify subscribers. */
export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  writeStoredLocale(l);
  if (typeof document !== "undefined") document.documentElement.lang = l;
  listeners.forEach((fn) => fn());
}

/** Test helper / provider init: set without persisting. */
export function setLocaleSilently(l: Locale): void {
  current = l;
}

export function subscribeLocale(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
  let r = pluralRules.get(locale);
  if (!r) pluralRules.set(locale, (r = new Intl.PluralRules(locale)));
  return r.select(n);
}

/** `{name}` placeholders. Unknown placeholders are left as-is so a typo is visible, not silently empty. */
export function interpolate(msg: string, params?: Params): string {
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** The message template for `key` (plural form already chosen, placeholders untouched). */
export function template(locale: Locale, key: MessageKey, params?: { count?: number | string }): string {
  const msg: Message | undefined = DICTIONARIES[locale][key] ?? en[key];
  if (msg === undefined) return key;
  if (typeof msg === "string") return msg;
  return msg[pluralCategory(locale, Number(params?.count ?? 0))] ?? msg.other;
}

/** Translate `key` in `locale`. Plural messages pick a form from `params.count` with Intl.PluralRules. */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  return interpolate(template(locale, key, params), params);
}

/** Translate in the current locale. Usable anywhere (components, lib helpers, toasts). */
export const t: TFunction = (key, params) => translate(current, key, params);

/** BCP-47 tag for Intl date formatting. English uses en-GB so dates read "3 Dec" like the rest of the app. */
export const intlLocale = (l: Locale = current): string => (l === "en" ? "en-GB" : l);
