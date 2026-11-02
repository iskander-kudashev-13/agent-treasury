/**
 * The bot's Hyperliquid API-wallet key (ADR-0005 section 3).
 *
 * - secp256k1 key generated with node:crypto randomness; the EVM address and the HL signer come from viem
 *   (`privateKeyToAccount`), so there is no hand-written crypto in this module.
 * - Stored in `<stateDir>/api-wallet.json` with mode 0600. A file that is group/world accessible is refused.
 * - Only the address leaves this module through `ApiWallet.address`. The raw key is available through `reveal()`,
 *   which exists for the HL signing adapter only; the object serialises without it.
 * - Rotation creates a brand-new key. Addresses ever used are kept (addresses only) in `retired-api-wallets.json`
 *   and are never generated again (HL nonce/replay rule), and the old key file is overwritten.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, keccak256 as viemKeccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";

/** keccak-256 (NOT sha3-256). Kept as a Buffer-returning helper for the existing callers and tests. */
export function keccak256(data: Uint8Array): Buffer {
  return Buffer.from(viemKeccak256(data).slice(2), "hex");
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function isValidPrivateKey(hex: string): boolean {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return false;
  const k = BigInt(hex);
  return k > 0n && k < N;
}

/** EIP-55 checksummed address of a secp256k1 private key (0x + 64 hex). */
export function addressOf(privateKey: string): string {
  if (!isValidPrivateKey(privateKey)) throw new Error("invalid secp256k1 private key");
  return getAddress(privateKeyToAccount(privateKey as `0x${string}`).address);
}

/** viem local account for the HL signing adapter (`createNktkasHl({ wallet })`). Same key as `ApiWallet`. */
export function signerOf(privateKey: string): PrivateKeyAccount {
  if (!isValidPrivateKey(privateKey)) throw new Error("invalid secp256k1 private key");
  return privateKeyToAccount(privateKey as `0x${string}`);
}

function randomPrivateKey(): string {
  for (;;) {
    const hex = `0x${randomBytes(32).toString("hex")}`;
    if (isValidPrivateKey(hex)) return hex;
  }
}

export class ApiWallet {
  readonly #key: string;
  readonly address: string;
  readonly createdAtMs: number;
  constructor(key: string, createdAtMs: number) {
    this.#key = key;
    this.address = addressOf(key);
    this.createdAtMs = createdAtMs;
  }
  /** Raw key for the Hyperliquid signing adapter only. Never log it, never put it in an HTTP response. */
  reveal(): string {
    return this.#key;
  }
  /** viem account over the same key, for the HL signing adapter. */
  signer(): PrivateKeyAccount {
    return signerOf(this.#key);
  }
  toJSON(): { address: string } {
    return { address: this.address };
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `ApiWallet(${this.address})`;
  }
}

interface WalletFile {
  address: string;
  privateKey: string;
  createdAtMs: number;
}

const FILE = "api-wallet.json";
const RETIRED = "retired-api-wallets.json";

function writeSecret(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function readRetired(dir: string): string[] {
  const p = join(dir, RETIRED);
  if (!existsSync(p)) return [];
  const j: unknown = JSON.parse(readFileSync(p, "utf8"));
  if (!Array.isArray(j) || j.some((x) => typeof x !== "string")) throw new Error(`${RETIRED} is malformed`);
  return (j as string[]).map((a) => a.toLowerCase());
}

export interface WalletManagerOptions {
  stateDir: string;
  /** `HL_API_WALLET_PRIVATE_KEY`: tests only. When set, nothing is written to disk and rotation is refused. */
  envKey?: string | undefined;
  now?: () => number;
}

export class ApiWalletManager {
  private current: ApiWallet | null = null;
  private readonly now: () => number;
  constructor(private readonly o: WalletManagerOptions) {
    this.now = o.now ?? Date.now;
  }

  /** Loads the key (or generates one on first start). Throws on a malformed file or unsafe permissions. */
  load(): ApiWallet {
    if (this.current) return this.current;
    if (this.o.envKey) {
      this.current = new ApiWallet(this.o.envKey, this.now());
      return this.current;
    }
    mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
    const path = join(this.o.stateDir, FILE);
    if (existsSync(path)) {
      if ((statSync(path).mode & 0o077) !== 0) throw new Error(`${path} must not be accessible by group or others (chmod 600)`);
      const f = JSON.parse(readFileSync(path, "utf8")) as Partial<WalletFile>;
      if (typeof f.privateKey !== "string" || !isValidPrivateKey(f.privateKey)) throw new Error(`${path} does not hold a valid key`);
      const w = new ApiWallet(f.privateKey, typeof f.createdAtMs === "number" ? f.createdAtMs : 0);
      if (f.address !== w.address) throw new Error(`${path} address does not match its key`);
      if (readRetired(this.o.stateDir).includes(w.address.toLowerCase())) throw new Error(`${path} holds a retired API wallet; delete it to generate a new one`);
      this.current = w;
      return w;
    }
    this.current = this.generate();
    return this.current;
  }

  /** The address only (what the dashboard may see). */
  address(): string {
    return this.load().address;
  }

  /** New key, never an address used before. Returns the new address; the old key is overwritten. */
  rotate(): string {
    if (this.o.envKey) throw new Error("API wallet is fixed by HL_API_WALLET_PRIVATE_KEY and cannot be rotated");
    const old = this.load();
    const retired = [...new Set([...readRetired(this.o.stateDir), old.address.toLowerCase()])];
    // Record the old address first: if we crash after this, the next start still never reuses it.
    writeSecret(join(this.o.stateDir, RETIRED), JSON.stringify(retired));
    this.current = null;
    this.current = this.generate();
    return this.current.address;
  }

  private generate(): ApiWallet {
    const retired = readRetired(this.o.stateDir);
    for (let i = 0; i < 8; i++) {
      const w = new ApiWallet(randomPrivateKey(), this.now());
      if (retired.includes(w.address.toLowerCase())) continue;
      const f: WalletFile = { address: w.address, privateKey: w.reveal(), createdAtMs: w.createdAtMs };
      writeSecret(join(this.o.stateDir, FILE), JSON.stringify(f));
      return w;
    }
    throw new Error("could not generate a fresh API wallet");
  }
}
