/** Configuration (lld/compliance.md §8, foundations §13). */
import { baseConfigShape, flag, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

/** OFAC Sanctions List Service, SDN advanced XML (SP-15: 302 → a signed S3 URL). */
export const OFAC_SDN_ADVANCED_URL =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN_ADVANCED.XML";

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** KEK for case notes and other PII at rest (envelope encryption). */
  piiKek: secret(),
  sanctionsSourceUrl: url(["https:", "http:", "file:"]).default(OFAC_SDN_ADVANCED_URL),
  /** `none` in Stage 1 (local list only); `chainalysis` in Stage 2. */
  screeningVendor: z.enum(["none"]).default("none"),
  /** `manual` in Stage 1 (ops CLI decision); `sumsub` in Stage 2. */
  kybVendor: z.enum(["manual"]).default("manual"),
};

export const apiShape = { ...shared };

export const workerShape = {
  ...shared,
  natsUrl: url(["nats:", "tls:"]),
  /** Daily OFAC download (off in tests and air-gapped setups; `sanctions-import` loads a file). */
  sanctionsRefresh: flag(true),
  sanctionsTimeoutMs: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
};

export const opsShape = {
  ...shared,
  sanctionsTimeoutMs: z.coerce.number().int().min(1_000).max(900_000).default(300_000),
  opsActor: z.string().min(1).max(100).optional(),
};

export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type WorkerConfig = z.output<z.ZodObject<typeof workerShape>>;
export type OpsConfig = z.output<z.ZodObject<typeof opsShape>>;

export const readApiConfig = () => loadConfig(apiShape);
export const readWorkerConfig = () => loadConfig(workerShape);
export const readOpsConfig = () => loadConfig(opsShape);
