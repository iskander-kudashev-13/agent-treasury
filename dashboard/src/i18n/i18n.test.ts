import { createElement, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DICTIONARIES, detectLocale, getLocale, interpolate, intlLocale, LOCALES, readStoredLocale, setLocale, setLocaleSilently, STORAGE_KEY, subscribeLocale, t, translate, type Locale, type Message, type MessageKey } from "./core";
import { en } from "./en";
import { rich } from "./react";
import { ru } from "./ru";
import { uk } from "./uk";
import { describeFrequency, shortDate } from "@/lib/frequency";
import { formatDay } from "@/lib/dates";
import { describeMandate } from "@/lib/describeMandate";
import { relativeTime } from "@/lib/relativeTime";
import type { Mandate } from "@/lib/types";

const keys = Object.keys(en) as MessageKey[];
const forms = (m: Message): string[] => (typeof m === "string" ? [m] : Object.values(m).filter((v): v is string => typeof v === "string"));
const placeholders = (m: Message): string[] => [...new Set(forms(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!)))].sort();

/** Keys whose placeholders legitimately differ between languages (English needs an ordinal suffix, Slavic languages do not). */
const PLACEHOLDER_EXCEPTIONS = new Set<MessageKey>(["freq.monthly"]);

afterEach(() => {
  setLocaleSilently("en");
  vi.unstubAllGlobals();
});

describe("dictionaries", () => {
  it("ru and uk define exactly the keys of en", () => {
    expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(uk).sort()).toEqual(Object.keys(en).sort());
  });

  it("every message is non-empty", () => {
    for (const l of LOCALES) for (const k of keys) for (const f of forms(DICTIONARIES[l][k])) expect(f.trim(), `${l}:${k}`).not.toBe("");
  });

  it("plural messages stay plural in every language, with the CLDR forms of that language", () => {
    for (const k of keys) {
      const e = en[k] as Message;
      if (typeof e === "string") continue;
      for (const l of ["ru", "uk"] as const) {
        const m = DICTIONARIES[l][k];
        // A plain string is allowed where the sentence does not need agreement (the count is placed at the end).
        if (typeof m === "string") continue;
        expect(Object.keys(m).sort(), `${l}:${k}`).toEqual(["few", "many", "one", "other"]);
      }
      expect(Object.keys(e).sort(), `en:${k}`).toEqual(["one", "other"]);
    }
  });

  it("a plural English message always receives {count}", () => {
    for (const k of keys) {
      const e = en[k] as Message;
      if (typeof e !== "string") expect(placeholders(e), k).toContain("count");
    }
  });

  it("interpolation placeholders match across languages", () => {
    for (const k of keys) {
      if (PLACEHOLDER_EXCEPTIONS.has(k)) continue;
      const base = placeholders(en[k] as Message);
      for (const l of ["ru", "uk"] as const) expect(placeholders(DICTIONARIES[l][k]), `${l}:${k}`).toEqual(base);
    }
  });

  it("bold markers (**) are balanced and identical in count across languages", () => {
    for (const k of keys.filter((x) => x.startsWith("m."))) {
      const n = (m: Message) => Math.max(...forms(m).map((f) => f.split("**").length - 1));
      for (const l of LOCALES) expect(n(DICTIONARIES[l][k]) % 2, `${l}:${k}`).toBe(0);
    }
  });
});

describe("t / interpolation", () => {
  it("interpolates {name} and leaves unknown placeholders visible", () => {
    expect(interpolate("Hello {name}, {n} items", { name: "Ann", n: 3 })).toBe("Hello Ann, 3 items");
    expect(interpolate("Hello {who}", { name: "Ann" })).toBe("Hello {who}");
    expect(interpolate("plain")).toBe("plain");
  });

  it("does not re-interpolate values (untrusted text stays literal)", () => {
    expect(translate("en", "common.cancel", { x: "y" })).toBe("Cancel");
    expect(translate("en", "owner.error", { label: "{msg}", msg: "boom" })).toBe("{msg}: boom");
  });

  it("t() follows the current locale", () => {
    expect(t("common.cancel")).toBe("Cancel");
    setLocaleSilently("ru");
    expect(t("common.cancel")).toBe("Отмена");
    setLocaleSilently("uk");
    expect(t("common.cancel")).toBe("Скасувати");
  });
});

