# AGENTS.md — nearpay-compliance

You are working in **nearpay-compliance**, one of 26 NearPay repositories (`nearpay-brain/architecture/repositories.md`).
Scope: Address screening, KYB cases, geo policy, compliance cases and blocklists; policies are data per jurisdiction.

## Before changing anything

1. Read `../nearpay-brain/AGENTS.md`, then this repo's LLD (`../nearpay-brain/lld/compliance.md`) — it is the implementation spec; do not make design decisions it already makes.
2. Contracts (requests, responses, events, errors) come from `@nearpay-money/spec`. If one must change, open a PR in `nearpay-spec` first; never hand-write contract types here.
3. Check your change against invariants INV-1…INV-9 in `nearpay-brain/product/requirements.md`.

## Rules for this repo

- Hexagonal layout: `src/domain` is pure (no I/O); `src/app` holds use cases; `src/vendors` adapts the OFAC source; `src/infra` adapts the DB; `src/api` maps spec routes to use cases; `src/ops` is the Stage 1 ops CLI.
- Every state change writes the aggregate row, its transition/case event row and the outbox row in ONE transaction; consumers run inside the inbox transaction (`inboxHandler`) and ignore stale `aggregate.version`.
- Fail safe, never fail open: a missing sanctions list or an unavailable vendor must not pass a live payment at or above the policy's fail-closed threshold; an empty or unparsable OFAC download never replaces the current list.
- Test mode uses only the magic rule (`sanctioned` in the subject); live lists are never consulted for test mode and test-mode cases are `low` (INV-8).
- Case notes and other PII are envelope-encrypted (`NP_PII_KEK_FILE`); log subjects, not notes.
- Policy is data (`policies` rows), not code. Every ops action records its actor.
- Keep ≥ 90% branch coverage on `src/domain`; every consumed subject and route has an integration test.

## Never

- Import source code from another NearPay repo (depend on published packages/images only).
- Read or write another service's database.
- Add design documents here — update `nearpay-brain` and link to it.
- Commit secrets, private keys or real customer data.
- Merge changes to paths listed in `.github/CODEOWNERS` without the required human review.
