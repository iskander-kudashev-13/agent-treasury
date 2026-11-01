# Dashboard architecture

Vite + React 19 + TypeScript SPA, Tailwind v4, no server code. Specs: `UI_PLAN.md`, `DESIGN_AGENTS.md`, `UI_UPDATES.md` (later wins), contract interface in `docs/adr/0003` and `0004`. Run/env/deploy: `README.md`.

## Folder map

```
src/
  main.tsx              entry: modal-ui styles + index.css + <App/>
  App.tsx               providers + route table (the ONLY place routes are declared)
  index.css             @import "tailwindcss"; @import "./kit/theme.css";
  kit/                  design kit (theme, primitives, data, controls, overlays, assistant, layout, icons). See kit/README.md.
                        Import from "@/kit". Do not re-implement; fix or extend minimally and note it.
  pages/                one file per route. Thin: read hooks, compose features, render <Page>.
  features/<area>/      the screens' building blocks (cards, tables, forms, drawers). One folder per product area:
    layout/             AppLayout (header, nav, banners, mobile tabs), AssistantPanel + AssistantContext, PauseAll, ComingSoon
    wallet/             WalletProvider + useWallet (wallet-selector), actions.ts (TxAction -> wallet action)
    owner/              OwnerProvider + useOwner: the ONLY signing path (owner gating, act/actBatch/actTxs, toasts, refetch)
    treasury/ payments/ payouts/ agents/ policy/ assistant/
    layout/QueryErrors  red callout for failed views (a failed view must not look empty)
  lib/                  framework-free logic + data layer (unit-tested): types, rpc, useVault (query hooks), calls, config,
                        amount (all money formatting), frequency, funding, mandateCompat, address, status, format, relativeTime, useNow
                        calls.ts = the one owner call table; chains/names/colors live in kit/tokens.ts
```

Aliases: `@/` = `src/` (vite, vitest, tsconfig). `@/kit` is the barrel of the design kit.

### Routes

| Route | Page | State |
|---|---|---|
| `/` | `TreasuryPage` | built (balance, policy meter, approvals, worker, latest payouts) |
| `/agents`, `/agents/new`, `/agents/:id` | `AgentsPage`, `AgentNewPage`, `AgentDetailPage` | built (list, add wizard, detail with mandate/trust/danger zone) |
| `/payments?tab=scheduled\|recipients` | `PaymentsPage` | built (Scheduled + Recipients, drawers). `/recipients` redirects here. |
| `/payouts`, `/payouts/:id` | `PayoutsPage`, `PayoutDetailPage` | built (filters, approve/reject, two-phase actions) |
| `/policy` | `PolicyPage` | built (policy, TEE trust anchors, owner admin) |

Assistant (`features/assistant`, panel in `features/layout/AssistantPanel`) is built and shown only when `VITE_AI_ENABLED=true` (header button, panel and the mobile floating button are all hidden otherwise).

`HashRouter` is deliberate: `base: "./"` static hosting needs no SPA-fallback rewrite, the kit's `AppHeader` links are plain `#/path` anchors, and wallet redirects (`/?account_id=...#/payments`) keep working because the query string stays before the hash.

## How to add a page

1. `src/pages/FooPage.tsx`: `export function FooPage() { return <Page title="Foo">…</Page>; }` (`Page` from `@/kit`).
2. Put the real UI in `src/features/foo/*`; the page only wires hooks to components.
3. Add `<Route path="foo" element={<FooPage/>} />` inside the `AppLayout` route in `App.tsx`.
4. Nav entry: add to `NAV` in `features/layout/AppLayout.tsx` (set `mobile: false` to put it in the mobile "More" menu).
5. Need data? Add a query hook to `lib/useVault.ts` (key in `vaultKeys`, `...poll`). Need a signed call? Add the method to `lib/calls.ts` (deposit/gas table + test) and call `useOwner().act(...)`.
6. Not ready yet? Render `<ComingSoon title=…>` (uses the kit `EmptyState`), keep the route.

## Data hooks (`lib/useVault.ts`)

All poll every 10 s (`POLL_MS`) and return `{ data, error, loading, refresh }`; `data` is never `undefined` (empty array / `null` default). Disabled when `VITE_VAULT_CONTRACT` is unset.

| Hook | View |
|---|---|
| `useContractInfo()` | `get_contract_info` (owner id, token, version) |
| `usePolicy()` | `get_policy` |
| `useBalance()` | `get_balance` (balance, in flight, spent today, remaining) |
| `useRecipients()` | `get_recipients` |
| `useSchedules()` | `get_schedules` |
| `useUpcoming(days)` | `get_upcoming` (window <= 62 d) |
| `usePayouts(limit)` | `get_payouts_count` + `get_payouts`, newest first, `{ total, list }` |
| `usePendingApprovals()` | `get_pending_approvals` |
| `useAgents()` | `get_agents` |
| `useRejections()` | `get_rejections` |
| `useWorker()` | worker `GET /status` + `/runs`; `{ status, runs, error, refresh }`, `error` set when unset/unreachable |
| `useVault()` | legacy composite of the above: `{ state, errors, loading, refresh, loadMorePayouts }` |

