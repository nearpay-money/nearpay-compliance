/** The Stage 1 ops CLI (`node dist/ops.js …`, LLD §5) against Postgres, in-process. */
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { withTx } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openCase } from "../../src/app/cases.js";
import { createKybCase } from "../../src/app/kyb.js";
import { runOps, USAGE } from "../../src/ops/cli.js";
import { CLEAN_EVM, LISTED_EVM, SAMPLE_SDN, type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

async function ops(...argv: string[]) {
  return opsWith(undefined, ...argv);
}

async function opsWith(stdin: Readable | undefined, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const f = (async () => new Response(new Uint8Array(readFileSync(SAMPLE_SDN)))) as unknown as typeof fetch;
  const code = await runOps(argv, s.compliance, {
    actor: "cli@test",
    sanctions: { source: "https://ofac.example/SDN", timeoutMs: 5_000, fetch: f },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(stdin ? { stdin } : {}),
  });
  const json = out.length ? JSON.parse(out.join("\n")) : undefined;
  return { code, json, err: err.join("\n") };
}

describe("usage", () => {
  it("prints the usage for no, unknown or malformed commands (exit 2)", async () => {
    for (const argv of [
      [],
      ["frobnicate"],
      ["cases", "--bogus"],
      ["kyb-decide", "acct_x", "maybe", "--reason", "r"],
      ["cases", "--limit", "-1"],
    ]) {
      const r = await ops(...argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.err).toContain(USAGE.split("\n")[0]);
    }
  });
  it("names the missing argument", async () => {
    const r = await ops("kyb-decide", newId("acct"), "approved");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^missing --reason/);
  });
});

describe("KYB", () => {
  it("shows and decides a case, recording the actor", async () => {
    const acct = newId("acct");
    expect((await ops("kyb-show", acct)).code).toBe(1);
    await withTx(s.admin.db, (tx) => createKybCase(tx, acct));
    expect((await ops("kyb-show", acct)).json).toMatchObject({ account_id: acct, status: "not_started" });
    const d = await ops("kyb-decide", acct, "approved", "--reason", "registry extract checked", "--actor", "alice");
    expect(d.code).toBe(0);
    expect(d.json).toMatchObject({ account_id: acct, status: "approved" });
    expect((await ops("kyb-show", acct)).json).toMatchObject({
      status: "approved",
      decided_by: "ops:alice",
      decision_reason: "registry extract checked",
    });
  });
  it("refuses to decide an account without a case (exit 1, JSON error)", async () => {
    const r = await ops("kyb-decide", newId("acct"), "approved", "--reason", "x");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err)).toMatchObject({ error: { code: "resource_missing" } });
  });
});

describe("cases", () => {
  it("lists, notes, investigates and closes a case with decrypted notes", async () => {
    const subjectId = newId("ex");
    const opened = await withTx(s.admin.db, (tx) =>
      openCase(s.compliance, tx, {
        kind: "held_execution",
        subject: { type: "execution", id: subjectId },
        accountId: newId("acct"),
        livemode: true,
        actor: "compliance",
        note: "execution held: evidence_timeout",
      }),
    );
    const list = (await ops("cases")).json as { id: string; subject: { id: string } }[];
    const c = list.find((x) => x.subject.id === subjectId);
    expect(c).toBeDefined();
    const id = c?.id as string;
    expect(id).toMatch(/^case_/);
    expect(toUuid(id, "case")).toBe(opened.id);
    expect((await ops("case-note", id, "--note", "called the merchant")).json).toEqual({ id, noted: true });
    expect((await ops("case-investigate", id)).json).toEqual({ id, status: "investigating" });
    expect((await ops("case-close", id, "--resolution", "refund confirmed")).json).toMatchObject({
      id,
      status: "closed",
      resolution: "refund confirmed",
    });
    expect(((await ops("cases")).json as { id: string }[]).some((x) => x.id === id)).toBe(false);
    const all = (
      (await ops("cases", "--all", "--limit", "500")).json as {
        id: string;
        events: { note: string | null; actor: string }[];
      }[]
    ).find((x) => x.id === id);
    expect(all?.events.map((e) => e.note)).toEqual([
      "execution held: evidence_timeout",
      "called the merchant",
      null,
      "refund confirmed",
    ]);
    expect(all?.events.slice(1).every((e) => e.actor === "ops:cli@test")).toBe(true);
    // notes are encrypted at rest
    const raw = await s.admin.db
      .selectFrom("case_events")
      .select("note_enc")
      .where("case_id", "=", opened.id)
      .execute();
    expect(raw.some((r) => r.note_enc?.includes(Buffer.from("called the merchant")))).toBe(false);
    // a closed case cannot be closed again
    const again = await ops("case-close", id, "--resolution", "x");
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err)).toMatchObject({ error: { code: "state_conflict" } });
    expect((await ops("case-close", "case_nope", "--resolution", "x")).code).toBe(1);
  });
});

