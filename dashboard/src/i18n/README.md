# Localization (en, ru, uk)

A small typed i18n module, no dependencies. English is the source language.

| File | Role |
|---|---|
| `en.ts` | **Source of truth for keys.** Flat `"area.name": "English text"` object (`as const`). |
| `ru.ts`, `uk.ts` | `Messages` = `Record<MessageKey, Message>`: a missing or extra key fails `pnpm typecheck`. |
| `core.ts` | `t()`, `translate()`, `setLocale()`, language detection, persistence (`localStorage` key `at.locale`, wrapped in try/catch). No React. |
| `react.tsx` | `I18nProvider`, `useT()`, `useLocale()`, `<LanguageSwitcher/>`, `rich()`. |
| `i18n.test.ts` | Key parity, placeholder parity, plural forms, interpolation, persistence, locale formatting. |

## Add a string

1. Add the key to `en.ts` (group by area, e.g. `payouts.` prefix; the trading page uses `trading.*`).
2. Add the same key to `ru.ts` and `uk.ts` (typecheck fails until you do).
3. Use it: `const t = useT(); t("nav.treasury")`, or `t("page.payoutNotFound", { id })`.
   Outside React (helpers in `src/lib`) import `t` from `@/i18n` and call it at the moment the text is built, never at module load.

```ts
// en.ts
"agents.count": { one: "{count} agent", other: "{count} agents" },
// ru.ts / uk.ts need one / few / many / other (Intl.PluralRules picks the form from `count`)
"agents.count": { one: "{count} агент", few: "{count} агента", many: "{count} агентов", other: "{count} агента" },
```

- `{name}` placeholders are replaced with `params`. An unknown placeholder stays visible, so a typo shows up.
- A plural message is an object; the form is chosen by `params.count`. A plain string is fine when the sentence does not need agreement ("Пропущено платежей: {count}").
- Text with styled or linked parts: `rich("key", { id: <span className="mono">{id}</span> })` (placeholders may be React nodes; values are never parsed as markup).
- `**bold**` markers are used only by the mandate sentence (`m.*`). The template is split at `**` *before* values are substituted, so untrusted text cannot inject bold.
- The same placeholders must appear in all languages (the test enforces it; `freq.monthly` is the one documented exception).

## What is never translated

Labels, memos, recipient/agent names and any model output (untrusted data); contract and worker error **codes** (`reason.CODE` keeps the code and translates only the explanation); addresses, hashes, token and chain names (USDC, NEAR, Hyperliquid, Base...), CLI commands and `.env` snippets, protocol words (TEE, PPID, API, P&L).

## Formats

- Amounts keep en-style digits in every language (`12,480.50`, `.` decimal): they are copied into forms and CLI commands that parse `.`, and `lib/amount.ts` is exact bigint math with no `Intl`.
- Dates are UTC. English keeps the fixed table (`3 Dec`); ru/uk use `Intl.DateTimeFormat` (`3 дек.`). `formatTime` stays ISO (`2026-12-03 09:00 UTC`).
- Switching language re-mounts the app below `I18nProvider` (lib helpers build strings outside React); open forms and modals reset.
- `<html lang>` follows the language. The wallet-selector popup (third party) only supports its own language list and stays English.
