/**
 * HlPort over @nktkas/hyperliquid (ADR-0005 W2).
 *
 * Identity model: `wallet` is the bot's HL API wallet (a secp256k1 account that signs L1 actions only). `account`
 * arguments of the port are the owner's HL MASTER address, used for info queries. HL resolves the master from the signed
 * order itself because the API wallet was approved for it, so no `vaultAddress` is set.
 *
 * Spot only: the port has no perp order path, `placeSpotOrder` and `cancelOrders` refuse any asset id below 10000 and any
 * id that is not a spot pair in the current `spotMeta`.
 *
 * Wallet: `AbstractWallet` accepts a viem local account, an ethers v5/v6 signer or a viem JSON-RPC account. The caller passes
 * `ApiWallet.signer()` (wallet.ts), a viem `privateKeyToAccount` over the stored API-wallet key.
 */
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { ApiRequestError } from "@nktkas/hyperliquid/api/exchange";
import type { AbstractWallet } from "@nktkas/hyperliquid/signing";
import type {
  Dec,
  HlApprovedAgent,
  HlBook,
  HlCandle,
  HlFill,
  HlLedgerEntry,
  HlMids,
  HlOpenOrder,
  HlOrderResult,
  HlPerpState,
  HlPlaceOrder,
  HlPort,
  HlSpotBalance,
  HlSpotPair,
  Window,
} from "../types.js";
import { isDecimal, isValidPrice, mulDec, normalizeDec, cmpDec } from "./format.js";
import { readAllFills } from "./pagination.js";

export const SPOT_ASSET_ID_BASE = 10000;
const CLOID_RE = /^0x[0-9a-fA-F]{32}$/;
/** HL message for an IOC that found nothing inside its limit price. */
const IOC_NO_MATCH_RE = /could not immediately match|no resting orders|IocCancel/i;
/** Cancelling an order that is already gone is the goal state, not an error. */
const ALREADY_GONE_RE = /never placed|already canceled|already cancelled|filled/i;

export type HlInfoApi = Pick<
  InfoClient,
  | "spotMetaAndAssetCtxs"
  | "allMids"
  | "l2Book"
  | "candleSnapshot"
  | "spotClearinghouseState"
  | "clearinghouseState"
  | "frontendOpenOrders"
  | "userFillsByTime"
  | "userNonFundingLedgerUpdates"
  | "extraAgents"
>;
export type HlExchangeApi = Pick<ExchangeClient, "order" | "cancel" | "scheduleCancel">;

export interface NktkasHlOptions {
  info: HlInfoApi;
  exchange: HlExchangeApi;
  now?: () => number;
  /**
   * Defence in depth: a resting (Gtc) order is only signed while this returns true (the dead-man switch works). Absent = false,
   * i.e. IOC only. The engine already refuses limit orders without the switch; this is the second lock.
   */
  deadManAvailable?: () => boolean;
}

export interface CreateNktkasHlOptions {
  network: "mainnet" | "testnet";
  /** The bot's API wallet. Never the master key. */
  wallet: AbstractWallet;
  timeoutMs?: number;
  now?: () => number;
  deadManAvailable?: () => boolean;
}

export function createNktkasHl(opts: CreateNktkasHlOptions): NktkasHl {
  const transport = new HttpTransport({ isTestnet: opts.network === "testnet", timeout: opts.timeoutMs ?? 10_000 });
  return new NktkasHl({
    info: new InfoClient({ transport }),
    exchange: new ExchangeClient({ transport, wallet: opts.wallet }),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.deadManAvailable ? { deadManAvailable: opts.deadManAvailable } : {}),
  });
}

interface PairMeta {
  /** Display name, "HYPE/USDC". */
  name: string;
  /** HL coin name used by info endpoints: "@107" (or "PURR/USDC" for the legacy pair). */
  coin: string;
  assetId: number;
  szDecimals: number;
  base: string;
}

export class NktkasHl implements HlPort {
  private readonly info: HlInfoApi;
  private readonly exchange: HlExchangeApi;
  private readonly now: () => number;
  private readonly deadManAvailable: () => boolean;
  private byName = new Map<string, PairMeta>();
  private byCoin = new Map<string, PairMeta>();
  private byAssetId = new Map<number, PairMeta>();
  private readonly warnedLedger = new Set<string>();

