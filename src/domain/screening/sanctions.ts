/**
 * OFAC SDN "Digital Currency Address - <CODE>" features → list keys (SP-15, compliance LLD §7). Pure.
 *
 * The family comes from the address format first (the same currency code is used across chains:
 * USDT appears as Ethereum and Tron addresses), then from the currency code; EVM addresses are
 * lower-cased so checksummed and plain spellings match.
 */
import type { ListKey } from "./subject.js";

export const OFAC_FEATURE_PREFIX = "Digital Currency Address - ";

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const TRON_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const BTC_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Segwit (bech32) addresses are case-insensitive; the registry normalises them to lower case. */
const BECH32_RE = /^(bc|ltc)1[02-9ac-hj-np-z]{6,87}$/i;

const BITCOIN_LIKE = new Set(["XBT", "BCH", "BSV", "BTG", "LTC", "DOGE"]);
const EVM_CODES = new Set(["ETH", "ETC", "ARB", "BSC", "USDC", "USDT", "BNB"]);

/** List key of one published address, or null when it cannot be classified (kept out of the list). */
export function classifyListedAddress(currency: string, raw: string): ListKey | null {
  const a = raw.trim();
  if (!a || /\s/.test(a)) return null;
  if (EVM_RE.test(a)) return { family: "evm", address: a.toLowerCase() };
  if (currency === "TRX" || (currency === "USDT" && TRON_RE.test(a))) return { family: "tron", address: a };
  if (BITCOIN_LIKE.has(currency)) return { family: "bitcoin", address: BECH32_RE.test(a) ? a.toLowerCase() : a };
  if (currency === "SOL" || ((currency === "USDC" || currency === "USDT") && SOL_RE.test(a)))
    return { family: "solana", address: a };
  if (EVM_CODES.has(currency)) return { family: "other", address: a };
  if (BECH32_RE.test(a)) return { family: "bitcoin", address: a.toLowerCase() };
  if (BTC_RE.test(a)) return { family: "bitcoin", address: a };
  return { family: "other", address: a };
}

/** Currency code of a feature type name (`Digital Currency Address - XBT` → `XBT`). */
export function currencyOfFeature(name: string): string | null {
  const t = name.trim();
  if (!t.startsWith(OFAC_FEATURE_PREFIX)) return null;
  const code = t.slice(OFAC_FEATURE_PREFIX.length).trim();
  return /^[A-Z0-9]{2,10}$/.test(code) ? code : null;
}
