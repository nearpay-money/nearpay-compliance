/**
 * Stage 1 ops CLI (compliance LLD §5, platform §3): the case-management, KYB and blocklist use cases
 * run in-process — `docker compose exec compliance-api node dist/ops.js <command> …`. There is no
 * network path to these actions in Stage 1; Stage 2 moves them to the console (ops principals).
 *
 * Every command prints one JSON document on stdout; errors print `{"error": …}` on stderr and exit 1
 * (2 for a usage error). Every state change records the actor (`ops:<--actor | NP_OPS_ACTOR | cli@host>`).
 */
import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import { fromUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { addToBlocklist, getGeoPolicy, removeFromBlocklist, setAccountSuspended, setGeoPolicy } from "../app/admin.js";
import { addCaseNote, listCases, updateCase } from "../app/cases.js";
import type { Compliance } from "../app/context.js";
import { decideKyb, getKybCase } from "../app/kyb.js";
import { importSanctions, OFAC_SOURCE, refreshSanctions, sanctionsAgeHours } from "../app/sanctions.js";
import { screen } from "../app/screening.js";
import type { KybDecision } from "../domain/kyb-case/kyb.js";
import type { SubjectType } from "../domain/screening/subject.js";

export const USAGE = `usage: ops.js <command> [arguments] [--actor <name>]

  kyb-show <acct_…>
  kyb-decide <acct_…> approved|rejected|needs_info --reason <text>
  cases [--all] [--limit <n>]
  case-investigate <case_…> [--note <text>]
  case-close <case_…> --resolution <text>
  case-note <case_…> --note <text>
  blocklist-add address|near_account <subject> [--chain <chain>] --reason <text>
  blocklist-remove address|near_account <subject> [--chain <chain>]
  account-suspend <acct_…> --reason <text>
  account-reinstate <acct_…> --reason <text>
  geo-policy
  geo-policy-set --countries <CC,CC,…> [--regions <CC-RR,…>]
  sanctions-status
  sanctions-refresh
  sanctions-import <file | ->
  screen address|near_account|destination <subject> [--chain <chain>] [--live] [--amount-usd-micros <n>]`;

export interface OpsDeps {
  /** Default actor when `--actor` is not given. */
  actor: string;
  sanctions: { source: string; timeoutMs: number; fetch?: typeof fetch };
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Input for `sanctions-import -` (default: process.stdin). */
  stdin?: Readable;
}

class UsageError extends Error {}

const OPTIONS = {
  actor: { type: "string" },
  reason: { type: "string" },
  resolution: { type: "string" },
  note: { type: "string" },
  chain: { type: "string" },
  countries: { type: "string" },
  regions: { type: "string" },
  all: { type: "boolean" },
  live: { type: "boolean" },
  limit: { type: "string" },
  "amount-usd-micros": { type: "string" },
} as const;

const KYB_DECISIONS: readonly KybDecision[] = ["approved", "rejected", "needs_info"];
const BLOCKLIST_TYPES: readonly SubjectType[] = ["address", "near_account"];
const SCREEN_TYPES: readonly SubjectType[] = ["address", "near_account", "destination"];

function need(v: string | undefined, what: string): string {
  if (v === undefined || v.trim() === "") throw new UsageError(`missing ${what}`);
  return v;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], what: string): T {
  const s = need(v, what);
  if (!(allowed as readonly string[]).includes(s)) throw new UsageError(`${what} must be one of ${allowed.join(", ")}`);
  return s as T;
}

function csv(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
}

function nonNegativeInt(v: string | undefined, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (!/^\d{1,15}$/.test(v)) throw new UsageError(`${what} must be a non-negative integer`);
  return Number(v);
}

