/** Configuration (lld/compliance.md §8, foundations §13). */
import { baseConfigShape, flag, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";
import { SCREENING_PROVIDERS } from "./app/screening-provider.js";

/** OFAC Sanctions List Service, SDN advanced XML (SP-15: 302 → a signed S3 URL). */
export const OFAC_SDN_ADVANCED_URL =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** KEK for case notes and other PII at rest (envelope encryption). */
  piiKek: secret(),
  sanctionsSourceUrl: url(["https:", "http:", "file:"]).default(OFAC_SDN_ADVANCED_URL),
  /**
   * Live screening provider behind the vendor-neutral interface (ADR-0020 decision 4): `local` (OFAC
   * digital-currency list + blocklist) is the only v1 value. Replaces `NP_SCREENING_VENDOR`.
   */
  screeningProvider: z.enum(SCREENING_PROVIDERS).default("local"),
  /** Deprecated Stage 1 keys, still accepted with their only values so older Compose files keep booting. */
  screeningVendor: z.enum(["none"]).optional(),
  kybVendor: z.enum(["manual"]).optional(),
};

export const apiShape = {
  ...shared,
  /** Lifetime of a pending two-person suspension request (LLD §8; default 24 h). */
  opsApprovalTtlSeconds: z.coerce
    .number()
    .int()
    .min(300)
    .max(7 * 86_400)
    .default(86_400),
};

export const workerShape = {
  ...shared,
  opsApprovalTtlSeconds: z.coerce
    .number()
    .int()
    .min(300)
    .max(7 * 86_400)
    .default(86_400),
  natsUrl: url(["nats:", "tls:"]),
  /** Daily OFAC download (off in tests and air-gapped setups; `sanctions-import` loads a file). */
  sanctionsRefresh: flag(true),
  sanctionsTimeoutMs: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
};

export const opsShape = {
  ...shared,
  sanctionsTimeoutMs: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
  opsActor: z.string().min(1).max(100).optional(),
  opsApprovalTtlSeconds: z.coerce
    .number()
    .int()
    .min(300)
    .max(7 * 86_400)
    .default(86_400),
};

export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type WorkerConfig = z.output<z.ZodObject<typeof workerShape>>;
export type OpsConfig = z.output<z.ZodObject<typeof opsShape>>;

export const readApiConfig = () => loadConfig(apiShape);
export const readWorkerConfig = () => loadConfig(workerShape);
export const readOpsConfig = () => loadConfig(opsShape);
