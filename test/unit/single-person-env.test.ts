/**
 * Audit finding 2 (stage 2): the single-person suspension commands (ops CLI `account-suspend|reinstate`)
 * are a local/test convenience. Any other `NP_ENV` value — `server`, an unknown stage, an empty or
 * mistyped value — must require two persons (the console).
 */
import { ApiError } from "@nearpay-internal/service";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { setAccountSuspended } from "../../src/app/admin.js";
import type { Compliance } from "../../src/app/context.js";
import { singlePersonAllowed } from "../../src/domain/ops-approval/approval.js";

class Reached extends Error {}

/** A compliance whose DB throws `Reached`: getting there means the single-person path was allowed. */
const fake = {
  db: {
    transaction: () => {
      throw new Reached();
    },
  },
} as unknown as Compliance;

const ACCT = "acct_0196b1c0d2e37f8a9b0c1d2e3f405162";

async function outcome(env: string, suspended: boolean): Promise<"allowed" | "two_person_required"> {
  try {
    await setAccountSuspended(fake, ACCT, suspended, "r", "cli@test", env);
  } catch (e) {
    if (e instanceof Reached) return "allowed";
    if (e instanceof ApiError && e.code === "two_person_required") return "two_person_required";
    throw e;
  }
  throw new Error("unreachable");
}

describe("single-person suspension by NP_ENV", () => {
  it("is allowed only on local and test", async () => {
    for (const s of [true, false]) {
      expect(await outcome("local", s)).toBe("allowed");
      expect(await outcome("test", s)).toBe("allowed");
    }
  });

  it("requires two persons on server, unknown stages and malformed values (suspend and reinstate)", async () => {
    for (const env of ["server", "staging", "production", "", "Local", "TEST", " local", "dev"]) {
      for (const s of [true, false]) expect(await outcome(env, s), env).toBe("two_person_required");
    }
  });

  it("has no default environment: a caller that passes none is refused", async () => {
    const call = setAccountSuspended as unknown as (...a: unknown[]) => Promise<unknown>;
    await expect(call(fake, ACCT, true, "r", "cli@test")).rejects.toMatchObject({ code: "two_person_required" });
  });

  it("property: any value other than local/test refuses", () => {
    fc.assert(
      fc.property(fc.string(), (env) => {
        expect(singlePersonAllowed(env)).toBe(env === "local" || env === "test");
      }),
    );
  });
});
