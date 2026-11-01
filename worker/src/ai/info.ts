/**
 * Data for the panel's privacy badge (UI_UPDATES.md §6.6), best effort and cached.
 * Docs read: https://docs.near.ai/cloud/models.md (privacy tiers), .../verification/cloud-api/model-attestations.md,
 * .../gateway-attestation.md. `GET /v1/models` is public; `GET /v1/attestation/report` needs the API key.
 * The worker FETCHES the attestation report but does not verify the Intel TDX quote / NVIDIA evidence itself
 * (that needs dcap-qvl + NRAS); the badge must say so, and links to the NEAR AI Verification Center.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

export type PrivacyTier = "confidential_tee" | "third_party_tee" | "incognito" | "unknown";

export interface AiInfoPayload {
  model: string;
  provider: "NEAR AI Cloud";
  /** True only for models NEAR AI runs itself inside TEEs ("Confidential TEE"). */
  private: boolean;
  tier: PrivacyTier;
  attestation: AttestationSummary | null;
}

export interface AttestationSummary {
  status: "fetched_unverified";
  fetched_at: string;
  nonce_echoed: boolean;
  model_reports: number;
  model_signing_address: string | null;
  gateway_signing_address: string | null;
  has_intel_quote: boolean;
  has_nvidia_payload: boolean;
  verify_url: string;
  note: string;
}

const modelsSchema = z.looseObject({ data: z.array(z.looseObject({ id: z.string(), owned_by: z.string().optional() })) });
const reportSchema = z.looseObject({
  gateway_attestation: z.looseObject({ signing_address: z.string().optional(), request_nonce: z.string().optional() }).optional(),
  model_attestations: z
    .array(z.looseObject({ signing_address: z.string().optional(), request_nonce: z.string().optional(), intel_quote: z.unknown().optional(), nvidia_payload: z.unknown().optional() }))
    .optional(),
});

export function tierOf(ownedBy: string | undefined): PrivacyTier {
  if (!ownedBy) return "unknown";
  const o = ownedBy.toLowerCase();
  if (o === "nearai") return "confidential_tee";
  if (o === "attested 3p") return "third_party_tee";
  return "incognito";
}

export interface InfoConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
  timeoutMs?: number;
}

const OK_TTL = 10 * 60_000;
const FAIL_TTL = 60_000;

export class AiInfo {
  private cache: { at: number; ttl: number; value: AiInfoPayload } | undefined;

  constructor(
    private readonly cfg: InfoConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<AiInfoPayload> {
    if (this.cache && this.now() - this.cache.at < this.cache.ttl) return this.cache.value;
    let tier: PrivacyTier = "unknown";
    let attestation: AttestationSummary | null = null;
    let failed = false;
    try {
      tier = await this.fetchTier();
    } catch {
      failed = true;
    }
    if (this.cfg.apiKey) {
      try {
        attestation = await this.fetchAttestation();
      } catch {
        failed = true;
      }
    }
    const value: AiInfoPayload = { model: this.cfg.model, provider: "NEAR AI Cloud", private: tier === "confidential_tee", tier, attestation };
    this.cache = { at: this.now(), ttl: failed ? FAIL_TTL : OK_TTL, value };
    return value;
  }

  private async getJson(path: string, auth: boolean, headers: Record<string, string> = {}): Promise<unknown> {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`, {
      headers: { Accept: "application/json", ...headers, ...(auth && this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}) },
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  private async fetchTier(): Promise<PrivacyTier> {
    const models = modelsSchema.parse(await this.getJson("/models", false));
    return tierOf(models.data.find((m) => m.id === this.cfg.model)?.owned_by);
  }

  private async fetchAttestation(): Promise<AttestationSummary> {
    const nonce = randomBytes(32).toString("hex");
    const q = new URLSearchParams({ model: this.cfg.model, provider: "near", include_tls_fingerprint: "false", signing_algo: "ecdsa", nonce });
    const r = reportSchema.parse(await this.getJson(`/attestation/report?${q.toString()}`, true, { "x-no-aliasing": "true" }));
    const models = r.model_attestations ?? [];
    const first = models[0];
    return {
      status: "fetched_unverified",
      fetched_at: new Date(this.now()).toISOString(),
      nonce_echoed: models.length > 0 && models.every((m) => m.request_nonce === nonce) && r.gateway_attestation?.request_nonce === nonce,
      model_reports: models.length,
      model_signing_address: first?.signing_address ?? null,
      gateway_signing_address: r.gateway_attestation?.signing_address ?? null,
      has_intel_quote: models.some((m) => m.intel_quote !== undefined && m.intel_quote !== null),
      has_nvidia_payload: models.some((m) => m.nvidia_payload !== undefined && m.nvidia_payload !== null),
      verify_url: "https://cloud.near.ai/verify",
      note: "Report fetched from NEAR AI Cloud; the Intel TDX quote and NVIDIA evidence are NOT verified by this worker. Verify in the NEAR AI Verification Center.",
    };
  }
}