describe("plurals", () => {
  const days = (l: Locale, n: number) => translate(l, "time.days", { count: n });
  it("English: one / other", () => {
    expect([1, 2, 0].map((n) => days("en", n))).toEqual(["1 day", "2 days", "0 days"]);
  });
  it("Russian: one / few / many", () => {
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 100, 101].map((n) => days("ru", n))).toEqual(["1 день", "2 дня", "4 дня", "5 дней", "11 дней", "12 дней", "14 дней", "21 день", "22 дня", "25 дней", "100 дней", "101 день"]);
  });
  it("Ukrainian: one / few / many", () => {
    expect([1, 2, 4, 5, 11, 12, 21, 22, 25].map((n) => days("uk", n))).toEqual(["1 день", "2 дні", "4 дні", "5 днів", "11 днів", "12 днів", "21 день", "22 дні", "25 днів"]);
  });
  it("a plural message that is a plain string in a language is used for every count", () => {
    expect(translate("ru", "treasury.missed", { count: 1 })).toBe("Пропущено запланированных платежей: 1");
    expect(translate("ru", "treasury.missed", { count: 5 })).toBe("Пропущено запланированных платежей: 5");
    expect(translate("en", "treasury.missed", { count: 1 })).toBe("Missed 1 scheduled payment");
    expect(translate("en", "treasury.missed", { count: 3 })).toBe("Missed 3 scheduled payments");
  });
  it("payments counter agrees in Russian", () => {
    expect([1, 3, 7].map((n) => translate("ru", "upcoming.paymentsCount", { count: n }))).toEqual(["1 платёж", "3 платежа", "7 платежей"]);
  });
});

describe("language detection and persistence", () => {
  const store = () => {
    const data = new Map<string, string>();
    return { data, api: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } };
  };
  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { lang: "" } });
  });

  it("detects ru / uk from navigator languages, otherwise en", () => {
    expect(detectLocale(["ru-RU", "en"])).toBe("ru");
    expect(detectLocale(["uk-UA"])).toBe("uk");
    expect(detectLocale(["UK"])).toBe("uk");
    expect(detectLocale(["en-US", "ru"])).toBe("en");
    expect(detectLocale(["de-DE", "ru"])).toBe("ru"); // first supported preference wins
    expect(detectLocale(["de-DE", "fr"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });

  it("setLocale persists the choice, updates <html lang> and notifies subscribers", () => {
    const s = store();
    vi.stubGlobal("localStorage", s.api);
    const seen: Locale[] = [];
    const off = subscribeLocale(() => seen.push(getLocale()));
    setLocale("uk");
    expect(getLocale()).toBe("uk");
    expect(s.data.get(STORAGE_KEY)).toBe("uk");
    expect(readStoredLocale()).toBe("uk");
    expect((globalThis as unknown as { document: { documentElement: { lang: string } } }).document.documentElement.lang).toBe("uk");
    setLocale("uk"); // no change: no notification
    setLocale("en");
    expect(s.data.get(STORAGE_KEY)).toBe("en");
    expect(seen).toEqual(["uk", "en"]);
    off();
    setLocale("ru");
    expect(seen).toHaveLength(2);
  });

  it("ignores an invalid stored value", () => {
    const s = store();
    s.data.set(STORAGE_KEY, "de");
    vi.stubGlobal("localStorage", s.api);
    expect(readStoredLocale()).toBeNull();
  });

  it("survives blocked storage (every access throws)", () => {
    const boom = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    expect(readStoredLocale()).toBeNull();
    expect(() => setLocale("ru")).not.toThrow();
    expect(getLocale()).toBe("ru"); // the language still switches for this session
  });
});

describe("rich()", () => {
  it("puts React nodes into placeholders and keeps the text around them", () => {
    const node = createElement("b", null, "X");
    const out = rich("ag.lastRequest", { when: node }) as unknown[];
    const flat = out.flat();
    expect(flat.some((n) => isValidElement(n))).toBe(true);
    setLocaleSilently("ru");
    const ru = rich("ag.lastRequest", { when: "вчера" }) as { props: { children: string } }[];
    expect(ru.map((n) => n.props.children).join("")).toBe("последний запрос: вчера");
  });
});

describe("locale-aware formatting", () => {
  const dec3 = Date.UTC(2026, 11, 3, 9, 0);
  it("short dates: English table, Intl for other languages (UTC)", () => {
    expect(shortDate(dec3)).toBe("3 Dec");
    setLocaleSilently("ru");
    expect(shortDate(dec3)).toMatch(/^3 дек/);
    setLocaleSilently("uk");
    expect(shortDate(dec3)).toMatch(/^3 груд/);
    expect(intlLocale("en")).toBe("en-GB");
  });
  it("weekday + date", () => {
    expect(formatDay(dec3)).toBe("Thu 3 Dec");
    setLocaleSilently("ru");
    expect(formatDay(dec3)).toMatch(/^чт 3 дек/);
  });
  it("frequency sentences agree with the weekday", () => {
    const weekly = (d: number) => describeFrequency({ Weekly: { weekday: d } }, 0);
    expect(weekly(3)).toBe("Every Wednesday");
    setLocaleSilently("ru");
    expect([1, 3, 5, 0].map(weekly)).toEqual(["Каждый понедельник", "Каждую среду", "Каждую пятницу", "Каждое воскресенье"]);
    expect(describeFrequency({ EveryNDays: { n: 21 } }, 0)).toBe("Каждые 21 день");
    setLocaleSilently("uk");
    expect(describeFrequency("Once", dec3)).toMatch(/^Один раз, 3 груд/);
  });
  it("relative time uses plural forms", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now + 3 * 86_400_000, now)).toBe("in 3 days");
    setLocaleSilently("ru");
    expect(relativeTime(now + 3 * 86_400_000, now)).toBe("через 3 дня");
    expect(relativeTime(now - 5 * 86_400_000, now)).toBe("5 дней назад");
    expect(relativeTime(null, now)).toBe("никогда");
  });
  it("amounts keep en-style digits in every language (documented decision)", async () => {
    const { usdcGrouped, parseUsdc } = await import("@/lib/amount");
    setLocaleSilently("ru");
    expect(usdcGrouped("12480500000")).toBe("12,480.50");
    expect(parseUsdc("12.5")).toBe("12500000");
  });
});

