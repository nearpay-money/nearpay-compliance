# nearpay-compliance

Address screening against the OFAC list and NearPay's blocklist, self-declared business details (KYB cases), geo policy, and compliance cases. Policies are data per jurisdiction.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** internal only. Identity, rails and agentpay call `POST /internal/screenings` before a payout wallet, a refund address or an agent payer is accepted; payments reads the geo policy and opens cases; the ops console calls its `/ops/…` routes; the dashboard's business-details page reaches `/v1/account/kyb` through the gateway. It calls no other NearPay service; its only outbound request is the daily download of the OFAC SDN list.
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money). This service is part of that deployment. Onboarding is open (ADR-0024): complete self-declared business details are approved by the system at once, with no business review, and the registration number is optional; the geo policy still blocks, and suspension for abuse stays. Screening is local (OFAC list and blocklist); no screening or KYB vendor is integrated in v1 (ADR-0020).

|                                       |                                                         |
| ------------------------------------- | ------------------------------------------------------- |
| Group                                 | Services                                                |
| Kind                                  | service                                                 |
| Ships as                              | image: ghcr.io/nearpay-money/compliance · internal only |
| Owns                                  | ScreeningResult, KybCase, GeoPolicy, Case, Blocklist    |
| Depends on (published artifacts only) | spec, kit; the OFAC SDN list (no vendor in v1)          |
| First built in                        | Stage 1 (step 1.2)                                      |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/compliance.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/compliance.md) — low-level design this repo is implemented from
- [`lld/audits/compliance.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/compliance.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`architecture/hld.md#13-compliance-architecture-summary`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md#13-compliance-architecture-summary)
- [`architecture/security.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/security.md)

## Layout

```
nearpay-compliance/
├── src/
│   ├── main.ts               process entry: `api` | `worker` | `migrate` | `healthcheck`
│   ├── ops.ts                Stage 1 ops CLI entry (`node dist/ops.js <command>`, run inside compliance-api)
│   ├── config.ts             NP_* configuration (secrets from files)
│   ├── api/                  spec route bindings (screening, geo policy, KYB start, manual KYB decision)
│   ├── app/                  use cases: screening, sanctions import, KYB, cases/reviews, ops actions, process wiring
│   ├── consumers/            domain-event handlers (inbox transaction per event)
│   ├── domain/               pure: subject normalisation, screening decision, OFAC classification, KYB, cases, geo policy
│   ├── ops/                  ops CLI commands (the Stage 1 path for case management and blocklist edits)
│   ├── vendors/screening/    OFAC SDN advanced XML parser and download
│   ├── workers/              jobs: sanctions refresh, destination re-screening, purges
│   └── infra/db/             Kysely schema, migrations path
├── migrations/               plain SQL (kit tables first, then 0001_compliance.sql)
├── test/
│   ├── unit/ property/       pure code and the OFAC parser (Vitest, fast-check)
│   ├── integration/          api over HTTP, worker on NATS JetStream, sanctions refresh, ops CLI (Testcontainers)
│   ├── contract/             spec route/subject coverage, response and error shapes
│   └── fixtures/             recorded OFAC SDN advanced XML (live publication cut to 6 parties; names and personal details redacted, addresses kept)
└── Dockerfile                distroless Node 22 image, `node dist/main.js <process>`
```

## Verify this repo

Needs Node 22 (`.nvmrc`) and pnpm 9. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm install --frozen-lockfile` → ends with `Done in …`, no registry errors.
3. `pnpm test` (unit and property tests: subject normalisation, the screening decision, the OFAC parser on a recorded and redacted list, KYB and case rules; no Docker) → `Test Files  12 passed (12)`, `Tests  115 passed (115)`.
4. `pnpm verify` (the full gate: typecheck, lint, unit tests with the coverage gate of ≥ 90 % branches on `src/domain`, integration tests, build) → exits 0. The integration and contract tests run on real Postgres and NATS started by Testcontainers, so this step needs a running Docker daemon; steps 1–3 do not.

## Commands

| Command                                                                                                       | What it does                                                                                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                              | Install (Node 22, pnpm 9); NearPay packages come from the local registry (see "Verify this repo") |
| `pnpm test`                                                                                                   | Unit and property tests                                                                           |
| `pnpm test:integration`                                                                                       | Integration and contract tests on real Postgres and NATS (Testcontainers; needs Docker)           |
| `pnpm verify`                                                                                                 | typecheck + lint + unit tests with the coverage gate + integration tests + build                  |
| `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/compliance:local .` | Image (what nearpay-deploy's `scripts/up.sh` runs)                                                |

## Configuration

| Variable                                | Process          | Meaning                                                                                     |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `NP_DB_URL_FILE`                        | all              | Database URL (app role for `api`/`worker`/ops, migrator role for `migrate`)                 |
| `NP_PII_KEK_FILE`                       | api, worker      | 32-byte KEK (base64 or hex) for case notes and idempotency responses at rest                |
| `NP_JWKS_URL`                           | api              | identity's JWKS (verifies service, session and ops tokens)                                  |
| `NP_NATS_URL`                           | worker           | NATS JetStream                                                                              |
| `NP_SANCTIONS_SOURCE_URL`               | worker, ops      | OFAC SDN advanced XML (default: the Sanctions List Service URL; `file:` for air-gapped)     |
| `NP_SANCTIONS_REFRESH`                  | worker           | Daily download at 03:00 UTC and on first start (default `true`)                             |
| `NP_SANCTIONS_TIMEOUT_MS`               | worker, ops      | Download timeout (default 300000; the file is ~128 MB)                                      |
| `NP_SCREENING_PROVIDER`                 | all              | `local` (OFAC list + blocklist behind the vendor-neutral interface; ADR-0020)               |
| `NP_OPS_APPROVAL_TTL_SECONDS`           | api, worker, ops | Pending two-person suspension request lifetime (default 86400)                              |
| `NP_KYB_MODE`                           | api, worker      | `auto` (default; ADR-0024 open onboarding: system decides at once) or `manual` (ops review) |
| `NP_SCREENING_VENDOR` / `NP_KYB_VENDOR` | all              | Deprecated (`none` / `manual` still accepted)                                               |
| `NP_OPS_ACTOR`                          | ops              | Default actor recorded by the ops CLI (`--actor` overrides; else `cli@<hostname>`)          |

## Behaviour

- **Screening** (`POST /internal/screenings`, scope `compliance.screen`): test mode blocks only subjects containing `sanctioned`. Live mode normalises the subject per chain family (EVM and bech32 lower-case; NEAR accounts lower-case, eth-implicit accounts also checked against EVM listings; chains the registry does not know are matched in every family), then blocklist and OFAC hits block, a cached decision is served, and otherwise the local list allows. Until a sanctions list has been imported, live screening is degraded like an unavailable vendor: at or above the policy's fail-closed threshold (USD 1,000) it answers `503 screening_unavailable`, below it allows with `post_screen_required`; degraded allows are never cached.
- **OFAC list** (`sanctions.refresh`): downloads the SDN advanced XML (follows the 302 to the signed S3 URL), streams it, extracts every "Digital Currency Address - <CODE>" feature (the type ids are read from the document), and replaces the list in one transaction with the diff logged. An empty result is refused; a failed download keeps the previous list; `nearpay_compliance_sanctions_list_age_hours` alerts after 48 h.
- **Post-screening** (consumers): `execution.settled` re-checks the refund address (an Intents refund is a NEAR account) and `agent_payment.settled` the payer, without the cache; a hit opens a `post_screen_hit` review (`review.opened`). The payment stands (non-custodial, INV-1).
- **Cases**: holds (`execution.held`) and sentinel audit mismatches (critical in live mode) open reviews; destination blocks open `screening_hit` cases. One open case per kind and subject; notes are envelope-encrypted.
- **KYB**: `account.created` opens `not_started`; the owner declares the details and submits them (`POST /v1/account/kyb/submit` → `pending`, `kyb.submitted`). With `NP_KYB_MODE=auto` (default, ADR-0024) the same transaction records the system's decision (actor `system`): `approved` with reason `auto-approved: open onboarding (ADR-0024)`, or `rejected` with `auto-rejected: geo_blocked (…)` when the business country/region is in the geo policy; the `kyb.auto_decide` job (every minute) decides complete cases still `pending`. With `manual`, ops decide it (console, `POST /internal/kyb_cases/{acct}/decision` with an ops token, or `ops.js kyb-decide`). Either way `kyb.approved|rejected|needs_info` goes to identity; ops can reject (abuse) or reverse a rejection in both modes. `registration_number` is optional.
- **Destinations**: activations are monitored; a blocklist entry or the daily re-screen blocks a matching live destination (`destination.blocked`, identity disables it).
- **Geo policy** (`GET /internal/geo-policy`, scope `compliance.read`): blocked countries and regions are data; `geo-policy-set` emits `policy.updated` (payments refreshes).

## Ops CLI

Since Stage 2 the ops console (`/ops/…`) covers these actions; the CLI remains for local stacks and drills. Run inside the api container:

```sh
docker compose exec compliance-api /nodejs/bin/node dist/ops.js kyb-decide acct_… approved --reason "registry extract checked" --actor alice
```

`kyb-show` · `kyb-decide` · `cases [--all]` · `case-investigate` · `case-close --resolution` · `case-note --note` · `blocklist-add` · `blocklist-remove [--reason]` (soft delete: the entry stays as history) · `account-suspend` (only when `NP_ENV` is `local`/`test`) · `account-reinstate` · `geo-policy` · `geo-policy-set --countries [--regions]` · `sanctions-status` · `sanctions-refresh` · `sanctions-import <file | ->` (`-` reads stdin: `… exec -T compliance-api /nodejs/bin/node dist/ops.js sanctions-import - < SDN_ADVANCED.XML`) · `screen <type> <subject> [--chain] [--live]`. Output is JSON; errors are JSON on stderr with exit 1 (2 for usage).

## Status

Stage 2 (step 2.2) implemented against `@nearpay*/spec` 0.2.0 and kit 0.2.0: self-declared KYB profile (`getKyb`, `updateKybProfile`, `submitKyb`, `getInternalKybCase`), payments' `createInternalCase`, every console route (`/ops/…`: KYB queue and decisions, cases, blocklist, screening and re-screening, merchant suspension with the two-person rule), operator actions (`evt.compliance.ops_action.recorded`), the `local` screening provider behind a provider port, and `Review.payment_intent`. Design: [`lld/compliance.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/compliance.md).

Stage 1 (step 1.2) implemented: every Stage-1 compliance route and consumed subject of `@nearpay-internal/spec` 0.1.2, the OFAC list (SP-15), post-screening, cases and reviews, manual KYB, blocklist, geo policy, destination re-screening and the ops CLI. Compliance makes no outbound calls to other NearPay services, so it needs no peer mocks. Vendor screening and a KYB vendor (hosted flow, `POST /webhooks/kyb/{vendor}`) are not built; they are post-v1 (ADR-0020).

Since then: open onboarding (`NP_KYB_MODE=auto` by default, ADR-0024) and kit 0.6.0. Current pins (`package.json`): `@nearpay-money/spec` 0.5.0, kit packages 0.6.0.

## Built with

- Runtime: TypeScript 5 on Node 22; `@nearpay-internal/*` kit (service, db, bus, auth, http, chains, ids) with Fastify, Kysely + pg and NATS JetStream underneath; `sax` (streaming XML), `prom-client`, `zod`.
- External data: the OFAC SDN advanced XML published by the US Treasury's Sanctions List Service.
- Tests and tooling: Vitest, fast-check, Testcontainers, Biome.
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
