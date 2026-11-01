// Living reference for every kit component, composed like the prototype screens. All values are SAMPLE data.
import { useState, type ReactNode } from "react";
import {
  Amount,
  AppHeader,
  AssistantFooter,
  Avatar,
  Banner,
  BatchBar,
  Button,
  Callout,
  Card,
  CardHeader,
  ChainBadge,
  Checkbox,
  Chip,
  DeltaChip,
  Drawer,
  EmptyState,
  Field,
  formatUsdc,
  Hash,
  Icons,
  Input,
  MandateSentence,
  MandateValue,
  Message,
  Modal,
  Overline,
  Page,
  PauseButton,
  PayoutRoute,
  Pill,
  PrivacyBadge,
  ProposalActions,
  ProposalCard,
  ReasonChip,
  RingGauge,
  SecretField,
  Segmented,
  Select,
  ShieldProof,
  SigningHint,
  Skeleton,
  SourceTag,
  SpendBar,
  Spinner,
  Stat,
  StatusPill,
  Stepper,
  SuggestionChip,
  Table,
  Tabs,
  Td,
  Th,
  Tile,
  Timeline,
  Toggle,
  Tr,
  TrustBadge,
  TypingDots,
  useCountUp,
  useSecretAck,
  useToast,
  type ProposalStatus,
  type TimelineStep,
} from "../index";

const SWATCHES: Array<[string, string]> = [
  ["bg", "bg-bg"],
  ["surface", "bg-surface"],
  ["surface-sunken", "bg-surface-sunken"],
  ["surface-raised", "bg-surface-raised"],
  ["track", "bg-track"],
  ["line", "bg-line"],
  ["line-strong", "bg-line-strong"],
  ["ok", "bg-ok"],
  ["warn", "bg-warn"],
  ["danger", "bg-danger"],
  ["info", "bg-info"],
  ["neutral-fill", "bg-neutral-fill"],
];

const PAYOUTS = [
  { id: "p-104", name: "Maria Lopez", amount: 1500, chain: "base", status: "pending", source: "scheduled" as const, when: "Today 09:12" },
  { id: "p-103", name: "Studio Kite", amount: 420, chain: "solana", status: "confirmed", source: "on-demand" as const, when: "Yesterday 18:40" },
  { id: "p-102", name: "Ivan Petrov", amount: 900, chain: "arbitrum", status: "confirmed", source: "scheduled" as const, when: "Oct 30 09:00" },
  { id: "p-101", name: "Tron vendor", amount: 75, chain: "tron", status: "refused", source: "on-demand" as const, when: "Oct 29 14:02" },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <Overline>{title}</Overline>
      {children}
    </section>
  );
}

