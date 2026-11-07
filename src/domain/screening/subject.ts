/**
 * Screening subjects (compliance LLD §4): normalisation per chain family and the list keys a subject
 * is checked against. Pure.
 *
 * - `address` on a chain: validated and normalised with the kit chain registry (EVM lower-case,
 *   bech32 lower-case, others as published). A chain the registry does not know (Tron, …) cannot be
 *   validated: an `eip155:` address is lower-cased, anything else is screened as published against
 *   every family (`*`), so an unknown chain can only produce more matches, never fewer.
 * - `near_account`: NEAR account ids are lower-case by protocol; an eth-implicit account (`0x…`)
 *   is the same key as the EVM address, so it is also checked against EVM listings.
 * - `destination`: an address on its chain (same as `address`).
 */
import { getChain, validateAddress } from "@nearpay-internal/chains";

export type SubjectType = "address" | "near_account" | "destination";

export interface ListKey {
  /** Chain family of the listing, or `*` to match the address in any family. */
  readonly family: string;
  readonly address: string;
}

export interface NormalizedSubject {
  readonly type: SubjectType;
  readonly chain: string | null;
  readonly norm: string;
  /** Sanctions-list keys to look up (family, normalised address). */
  readonly listKeys: readonly ListKey[];
}

export class SubjectError extends Error {
  constructor(
    message: string,
    readonly param: string,
  ) {
    super(message);
    this.name = "SubjectError";
  }
}

const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const ETH_IMPLICIT_RE = /^0x[0-9a-f]{40}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function normalizeSubject(type: SubjectType, subject: string, chain?: string): NormalizedSubject {
  if (type === "near_account") {
    const norm = subject.toLowerCase();
    if (!NEAR_ACCOUNT_RE.test(norm)) throw new SubjectError(`${subject} is not a NEAR account id`, "subject");
    const keys: ListKey[] = [{ family: "near", address: norm }];
    if (ETH_IMPLICIT_RE.test(norm)) keys.push({ family: "evm", address: norm });
    return { type, chain: chain ?? "near:mainnet", norm, listKeys: keys };
  }
  if (!chain) throw new SubjectError(`chain is required to screen an ${type}`, "chain");
  const info = getChain(chain);
  if (!info) {
    if (subject.length === 0 || subject.length > 256 || subject !== subject.trim() || /\s/.test(subject))
      throw new SubjectError(`${JSON.stringify(subject)} is not an address`, "subject");
    if (chain.startsWith("eip155:") && EVM_ADDRESS_RE.test(subject)) {
      const norm = subject.toLowerCase();
      return { type, chain, norm, listKeys: [{ family: "evm", address: norm }] };
    }
    return { type, chain, norm: subject, listKeys: [{ family: "*", address: subject }] };
  }
  const r = validateAddress(chain, subject);
  if (!r.ok) throw new SubjectError(`${subject} is not a valid address on ${chain}: ${r.reason}`, "subject");
  const keys: ListKey[] = [{ family: info.family, address: r.normalized }];
  if (info.family === "near" && ETH_IMPLICIT_RE.test(r.normalized)) keys.push({ family: "evm", address: r.normalized });
  return { type, chain, norm: r.normalized, listKeys: keys };
}

/** Test-mode magic (api-conventions §8): any subject containing `sanctioned` is blocked. */
export function isSandboxBlocked(subject: string): boolean {
  return subject.toLowerCase().includes("sanctioned");
}

const BECH32_RE = /^(bc1|tb1|ltc1)[0-9a-z]{8,87}$/i;

/**
 * Blocklist subjects (console `addOpsBlocklistEntry`, ops CLI): with a chain, normalised exactly like a
 * screening subject; an address without a chain is matched in every family its form fits, so it is
 * normalised by form (EVM hex and bech32 lower-case, anything else as published). Screening matches the
 * blocklist by normalised subject, whatever the chain.
 */
export function normalizeBlocklistSubject(
  type: "address" | "near_account",
  subject: string,
  chain?: string,
): { norm: string; chain: string | null } {
  if (type === "near_account" || chain) {
    const n = normalizeSubject(type, subject, chain);
    return { norm: n.norm, chain: type === "near_account" ? (chain ?? null) : n.chain };
  }
  if (subject.length === 0 || subject.length > 256 || subject !== subject.trim() || /\s/.test(subject))
    throw new SubjectError(`${JSON.stringify(subject)} is not an address`, "subject");
  if (EVM_ADDRESS_RE.test(subject) || BECH32_RE.test(subject)) return { norm: subject.toLowerCase(), chain: null };
  return { norm: subject, chain: null };
}
