import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { openSdnSource, parseSdnAdvanced } from "../../src/vendors/screening/ofac-sdn.js";

const FIXTURE = new URL("../fixtures/sdn_advanced.sample.xml", import.meta.url);
const NS = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML";

const doc = (types: string, parties: string, typesFirst = true) => {
  const ref = `<ReferenceValueSets><FeatureTypeValues>${types}</FeatureTypeValues></ReferenceValueSets>`;
  const dp = `<DistinctParties>${parties}</DistinctParties>`;
  return `<?xml version="1.0" encoding="utf-8"?><Sanctions xmlns="${NS}">${typesFirst ? ref + dp : dp + ref}</Sanctions>`;
};
const party = (features: [string, string][]) =>
  `<DistinctParty><Profile>${features
    .map(
      ([id, v]) =>
        `<Feature ID="1" FeatureTypeID="${id}"><FeatureVersion ReliabilityID="1"><VersionDetail DetailTypeID="1432">${v}</VersionDetail></FeatureVersion></Feature>`,
    )
    .join("")}</Profile></DistinctParty>`;
const TYPES = `<FeatureType ID="21">Email Address</FeatureType><FeatureType ID="344">Digital Currency Address - XBT</FeatureType><FeatureType ID="345">Digital Currency Address - ETH</FeatureType><FeatureType ID="887">Digital Currency Address - USDT</FeatureType>`;
const parse = (xml: string) => parseSdnAdvanced(Readable.from([Buffer.from(xml)]));

describe("parseSdnAdvanced on the recorded OFAC sample (SP-15)", () => {
  it("extracts every digital-currency address and nothing else", async () => {
    const r = await parseSdnAdvanced(createReadStream(FIXTURE));
    const count = (key: (e: (typeof r.entries)[number]) => string) => {
      const m: Record<string, number> = {};
      for (const e of r.entries) m[key(e)] = (m[key(e)] ?? 0) + 1;
      return m;
    };
    expect(r.entries).toHaveLength(88);
    expect(r.skipped).toBe(0);
    expect(count((e) => e.family)).toEqual({
      bitcoin: 9,
      evm: 15,
      tron: 63,
      solana: 1,
    });
    expect(count((e) => e.currency)).toEqual({
      XBT: 9,
      ETH: 15,
      TRX: 10,
      USDT: 53,
      SOL: 1,
    });
    // the 20 digital-currency feature types of the live publication (ids read from the document)
    expect(r.currencies.size).toBe(20);
    expect(r.currencies.get("344")).toBe("XBT");
    expect(r.currencies.get("1167")).toBe("SOL");
    expect(r.entries).toContainEqual({
      family: "evm",
      address: "0x252a8bd2319d8a555b872990601221b3a2053bce",
      currency: "ETH",
    });
    expect(r.entries).toContainEqual({
      family: "bitcoin",
      address: "12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL",
      currency: "XBT",
    });
    for (const e of r.entries) if (e.family === "evm") expect(e.address).toBe(e.address.toLowerCase());
  });

  it("hashes and counts the raw bytes", async () => {
    const r = await parseSdnAdvanced(createReadStream(FIXTURE));
    expect(r.sha256.equals(createHash("sha256").update(readFileSync(FIXTURE)).digest())).toBe(true);
    expect(r.bytes).toBe(statSync(FIXTURE).size);
  });
});

describe("parseSdnAdvanced edge cases", () => {
  it("de-duplicates per (family, address) and ignores non-currency features", async () => {
    const r = await parse(
      doc(
        TYPES,
        party([
          ["345", "0x7F367cC41522cE07553e823bf3be79A889DEbe1B"],
          ["887", "0x7f367cc41522ce07553e823bf3be79a889debe1b"],
          ["21", "someone@example.com"],
          ["999", "unknown feature type"],
        ]),
      ),
    );
    expect(r.entries).toEqual([
      { family: "evm", address: "0x7f367cc41522ce07553e823bf3be79a889debe1b", currency: "ETH" },
    ]);
  });

  it("counts unclassifiable values as skipped and trims values (CDATA too)", async () => {
    const r = await parse(
      doc(
        TYPES,
        party([
          ["344", "1BvB MSEY"],
          ["344", "  1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2\n"],
          ["344", "<![CDATA[bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4]]>"],
        ]),
      ),
    );
    expect(r.skipped).toBe(1);
    expect(r.entries.map((e) => e.address)).toEqual([
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    ]);
  });

  it("still parses a document whose parties precede the reference values", async () => {
    const r = await parse(doc(TYPES, party([["345", "0x7f367cc41522ce07553e823bf3be79a889debe1b"]]), false));
    expect(r.entries).toHaveLength(1);
  });

  it("returns no entries for a document without digital-currency features", async () => {
    const r = await parse(doc(`<FeatureType ID="21">Email Address</FeatureType>`, party([["21", "a@b.c"]])));
    expect(r.entries).toEqual([]);
    expect(r.currencies.size).toBe(0);
  });

  it("rejects malformed XML and stream errors", async () => {
    await expect(parse(`<Sanctions><FeatureTypeValues></Sanctions>`)).rejects.toThrow();
    const broken = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });
    await expect(parseSdnAdvanced(broken)).rejects.toThrow("connection reset");
  });
});

describe("openSdnSource", () => {
  it("opens file: URLs", async () => {
    const r = await parseSdnAdvanced(await openSdnSource(pathToFileURL(FIXTURE.pathname).href, 1_000));
    expect(r.entries).toHaveLength(88);
  });

  it("downloads over HTTPS, following redirects", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = (async (u: string, init?: RequestInit) => {
      calls.push([u, init]);
      return new Response(readFileSync(FIXTURE));
    }) as unknown as typeof fetch;
    const r = await parseSdnAdvanced(await openSdnSource("https://ofac.example/SDN_ADVANCED.XML", 5_000, f));
    expect(r.entries).toHaveLength(88);
    expect(calls[0]?.[0]).toBe("https://ofac.example/SDN_ADVANCED.XML");
    expect(calls[0]?.[1]?.redirect).toBe("follow");
    expect(calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails on a non-2xx response", async () => {
    const f = (async () => new Response("busy", { status: 503 })) as unknown as typeof fetch;
    await expect(openSdnSource("https://ofac.example/x", 5_000, f)).rejects.toThrow("sanctions source responded 503");
  });

  it("aborts after the timeout", async () => {
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) =>
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    await expect(openSdnSource("https://ofac.example/x", 1_000, f)).rejects.toThrow(/timed? ?out|aborted/i);
  });
});
