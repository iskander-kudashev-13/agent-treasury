import { z } from "zod";

/** Terminal statuses: after one of these the swap will not change anymore. */
export const TERMINAL_STATUSES = ["SUCCESS", "REFUNDED", "FAILED"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

const STATUSES = [
  "KNOWN_DEPOSIT_TX",
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;
export type SwapStatus = (typeof STATUSES)[number];

export function isTerminal(status: SwapStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

const tokenSchema = z.looseObject({
  assetId: z.string(),
  decimals: z.number().int(),
  blockchain: z.string(),
  symbol: z.string(),
  price: z.number().optional(),
  priceUpdatedAt: z.string().optional(),
  contractAddress: z.string().optional(),
});
export type Token = z.infer<typeof tokenSchema>;

const quoteRequestSchema = z.looseObject({
  dry: z.boolean(),
  swapType: z.string(),
  slippageTolerance: z.number(),
  originAsset: z.string(),
  depositType: z.string(),
  destinationAsset: z.string(),
  amount: z.string(),
  refundTo: z.string(),
  refundType: z.string(),
  recipient: z.string(),
  recipientType: z.string(),
  deadline: z.string(),
  customRecipientMsg: z.string().optional(),
  msg: z.string().optional(),
});

const quoteSchema = z.looseObject({
  depositAddress: z.string().optional(),
  amountIn: z.string(),
  amountOut: z.string(),
  amountOutFormatted: z.string().optional(),
  minAmountOut: z.string(),
  deadline: z.string().optional(),
  timeEstimate: z.number().optional(),
  withdrawFee: z.string().optional(),
});

const quoteResponseSchema = z.looseObject({
  correlationId: z.string().optional(),
  timestamp: z.string().optional(),
  signature: z.string().optional(),
  quoteRequest: quoteRequestSchema,
  quote: quoteSchema,
});
export type QuoteResponse = z.infer<typeof quoteResponseSchema>;

export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

const txHashesSchema = z.array(z.looseObject({ hash: z.string(), explorerUrl: z.string().optional() }));
const statusResponseSchema = z.looseObject({
  correlationId: z.string().optional(),
  status: z.enum(STATUSES),
  updatedAt: z.string().optional(),
  swapDetails: z
    .looseObject({
      originChainTxHashes: txHashesSchema.optional(),
      destinationChainTxHashes: txHashesSchema.optional(),
      refundedAmount: z.string().optional(),
      refundReason: z.string().optional(),
    })
    .optional(),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export type OneClickErrorKind = "timeout" | "network" | "http" | "schema";

export class OneClickError extends Error {
  constructor(
    readonly kind: OneClickErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "OneClickError";
  }
}

export interface OneClickOptions {
  baseUrl: string;
  /** Sent as `X-API-Key`. */
  apiKey?: string | undefined;
  /** Partner JWT, sent as `Authorization: Bearer`. */
  jwt?: string | undefined;
  timeoutMs?: number;
  tokensTtlMs?: number;
  fetchFn?: typeof fetch;
  now?: () => number;
}

/** Typed client for the 1Click API (https://1click.chaindefuser.com, OpenAPI v0.1.10). Every request has a timeout. */
export class OneClickClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly jwt: string | undefined;
  private readonly timeoutMs: number;
  private readonly tokensTtlMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private tokensCache: { at: number; tokens: Token[] } | undefined;

  constructor(opts: OneClickOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.jwt = opts.jwt;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.tokensTtlMs = opts.tokensTtlMs ?? 10 * 60_000;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: { method: "POST"; body: unknown }): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init) headers["Content-Type"] = "application/json";
    // Both credentials are supported: X-API-Key (ONECLICK_API_KEY) and Bearer JWT (ONECLICK_JWT).
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (this.jwt) headers.Authorization = `Bearer ${this.jwt}`;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers,
        ...(init ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new OneClickError("timeout", `1Click ${path} timed out after ${this.timeoutMs} ms`);
      }
      throw new OneClickError("network", `1Click ${path} request failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new OneClickError("timeout", `1Click ${path} body timed out after ${this.timeoutMs} ms`);
      }
      throw new OneClickError("network", `1Click ${path} body read failed`);
    }
    if (!res.ok) {
      throw new OneClickError("http", `1Click ${path} returned HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, text.slice(0, 500));
    }
    let json: unknown;
    try {
      json = text === "" ? {} : JSON.parse(text);
    } catch {
      throw new OneClickError("schema", `1Click ${path} returned invalid JSON`, res.status, text.slice(0, 200));
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new OneClickError("schema", `1Click ${path} response does not match schema: ${parsed.error.message}`, res.status);
    }
    return parsed.data;
  }

  /** `GET /v0/tokens`, cached (default 10 min). */
  async getTokens(): Promise<Token[]> {
    const t = this.now();
    if (this.tokensCache && t - this.tokensCache.at < this.tokensTtlMs) return this.tokensCache.tokens;
    const tokens = await this.request("/v0/tokens", z.array(tokenSchema));
    this.tokensCache = { at: t, tokens };
    return tokens;
  }

  /** Never hand-build an assetId: only ids present in `/v0/tokens` are accepted. */
  async findToken(assetId: string): Promise<Token | undefined> {
    return (await this.getTokens()).find((tk) => tk.assetId === assetId);
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    return this.request("/v0/quote", quoteResponseSchema, { method: "POST", body: req });
  }

  /** Optional hint that the deposit tx was sent; speeds up detection. Failure is not fatal for the caller. */
  async submitDeposit(args: { txHash: string; depositAddress: string; nearSenderAccount: string }): Promise<void> {
    await this.request("/v0/deposit/submit", z.looseObject({}), { method: "POST", body: args });
  }

  async getStatus(depositAddress: string): Promise<StatusResponse> {
    return this.request(`/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, statusResponseSchema);
  }
}
