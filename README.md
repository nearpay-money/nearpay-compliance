# nearpay-compliance

> Address screening, KYB cases, geo policy, compliance cases and blocklists; policies are data per jurisdiction.

|                                       |                                                         |
| ------------------------------------- | ------------------------------------------------------- |
| Group                                 | Services                                                |
| Kind                                  | service                                                 |
| Ships as                              | image: ghcr.io/nearpay-money/compliance · internal only |
| Owns                                  | ScreeningResult, KybCase, GeoPolicy, Case, Blocklist    |
| Depends on (published artifacts only) | spec, kit, screening vendor, KYB vendor                 |
| First built in                        | Stage 1 (step 1.2)                                      |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/compliance.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/compliance.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/hld.md#13-compliance-architecture-summary`
- `nearpay-brain/architecture/security.md`

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

## Commands

| Command                                                                                                       | What it does                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install`                                                                                                | Install (Node 22, pnpm 9); `@nearpay/*` and `@nearpay-internal/*` come from the local registry (`.npmrc`, `nearpay-deploy/scripts/up.sh` starts it) |
| `pnpm test`                                                                                                   | Unit and property tests                                                                                                                             |
| `pnpm test:integration`                                                                                       | Integration and contract tests on real Postgres and NATS (Testcontainers; needs Docker)                                                             |
| `pnpm verify`                                                                                                 | typecheck + lint + unit tests with the coverage gate + integration tests + build                                                                    |
| `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/compliance:local .` | Image (what `up.sh` runs)                                                                                                                           |

## Configuration

| Variable                  | Process     | Meaning                                                                                 |
| ------------------------- | ----------- | --------------------------------------------------------------------------------------- |
| `NP_DB_URL_FILE`          | all         | Database URL (app role for `api`/`worker`/ops, migrator role for `migrate`)             |
| `NP_PII_KEK_FILE`         | api, worker | 32-byte KEK (base64 or hex) for case notes and idempotency responses at rest            |
| `NP_JWKS_URL`             | api         | identity's JWKS (verifies service, session and ops tokens)                              |
| `NP_NATS_URL`             | worker      | NATS JetStream                                                                          |
| `NP_SANCTIONS_SOURCE_URL` | worker, ops | OFAC SDN advanced XML (default: the Sanctions List Service URL; `file:` for air-gapped) |
| `NP_SANCTIONS_REFRESH`    | worker      | Daily download at 03:00 UTC and on first start (default `true`)                         |
| `NP_SANCTIONS_TIMEOUT_MS` | worker, ops | Download timeout (default 300000; the file is ~128 MB)                                  |
| `NP_SCREENING_VENDOR`     | all         | `none` (Stage 1: the local list is the screen)                                          |
| `NP_KYB_VENDOR`           | all         | `manual` (Stage 1: ops decision)                                                        |
| `NP_OPS_ACTOR`            | ops         | Default actor recorded by the ops CLI (`--actor` overrides; else `cli@<hostname>`)      |

## Behaviour

- **Screening** (`POST /internal/screenings`, scope `compliance.screen`): test mode blocks only subjects containing `sanctioned`. Live mode normalises the subject per chain family (EVM and bech32 lower-case; NEAR accounts lower-case, eth-implicit accounts also checked against EVM listings; chains the registry does not know are matched in every family), then blocklist and OFAC hits block, a cached decision is served, and otherwise the local list allows. Until a sanctions list has been imported, live screening is degraded like an unavailable vendor: at or above the policy's fail-closed threshold (USD 1,000) it answers `503 screening_unavailable`, below it allows with `post_screen_required`; degraded allows are never cached.
- **OFAC list** (`sanctions.refresh`): downloads the SDN advanced XML (follows the 302 to the signed S3 URL), streams it, extracts every "Digital Currency Address - <CODE>" feature (the type ids are read from the document), and replaces the list in one transaction with the diff logged. An empty result is refused; a failed download keeps the previous list; `nearpay_compliance_sanctions_list_age_hours` alerts after 48 h.
- **Post-screening** (consumers): `execution.settled` re-checks the refund address (an Intents refund is a NEAR account) and `agent_payment.settled` the payer, without the cache; a hit opens a `post_screen_hit` review (`review.opened`). The payment stands (non-custodial, INV-1).
- **Cases**: holds (`execution.held`) and sentinel audit mismatches (critical in live mode) open reviews; destination blocks open `screening_hit` cases. One open case per kind and subject; notes are envelope-encrypted.
- **KYB**: `account.created` opens `not_started`; the owner starts it (`POST /v1/account/kyb` → `pending`); ops decide it (`POST /internal/kyb_cases/{acct}/decision` with an ops token, or `ops.js kyb-decide`), which emits `kyb.approved|rejected|needs_info` for identity.
- **Destinations**: activations are monitored; a blocklist entry or the daily re-screen blocks a matching live destination (`destination.blocked`, identity disables it).
- **Geo policy** (`GET /internal/geo-policy`, scope `compliance.read`): blocked countries and regions are data; `geo-policy-set` emits `policy.updated` (payments refreshes).

## Ops CLI (Stage 1)

There is no network path to these actions in Stage 1 (Stage 2 moves them to the console). Run inside the api container:

```sh
docker compose exec compliance-api /nodejs/bin/node dist/ops.js kyb-decide acct_… approved --reason "registry extract checked" --actor alice
```

`kyb-show` · `kyb-decide` · `cases [--all]` · `case-investigate` · `case-close --resolution` · `case-note --note` · `blocklist-add` · `blocklist-remove` · `account-suspend` · `account-reinstate` · `geo-policy` · `geo-policy-set --countries [--regions]` · `sanctions-status` · `sanctions-refresh` · `sanctions-import <file | ->` (`-` reads stdin: `… exec -T compliance-api /nodejs/bin/node dist/ops.js sanctions-import - < SDN_ADVANCED.XML`) · `screen <type> <subject> [--chain] [--live]`. Output is JSON; errors are JSON on stderr with exit 1 (2 for usage).

## Status

Stage 1 (step 1.2) implemented: every Stage-1 compliance route and consumed subject of `@nearpay-internal/spec` 0.1.2, the OFAC list (SP-15), post-screening, cases and reviews, manual KYB, blocklist, geo policy, destination re-screening and the ops CLI. Compliance makes no outbound calls to other NearPay services, so it needs no peer mocks. Vendor screening and the KYB vendor (hosted flow, `POST /webhooks/kyb/{vendor}`) are Stage 2.

## Built with

TypeScript 5, Node 22, `@nearpay-internal/*` kit (service, db, bus, chains, ids), `sax` (streaming XML), Kysely + pg, NATS JetStream; tests with Vitest, fast-check and Testcontainers. Code and documentation are written with AI assistance (Claude) under human direction and review.
