/** OFAC list import and refresh (LLD §7 `sanctions.refresh`, SP-15) against Postgres. */
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importSanctions, OFAC_SOURCE, refreshSanctions, sanctionsAgeHours } from "../../src/app/sanctions.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { eventually, LISTED_EVM, SAMPLE_SDN, type Stack, startStack } from "../support/stack.js";

const sample = readFileSync(SAMPLE_SDN);
const NS = "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML";
const tiny = (addresses: string[]) =>
  Buffer.from(
    `<?xml version="1.0"?><Sanctions xmlns="${NS}"><ReferenceValueSets><FeatureTypeValues><FeatureType ID="345">Digital Currency Address - ETH</FeatureType></FeatureTypeValues></ReferenceValueSets><DistinctParties>${addresses
      .map(
        (a) =>
          `<DistinctParty><Profile><Feature FeatureTypeID="345"><FeatureVersion><VersionDetail>${a}</VersionDetail></FeatureVersion></Feature></Profile></DistinctParty>`,
      )
      .join("")}</DistinctParties></Sanctions>`,
  );
const served = (body: Buffer | null, status = 200) =>
  (async () => new Response(body === null ? null : new Uint8Array(body), { status })) as unknown as typeof fetch;
const entries = async (s: Stack) =>
  (
    await s.admin.db
      .selectFrom("sanctions_entries")
      .select(["chain_family", "address_norm"])
      .where("source", "=", OFAC_SOURCE)
      .execute()
  )
    .map((r) => `${r.chain_family}|${r.address_norm}`)
    .sort();

describe("importing and refreshing the list", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(async () => {
    await s?.stop();
  });

  it("reports never-fetched as -1", async () => {
    expect(await sanctionsAgeHours(s.compliance)).toBe(-1);
  });

  it("refuses an empty list (a format change must not silently empty it)", async () => {
    await expect(importSanctions(s.compliance, Readable.from([tiny([])]))).rejects.toThrow(
      /no digital-currency addresses/,
    );
    expect(await entries(s)).toEqual([]);
  });

  it("imports the recorded sample", async () => {
    const r = await refreshSanctions(s.compliance, "https://ofac.example/x", 5_000, served(sample));
    expect(r).toMatchObject({ entries: 88, added: 88, removed: 0, skipped: 0, unchanged: false });
    expect(await entries(s)).toHaveLength(88);
    const list = await s.admin.db.selectFrom("sanctions_lists").selectAll().executeTakeFirstOrThrow();
    expect(list).toMatchObject({ source: OFAC_SOURCE, entries: 88 });
    expect(list.sha256.toString("hex")).toBe(r.sha256);
    expect(await sanctionsAgeHours(s.compliance)).toBeLessThan(0.01);
  });

  it("an identical download only refreshes the fetch time", async () => {
    const before = await s.admin.db.selectFrom("sanctions_lists").select("fetched_at").executeTakeFirstOrThrow();
    await new Promise((r) => setTimeout(r, 20));
    const r = await refreshSanctions(s.compliance, "https://ofac.example/x", 5_000, served(sample));
    expect(r).toMatchObject({ unchanged: true, added: 0, removed: 0, entries: 88 });
    const after = await s.admin.db.selectFrom("sanctions_lists").select("fetched_at").executeTakeFirstOrThrow();
    expect(after.fetched_at.getTime()).toBeGreaterThan(before.fetched_at.getTime());
  });

  it("a changed list replaces the entries and reports the diff", async () => {
    const r = await importSanctions(
      s.compliance,
      Readable.from([tiny([LISTED_EVM, "0x6666666666666666666666666666666666666666"])]),
    );
    expect(r).toMatchObject({ entries: 2, added: 1, removed: 87, unchanged: false });
    expect(await entries(s)).toEqual([`evm|${LISTED_EVM}`, "evm|0x6666666666666666666666666666666666666666"]);
  });

  it("a failed download or parse keeps the previous list", async () => {
    await expect(
      refreshSanctions(s.compliance, "https://ofac.example/x", 5_000, served(Buffer.from("busy"), 503)),
    ).rejects.toThrow(/responded 503/);
    await expect(
      refreshSanctions(s.compliance, "https://ofac.example/x", 5_000, served(Buffer.from("<Sanctions><oops"))),
    ).rejects.toThrow();
    expect(await entries(s)).toHaveLength(2);
  });

  it("concurrent imports serialise (advisory lock) and leave one consistent list", async () => {
    await Promise.all([
      importSanctions(s.compliance, Readable.from([sample])),
      importSanctions(s.compliance, Readable.from([sample])),
    ]);
    expect(await entries(s)).toHaveLength(88);
  });

  it("the job is a no-op when the refresh is switched off, and extends its lease when on", async () => {
    const leases: (number | undefined)[] = [];
    const ctx = {
      id: "j",
      kind: "sanctions.refresh",
      attempt: 1,
      extendLease: async (sec?: number) => void leases.push(sec),
    };
    const fetched: string[] = [];
    const f = (async (u: string) => {
      fetched.push(u);
      return new Response(new Uint8Array(sample));
    }) as unknown as typeof fetch;
    const opts = { sanctionsSourceUrl: "https://ofac.example/SDN", sanctionsTimeoutMs: 60_000, fetch: f };
    await jobHandlers(s.compliance, { ...opts, sanctionsRefresh: false })["sanctions.refresh"]?.(null, ctx);
    expect(fetched).toEqual([]);
    await jobHandlers(s.compliance, { ...opts, sanctionsRefresh: true })["sanctions.refresh"]?.(null, ctx);
    expect(fetched).toEqual(["https://ofac.example/SDN"]);
    expect(leases).toEqual([360]);
  });
});

describe("the worker refreshes the list on its first run", () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack({ worker: true, sanctionsRefresh: true, fetch: served(sample) });
  });
  afterAll(async () => {
    await s?.stop();
  });

  it("imports the list without waiting for 03:00 UTC", async () => {
    await eventually(async () => (await entries(s)).length === 88, 20_000);
  });
});
