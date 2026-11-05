# nearpay-compliance

> Address screening, KYB cases, geo policy, compliance cases and blocklists; policies are data per jurisdiction.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/compliance · internal only |
| Owns | ScreeningResult, KybCase, GeoPolicy, Case, Blocklist |
| Depends on (published artifacts only) | spec, kit, screening vendor, KYB vendor |
| First built in | Stage 1 (step 1.2) |

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
├── migrations/
├── policies/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── domain/
│   │   ├── blocklist/
│   │   ├── case/
│   │   ├── geo-policy/
│   │   ├── kyb-case/
│   │   └── screening/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── vendors/
│   │   ├── kyb/
│   │   └── screening/
│   └── workers/
├── test/
│   ├── contract/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.2)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
