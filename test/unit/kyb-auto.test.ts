import { describe, expect, it } from "vitest";
import { AUTO_APPROVED_REASON, autoDecide, KYB_MODES, SYSTEM_ACTOR } from "../../src/domain/kyb-case/auto.js";
import { emptyProfile, type KybProfile } from "../../src/domain/kyb-case/profile.js";

const GEO = { blocked_countries: ["CU", "IR", "KP", "SY"], blocked_regions: ["UA-43", "UA-14", "UA-09"] };

const profile = (over: Partial<KybProfile> = {}): KybProfile => ({
  ...emptyProfile(),
  legal_name: "Acme Trading Ltd",
  country_of_incorporation: "GB",
  business_type: "company",
  business_address: { line1: "1 High St", line2: null, city: "London", postal_code: null, region: null, country: "GB" },
  representative: { name: "Jane Doe", title: "Director" },
  expected_monthly_volume: "under_10k",
  ...over,
});

describe("open onboarding: automatic KYB decision (ADR-0024)", () => {
  it("approves a complete declaration, with or without a register number", () => {
    expect(autoDecide(profile(), GEO)).toEqual({ decision: "approved", reason: AUTO_APPROVED_REASON });
    expect(autoDecide(profile({ registration_number: "01234567" }), GEO).decision).toBe("approved");
    expect(AUTO_APPROVED_REASON).toBe("auto-approved: open onboarding (ADR-0024)");
    expect(SYSTEM_ACTOR).toBe("system");
    expect(KYB_MODES).toEqual(["auto", "manual"]);
  });

  it("rejects a business incorporated in a blocked country with the geo_blocked reason code", () => {
    expect(autoDecide(profile({ country_of_incorporation: "IR" }), GEO)).toEqual({
      decision: "rejected",
      code: "geo_blocked",
      reason: "auto-rejected: geo_blocked (country of incorporation IR)",
    });
  });

  it("rejects a business whose address is in a blocked country or region", () => {
    const at = (country: string, region: string | null) =>
      profile({ business_address: { line1: "x", line2: null, city: "y", postal_code: null, region, country } });
    expect(autoDecide(at("KP", null), GEO)).toMatchObject({ decision: "rejected", code: "geo_blocked" });
    expect(autoDecide(at("UA", "UA-43"), GEO).reason).toBe(
      "auto-rejected: geo_blocked (business address region UA-43)",
    );
    expect(autoDecide(at("UA", "43"), GEO)).toMatchObject({ decision: "rejected" });
    expect(autoDecide(at("UA", "Kyiv"), GEO).decision).toBe("approved");
    expect(autoDecide(at("UA", "UA-30"), GEO).decision).toBe("approved");
  });

  it("follows the policy data (char-padded, lower-case codes) and allows everything when nothing is blocked", () => {
    expect(
      autoDecide(profile({ country_of_incorporation: "cu" }), { blocked_countries: ["CU "], blocked_regions: [] }),
    ).toMatchObject({ decision: "rejected" });
    expect(
      autoDecide(profile({ country_of_incorporation: "IR" }), { blocked_countries: [], blocked_regions: [] }).decision,
    ).toBe("approved");
    expect(autoDecide(profile({ country_of_incorporation: null, business_address: null }), GEO).decision).toBe(
      "approved",
    );
  });
});