export function Showcase() {
  const toast = useToast();
  const [paused, setPaused] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [signing, setSigning] = useState(false);
  const [spent, setSpent] = useState(1650);
  const [deltaKey, setDeltaKey] = useState(0);
  const [range, setRange] = useState<"7" | "30">("7");
  const [tab, setTab] = useState<"overview" | "activity" | "mandate">("overview");
  const [filter, setFilter] = useState("all");
  const [allowlist, setAllowlist] = useState(true);
  const [amount, setAmount] = useState("1500");
  const [step, setStep] = useState(2);
  const [proposal, setProposal] = useState<ProposalStatus>("draft");
  const ack = useSecretAck(3000);
  const limit = 3000;
  const balance = useCountUp(12480.5 - (spent - 1650));

  const amountNum = Number(amount);
  const amountState = !amount ? "default" : !Number.isFinite(amountNum) || amountNum <= 0 ? "error" : amountNum > 2000 ? "error" : "valid";

  const timeline: TimelineStep[] = [
    { title: "Agent requested payout", detail: "request_payout · 09:12:04", state: "done" },
    { title: "Policy checks passed", detail: "limits, allowlist, mandate", state: "done" },
    { title: "USDC sent to Intents deposit address", detail: <Hash value="0x7f3a9c4b2d1e00e41b02" />, state: "done" },
    { title: "Swap & bridge via NEAR Intents", detail: "Usually under 2 minutes", state: "active" },
    { title: "Money arrived on Base", state: "todo" },
    { title: "Status written back to the vault", state: "todo" },
  ];

  const pay = () => {
    setSpent((s) => Math.min(s + 600, 3200));
    setDeltaKey((k) => k + 1);
    toast({ text: "Paid · Maria Lopez · 600.00 USDC", href: "https://nearblocks.io", accent: "ok" });
  };

  return (
    <>
      <AppHeader
        vaultId="vault.example.testnet"
        network="testnet"
        account="owner.testnet"
        onAssistant={() => toast({ text: "Assistant panel opens here", accent: "info" })}
        nav={[
          { label: "Treasury", href: "#/", active: true },
          { label: "Agents", href: "#/agents" },
          { label: "Payments", href: "#/payments" },
          { label: "Policy", href: "#/policy" },
          { label: "Payouts", href: "#/payouts" },
        ]}
        banner={
          paused ? (
            <Banner icon={<Icons.Pause size={14} />}>Agent paused — no payments will be made until you resume.</Banner>
          ) : undefined
        }
      />
      <Page title="Design kit" actions={<Pill accent="info">Sample data</Pill>}>
        {/* Treasury hero + agent card, as in Main.dc.html */}
        <div className="flex flex-wrap gap-4">
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-4">
            <Card decorated foil padding="lg" aria-labelledby="t-balance">
              <div className="flex flex-wrap items-center gap-6">
                <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-1.5">
                  <Overline id="t-balance">Vault balance</Overline>
                  <div className="flex flex-wrap items-baseline gap-2.5">
                    <Amount value={formatUsdc(balance)} size="hero" />
                    {deltaKey > 0 && <DeltaChip key={deltaKey} text="−600.00" />}
                  </div>
                  <p className="m-0 mt-1 text-ink-muted">
                    Available to agent today: <span className="mono font-semibold text-ink">{formatUsdc(Math.max(0, limit - spent))}</span> of <span className="mono">{formatUsdc(limit)}</span>
                  </p>
                  <div className="mt-3.5 flex flex-wrap gap-2">
                    <Button variant="primary" icon={<Icons.ArrowDown />}>
                      Deposit
                    </Button>
                    <Button icon={<Icons.ArrowUp />}>Withdraw</Button>
                    <Button variant="ghost" onClick={pay}>
                      Simulate payout
                    </Button>
                  </div>
                </div>
                <RingGauge pct={spent / limit} />
              </div>
            </Card>

            <Card className="flex flex-col gap-3.5" aria-labelledby="t-policy">
              <CardHeader id="t-policy" title="Spending policy" badge={<Pill accent="ok" icon={<Icons.Check size={12} strokeWidth={2.6} />}>Allowlist only</Pill>} actions={<a href="#/policy" className="text-[13px]">Edit policy</a>} />
              <SpendBar spent={spent} limit={limit} spentText={formatUsdc(spent)} limitText={formatUsdc(limit)} marker80 />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Tile>
                  <Stat size="sm" label="Per payment" value="2,000.00" />
                </Tile>
                <Tile>
                  <Stat size="sm" label="Needs approval above" value="1,000.00" accent="warn" />
                </Tile>
                <Tile>
                  <Stat size="sm" label="Daily limit" value="3,000.00" />
                </Tile>
              </div>
            </Card>

            <Card padding="none" aria-labelledby="t-upcoming">
              <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-5 py-3.5">
                <h2 id="t-upcoming" className="m-0 text-[15px] font-semibold">
                  Upcoming
                </h2>
                <Segmented label="Range" value={range} onChange={setRange} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} />
                <div className="grow" />
                <Amount value={range === "7" ? "3,800.00" : "9,140.00"} />
              </div>
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Recipient</Th>
                    <Th align="right">Amount</Th>
                    <Th>Chain</Th>
                    <Th>Note</Th>
                  </tr>
                </thead>
                <tbody>
                  <Tr>
                    <Td className="text-ink-muted">Mon 2 Nov</Td>
                    <Td className="font-medium">Maria Lopez</Td>
                    <Td align="right" mono className="font-semibold">1,500.00</Td>
                    <Td><ChainBadge chain="base" arrow /></Td>
                    <Td className="text-xs text-warn">approval</Td>
                  </Tr>
                  <Tr fresh>
                    <Td className="text-ink-muted">Mon 2 Nov</Td>
                    <Td className="font-medium">Ivan Petrov</Td>
                    <Td align="right" mono className="font-semibold">2,300.00</Td>
                    <Td><ChainBadge chain="arbitrum" arrow /></Td>
                    <Td className="text-xs text-ink-muted">new</Td>
                  </Tr>
                </tbody>
              </Table>
              <div className="px-4 pt-1 pb-4">
                <Callout>Mon 2 Nov totals 3,800 — above the vault’s daily limit (3,000). 800 will move to the next day.</Callout>
              </div>
            </Card>
          </div>

          <Card className="flex min-w-0 flex-[1_1_360px] flex-col gap-4" aria-labelledby="t-agent">
            <CardHeader id="t-agent" title="Agent" actions={paused ? <StatusPill state="paused" label="Paused by owner" /> : <StatusPill state="active" label="Running in TEE" />} />
            <ShieldProof hash="7f3a9c4b2d1e8a00e41b02" />
            <div>
              <div className="mb-2.5 text-xs text-ink-muted">Payout route</div>
              <PayoutRoute chains={["base", "solana", "arbitrum"]} running={!paused} />
            </div>
            <div className="grid grid-cols-2 gap-3 text-[13px]">
              <Stat size="sm" label="Last run" value={<span className="font-sans font-normal">12 min ago</span>} />
              <Stat size="sm" label="Next run" value={<span className="font-sans font-normal">in 48 min</span>} />
            </div>
            <Tile className="flex items-center gap-2 text-[13px]">
              <Icons.Clock className="text-ink-muted" /> Next run will pay <b>3 recipients</b>
            </Tile>
            <SpendBar scope="agent" label="Today" spent={150} limit={200} spentText="150.00" limitText="200.00 USDC" />
            <div className="grow" />
            <PauseButton paused={paused} onClick={() => setConfirmPause(true)} sticky />
          </Card>
        </div>

        <Section title="Color">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {SWATCHES.map(([name, cls]) => (
              <div key={name} className="overflow-hidden rounded-tile border border-line">
                <div className={`h-12 ${cls}`} />
                <div className="mono bg-surface px-2 py-1.5 text-[11px] text-ink-muted">{name}</div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            {["base", "ethereum", "arbitrum", "solana", "tron", "near"].map((c) => (
              <ChainBadge key={c} chain={c} outlined />
            ))}
          </div>
        </Section>

        <Section title="Type">
          <Card className="flex flex-col gap-2">
            <Amount value="12,480.50" size="hero" />
            <div className="text-2xl font-semibold">Page title · 24 Inter</div>
            <Amount value="1,500.00" size="lg" />
            <MandateSentence>
              Can spend up to <MandateValue>200 USDC per day</MandateValue>, <MandateValue>100 per payment</MandateValue>, on <MandateValue>Base and Solana</MandateValue>, only to listed recipients. Payments above <MandateValue>50 USDC</MandateValue> need your approval.
            </MandateSentence>
            <p className="m-0">Body 14 / 1.45 — plain words: “Waiting for your approval”, “Money arrived on Base”.</p>
            <p className="m-0 text-xs text-ink-muted">Label / caption 12 muted</p>
          </Card>
        </Section>

        <Section title="Buttons">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={<Icons.Plus />}>Add agent</Button>
            <Button>Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="approve">Approve</Button>
            <Button variant="danger" icon={<Icons.Pause size={14} />}>Pause</Button>
            <Button variant="danger-fill">Revoke agent</Button>
            <Button variant="assistant" icon={<Icons.Sparkles size={14} />}>Ask assistant</Button>
            <Button variant="primary" loading>Confirm in wallet…</Button>
            <Button disabled>Disabled</Button>
            <Button size="sm">Small</Button>
          </div>
        </Section>

        <Section title="Status, badges, proof">
          <Card className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <StatusPill state="active" />
              <StatusPill state="paused" />
              <StatusPill state="waiting" />
              <StatusPill state="revoked" />
              <StatusPill state="ended" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Pill accent="warn">testnet</Pill>
              <Pill accent="ok" icon={<Icons.Check size={12} />}>Verified</Pill>
              <Pill accent="info">Fastest</Pill>
              <Pill accent="danger">Failed</Pill>
              <Pill accent="warn" mono>3</Pill>
              <SourceTag source="scheduled" />
              <SourceTag source="on-demand" />
              <ReasonChip code="AGENT_DAILY_LIMIT_EXCEEDED" />
              <PrivacyBadge />
            </div>
            <div className="flex flex-col gap-2">
              <TrustBadge kind="tee" value="7f3a9c4b2d1e8a00e41b02" />
              <TrustBadge kind="tee" approved={false} value="a19e0c4b2d1e8a00ff3310" />
              <TrustBadge kind="key" value="ed25519:8hQx3n2Vt9ZkLmQ4" />
            </div>
            <div className="flex items-center gap-2">
              <Avatar name="Maria Lopez" />
              <Avatar name="Studio Kite" />
              <Avatar name="procurement.near" />
              <Spinner className="text-warn" />
              <Skeleton className="h-4 w-40" />
            </div>
          </Card>
        </Section>

        <Section title="Payouts table">
          <Card padding="none">
            <div className="flex flex-wrap gap-2 px-5 pt-4 pb-3">
              {["all", "pending", "confirmed", "refused"].map((f) => (
                <Chip key={f} selected={filter === f} onClick={() => setFilter(f)}>
                  {f[0]!.toUpperCase() + f.slice(1)}
                </Chip>
              ))}
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Recipient</Th>
                  <Th align="right">Amount</Th>
                  <Th>Destination</Th>
                  <Th>Status</Th>
                  <Th>When</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {PAYOUTS.filter((p) => filter === "all" || p.status === filter).map((p) => (
                  <Tr key={p.id} className="row-in">
                    <Td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={p.name} size={28} />
                        <span className="flex flex-col">
                          <span className="font-medium">{p.status === "refused" ? `Refused: Over the agent's daily limit` : p.name}</span>
                          <SourceTag source={p.source} />
                        </span>
                      </span>
                    </Td>
                    <Td align="right" mono className="font-semibold">
                      {formatUsdc(p.amount)}
                    </Td>
                    <Td>
                      <ChainBadge chain={p.chain} arrow />
                    </Td>
                    <Td>
                      {p.status === "pending" && <Pill accent="warn">Waiting for your approval</Pill>}
                      {p.status === "confirmed" && <Pill accent="ok" icon={<Icons.Check size={12} />}>Confirmed</Pill>}
                      {p.status === "refused" && <ReasonChip code="AGENT_DAILY_LIMIT_EXCEEDED" />}
                    </Td>
                    <Td className="text-ink-muted whitespace-nowrap">{p.when}</Td>
                    <Td align="right">
                      {p.status === "pending" ? (
                        <span className="inline-flex gap-1.5">
                          <Button size="sm" variant="approve">Approve</Button>
                          <Button size="sm">Reject</Button>
                        </span>
                      ) : (
                        <a href="#/payouts" className="text-[13px] whitespace-nowrap">Details →</a>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </Section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Section title="Forms">
            <Card className="flex flex-col gap-4">
              <Field label="Amount per payment" error={amountState === "error" ? "Above the per-payment limit (2,000.00)" : undefined} hint="USDC, 2 decimals">
                {(a) => <Input {...a} mono inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} state={amountState} suffix="USDC" />}
              </Field>
              <Field label="Destination chain">
                {(a) => (
                  <Select {...a} defaultValue="base">
                    <option value="base">Base</option>
                    <option value="solana">Solana</option>
                    <option value="arbitrum">Arbitrum</option>
                  </Select>
                )}
              </Field>
              <Field label="Destination address" hint="Checked against the chain format">
                {(a) => <Input {...a} mono placeholder="0x…" defaultValue="0x52bc44d5378309ee2abf1539bf71de1b7d7be3b5" state="valid" />}
              </Field>
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm">Allowlist only</span>
                <Toggle label="Allowlist only" checked={allowlist} onChange={setAllowlist} />
              </div>
              <SecretField value="ed25519:3kR9vY2mQ8xTn4LpZsB7wHcE1dFj6GuA5oNq0Xi" />
              <Checkbox label="I saved the key" checked={ack.acked} onChange={ack.setAcked} />
              <Button variant="primary" disabled={!ack.canFinish}>
                {ack.ready ? "Done" : "Done (unlocks in 3 s)"}
              </Button>
            </Card>
          </Section>

          <Section title="Navigation & progress">
            <Card className="flex flex-col gap-5">
              <Tabs
                label="Agent sections"
                value={tab}
                onChange={setTab}
                items={[
                  { value: "overview", label: "Overview" },
                  { value: "activity", label: "Activity", count: 2 },
                  { value: "mandate", label: "Mandate" },
                ]}
              />
              <div className="flex flex-col gap-3">
                <Stepper steps={["Type", "Identity", "Mandate", "Review", "Connect"]} current={step} />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</Button>
                  <Button size="sm" variant="primary" onClick={() => setStep((s) => Math.min(4, s + 1))}>Next</Button>
                </div>
              </div>
              <Timeline steps={timeline} />
            </Card>
          </Section>
        </div>

        <Section title="Assistant">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="flex flex-col gap-3 border-ai-line">
              <div className="flex items-center gap-2">
                <span className="text-[15px] font-semibold">Assistant</span>
                <div className="grow" />
                <PrivacyBadge />
              </div>
              <div className="flex flex-wrap gap-2">
                <SuggestionChip onClick={() => undefined}>What do we pay this week?</SuggestionChip>
                <SuggestionChip onClick={() => undefined}>Pause everything</SuggestionChip>
              </div>
              <Message from="user">Pay Maria 1,500 USDC monthly on Base</Message>
              <Message from="assistant" streaming>
                Here is a schedule for Maria. Payroll’s mandate doesn’t list her yet, so I added that change too
              </Message>
              <div className="pl-1">
                <TypingDots />
              </div>
              <BatchBar count={proposal === "queued" ? 1 : 0} onReview={() => setProposal("signed")} />
              <AssistantFooter />
            </Card>
            <div className="flex flex-col gap-3">
              <ProposalCard
                title="Add schedule · Maria Lopez"
                status={proposal}
                rows={[
                  { label: "Amount", to: "1,500.00 USDC" },
                  { label: "Frequency", to: "Monthly, 1st" },
                  { label: "Payroll daily", from: "3,000.00", to: "4,500.00" },
                ]}
                warning="Above the approval threshold — each payment will wait for you."
                actions={proposal === "draft" ? <ProposalActions onEdit={() => setDrawer(true)} onDiscard={() => undefined} onQueue={() => setProposal("queued")} /> : undefined}
              />
              <ProposalCard
                danger
                title="Pause all agents"
                status="draft"
                rows={[{ label: "Effect", to: "No payments until you resume" }]}
                actions={<Button size="sm" variant="danger-fill" icon={<Icons.Pause size={13} />}>Pause now</Button>}
              />
            </div>
          </div>
        </Section>

        <Section title="Overlays & feedback">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setDrawer(true)}>Open drawer</Button>
            <Button onClick={() => setConfirmPause(true)}>Open confirm sheet</Button>
            <Button onClick={() => toast({ text: "Approved · Maria Lopez paid now", href: "https://nearblocks.io" })}>Toast ok</Button>
            <Button onClick={() => toast({ text: "Transfer failed — reservation released", accent: "danger" })}>Toast error</Button>
          </div>
          <Callout accent="danger">Wallet rejected the transaction.</Callout>
          <Callout accent="info" icon={<Icons.Info />}>
            Intents has no testnet: payouts route on mainnet with tiny amounts.
          </Callout>
          <Card padding="none">
            <EmptyState title="No agents yet" action={<Button variant="primary" icon={<Icons.Plus />}>Add agent</Button>}>
              An agent can only ask the vault to pay. The vault checks every request against your rules.
            </EmptyState>
          </Card>
        </Section>
      </Page>

      <Modal
        open={confirmPause}
        onClose={() => setConfirmPause(false)}
        danger={!paused}
        title={paused ? "Resume agent?" : "Pause agent?"}
        footer={
          <>
            <Button onClick={() => setConfirmPause(false)}>Cancel</Button>
            <Button
              variant={paused ? "primary" : "danger-fill"}
              onClick={() => {
                setPaused((p) => !p);
                setConfirmPause(false);
                toast({ text: paused ? "Agent resumed" : "Agent paused", accent: paused ? "ok" : "danger" });
              }}
            >
              {paused ? "Resume" : "Pause now"}
            </Button>
          </>
        }
      >
        {paused ? "The agent will continue with the next run." : "The vault will refuse every payout request until you resume. Already sent payments are not affected."}
      </Modal>

      <Drawer
        open={drawer}
        onClose={() => {
          setDrawer(false);
          setSigning(false);
        }}
        title="New schedule"
        subtitle="Payroll agent · Fixed recipients"
        footer={
          <>
            {signing && <SigningHint />}
            <Button onClick={() => setDrawer(false)}>Cancel</Button>
            <Button variant="primary" loading={signing} onClick={() => setSigning(true)}>
              Create schedule
            </Button>
          </>
        }
      >
        <div className="step-in flex flex-col gap-4">
          <Field label="Recipient">
            {(a) => (
              <Select {...a}>
                <option>Maria Lopez · Base</option>
              </Select>
            )}
          </Field>
          <Field label="Amount">{(a) => <Input {...a} mono defaultValue="1,500.00" suffix="USDC" />}</Field>
          <Segmented label="Frequency" value="monthly" onChange={() => undefined} options={[{ value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }, { value: "once", label: "Once" }]} />
          <Callout accent="ok" icon={<Icons.Check />}>
            Fits payroll’s mandate
          </Callout>
        </div>
      </Drawer>
    </>
  );
}
