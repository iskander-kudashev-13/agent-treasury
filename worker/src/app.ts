import { Hono } from "hono";
import { cors } from "hono/cors";
import { timingSafeEqual } from "node:crypto";
import type { AttestationSummary, RegistrationState } from "./near.js";
import type { AiDeps } from "./ai/index.js";
import { createAiRouter } from "./ai/index.js";
import type { PayoutLoop } from "./payout-loop.js";
import type { AgentBudget, Rejection, UpcomingItem } from "./vault.js";

export interface AppDeps {
  mode: "local" | "tee";
  network: string;
  vaultId: string;
  dryRun: boolean;
  oneclickMode: "live" | "simulated";
  agentAccountId: string;
  agentId: string;
  loop: PayoutLoop;
  budget: () => Promise<AgentBudget | null>;
  rejections: (limit: number) => Promise<Rejection[]>;
  /** Number of schedules due now and the next expected payments (`get_due`, `get_upcoming`). */
  schedules: () => Promise<{ due: number; upcoming: UpcomingItem[] }>;
  registration: () => RegistrationState;
  attestation: () => Promise<AttestationSummary | undefined>;
  adminToken: string | undefined;
  dashboardOrigin: string;
  /** AI assistant (docs: worker/README.md "AI assistant"). Omitted = routes not mounted. */
  ai?: AiDeps;
}

function tokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  app.use(cors({ origin: d.dashboardOrigin, allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Authorization", "Content-Type"] }));

  app.get("/", (c) => c.json({ message: "agent-treasury worker is running" }));

  app.get("/status", async (c) => {
    const reg = d.registration();
    const last = d.loop.lastRun();
    // Vault reads are best-effort: /status must still answer when the RPC is down.
    const [budget, rejections, sched] = await Promise.all([
      d.budget().catch(() => null),
      d.rejections(10).catch(() => null),
      d.schedules().catch(() => null),
    ]);
    return c.json({
      mode: d.mode,
      insecureDevMode: d.mode === "local",
      network: d.network,
      vaultContractId: d.vaultId,
      dryRun: d.dryRun,
      oneclickMode: d.oneclickMode,
      agentId: d.agentId,
      agentAccountId: d.agentAccountId,
      budget,
      lastRejections: rejections,
      due: sched?.due ?? null,
      upcoming: sched?.upcoming ?? null,
      registration: reg,
      registered: reg.state === "registered",
      running: d.loop.isRunning,
      lastRun: last ?? null,
      nextRunAt: d.loop.nextRunAt?.toISOString() ?? null,
      attestation: (await d.attestation()) ?? null,
    });
  });

  app.get("/runs", (c) => c.json({ runs: d.loop.recentRuns() }));

  app.post("/run", (c) => {
    if (!d.adminToken) return c.json({ error: "POST /run is disabled: WORKER_ADMIN_TOKEN is not set" }, 403);
    const m = /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "");
    if (!m?.[1] || !tokenOk(m[1], d.adminToken)) return c.json({ error: "unauthorized" }, 401);
    if (d.loop.isRunning) return c.json({ error: "a run is already in progress" }, 409);
    if (!d.dryRun && d.registration().state !== "registered") return c.json({ error: "agent is not registered yet" }, 409);
    // Fire and forget: runs can take minutes (status polling). Follow progress via GET /runs.
    void d.loop.run("manual");
    return c.json({ started: true }, 202);
  });

  if (d.ai) app.route("/ai", createAiRouter(d.ai));

  return app;
}
