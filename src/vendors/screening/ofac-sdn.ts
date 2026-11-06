/**
 * OFAC SDN advanced XML (SP-15, compliance LLD §7 `sanctions.refresh`): streams the document and
 * extracts every "Digital Currency Address - <CODE>" feature value. Feature type ids are read from
 * the document's `FeatureTypeValues` (not hard-coded): as of 2026-11-05 they are 344 XBT, 345 ETH,
 * 444 XMR, 566 LTC, 686 ZEC, 687 DASH, 688 BTG, 689 ETC, 706 BSV, 726 BCH, 746 XVG, 887 USDT, 907 XRP,
 * 989 BNB, 992 TRX, 996 DOGE, 998 USDC, 1007 ARB, 1008 BSC, 1167 SOL (≈1,075 addresses, 128 MB).
 *
 * Shape: `Sanctions > ReferenceValueSets > FeatureTypeValues > FeatureType[@ID]` and
 * `DistinctParties > DistinctParty > Profile > Feature[@FeatureTypeID] > FeatureVersion > VersionDetail`.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import sax from "sax";
import { classifyListedAddress, currencyOfFeature } from "../../domain/screening/sanctions.js";

export interface ListedAddress {
  readonly family: string;
  readonly address: string;
  readonly currency: string;
}

export interface SdnParseResult {
  readonly entries: ListedAddress[];
  /** Feature type id → currency code found in the document. */
  readonly currencies: ReadonlyMap<string, string>;
  /** Values that could not be classified (logged, not listed). */
  readonly skipped: number;
  readonly sha256: Buffer;
  readonly bytes: number;
}

/** Parses an SDN advanced XML stream. Entries are unique per (family, address). */
export function parseSdnAdvanced(input: Readable): Promise<SdnParseResult> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: false, xmlns: false });
    const hash = createHash("sha256");
    let bytes = 0;
    const featureTypes = new Map<string, string>();
    const raw: { typeId: string; value: string }[] = [];
    // Reference values precede the parties in the schema; once they are read, only digital-currency
    // features are collected (the document holds hundreds of thousands of other features).
    let typesRead = false;
    let inFeatureType: string | null = null;
    let featureTypeText = "";
    let currentFeature: string | null = null;
    let inDetail = false;
    let detailText = "";

    parser.on("opentag", (node) => {
      const attrs = node.attributes as Record<string, string>;
      switch (node.name) {
        case "FeatureType":
          inFeatureType = attrs.ID ?? null;
          featureTypeText = "";
          break;
        case "Feature": {
          const id = attrs.FeatureTypeID ?? null;
          currentFeature = id !== null && (!typesRead || featureTypes.has(id)) ? id : null;
          break;
        }
        case "VersionDetail":
          if (currentFeature !== null) {
            inDetail = true;
            detailText = "";
          }
          break;
      }
    });
    parser.on("text", (t) => {
      if (inFeatureType !== null) featureTypeText += t;
      if (inDetail) detailText += t;
    });
    parser.on("cdata", (t) => {
      if (inDetail) detailText += t;
    });
    parser.on("closetag", (name) => {
      if (name === "FeatureType" && inFeatureType !== null) {
        const code = currencyOfFeature(featureTypeText);
        if (code) featureTypes.set(inFeatureType, code);
        inFeatureType = null;
      } else if (name === "VersionDetail" && inDetail) {
        if (currentFeature !== null) raw.push({ typeId: currentFeature, value: detailText.trim() });
        inDetail = false;
      } else if (name === "Feature") {
        currentFeature = null;
      } else if (name === "FeatureTypeValues") {
        typesRead = true;
      }
    });
    parser.on("error", reject);
    parser.on("end", () => {
      const seen = new Map<string, ListedAddress>();
      let skipped = 0;
      for (const r of raw) {
        const currency = featureTypes.get(r.typeId);
        if (!currency) continue; // not a digital-currency feature
        const key = classifyListedAddress(currency, r.value);
        if (!key) {
          skipped++;
          continue;
        }
        const k = `${key.family}|${key.address}`;
        if (!seen.has(k)) seen.set(k, { family: key.family, address: key.address, currency });
      }
      resolve({ entries: [...seen.values()], currencies: featureTypes, skipped, sha256: hash.digest(), bytes });
    });
    input.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    input.on("error", reject);
    input.pipe(parser);
  });
}

/** Opens the source (`https:` download following redirects, or a local `file:` URL). */
export async function openSdnSource(source: string, timeoutMs: number, f: typeof fetch = fetch): Promise<Readable> {
  if (source.startsWith("file:")) return createReadStream(fileURLToPath(source));
  const res = await f(source, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`sanctions source responded ${res.status}`);
  return Readable.fromWeb(res.body as never);
}
