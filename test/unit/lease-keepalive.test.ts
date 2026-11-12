import type { JobContext } from "@nearpay-internal/db";
import { describe, expect, it } from "vitest";
import { keepingLease, throttled } from "../../src/workers/jobs.js";

describe("job lease keep-alive (kit 0.6.0 job worker liveness)", () => {
  it("throttled calls through at most once per window", async () => {
    let t = 0;
    let n = 0;
    const f = throttled(
      async () => {
        n++;
      },
      30_000,
      () => t,
    );
    await f();
    await f();
    t = 29_999;
    await f();
    t = 30_000;
    await f();
    expect(n).toBe(2);
  });

  it("keepingLease extends the lease while the work runs and stops after it", async () => {
    const leases: number[] = [];
    const ctx = { extendLease: async (s?: number) => void leases.push(s ?? 0) } as unknown as JobContext;
    const r = await keepingLease(ctx, 600, () => new Promise((res) => setTimeout(() => res("done"), 55)), 10);
    expect(r).toBe("done");
    const seen = leases.length;
    expect(seen).toBeGreaterThanOrEqual(3);
    expect(new Set(leases)).toEqual(new Set([600]));
    await new Promise((res) => setTimeout(res, 30));
    expect(leases.length).toBe(seen);
  });
});