/** Runs one command; returns the process exit code. */
export async function runOps(argv: readonly string[], c: Compliance, deps: OpsDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true; strict: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, ...args] = parsed.positionals;
  const v = parsed.values;
  const actor = `ops:${v.actor?.trim() || deps.actor}`;
  const print = (x: unknown) => out(JSON.stringify(x, null, 2));
  try {
    switch (command) {
      case "kyb-show": {
        const acct = need(args[0], "account id");
        const row = await getKybCase(c, acct);
        if (!row) throw ApiError.missing("kyb_case", acct);
        print({
          account_id: acct,
          status: row.status,
          vendor: row.vendor,
          decision_reason: row.decision_reason,
          decided_by: row.decided_by,
          decided_at: row.decided_at?.toISOString() ?? null,
          version: row.version,
        });
        return 0;
      }
      case "kyb-decide": {
        const acct = need(args[0], "account id");
        const decision = oneOf(args[1], KYB_DECISIONS, "decision");
        print(await decideKyb(c, acct, decision, need(v.reason, "--reason"), actor));
        return 0;
      }
      case "cases": {
        print(await listCases(c, { all: v.all ?? false, limit: nonNegativeInt(v.limit, "--limit") ?? 100 }));
        return 0;
      }
      case "case-investigate": {
        const r = await updateCase(c, need(args[0], "case id"), "investigating", actor, v.note);
        print({ id: fromUuid("case", r.id), status: r.status });
        return 0;
      }
      case "case-close": {
        const r = await updateCase(c, need(args[0], "case id"), "closed", actor, need(v.resolution, "--resolution"));
        print({ id: fromUuid("case", r.id), status: r.status, resolution: r.resolution });
        return 0;
      }
      case "case-note": {
        const id = need(args[0], "case id");
        await addCaseNote(c, id, actor, need(v.note, "--note"));
        print({ id, noted: true });
        return 0;
      }
      case "blocklist-add": {
        const subjectType = oneOf(args[0], BLOCKLIST_TYPES, "subject type");
        print(
          await addToBlocklist(c, {
            subjectType,
            subject: need(args[1], "subject"),
            ...(v.chain ? { chain: v.chain } : {}),
            reason: need(v.reason, "--reason"),
            actor,
          }),
        );
        return 0;
      }
      case "blocklist-remove": {
        const subjectType = oneOf(args[0], BLOCKLIST_TYPES, "subject type");
        const r = await removeFromBlocklist(c, subjectType, need(args[1], "subject"), v.chain);
        c.log.warn({ subject_type: subjectType, actor, removed: r.removed }, "blocklist entry removed");
        print(r);
        return 0;
      }
      case "account-suspend":
      case "account-reinstate": {
        const acct = need(args[0], "account id");
        const r = await setAccountSuspended(c, acct, command === "account-suspend", need(v.reason, "--reason"), actor);
        print({ account_id: acct, suspended: command === "account-suspend", ...r });
        return 0;
      }
      case "geo-policy": {
        print(await getGeoPolicy(c));
        return 0;
      }
      case "geo-policy-set": {
        const countries = csv(need(v.countries, "--countries"));
        const regions = v.regions === undefined ? (await getGeoPolicy(c)).blocked_regions : csv(v.regions);
        print(await setGeoPolicy(c, { blockedCountries: countries, blockedRegions: regions }, actor));
        return 0;
      }
      case "sanctions-status": {
        const row = await c.db
          .selectFrom("sanctions_lists")
          .selectAll()
          .where("source", "=", OFAC_SOURCE)
          .executeTakeFirst();
        print(
          row
            ? {
                source: OFAC_SOURCE,
                entries: row.entries,
                fetched_at: row.fetched_at.toISOString(),
                age_hours: Math.round((await sanctionsAgeHours(c)) * 10) / 10,
                sha256: row.sha256.toString("hex"),
              }
            : { source: OFAC_SOURCE, entries: 0, fetched_at: null },
        );
        return 0;
      }
      case "sanctions-refresh": {
        const s = deps.sanctions;
        print(await refreshSanctions(c, s.source, s.timeoutMs, s.fetch));
        return 0;
      }
      case "sanctions-import": {
        // `-` reads stdin: the container root filesystem is read-only, so files are piped in
        // (`docker compose exec -T compliance-api node dist/ops.js sanctions-import - < SDN_ADVANCED.XML`).
        const file = need(args[0], "file");
        print(await importSanctions(c, file === "-" ? (deps.stdin ?? process.stdin) : createReadStream(file)));
        return 0;
      }
      case "screen": {
        const subjectType = oneOf(args[0], SCREEN_TYPES, "subject type");
        const amount = nonNegativeInt(v["amount-usd-micros"], "--amount-usd-micros");
        print(
          await screen(
            c,
            {
              subject_type: subjectType,
              subject: need(args[1], "subject"),
              chain: v.chain,
              context: "ops",
              livemode: v.live ?? false,
              amount_usd_micros: amount,
            },
            { fresh: true },
          ),
        );
        return 0;
      }
      default:
        err(`${command ? `unknown command "${command}"\n\n` : ""}${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof ApiError) {
      err(JSON.stringify({ error: { code: e.code, message: e.message, ...(e.param ? { param: e.param } : {}) } }));
      return 1;
    }
    err(JSON.stringify({ error: { message: e instanceof Error ? e.message : String(e) } }));
    return 1;
  }
}