describe("blocklist, accounts, geo policy", () => {
  it("adds and removes blocklist entries (normalised)", async () => {
    const upper = "0x7777777777777777777777777777777777777777".toUpperCase().replace("0X", "0x");
    const add = await ops(
      "blocklist-add",
      "address",
      upper,
      "--chain",
      "eip155:1",
      "--reason",
      "law enforcement request",
    );
    expect(add.json).toEqual({ subject: "0x7777777777777777777777777777777777777777", destinationsBlocked: 0 });
    expect((await ops("screen", "address", upper, "--chain", "eip155:8453", "--live")).json).toMatchObject({
      decision: "block",
      reasons: ["blocklist"],
    });
    expect((await ops("blocklist-remove", "address", upper, "--chain", "eip155:1")).json).toEqual({ removed: 1 });
    expect((await ops("blocklist-remove", "address", upper, "--chain", "eip155:1")).json).toEqual({ removed: 0 });
    expect((await ops("blocklist-add", "address", "0x12", "--chain", "eip155:1", "--reason", "x")).code).toBe(1);
  });

  it("suspends and reinstates an account", async () => {
    const acct = newId("acct");
    expect((await ops("account-suspend", acct, "--reason", "fraud")).json).toEqual({
      account_id: acct,
      suspended: true,
      changed: true,
    });
    expect((await ops("account-suspend", acct, "--reason", "fraud")).json).toMatchObject({ changed: false });
    expect((await ops("account-reinstate", acct, "--reason", "cleared")).json).toEqual({
      account_id: acct,
      suspended: false,
      changed: true,
    });
  });

  it("shows and replaces the geo policy (regions kept unless given)", async () => {
    expect((await ops("geo-policy")).json).toMatchObject({ blocked_countries: ["CU", "IR", "KP", "SY"], version: "1" });
    const set = await ops("geo-policy-set", "--countries", "cu, ir,kp,sy,by");
    expect(set.json).toEqual({
      version: "2",
      blocked_countries: ["BY", "CU", "IR", "KP", "SY"],
      blocked_regions: ["UA-09", "UA-14", "UA-43"],
    });
    expect((await ops("geo-policy-set", "--countries", "CU", "--regions", "")).json).toMatchObject({
      blocked_regions: [],
    });
    const bad = await ops("geo-policy-set", "--countries", "CUBA");
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.err)).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("sanctions and screening", () => {
  it("imports a file, reports the status, refreshes and screens", async () => {
    expect((await ops("sanctions-status")).json).toEqual({ source: "ofac_sdn", entries: 0, fetched_at: null });
    const live = await ops(
      "screen",
      "address",
      CLEAN_EVM,
      "--chain",
      "eip155:8453",
      "--live",
      "--amount-usd-micros",
      "5000000000",
    );
    expect(live.code).toBe(1);
    expect(JSON.parse(live.err)).toMatchObject({ error: { code: "screening_unavailable" } });
    expect((await ops("sanctions-import", fileURLToPath(SAMPLE_SDN))).json).toMatchObject({ entries: 88, added: 88 });
    expect((await ops("sanctions-status")).json).toMatchObject({ entries: 88, age_hours: 0 });
    expect((await ops("sanctions-refresh")).json).toMatchObject({ entries: 88, unchanged: true });
    expect((await ops("screen", "address", LISTED_EVM, "--chain", "eip155:1", "--live")).json).toMatchObject({
      decision: "block",
      reasons: ["sanctions"],
    });
    expect((await ops("screen", "address", LISTED_EVM, "--chain", "eip155:1")).json).toMatchObject({
      decision: "allow",
    });
    expect((await ops("screen", "near_account", "sanctioned.testnet")).json).toMatchObject({
      decision: "block",
      reasons: ["sandbox_magic"],
    });
    expect((await ops("sanctions-import", "/nonexistent.xml")).code).toBe(1);
    // piped in (the container filesystem is read-only)
    const piped = await opsWith(Readable.from([readFileSync(SAMPLE_SDN)]), "sanctions-import", "-");
    expect(piped.json).toMatchObject({ entries: 88, unchanged: true });
  });
});
