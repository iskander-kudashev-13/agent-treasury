# Agent Treasury — Design System

Visual language of the owner dashboard. Source of truth for `/dashboard` (Vite + React + Tailwind).
Tokens live in `tokens.json`, `tokens.css` and `tailwind.preset.ts` next to this file. Screens that use them: `../design/canvas/*.dc.html`.

Character: **a bank's internal admin tool, not a crypto dashboard.** Dark, calm, numeric. One accent per element. Proof (hashes, tx links) is always visible. Motion explains state changes and nothing else.

---

## 1. Color

### 1.1 Base

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0B0D10` | Page background |
| `bg-deep` | `#07080A` | Backdrop behind large modals |
| `surface` | `#13161B` | Cards, panels, drawers |
| `surface-sunken` | `#0F1216` | Inputs, inner tiles, assistant panel, segmented track |
| `surface-raised` | `#1A1E25` | Active nav item, secondary buttons, toasts |
| `surface-hover` | `#171B21` | Table/list row hover |
| `track` | `#1C2028` | Progress bar track, row dividers |
| `border` | `#232832` | Card borders, section dividers |
| `border-strong` | `#2E3440` | Inputs, secondary buttons, chips |

### 1.2 Text

| Token | Hex | Contrast on `surface` | Use |
|---|---|---|---|
| `text` | `#E6E8EC` | 14.8:1 | Primary text, numbers |
| `text-secondary` | `#A9B1BF` | 8.4:1 | Body copy in cards, mandate glue words |
| `text-muted` | `#8A93A3` | 5.9:1 | Labels, captions, metadata |
| `text-subtle` | `#6B7383` | 3.8:1 | Hints ≥ 12px only, never essential info |

### 1.3 Semantic accents (one per element)

| Token | Hex | Tint (bg) | Meaning |
|---|---|---|---|
| `green` | `#2ECC71` | `rgba(46,204,113,.12)` | Verified, success, active, primary action |
| `amber` | `#F5B544` | `rgba(245,181,68,.12)` | Waiting for approval, attention, testnet, 80–99 % of a limit |
| `red` | `#E5484D` | `rgba(229,72,77,.08)` | Pause, revoke, error, 100 % of a limit. **Never** for refusals |
| `red-text` | `#FF8A8E` | — | Red text on dark (passes 4.5:1) |
| `info` | `#8AB4FF` | `rgba(138,180,255,.12)` | Links, assistant, "Fastest" badge |
| `neutral-fill` | `#AEB5C1` | — | Agent spend bar under 80 % |

Text on filled buttons: on green `#06210F`, on amber `#241703`, on red `#FFFFFF`.

Assistant surfaces: chip bg `#141B2B`, border `#2B3550`, active `#1F2A44` / `#3B4A6B`, text `#B9D1FF`.

### 1.4 Chain colors (dots and badges only, never logos)

| Chain | Hex |
|---|---|
| Base | `#3B82F6` |
| Ethereum | `#94A3B8` |
| Arbitrum | `#38BDF8` |
| Solana | `#A78BFA` |
| Tron | `#F87171` |
| NEAR | `#2ECC71` |

Always pair the dot with the chain name — color is never the only signal.

### 1.5 Limit color rule

`pct < 0.8 → green (vault) / neutral-fill (agent)` · `0.8 ≤ pct < 1 → amber` · `pct ≥ 1 → red`.

---

## 2. Typography

- **Inter** 400/500/600/700 — all UI text.
- **JetBrains Mono** 400/500/600 — amounts, hashes, addresses, account ids, code, reason codes. Always `font-variant-numeric: tabular-nums`.

| Role | Size / line | Weight | Font |
|---|---|---|---|
| Balance hero | 40 / 1.1, letter-spacing −0.02em | 600 | Mono |
| Page title | 24 | 600 | Inter |
| Amount large (detail) | 32 | 600 | Mono |
| Stat value | 22 | 600 | Mono |
| Mandate sentence | 18 / 1.55 | 400 glue, 600 numbers & chains | Inter |
| Card title | 15 | 600 | Inter |
| Body | 14 / 1.45 | 400 | Inter |
| Label / caption | 12–13 | 400–500 | Inter, `text-muted` |
| Overline | 12–13, uppercase, +0.06em | 500 | Inter, `text-muted` |
| Reason chip / code | 11 | 400 | Mono |