  constructor(opts: NktkasHlOptions) {
    this.info = opts.info;
    this.exchange = opts.exchange;
    this.now = opts.now ?? Date.now;
    this.deadManAvailable = opts.deadManAvailable ?? (() => false);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------------------------------------------

  async getSpotPairs(): Promise<HlSpotPair[]> {
    const [meta, ctxs] = await this.info.spotMetaAndAssetCtxs();
    const ctxByCoin = new Map(ctxs.map((c) => [c.coin, c]));
    const tokenName = (i: number) => meta.tokens.find((t) => t.index === i)?.name;

    // Display names can collide (non-canonical tokens may reuse a name). Keep the canonical pair; when none of the
    // colliders is canonical the name is ambiguous and dropped, so the engine can never trade a look-alike token.
    const candidates = new Map<string, { canonical: boolean; meta: PairMeta; ctx: (typeof ctxs)[number] | undefined }[]>();
    for (const u of meta.universe) {
      const [b, q] = u.tokens;
      const baseTok = meta.tokens.find((t) => t.index === b);
      const base = tokenName(b);
      const quote = tokenName(q);
      if (!baseTok || !base || !quote) continue;
      const name = `${base}/${quote}`;
      const entry = {
        canonical: u.isCanonical,
        meta: { name, coin: u.name, assetId: SPOT_ASSET_ID_BASE + u.index, szDecimals: baseTok.szDecimals, base },
        ctx: ctxByCoin.get(u.name) ?? ctxs[u.index],
      };
      const list = candidates.get(name) ?? [];
      list.push(entry);
      candidates.set(name, list);
    }

    const byName = new Map<string, PairMeta>();
    const out: HlSpotPair[] = [];
    for (const [name, list] of candidates) {
      const canon = list.filter((e) => e.canonical);
      const pick = canon.length === 1 ? canon[0] : list.length === 1 ? list[0] : undefined;
      if (!pick) continue;
      byName.set(name, pick.meta);
      const mid = pick.ctx?.midPx;
      out.push({
        name,
        base: pick.meta.base,
        assetId: pick.meta.assetId,
        szDecimals: pick.meta.szDecimals,
        volume24hUsdc: normalizeDec(pick.ctx?.dayNtlVlm ?? "0"),
        midUsdc: mid && isDecimal(mid) ? normalizeDec(mid) : null,
      });
    }
    this.byName = byName;
    this.byCoin = new Map([...byName.values()].map((m) => [m.coin, m]));
    this.byAssetId = new Map([...byName.values()].map((m) => [m.assetId, m]));
    return out;
  }

  private async pair(name: string): Promise<PairMeta> {
    let m = this.byName.get(name);
    if (!m && this.byName.size === 0) {
      await this.getSpotPairs();
      m = this.byName.get(name);
    }
    if (!m) throw new Error(`unknown or ambiguous spot pair ${name}`);
    return m;
  }

  /** Display name of an HL coin, or the raw coin when it is not a known spot pair. */
  private displayOf(coin: string): string {
    return this.byCoin.get(coin)?.name ?? coin;
  }

  private async ensureMeta(): Promise<void> {
    if (this.byName.size === 0) await this.getSpotPairs();
  }

  private static isSpotCoin(coin: string): boolean {
    // Spot coins are "@<index>" or the legacy "PURR/USDC". Perps are bare tickers ("BTC") or "dex:TICKER" (HIP-3).
    return coin.startsWith("@") || coin.includes("/");
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Market data
  // ---------------------------------------------------------------------------------------------------------------

  async getMids(): Promise<HlMids> {
    await this.ensureMeta();
    const raw = await this.info.allMids();
    const mids: Record<string, Dec> = {};
    for (const [coin, px] of Object.entries(raw)) {
      const m = this.byCoin.get(coin);
      if (m && isDecimal(px)) mids[m.name] = normalizeDec(px);
    }
    return { mids, atMs: this.now() };
  }

  async getBook(pair: string): Promise<HlBook> {
    const m = await this.pair(pair);
    const book = await this.info.l2Book({ coin: m.coin });
    const bid = book?.levels[0][0]?.px;
    const ask = book?.levels[1][0]?.px;
    return {
      bid: bid && isDecimal(bid) ? normalizeDec(bid) : null,
      ask: ask && isDecimal(ask) ? normalizeDec(ask) : null,
      atMs: this.now(),
    };
  }

  async getCandles(pair: string, interval: Window, startMs: number, endMs: number): Promise<HlCandle[]> {
    const m = await this.pair(pair);
    const rows = await this.info.candleSnapshot({ coin: m.coin, interval, startTime: startMs, endTime: endMs });
    return rows.map((c) => ({ openTimeMs: c.t, closeTimeMs: c.T, open: normalizeDec(c.o), close: normalizeDec(c.c) }));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Account state (master address)
  // ---------------------------------------------------------------------------------------------------------------

  async getSpotBalances(account: string): Promise<HlSpotBalance[]> {
    const s = await this.info.spotClearinghouseState({ user: asAddress(account) });
    const out: HlSpotBalance[] = [];
    for (const b of s.balances) {
      if (b.coin.startsWith("+") || /^o\d+$/.test(b.coin)) continue; // outcome-market pseudo coins, not spot tokens
      out.push({ coin: b.coin, total: normalizeDec(b.total), hold: normalizeDec(b.hold) });
    }
    return out;
  }

  /**
   * Perp exposure of the default dex: non-zero positions, open perp orders, account value.
   * Limitation: HIP-3 builder dexes (other `dex` values) are not queried.
   */
  async getPerpState(account: string): Promise<HlPerpState> {
    const user = asAddress(account);
    const [ch, orders] = await Promise.all([this.info.clearinghouseState({ user }), this.info.frontendOpenOrders({ user })]);
    return {
      positions: ch.assetPositions
        .filter((p) => !/^-?0+(\.0+)?$/.test(p.position.szi))
        .map((p) => ({ coin: p.position.coin, size: p.position.szi })),
      openPerpOrders: orders.filter((o) => !NktkasHl.isSpotCoin(o.coin)).length,
      accountValueUsdc: normalizeDec(ch.marginSummary.accountValue.replace(/^-/, "")),
    };
  }

  async getOpenOrders(account: string): Promise<HlOpenOrder[]> {
    await this.ensureMeta();
    const orders = await this.info.frontendOpenOrders({ user: asAddress(account) });
    return orders.map((o) => {
      const spot = NktkasHl.isSpotCoin(o.coin);
      return {
        oid: o.oid,
        cloid: o.cloid,
        market: spot ? "spot" : "perp",
        pair: spot ? this.displayOf(o.coin) : o.coin,
        side: o.side === "B" ? "buy" : "sell",
        price: normalizeDec(o.limitPx),
        size: normalizeDec(o.sz),
        placedAtMs: o.timestamp,
      };
    });
  }

  async getUserFills(account: string, startMs: number): Promise<HlFill[]> {
    await this.ensureMeta();
    const user = asAddress(account);
    return readAllFills(async (start, end) => {
      const rows = await this.info.userFillsByTime(end === undefined ? { user, startTime: start } : { user, startTime: start, endTime: end });
      return {
        rawCount: rows.length,
        maxTimeMs: rows.reduce<number | null>((m, f) => (m === null || f.time > m ? f.time : m), null),
        minTimeMs: rows.reduce<number | null>((m, f) => (m === null || f.time < m ? f.time : m), null),
        ascending: rows.every((f, i) => i === 0 || (rows[i - 1]?.time ?? 0) <= f.time),
        fills: rows
          .filter((f) => NktkasHl.isSpotCoin(f.coin))
          .map((f) => ({
            oid: f.oid,
            tid: f.tid,
            cloid: f.cloid ?? null,
            pair: this.displayOf(f.coin),
            side: f.side === "B" ? ("buy" as const) : ("sell" as const),
            price: normalizeDec(f.px),
            size: normalizeDec(f.sz),
            feeUsdc: feeInUsdc(f.fee, f.feeToken, f.px),
            feeToken: f.feeToken,
            feeAmount: rawFeeAmount(f.fee),
            timeMs: f.time,
          })),
      };
    }, startMs);
  }

  /**
   * USDC movements into/out of the account, for the loss stop's net inflow. Mapping (live fields not yet observed with a
   * real 1Click landing, see docs/research/hyperliquid-trading.md "V0 spike results"):
   * - `deposit` (Arbitrum bridge) -> deposit; `withdraw` -> withdraw;
   * - `spotTransfer` / `send` of USDC and `internalTransfer`: transfer_in when `destination` is the account, else
   *   transfer_out when `user` is the account (fee not included).
   * - `accountClassTransfer`: `class_in` (perp -> spot) / `class_out` (spot -> perp). Not external flows (netFunded skips them),
   *   but the equity backstop counts them as flows.
   * Vault and reward entries are not external flows.
   */
  async getLedger(account: string, startMs: number): Promise<HlLedgerEntry[]> {
    const user = asAddress(account);
    const rows = await this.info.userNonFundingLedgerUpdates({ user, startTime: startMs });
    const me = user.toLowerCase();
    const out: HlLedgerEntry[] = [];
    for (const r of rows) {
      const d = r.delta;
      switch (d.type) {
        case "deposit":
          out.push({ timeMs: r.time, kind: "deposit", usdc: normalizeDec(d.usdc) });
          break;
        case "withdraw":
          out.push({ timeMs: r.time, kind: "withdraw", usdc: normalizeDec(d.usdc) });
          break;
        case "spotTransfer":
        case "send": {
          if (d.token.split(":")[0] !== "USDC") break;
          const kind = flowKind(me, d.user, d.destination);
          if (kind) out.push({ timeMs: r.time, kind, usdc: normalizeDec(d.amount) });
          break;
        }
        case "accountClassTransfer":
          // Spot <-> perp inside the account: not an external flow, but it moves the spot USDC the equity backstop watches.
          out.push({ timeMs: r.time, kind: d.toPerp ? "class_out" : "class_in", usdc: normalizeDec(d.usdc) });
          break;
        case "internalTransfer": {
          const kind = flowKind(me, d.user, d.destination);
          if (kind) out.push({ timeMs: r.time, kind, usdc: normalizeDec(d.usdc) });
          break;
        }
        default:
          // Not an external USDC flow we know of. Surface unknown types once, so a new HL ledger type that moves USDC in
          // or out (and would distort the loss stop) is noticed.
          if (!KNOWN_NON_FLOW.has(d.type) && !this.warnedLedger.has(d.type)) {
            this.warnedLedger.add(d.type);
            console.warn(`[trading] unknown HL ledger delta type "${d.type}" ignored for the net-flow calculation`);
          }
          break;
      }
    }
    return out;
  }

  /** API wallets approved by the master (`extraAgents` info request). `validUntil` is a ms timestamp or null. */
  async getApprovedAgents(account: string): Promise<HlApprovedAgent[]> {
    const rows = await this.info.extraAgents({ user: asAddress(account) });
    return rows.map((a) => ({ address: a.address.toLowerCase(), name: a.name === "" ? null : a.name, validUntilMs: a.validUntil }));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Trading (signed by the API wallet)
  // ---------------------------------------------------------------------------------------------------------------

  async placeSpotOrder(order: HlPlaceOrder): Promise<HlOrderResult> {
    await this.assertSpotAsset(order.assetId);
    if (!isDecimal(order.price) || cmpDec(order.price, "0") <= 0) throw new Error(`bad order price ${order.price}`);
    if (!isDecimal(order.size) || cmpDec(order.size, "0") <= 0) throw new Error(`bad order size ${order.size}`);
    if (!CLOID_RE.test(order.cloid)) throw new Error(`bad cloid ${order.cloid}`);
    // Last line of defence before signing: the price must already obey HL's tick rules and the size its lot size
    // (a wrong string would at best be rejected, at worst hash differently from what the node computes).
    const meta = this.byAssetId.get(order.assetId);
    if (!meta) throw new Error(`refused: asset id ${order.assetId} is not a known spot pair`);
    if (!isValidPrice(order.price, meta.szDecimals)) throw new Error(`refused: price ${order.price} violates the tick rules for ${meta.name}`);
    if (order.size !== normalizeDec(order.size) || (order.size.split(".")[1] ?? "").length > meta.szDecimals)
      throw new Error(`refused: size ${order.size} violates the lot size of ${meta.name} (${meta.szDecimals} decimals)`);
    const tif: string = order.tif; // runtime guard: callers may bypass the type (JSON, casts)
    if (tif !== "Ioc" && tif !== "Gtc") throw new Error(`unsupported tif ${tif}`);
    // A resting order outlives a dead worker; only the dead-man switch cancels it. No switch, no resting orders.
    if (tif !== "Ioc" && !this.deadManAvailable()) throw new Error(`refused: ${tif} order without a working dead-man switch (IOC only)`);

    let res;
    try {
      res = await this.exchange.order({
        orders: [
          {
            a: order.assetId,
            b: order.isBuy,
            p: order.price,
            s: order.size,
            r: false, // reduce-only is a perp concept
            t: { limit: { tif: order.tif } },
            c: order.cloid,
          },
        ],
        grouping: "na",
      });
    } catch (e) {
      // HL answered with an error status: the order definitely does not exist. Anything else (network, timeout) leaves
      // the outcome unknown, so it propagates and the engine reconciles through getOpenOrders/getUserFills.
      if (e instanceof ApiRequestError) {
        return IOC_NO_MATCH_RE.test(e.message) ? { status: "unfilled" } : { status: "rejected", error: e.message };
      }
      throw e;
    }
    const st = res.response.data.statuses[0];
    if (st === undefined) return { status: "rejected", error: "empty statuses in order response" };
    if (typeof st === "string") return { status: "rejected", error: `unexpected order status ${st}` };
    if ("filled" in st) return { status: "filled", oid: st.filled.oid, filledSize: normalizeDec(st.filled.totalSz), avgPx: normalizeDec(st.filled.avgPx) };
    if ("resting" in st) return { status: "resting", oid: st.resting.oid };
    return { status: "rejected", error: "unrecognised order status" };
  }

  async cancelOrders(orders: { assetId: number; oid: number }[]): Promise<void> {
    if (orders.length === 0) return;
    for (const o of orders) await this.assertSpotAsset(o.assetId);
    try {
      await this.exchange.cancel({ cancels: orders.map((o) => ({ a: o.assetId, o: o.oid })) });
    } catch (e) {
      if (e instanceof ApiRequestError && ALREADY_GONE_RE.test(e.message)) return;
      throw e;
    }
  }

  async scheduleCancel(timeMs: number | null): Promise<void> {
    if (timeMs === null) await this.exchange.scheduleCancel();
    else {
      if (!Number.isSafeInteger(timeMs) || timeMs <= 0) throw new Error(`bad scheduleCancel time ${timeMs}`);
      await this.exchange.scheduleCancel({ time: timeMs });
    }
  }

  /** Hard spot-only guard: a perp (id < 10000) or an unknown id never reaches the signer. */
  private async assertSpotAsset(assetId: number): Promise<void> {
    if (!Number.isInteger(assetId) || assetId < SPOT_ASSET_ID_BASE) {
      throw new Error(`refused: asset id ${assetId} is not a spot asset (< ${SPOT_ASSET_ID_BASE}); this module never trades perps`);
    }
    if (!this.byAssetId.has(assetId)) await this.getSpotPairs();
    if (!this.byAssetId.has(assetId)) throw new Error(`refused: asset id ${assetId} is not a known spot pair`);
  }
}

/** Ledger delta types that are known not to be external USDC flows (or are not USDC). */
const KNOWN_NON_FLOW = new Set([
  "vaultCreate",
  "vaultDeposit",
  "vaultWithdraw",
  "vaultDistribution",
  "vaultLeaderCommission",
  "rewardsClaim",
  "spotGenesis",
  "liquidation",
  "subAccountTransfer",
  "cStakingTransfer",
  "borrowLend",
  "activateDuringTransfer",
  "deployGasAuction",
  "perpDexClassTransfer",
  "perpDexTransfer",
  "spotDust",
]);

function asAddress(a: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`bad HL address ${a}`);
  return a.toLowerCase() as `0x${string}`;
}

function flowKind(me: string, from: string, to: string): "transfer_in" | "transfer_out" | null {
  if (to.toLowerCase() === me) return "transfer_in";
  if (from.toLowerCase() === me) return "transfer_out";
  return null;
}

/** The fee as HL charged it, in its own token. A rebate (negative) or malformed value counts as 0, like `feeInUsdc`. */
function rawFeeAmount(fee: string): Dec {
  return fee.startsWith("-") || !isDecimal(fee) ? "0" : normalizeDec(fee);
}

/** Fee in USDC: buys pay the fee in the base token, so convert at the fill price. Rebates (negative) count as 0. */
function feeInUsdc(fee: string, feeToken: string, px: string): Dec {
  if (fee.startsWith("-") || !isDecimal(fee)) return "0";
  return feeToken === "USDC" ? normalizeDec(fee) : mulDec(fee, px);
}