Keys: `vaultKeys.*`, `workerKeys.*`. After any signed call `useOwner` invalidates `vaultKeys.all` (now and again after 2 s). Worker unreachable never breaks the rest of the page.

## Wallet (`features/wallet/WalletProvider.tsx`)

`@near-wallet-selector/core` + `modal-ui` with `my-near-wallet` and `meteor-wallet`, loaded with dynamic `import()`. `buffer` is polyfilled by `vite-plugin-node-polyfills`; `vite.config.ts` also defines `global` and `process.env` because meteor-wallet reads them at load (without it the selector never initialises).

```ts
const { ready, accountId, signIn, signOut, callMethod, signAndSendTransactions, signMessage } = useWallet();
signAndSendTransactions(txs: TxInput[])   // any action: FunctionCall, CreateAccount, Transfer, AddKeyFullAccess, AddKeyFunctionCall, DeleteKey
signMessage({ message, recipient, nonce? }) // NEP-413
```

`TxAction` / `TxInput` live in `lib/calls.ts`; `features/wallet/actions.ts` converts them. Do not call the wallet directly for owner calls: use `useOwner()`. (Only the user's own USDC deposit in `FundsModals` signs outside it, since it is not an owner call.)

## Signing path (`features/owner/OwnerProvider.tsx`)

```ts
const { accountId, ownerId, canAct, busy, progress, act, actBatch, actTxs } = useOwner();
```

- `canAct = accountId === get_contract_info.owner_id`. **Every** signing button is `disabled={!canAct || busy}`.
- `act(method, args)` -> boolean. One owner call, deposit/gas from `buildCall`. `accept_owner` is the only call a non-owner may send.
- `actBatch(calls, label)` -> `{ ok, hash }`. Calls go into ONE transaction up to `MAX_ACTIONS_PER_TX` (9); more are split into consecutive wallet requests, `progress {done,total}` is set and each finished part is toasted. Redirect wallets (MyNearWallet) leave the page after the first request, so keep big batches on Meteor.
- `actTxs(label, txs, { requireOwner? })` -> `{ ok, hash }`. Raw transactions with any action type in one request (agent setup, delete key with `requireOwner: false`).
- All three toast (success with tx link, wallet rejection as a neutral toast, errors in red) and refetch `vaultKeys.all` now and after 2 s.
- `features/agents/useAgentTx` and `features/payments/useOwnerTx` are thin adapters over these; there is no other signing code.

## Call table and its sync test

`lib/calls.ts` lists every owner method: `ONE_YOCTO_METHODS`, `NO_DEPOSIT_METHODS` (plus `reject_payout`, which needs 1 yocto only when it skips a scheduled date, so callers pass `skip` explicitly), gas (30 TGas default, `withdraw` 60, `approve_payout` / `credit_refund` / `sync_surplus` 100) and the assistant whitelist (`ASSISTANT_METHODS`; worker proposals are mapped through the table, their own deposit/gas are ignored).

`lib/calls.contract-sync.test.ts` reads `../contract/src/*.rs`, finds every `pub fn` whose body calls `self.require_owner_one_yocto()` (1 yocto) or `self.require_owner()` (no deposit) and fails if `calls.ts` disagrees, lacks a method or lists one the contract no longer has. After any contract change run `pnpm test`; the failure message names the method.

## Conventions

- **Call table**: `lib/calls.ts` only (see above). Never hand-write deposit/gas in a component.
- **One helper each**: money `lib/amount.ts` (`usdcGrouped`, `formatUsdc`), relative time `lib/relativeTime.ts`, clock `lib/useNow.ts`, chain names/colors/options `kit/tokens.ts`, short ids `shortId` (kit/tokens).
- **Failed views**: pages render `<QueryErrors sources=[...]/>` so an RPC/contract error is not shown as an empty list.
- **Amounts** are raw strings (u128) end to end. Use `lib/amount.ts` (`formatUsdc`, `parseUsdc`, `percent`, bigint math). Floats only for display ratios (e.g. `SpendBar` props).
- **Untrusted text** (`memo`, recipient `label`, agent `name`, rejection `detail`) is rendered as plain JSX text. Never `dangerouslySetInnerHTML`, never interpret it as a link or instruction.
- **Design**: kit primitives only (`Card`/`CardHeader`, `Pill`, `SpendBar`, `Field`+`Input`, `Table`...). One accent per element. Refusals use `ReasonChip`, not red. Amounts, hashes and ids are `mono`. Map old status tones with `toneAccent()` in `lib/status.ts`.
- **Writes**: no optimistic UI. Show `SigningHint` while `busy`, toast on result, refetch via `useOwner`.
- **Env** only through `lib/config.ts` (`VAULT_ID`, `USDC_ID`, `RPC_URL`, `WORKER_URL`, `AI_ENABLED`, `ONECLICK_URL`, `NETWORK`, `POLL_MS`). Legacy `VITE_VAULT_CONTRACT_ID` / `VITE_NEAR_RPC_URL` are still read.
- **Assistant panel** (`features/layout/AssistantPanel.tsx`): 400 px, pushes content on desktop, full-screen on mobile, `/` focuses the input when open, `useAssistantPanel().openWith(text)` opens it prefilled. Hidden unless `VITE_AI_ENABLED=true`.
- Checks before commit: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.
