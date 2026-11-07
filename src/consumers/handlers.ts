/**
 * Domain-event consumers (compliance LLD §6). Each handler runs inside the inbox transaction
 * (`inboxHandler`): a redelivered event is skipped, a failure rolls everything back for the retry.
 *
 * | subject                                         | handler                                          |
 * |-------------------------------------------------|--------------------------------------------------|
 * | evt.identity.account.created                    | KYB placeholder (`not_started`)                  |
 * | evt.identity.settlement_destination.activated   | monitor the destination                          |
 * | evt.identity.settlement_destination.disabled    | stop monitoring                                  |
 * | evt.rails.execution.settled                     | post-screen the refund address / payer account   |
 * | evt.rails.execution.held                        | case `held_execution` (review)                   |
 * | evt.sentinel.audit_finding.created              | case `audit_mismatch` (review, critical)         |
 * | evt.agentpay.agent_payment.settled              | post-screen the payer account                    |
 *
 * Post-screening re-checks today's lists without the cache. Stage 1 has no Explorer `senders`, so the
 * refund address / payer account is what is re-checked (LLD §12). A hit opens a `post_screen_hit`
 * review; the payment stands (non-custodial).
 */

import type { Envelope, EventHandler } from "@nearpay-internal/bus";
import type { Kysely } from "@nearpay-internal/db";
import { deadLetterSink, inboxHandler } from "@nearpay-internal/db";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Subject } from "@nearpay-internal/spec";
import { openCase } from "../app/cases.js";
import type { Compliance, Tx } from "../app/context.js";
import { createKybCase } from "../app/kyb.js";
import { screen } from "../app/screening.js";
import type { DB } from "../infra/db/schema.js";

const ACTOR = "compliance";

interface DestinationObject {
  id: string;
  account: string;
  livemode: boolean;
  chain: string;
  address_norm: string;
  asset_id: string;
  type: string;
}
interface ExecutionObject {
  id: string;
  account_id: string;
  livemode: boolean;
  origin: { asset_id: string; chain: string; refund_to: string; refund_type: "origin_chain" | "intents" };
  /** Stage 2 (`Execution.reference`): the payments object of the execution. */
  reference?: { payment_intent?: string | null } | null;
}
interface AgentPaymentObject {
  id: string;
  livemode: boolean;
  payer: string;
}
interface FindingObject {
  id: string;
  execution_id: string;
  account_id: string;
  livemode: boolean;
  check_kind: string;
  result: string;
}

const obj = <T>(e: Envelope) => e.data.object as unknown as T;

async function monitorDestination(tx: Tx, e: Envelope, active: boolean) {
  const d = obj<DestinationObject>(e);
  const id = toUuid(d.id, "sd");
  const version = e.aggregate.version;
  await tx
    .insertInto("monitored_destinations")
    .values({
      destination_id: id,
      account_id: toUuid(d.account, "acct"),
      livemode: d.livemode,
      chain: d.chain,
      address_norm: d.address_norm,
      asset_id: d.asset_id,
      type: d.type,
      active,
      source_version: version,
    })
    .onConflict((oc) =>
      oc
        .column("destination_id")
        .doUpdateSet({ active, source_version: version, updated_at: new Date() })
        // stale events (lower aggregate version) never undo a newer state
        .where("monitored_destinations.source_version", "<", version),
    )
    .execute();
}

/** Re-screens without the cache; a block opens a review. */
async function postScreen(
  c: Compliance,
  tx: Tx,
  s: { subjectType: "address" | "near_account"; subject: string; chain?: string; accountId: string; livemode: boolean },
  review: { type: "execution" | "agent_payment"; id: string; paymentIntent?: string | null },
  context: "payment" | "x402",
) {
  let decision: string;
  try {
    decision = (
      await screen(
        { ...c, db: tx as unknown as Kysely<DB> },
        {
          subject_type: s.subjectType,
          subject: s.subject,
          ...(s.chain ? { chain: s.chain } : {}),
          context,
          account_id: s.accountId,
          livemode: s.livemode,
        },
        { fresh: true },
      )
    ).decision;
  } catch (e) {
    // An address that cannot be normalised was never screenable: log and stop (a retry cannot help).
    // Anything else (database, …) fails the event for redelivery.
    if (!(e instanceof ApiError && e.code === "invalid_request")) throw e;
    c.log.error({ err: e, review }, "post-screening could not run: the subject is not screenable");
    return;
  }
  if (decision === "allow") return;
  await openCase(c, tx, {
    kind: "post_screen_hit",
    subject: { type: review.type, id: review.id },
    paymentIntent: review.paymentIntent ?? null,
    accountId: s.accountId,
    livemode: s.livemode,
    actor: ACTOR,
    note: `post-screening ${decision}: ${s.subject}`,
  });
}

export function complianceHandlers(c: Compliance): Partial<Record<Subject, EventHandler>> {
  const h = (fn: (tx: Tx, e: Envelope) => Promise<void>) => inboxHandler(c.db, fn);
  return {
    "evt.identity.account.created": h(async (tx, e) => {
      const a = e.data.object as { id: string; display_name?: string };
      await createKybCase(tx, a.id, a.display_name);
    }),
    "evt.identity.settlement_destination.activated": h((tx, e) => monitorDestination(tx, e, true)),
    "evt.identity.settlement_destination.disabled": h((tx, e) => monitorDestination(tx, e, false)),
    "evt.rails.execution.settled": h(async (tx, e) => {
      const x = obj<ExecutionObject>(e);
      await postScreen(
        c,
        tx,
        x.origin.refund_type === "intents"
          ? { subjectType: "near_account", subject: x.origin.refund_to, accountId: x.account_id, livemode: x.livemode }
          : {
              subjectType: "address",
              subject: x.origin.refund_to,
              chain: x.origin.chain,
              accountId: x.account_id,
              livemode: x.livemode,
            },
        { type: "execution", id: x.id, paymentIntent: x.reference?.payment_intent ?? null },
        "payment",
      );
    }),
    "evt.rails.execution.held": h(async (tx, e) => {
      const x = obj<ExecutionObject & { held_reason: string | null }>(e);
      await openCase(c, tx, {
        kind: "held_execution",
        subject: { type: "execution", id: x.id },
        paymentIntent: x.reference?.payment_intent ?? null,
        accountId: x.account_id,
        livemode: x.livemode,
        actor: ACTOR,
        note: `execution held: ${x.held_reason ?? "unknown"}`,
      });
    }),
    "evt.sentinel.audit_finding.created": h(async (tx, e) => {
      const f = obj<FindingObject>(e);
      if (f.result === "pass") return;
      await openCase(c, tx, {
        kind: "audit_mismatch",
        subject: { type: "execution", id: f.execution_id },
        accountId: f.account_id,
        livemode: f.livemode,
        actor: ACTOR,
        note: `sentinel ${f.check_kind}: ${f.result} (${f.id})`,
        ...(f.livemode ? { severity: "critical" as const } : {}),
      });
    }),
    "evt.agentpay.agent_payment.settled": h(async (tx, e) => {
      const p = obj<AgentPaymentObject>(e);
      if (!e.account_id) return;
      await postScreen(
        c,
        tx,
        {
          subjectType: "near_account",
          subject: p.payer,
          accountId: fromUuid("acct", e.account_id),
          livemode: p.livemode,
        },
        { type: "agent_payment", id: p.id },
        "x402",
      );
    }),
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:compliance");
