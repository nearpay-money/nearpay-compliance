import { describe, expect, it } from "vitest";
import { classifyListedAddress, currencyOfFeature } from "../../src/domain/screening/sanctions.js";

describe("currencyOfFeature", () => {
  it("extracts the code of a digital-currency feature type", () => {
    expect(currencyOfFeature("Digital Currency Address - XBT")).toBe("XBT");
    expect(currencyOfFeature("  Digital Currency Address - USDT ")).toBe("USDT");
  });
  it("ignores other features and malformed codes", () => {
    expect(currencyOfFeature("Email Address")).toBeNull();
    expect(currencyOfFeature("Digital Currency Address - ")).toBeNull();
    expect(currencyOfFeature("Digital Currency Address - usdt")).toBeNull();
  });
});

describe("classifyListedAddress", () => {
  it("lower-cases EVM addresses whatever the currency code", () => {
    for (const code of ["ETH", "USDT", "USDC", "ARB", "BSC", "ETC", "BNB", "XBT"])
      expect(classifyListedAddress(code, "0x7F367cC41522cE07553e823bf3be79A889DEbe1B")).toEqual({
        family: "evm",
        address: "0x7f367cc41522ce07553e823bf3be79a889debe1b",
      });
  });
  it("classifies Tron addresses (TRX, and USDT on Tron)", () => {
    expect(classifyListedAddress("TRX", "TXmVthgn6yUWDiL1CanCN6n9ESW6cKzETc")).toEqual({
      family: "tron",
      address: "TXmVthgn6yUWDiL1CanCN6n9ESW6cKzETc",
    });
    expect(classifyListedAddress("USDT", "TXmVthgn6yUWDiL1CanCN6n9ESW6cKzETc")?.family).toBe("tron");
  });
  it("classifies bitcoin-like addresses, lower-casing bech32", () => {
    expect(classifyListedAddress("XBT", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toEqual({
      family: "bitcoin",
      address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    });
    expect(classifyListedAddress("LTC", "ltc1qg82tvfjlvqhq3xyy5eyvawqvjzrlqzjqhnzcjz")?.address).toBe(
      "ltc1qg82tvfjlvqhq3xyy5eyvawqvjzrlqzjqhnzcjz",
    );
    expect(classifyListedAddress("DOGE", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L")).toEqual({
      family: "bitcoin",
      address: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
    });
  });
  it("classifies Solana addresses (SOL, USDC/USDT on Solana)", () => {
    const a = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    expect(classifyListedAddress("SOL", a)).toEqual({ family: "solana", address: a });
    expect(classifyListedAddress("USDC", a)?.family).toBe("solana");
  });
  it("keeps EVM-code values that are not EVM addresses as 'other'", () => {
    expect(classifyListedAddress("BNB", "bnb1fnd0k5l4p3ck2j9x9dp36chk059w977pszdgdz")).toEqual({
      family: "other",
      address: "bnb1fnd0k5l4p3ck2j9x9dp36chk059w977pszdgdz",
    });
  });
  it("classifies unknown currencies by format, else 'other'", () => {
    expect(
      classifyListedAddress(
        "XMR",
        "4AfUP827TeRZ1cck3tZThgZbRCEwBrpcJTkA1LCiyFVuMH4b5y59bKMZHGb9y58K3gSjWDCBsB4RkGsGDhsmMG5R2qmbLeW",
      ),
    ).toEqual({
      family: "other",
      address: "4AfUP827TeRZ1cck3tZThgZbRCEwBrpcJTkA1LCiyFVuMH4b5y59bKMZHGb9y58K3gSjWDCBsB4RkGsGDhsmMG5R2qmbLeW",
    });
    expect(classifyListedAddress("ZZZ", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")?.family).toBe("bitcoin");
    expect(classifyListedAddress("ZZZ", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")?.family).toBe("bitcoin");
  });
  it("refuses empty or whitespace-containing values", () => {
    expect(classifyListedAddress("XBT", "   ")).toBeNull();
    expect(classifyListedAddress("XBT", "1Bv BMS")).toBeNull();
    expect(classifyListedAddress("ETH", " 0x7f367cc41522ce07553e823bf3be79a889debe1b ")?.family).toBe("evm");
  });
});