Numbers: 2 decimals for USDC (`12,480.50`), `en-US` grouping. Short hashes: first 6 + `…` + last 4.

---

## 3. Space, shape, elevation

- 8 px grid. Card padding 16–24 px. Page gutter 24 px desktop, 16 px mobile. Max content width 1280 px.
- Radius: chips/pills `999px`, inputs & buttons `8px`, inner tiles `10px`, cards `12px`, modals `14–16px`.
- Borders 1 px. **No drop shadows.** The only "glow" allowed: `0 0 18px rgba(46,204,113,.18)` on a just-signed / just-arrived item, and the 1 px colored ring on toasts.
- Touch targets ≥ 44 px on mobile, ≥ 32 px for inline table actions on desktop.

---

## 4. Components

| Component | Anatomy & rules |
|---|---|
| **Button** | Primary: green fill, 40 px. Secondary: transparent + `border-strong`. Danger: red outline (Pause) or red fill (confirm Revoke). Amber fill only for Approve. Hover `brightness(1.15)`, active `translateY(1px)`, disabled 40 % opacity. |
| **Pause button** | 52 px, full width of the agent card, red outline + red tint; turns green "Resume agent" when paused. Always opens a confirm sheet. Sticky at bottom on mobile. |
| **Card** | `surface`, `border`, 12 px radius. Optional decoration: dotted grid (16 px, masked) and one soft radial tint in a corner at ≤ 0.12 alpha. |
| **Status pill** | 8 px dot + label, no filled background. Active = green dot with slow ping; Paused = amber dot; Revoked/Ended = hollow grey dot. |
| **Trust badge** | TEE: `ShieldCheck`, green when hash approved, amber "waiting for registration". Key: `KeyRound`, muted grey. Always followed by mono hash/public key. |
| **Spend bar** | 8 px, `track` background, fill by limit color rule, width transition 0.6–0.8 s. Label row above: "Today · 150.00 / 200.00 USDC". |
| **Ring gauge** | Vault daily limit on Treasury: 148 px, 10 px stroke, rounded cap, dashed inner guide; % in mono 24 px at center. |
| **Chip / filter** | 32–36 px pill. Selected: green border + green tint, text `text`. Unselected: `border-strong`, `text-secondary`. |
| **Segmented control** | Track `surface-sunken` + border, 3 px padding; selected segment `border` fill. |
| **Tabs** | Text tabs 44 px with a 2 px green underline that slides between tabs. Pending count as amber mono pill. |
| **Table** | Header 12 px muted; rows 12 px vertical padding, `track` dividers, hover `surface-hover`; wide tables scroll inside `overflow-x: auto`. |
| **Toggle** | 40×24 track, green when on; knob slides 16 px. |
| **Input** | 40 px, `surface-sunken`, `border-strong`; focus = green border + 3 px green ring at .18; error = red border + message below in `red-text`; valid address = green border at .6. |
| **Drawer** | Right side, max 480–520 px, slides in 32 px + fade. Footer: Cancel + primary; "Confirm in wallet…" amber text while signing. |
| **Modal / sheet** | Centered, max 420–520 px, backdrop `rgba(5,6,8,.72)`, enter `translateY(20px) scale(.98)`. |
| **Toast** | Bottom-right, `surface-raised`, 1 px ring in the status color, colored dot, optional "View tx ↗". Auto-hides ~3 s. |
| **Stepper** | Thin progress segments + numbered labels; done steps get a green check. |
| **Timeline** | Vertical line `track` with a green fill that grows; steps: done (green check pops in), active (amber spinner), todo (dashed circle, 45 % opacity). |
| **Reason chip** | Mono 11 px, border only, `text-secondary` — refusals look calm, not like errors. Title in activity: "Refused: {human reason}". |
| **Secret field** | Mono, amber border, `filter: blur(4px)` until hover/focus. Done button unlocks after 3 s + "I saved the key" checkbox. |
| **Proposal card** (assistant) | Title + status badge (draft / Queued / Signed). Diff rows: old value struck through → new value on green tint. Warning amber, OK green. Actions: Edit in form · Discard · ✓ Add to batch. Danger variant (pause): red border + "Pause now". |
| **Batch bar** | Slides up above the chat input: count bubble + "N changes ready to sign" + "Review & sign ▸". |
| **Source tag** | Tiny outline pill on payout rows: calendar icon "scheduled" / bolt icon "on demand". |
| **Privacy badge** | "Private · NEAR AI Cloud (TEE)", lock icon, slow blue-green shimmer, tooltip with the plain-language explanation. |

