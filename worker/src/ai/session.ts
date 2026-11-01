/**
 * Owner sessions for the assistant (NEP-413 sign-in + short-lived HMAC token).
 *
 * Flow: POST /ai/session/challenge -> wallet `signMessage` (NEP-413) -> POST /ai/session -> Bearer token for /ai/chat.
 * NEP-413 (https://github.com/near/NEPs/blob/master/neps/nep-0413.md): the signed bytes are
 * sha256( borsh(u32 2^31+413) ++ borsh(Payload{ message, nonce[32], recipient, callbackUrl: Option<string> }) ),
 * signed with an ed25519 FULL-ACCESS key. Implemented with node:crypto only (no extra dependency).
 */
import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

export const NEP413_TAG = 2 ** 31 + 413;
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 60 * 60_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  const zeros = s.length - s.replace(/^1+/, "").length;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** The 32-byte digest the wallet signs. */
export function nep413Digest(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null }): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]) : Buffer.from([0]);
  return createHash("sha256").update(Buffer.concat([tag, borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient), cb])).digest();
}

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** `publicKey` is "ed25519:<base58>". Returns false for any malformed input. */
export function verifyEd25519(publicKey: string, digest: Buffer, signature: Uint8Array): boolean {
  const m = /^ed25519:(.+)$/.exec(publicKey);
  const raw = m?.[1] ? base58Decode(m[1]) : null;
  if (!raw || raw.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(raw)]), format: "der", type: "spki" });
    return verify(null, digest, key, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Single-use, short-lived challenges. */
export class ChallengeStore {
  private readonly nonces = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly max = 2000) {}

  issue(): { nonce: Buffer; expiresAt: number } | null {
    const t = this.now();
    for (const [k, exp] of this.nonces) if (exp <= t) this.nonces.delete(k);
    if (this.nonces.size >= this.max) return null;
    const nonce = randomBytes(32);
    const expiresAt = t + CHALLENGE_TTL_MS;
    this.nonces.set(nonce.toString("hex"), expiresAt);
    return { nonce, expiresAt };
  }

  /** Consumes the nonce (first use wins, also when the signature later turns out invalid). */
  consume(nonce: Buffer): boolean {
    const k = nonce.toString("hex");
    const exp = this.nonces.get(k);
    this.nonces.delete(k);
    return exp !== undefined && exp > this.now();
  }
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

export interface SessionClaims {
  sub: string;
  vault: string;
  iat: number;
  exp: number;
}

export function signToken(secret: string, claims: SessionClaims): string {
  const body = b64u(JSON.stringify(claims));
  return `${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
}

/** Returns the claims if the token is authentic, unexpired and for this vault; otherwise `null`. */
export function verifyToken(secret: string, token: string, vault: string, now: number): SessionClaims | null {
  const [body, mac, extra] = token.split(".");
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionClaims>;
    if (typeof c.sub !== "string" || typeof c.exp !== "number" || typeof c.iat !== "number" || c.vault !== vault || c.exp <= now) return null;
    return { sub: c.sub, vault, iat: c.iat, exp: c.exp };
  } catch {
    return null;
  }
}

export function challengeMessage(vault: string): string {
  return `Agent Treasury assistant session for ${vault}`;
}
