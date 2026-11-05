# nearpay-compliance

> Address screening, KYB cases, geo policy, compliance cases and blocklists; policies are data per jurisdiction.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/compliance · internal only |
| Owns | ScreeningResult, KybCase, GeoPolicy, Case, Blocklist |
| Depends on (published artifacts only) | spec, kit, screening vendor, KYB vendor |
| Roadmap phase | P1 Core payments |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

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

Scaffold only. Implementation starts in phase **P1 Core payments** (`nearpay-brain/roadmap/roadmap.md`).
