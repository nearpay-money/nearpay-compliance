/**
 * Identity, as compliance calls it (spec 0.2.1): `getInternalOpsOperator` for the `assignOpsCase`
 * active-operator check, with compliance's own service token (scope `identity.operators.read`).
 */
import { serviceTokenClient } from "@nearpay-internal/auth";
import { HttpError, httpClient } from "@nearpay-internal/http";
import { getInternalOpsOperator } from "@nearpay-internal/spec";

export interface OperatorStatus {
  readonly active: boolean;
}

export interface OperatorDirectory {
  /** The operator, or null when the user never was one (identity `404`); throws when identity is unavailable. */
  operator(userId: string): Promise<OperatorStatus | null>;
}

export function httpOperatorDirectory(o: {
  identityUrl: string;
  serviceToken: () => Promise<string>;
  fetch?: typeof fetch;
}): OperatorDirectory {
  const identity = httpClient({
    target: "identity",
    baseUrl: o.identityUrl,
    timeoutMs: 2_000,
    attempts: 2,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    async operator(userId) {
      try {
        const r = await identity.call(getInternalOpsOperator, { params: { id: userId as `usr_${string}` } });
        return { active: r.active };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404 && e.error?.code === "resource_missing") return null;
        throw e;
      }
    },
  };
}

/** Service token from identity's client-credentials endpoint (client id `compliance`). */
export function complianceServiceToken(identityUrl: string, secret: string, f?: typeof fetch): () => Promise<string> {
  const client = serviceTokenClient({ identityUrl, clientId: "compliance", secret, ...(f ? { fetch: f } : {}) });
  return () => client.getToken();
}
