/**
 * `POST /internal/screenings` (compliance LLD §4–§5): normalise, ask the provider (vendor-neutral
 * interface; v1 `local`), use the cache, decide, persist. Every non-cached decision is stored (it is the screening record and the cache).
 */
import { sql } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import {
  cacheTtlMs,
  decide,
  type ProviderResult,
  SANDBOX_PROVIDER,
  storedProvider,
} from "../domain/screening/decision.js";
import { isSandboxBlocked, normalizeSubject, SubjectError, type SubjectType } from "../domain/screening/subject.js";
import { type Compliance, dbNow } from "./context.js";

export interface ScreenInput {
  subject_type: SubjectType;
  chain?: string | undefined;
  subject: string;
  context: string;
  account_id?: string | undefined;
  livemode: boolean;
  amount_usd_micros?: number | undefined;
}

export type ScreenResult = {
  screening_id: `scr_${string}`;
  decision: "allow" | "block" | "review";
  risk: string | null;
  reasons: string[];
  cached: boolean;
  post_screen_required: boolean;
  provider: "local" | "sandbox";
};

/** Loads the policy the decision needs (one row; policies are data, FR-CMP-03). */
export async function currentPolicy(c: Compliance) {
  return c.db.selectFrom("policies").selectAll().where("id", "=", "default").executeTakeFirstOrThrow();
}

/**
 * Screens a subject. `fresh` skips the cache (post-screening after settlement and console lookups
 * must see today's lists, not this morning's decision); `uncached` also stores the result so that it
 * is never served from the cache (console lookups, LLD §5.1).
 */
export async function screen(
  c: Compliance,
  input: ScreenInput,
  o: { fresh?: boolean; uncached?: boolean; requestedBy?: string } = {},
): Promise<ScreenResult> {
  const started = performance.now();
  let subject: ReturnType<typeof normalizeSubject>;
  try {
    subject = normalizeSubject(input.subject_type, input.subject, input.chain);
  } catch (e) {
    if (e instanceof SubjectError) throw ApiError.invalid(e.message, e.param);
    throw e;
  }
  const policy = await currentPolicy(c);
  const now = await dbNow(c.db);

  // Test mode never consults the live lists (INV-8): the provider is asked only in live mode.
  const provider: ProviderResult = input.livemode
    ? await c.provider.check(c.db, subject)
    : { name: SANDBOX_PROVIDER, hits: [], unavailable: null, risk: null };
  let cached: {
    id: string;
    decision: "allow" | "block" | "review";
    reasons: string[];
    risk: string | null;
    post: boolean;
    provider: string;
  } | null = null;
  if (input.livemode && !o.fresh && !o.uncached) {
    const row = await c.db
      .selectFrom("screenings")
      .select(["id", "decision", "reasons", "risk", "post_screen_required", "provider"])
      .where("subject_type", "=", subject.type)
      .where(sql<string>`coalesce(chain, '')`, "=", subject.chain ?? "")
      .where("subject_norm", "=", subject.norm)
      .where("livemode", "=", true)
      .where("expires_at", ">", now)
      .orderBy("expires_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (row)
      cached = {
        id: row.id,
        decision: row.decision,
        reasons: row.reasons,
        risk: row.risk,
        post: row.post_screen_required,
        provider: row.provider,
      };
  }

  const outcome = decide({
    livemode: input.livemode,
    sandboxBlocked: isSandboxBlocked(input.subject),
    provider,
    cached,
    amountUsdMicros: input.amount_usd_micros === undefined ? null : BigInt(input.amount_usd_micros),
    failClosedThresholdUsdMicros: policy.fail_closed_threshold_usd_micros,
  });
  c.metrics.screeningSeconds((performance.now() - started) / 1000);
  if (outcome.kind === "unavailable") {
    c.metrics.vendorUnavailable();
    throw new ApiError("screening_unavailable");
  }
  c.metrics.screenings({
    context: input.context,
    decision: outcome.decision,
    provider: outcome.provider,
    cached: String(outcome.cached),
  });
  if (outcome.cached && cached) {
    return {
      screening_id: fromUuid("scr", cached.id),
      decision: cached.decision,
      risk: cached.risk,
      reasons: cached.reasons,
      cached: true,
      post_screen_required: cached.post,
      provider: storedProvider(cached.provider),
    };
  }
  const id = uuidv7();
  const ttl = o.uncached ? 0 : cacheTtlMs(outcome.decision, outcome.postScreenRequired);
  await c.db
    .insertInto("screenings")
    .values({
      id,
      subject_type: subject.type,
      chain: subject.chain,
      subject_norm: subject.norm,
      context: input.context,
      account_id: input.account_id ? toUuid(input.account_id, "acct") : null,
      livemode: input.livemode,
      decision: outcome.decision,
      risk: outcome.risk,
      reasons: [...outcome.reasons],
      provider: outcome.provider,
      post_screen_required: outcome.postScreenRequired,
      created_at: now,
      expires_at: new Date(now.getTime() + ttl),
      requested_by: o.requestedBy ?? null,
    })
    .execute();
  if (outcome.decision !== "allow")
    c.log.warn(
      {
        subject_type: subject.type,
        chain: subject.chain,
        decision: outcome.decision,
        reasons: outcome.reasons,
        provider: outcome.provider,
        lm: input.livemode,
      },
      "screening hit",
    );
  return {
    screening_id: fromUuid("scr", id),
    decision: outcome.decision,
    risk: outcome.risk,
    reasons: [...outcome.reasons],
    cached: false,
    post_screen_required: outcome.postScreenRequired,
    provider: storedProvider(outcome.provider),
  };
}