Icons: lucide-react, 1.6–2.4 px stroke, never emoji in UI. Avatars: initials on soft pastel circles.

---

## 5. Motion

Principle: motion only marks a **state change** (arrived, queued, signed, paused). Nothing loops forever except "live" indicators and in-progress spinners. Every animation has a `prefers-reduced-motion` fallback (keyframes cut to 1 ms, loops off, transitions off).

| Name | Spec | Where |
|---|---|---|
| `row-in` | opacity 0→1, translateY −6→0, 150 ms ease-out | New payout in feed, new schedule/recipient row (+ green bg flash 1.8 s) |
| `count-up` | 900 ms, ease-out cubic, rAF | Balance and available amount on first load |
| `ring/bar fill` | stroke-dashoffset / width, 600–800 ms `cubic-bezier(.2,.7,.2,1)` | Limit gauge and spend bars on load and on change |
| `delta chip` | appear → hold → fade, 1.8 s | "−1,200.00" next to the balance after a payout |
| `live ping` | ring scale .6→1.6, fade, 2.4 s loop | Green "running / active" dot only |
| `route pulse` | dot travels Vault → Intents → chains, 2.8 s loop, stops on pause | Agent card |
| `foil sweep` | one diagonal light pass, 1.6 s, once | Treasury card on first load |
| `sheet` | translateY 20→0 + scale .98→1, 300 ms `cubic-bezier(.2,.9,.3,1)` | Modals, toasts |
| `drawer` | translateX 40→0 + fade, 320 ms | Drawers |
| `step-in` | translateX 14→0 + fade, 320 ms | Wizard step change |
| `check draw` | stroke-dashoffset to 0, 400–500 ms | Selected cards, signed transactions, success screens |
| `halo` | expanding green box-shadow, 1.2 s, once | "Agent is ready" |
| `card-in` | translateY 10→0, scale .97→1, slight overshoot, 400 ms | Assistant proposal cards |
| `typing` | 3 dots bounce, 1.1 s | Assistant thinking |
| `stream caret` | blinking block caret while text streams | Assistant replies |
| `spinner` | 1 s linear rotation | "Confirm in wallet…", pending payout |

Not allowed: confetti, spinning wheels, neon text-shadow, parallax, animated gradients behind content.

---

## 6. Writing

- Plain words: "Daily limit", "Waiting for your approval", "Money arrived on Base". Technical terms only in detail views.
- Mandate sentence template: "Can spend up to **{daily} USDC per day**, **{per} per payment**, on **{chains}**, {recipients clause}. Payments above **{threshold} USDC** need your approval."
- Refusals: "Refused: Over the agent's daily limit" + mono code + one-sentence detail.
- Secrets: "Save this key now. You won't see it again."
- Assistant footer: "The assistant only prepares changes. Nothing happens until you sign."
- Sample data in mocks is clearly sample; never invent numbers in the real UI.

## 7. Accessibility checklist

- Real `<button>`, `<a href>`, `<input>` + `<label>`; `aria-label` on icon-only buttons; `role="switch"` on toggles, `role="tablist"/"tab"` on tabs, `role="dialog" aria-modal` on sheets.
- Text ≥ 4.5:1 (see §1.2); status never by color alone (icon + word).
- Visible focus ring (green, 3 px at .18).
- Lighthouse accessibility ≥ 90; works at 390 px width.
