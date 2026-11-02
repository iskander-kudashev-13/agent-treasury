import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createNktkasHl } from "../../src/trading/hl/nktkas.js";
import { addressOf, ApiWalletManager, isValidPrivateKey, keccak256, signerOf } from "../../src/trading/wallet.js";

const dir = () => mkdtempSync(join(tmpdir(), "wallet-"));

describe("keccak256 / address derivation", () => {
  it("known keccak vectors", () => {
    expect(keccak256(Buffer.alloc(0)).toString("hex")).toBe("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    expect(keccak256(Buffer.from("abc")).toString("hex")).toBe("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    // longer than one 136-byte block
    expect(keccak256(Buffer.alloc(200, 0x61)).length).toBe(32);
  });
  it("known EVM addresses (EIP-55)", () => {
    expect(addressOf(`0x${"0".repeat(63)}1`)).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
    expect(addressOf("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });
  it("rejects invalid keys", () => {
    expect(isValidPrivateKey(`0x${"0".repeat(64)}`)).toBe(false);
    expect(isValidPrivateKey(`0x${"f".repeat(64)}`)).toBe(false);
    expect(isValidPrivateKey("0x12")).toBe(false);
    expect(() => addressOf("nope")).toThrow();
  });
});

describe("viem signer", () => {
  it("is the same account as the stored wallet and plugs into the HL adapter", async () => {
    const w = new ApiWalletManager({ stateDir: dir() }).load();
    const acct = w.signer();
    expect(acct.address.toLowerCase()).toBe(w.address.toLowerCase());
    expect(signerOf(w.reveal()).address).toBe(acct.address);
    expect(() => signerOf("0x12")).toThrow();
    // the adapter factory accepts it (no network call at construction)
    expect(createNktkasHl({ network: "testnet", wallet: acct })).toBeDefined();
    // and it really signs (secp256k1 via viem)
    expect(await acct.signMessage({ message: "x" })).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe("ApiWalletManager", () => {
  it("generates on first start, mode 0600, reloads the same key", () => {
    const d = dir();
    const a = new ApiWalletManager({ stateDir: d }).load();
    expect(a.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(statSync(join(d, "api-wallet.json")).mode & 0o777).toBe(0o600);
    const b = new ApiWalletManager({ stateDir: d }).load();
    expect(b.address).toBe(a.address);
    expect(b.reveal()).toBe(a.reveal());
  });

  it("does not leak the key through JSON or inspect", () => {
    const w = new ApiWalletManager({ stateDir: dir() }).load();
    expect(JSON.stringify(w)).toBe(JSON.stringify({ address: w.address }));
    expect(inspect(w)).not.toContain(w.reveal().slice(2));
    expect(JSON.stringify({ w })).not.toContain(w.reveal().slice(2));
  });

  it("rotate gives a new address, retires the old one and overwrites the key", () => {
    const d = dir();
    const m = new ApiWalletManager({ stateDir: d });
    const old = m.load();
    const oldKey = old.reveal();
    const addr = m.rotate();
    expect(addr).not.toBe(old.address);
    expect(m.address()).toBe(addr);
    expect(readFileSync(join(d, "api-wallet.json"), "utf8")).not.toContain(oldKey.slice(2));
    expect(JSON.parse(readFileSync(join(d, "retired-api-wallets.json"), "utf8"))).toEqual([old.address.toLowerCase()]);
    expect(statSync(join(d, "api-wallet.json")).mode & 0o777).toBe(0o600);
    expect(new ApiWalletManager({ stateDir: d }).address()).toBe(addr);
  });

  it("refuses a file with open permissions, a bad key, a wrong address or a retired address", () => {
    const d = dir();
    const m = new ApiWalletManager({ stateDir: d });
    const w = m.load();
    const p = join(d, "api-wallet.json");
    chmodSync(p, 0o644);
    expect(() => new ApiWalletManager({ stateDir: d }).load()).toThrow(/group or others/);
    chmodSync(p, 0o600);
    const f = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...f, address: "0x0000000000000000000000000000000000000001" }), { mode: 0o600 });
    expect(() => new ApiWalletManager({ stateDir: d }).load()).toThrow(/does not match/);
    writeFileSync(p, JSON.stringify({ ...f, privateKey: "0x12" }), { mode: 0o600 });
    expect(() => new ApiWalletManager({ stateDir: d }).load()).toThrow(/valid key/);
    writeFileSync(p, JSON.stringify(f), { mode: 0o600 });
    writeFileSync(join(d, "retired-api-wallets.json"), JSON.stringify([w.address]), { mode: 0o600 });
    expect(() => new ApiWalletManager({ stateDir: d }).load()).toThrow(/retired/);
  });

  it("env key: used as is, nothing written, no rotation", () => {
    const d = dir();
    const key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    const m = new ApiWalletManager({ stateDir: d, envKey: key });
    expect(m.address()).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(() => statSync(join(d, "api-wallet.json"))).toThrow();
    expect(() => m.rotate()).toThrow(/cannot be rotated/);
  });
});
