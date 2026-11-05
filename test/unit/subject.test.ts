import { describe, expect, it } from "vitest";
import { isSandboxBlocked, normalizeSubject, SubjectError } from "../../src/domain/screening/subject.js";

const BASE = "eip155:8453";
const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const LTC = "bip122:12a765e31ffd4059bada1e25190f6e98";

describe("normalizeSubject", () => {
  it("lower-cases EVM addresses (checksummed and plain spellings are one key)", () => {
    const a = normalizeSubject("address", "0x52908400098527886E0F7030069857D2E4169EE7", BASE);
    expect(a).toEqual({
      type: "address",
      chain: BASE,
      norm: "0x52908400098527886e0f7030069857d2e4169ee7",
      listKeys: [{ family: "evm", address: "0x52908400098527886e0f7030069857d2e4169ee7" }],
    });
    expect(normalizeSubject("destination", a.norm, BASE).listKeys).toEqual(a.listKeys);
  });

  it("rejects an EVM address with a bad checksum or length", () => {
    expect(() => normalizeSubject("address", "0x52908400098527886E0F7030069857D2E4169Ee7", BASE)).toThrow(SubjectError);
    expect(() => normalizeSubject("address", "0x1234", BASE)).toThrow(/not a valid address/);
  });

  it("keeps Solana addresses as published (base58 is case-sensitive)", () => {
    const a = normalizeSubject("address", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", SOL);
    expect(a.norm).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(a.listKeys).toEqual([{ family: "solana", address: a.norm }]);
  });

  it("lower-cases bech32 and keeps base58check bitcoin addresses", () => {
    expect(normalizeSubject("address", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4", BTC).norm).toBe(
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    );
    expect(normalizeSubject("address", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", BTC).listKeys).toEqual([
      { family: "bitcoin", address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2" },
    ]);
    expect(() => normalizeSubject("address", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", BTC)).toThrow(SubjectError);
    expect(normalizeSubject("address", "LaMT348PWRnrqeeWArpwQPbuanpXDZGEUz", LTC).listKeys[0]?.family).toBe("bitcoin");
  });

  it("requires a chain for addresses", () => {
    try {
      normalizeSubject("address", "0x52908400098527886e0f7030069857d2e4169ee7");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SubjectError);
      expect((e as SubjectError).param).toBe("chain");
    }
  });

  it("screens addresses on unknown chains as published against every family", () => {
    const tron = normalizeSubject("address", "TXmVthgn6yUWDiL1CanCN6n9ESW6cKzETc", "tron:mainnet");
    expect(tron).toEqual({
      type: "address",
      chain: "tron:mainnet",
      norm: "TXmVthgn6yUWDiL1CanCN6n9ESW6cKzETc",
      listKeys: [{ family: "*", address: "TXmVthgn6yUWDiL1CanCN6n9ESW6cKzETc" }],
    });
    // an EVM chain the registry does not list is still an EVM address
    expect(normalizeSubject("address", "0x52908400098527886E0F7030069857D2E4169EE7", "eip155:999999").listKeys).toEqual(
      [{ family: "evm", address: "0x52908400098527886e0f7030069857d2e4169ee7" }],
    );
    for (const bad of ["", " TX", "T X", "x".repeat(257)])
      expect(() => normalizeSubject("address", bad, "tron:mainnet"), JSON.stringify(bad)).toThrow(SubjectError);
  });

  it("lower-cases NEAR accounts and checks eth-implicit accounts against EVM listings too", () => {
    expect(normalizeSubject("near_account", "Alice.NEAR")).toEqual({
      type: "near_account",
      chain: "near:mainnet",
      norm: "alice.near",
      listKeys: [{ family: "near", address: "alice.near" }],
    });
    expect(normalizeSubject("near_account", "0x52908400098527886E0F7030069857D2E4169EE7").listKeys).toEqual([
      { family: "near", address: "0x52908400098527886e0f7030069857d2e4169ee7" },
      { family: "evm", address: "0x52908400098527886e0f7030069857d2e4169ee7" },
    ]);
    expect(() => normalizeSubject("near_account", "bad..account")).toThrow(/not a NEAR account id/);
    expect(() => normalizeSubject("near_account", "a")).toThrow(SubjectError);
  });

  it("treats a NEAR-chain address like the account (eth-implicit also against EVM)", () => {
    const a = normalizeSubject("address", "0x52908400098527886e0f7030069857d2e4169ee7", "near:mainnet");
    expect(a.listKeys.map((k) => k.family)).toEqual(["near", "evm"]);
    expect(normalizeSubject("destination", "merchant.near", "near:mainnet").listKeys).toEqual([
      { family: "near", address: "merchant.near" },
    ]);
  });
});

describe("isSandboxBlocked (test-mode magic)", () => {
  it("blocks any subject containing 'sanctioned', case-insensitively", () => {
    expect(isSandboxBlocked("sanctioned.testnet")).toBe(true);
    expect(isSandboxBlocked("0xSANCTIONED")).toBe(true);
    expect(isSandboxBlocked("alice.near")).toBe(false);
  });
});
