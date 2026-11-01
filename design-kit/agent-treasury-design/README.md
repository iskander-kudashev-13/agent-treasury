# Agent Treasury — design package

Handoff for the coding agent building `/dashboard` (NEAR hackathon, Nov 2026).

## What's inside

```
specs/
  UI_PLAN.md          base dashboard plan (stack, data, screens, build order U0–U2)
  DESIGN_AGENTS.md    agents, mandates, add-agent wizard, revoke
  UI_UPDATES.md       schedules, Payments page, Upcoming, AI assistant — wins on conflicts
design-system/
  DESIGN_SYSTEM.md    colors, type, components, motion, copy, a11y
  tokens.json         same tokens as data
  tokens.css          CSS variables + all keyframes (import once)
  tailwind.preset.ts  Tailwind preset with the tokens
design/
  SCREENS.md          what each prototype screen shows and how to click through it
  OPEN_QUESTIONS.md   spec gaps found while prototyping
  canvas/             prototype sources (*.dc.html + canvas.json)
```

## Reading order for the coding agent

1. `specs/UI_PLAN.md` → `specs/DESIGN_AGENTS.md` → `specs/UI_UPDATES.md` (later files win).
2. `design-system/DESIGN_SYSTEM.md`, then drop `tokens.css` + `tailwind.preset.ts` into `/dashboard`.
3. Use `design/canvas/*.dc.html` as the visual reference: markup, spacing and copy are final-ish; the JS inside is prototype logic with sample data, **not** production code.

## About the prototype files

The `.dc.html` files are artboards from a Claude Design canvas. They load a runtime (`support.js`) that only exists inside that canvas, so opening them directly in a browser shows raw template markup (`{{…}}`, `<sc-for>`). To click through the prototypes, open the canvas "Agent Treasury — Dashboard" in Claude. For coding, read them as annotated HTML: inline styles hold the exact values, `<helmet><style>` holds the animations, `renderVals()` holds the state logic.

All names, amounts and addresses in the prototypes are sample data.