describe("mandate sentence", () => {
  const m: Mandate = {
    daily_limit: "200000000",
    per_tx_limit: "50000000",
    approval_threshold: "30000000",
    allowed_chains: ["base", "sol"],
    recipients_mode: "Open",
    allowlist: [],
    recipients: [],
    expires_at: null,
    max_payments_per_day: 10,
  };
  it("is built per language without leaking bold markers", () => {
    expect(describeMandate(m)).toBe("Can spend up to 200 USDC per day, 50 USDC per payment, on Base and Solana, to any address. Payments above 30 USDC need your approval. At most 10 payments per day.");
    setLocaleSilently("ru");
    const ruText = describeMandate(m);
    expect(ruText).toBe("Может потратить до 200 USDC в день, 50 USDC за платёж, в сетях Base и Solana, на любой адрес. Платежи свыше 30 USDC требуют вашего подтверждения. Не более 10 платежей в день.");
    expect(ruText).not.toContain("**");
    setLocaleSilently("uk");
    expect(describeMandate(m)).not.toContain("**");
  });
  it("untrusted recipient labels cannot inject bold markers", () => {
    const fixed: Mandate = { ...m, recipients_mode: "Fixed", recipients: [1] };
    const text = describeMandate(fixed, { 1: "**evil**" });
    expect(text).toContain("**evil**");
  });
});

describe("LanguageSwitcher", () => {
  it("renders EN / RU / UK and marks the active language", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { LanguageSwitcher } = await import("./react");
    const html = renderToStaticMarkup(createElement(LanguageSwitcher));
    for (const label of ["EN", "RU", "UK"]) expect(html).toContain(`>${label}<`);
    expect(html).toMatch(/lang="en"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/lang="ru"[^>]*aria-pressed="false"/);
    setLocaleSilently("ru");
    const ruHtml = renderToStaticMarkup(createElement(LanguageSwitcher));
    expect(ruHtml).toMatch(/lang="ru"[^>]*aria-pressed="true"/);
    expect(ruHtml).toContain('aria-label="Язык"');
  });
});
