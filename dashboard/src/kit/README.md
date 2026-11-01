# Agent Treasury design kit

React + Tailwind v4 implementation of `design-kit/agent-treasury-design/design-system/DESIGN_SYSTEM.md`.
The visual reference is `design-kit/agent-treasury-design/design/canvas/*.dc.html`.

## See it

```bash
cd dashboard && pnpm dev
# open http://localhost:5173/kit.html  → every component, composed like Main.dc.html, with sample data
```

`kit.html` is a dev-only entry. `vite build` builds only `index.html`.

## Files

| File | What |
|---|---|
| `theme.css` | Tailwind v4 `@theme` tokens (port of `tokens.css` + `tailwind.preset.ts`), base styles, every motion class + `prefers-reduced-motion` fallbacks |
| `tokens.ts` | Chain colors/names, limit color rule `limitTone()`, `formatUsdc`, `shortId`, avatar helpers (unit-tested) |
| `primitives.tsx` | Button, IconButton, PauseButton, Card, CardHeader, Tile, Stat, Overline, Pill, Dot, StatusPill, Amount, Hash, Avatar, Spinner, Skeleton, Callout, Banner, EmptyState |
| `data.tsx` | SpendBar, RingGauge, useCountUp, DeltaChip, ChainDot/ChainBadge/ChainStack, TrustBadge, ShieldProof, ReasonChip, SourceTag, PrivacyBadge, PayoutRoute, Table/Th/Tr/Td |
| `controls.tsx` | Field (a11y render prop), Input, Select, Textarea, SecretField + useSecretAck, Checkbox, Toggle, Chip, Segmented, Tabs, Stepper, Timeline |
| `overlays.tsx` | Modal (confirm sheet), Drawer, SigningHint, ToastProvider + useToast |
| `assistant.tsx` | ProposalCard, ProposalActions, BatchBar, SuggestionChip, TypingDots, Message, AssistantFooter |
| `layout.tsx` | AppHeader, Page, Logo, MandateSentence/MandateValue |
| `icons.tsx` | Inline lucide-style icons (no new dependency) |

## Adopting it in the app (not done yet: the app code is owned by another session)

1. `src/index.css` → replace the slate base rules with:
   ```css
   @import "tailwindcss";
   @import "./kit/theme.css";
   ```
2. `index.html` → add the Inter + JetBrains Mono `<link>` tags from `kit.html`.
3. Wrap `<App />` in `<ToastProvider>`.
4. Replace `components/ui.tsx` usages: `Card` → `Card` + `CardHeader`, `Badge tone` → `Pill accent`
   (`green→ok`, `yellow/orange→warn`, `red→danger`, `blue→info`, `gray→neutral`), `Progress` → `SpendBar`, `Field` → `Field` render prop.

## Rules worth remembering

- One accent per element. Red is never used for refusals: use `ReasonChip`.
- Amounts, hashes and account ids always go through `mono` (tabular numbers). Format before passing: the kit never converts u128.
- Color is never the only signal: `ChainBadge` always shows the name, `StatusPill` always shows the word.
- Motion only on state change. Every motion class already has a reduced-motion fallback in `theme.css`.
