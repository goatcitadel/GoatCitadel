# Contributing to GoatCitadel

Thanks for contributing.

Last updated: 2026-03-05

## Development Setup

```bash
pnpm install
pnpm config:sync
```

Start local runtime:

```bash
pnpm dev
```

## Quality Gates

Required before merge:

```bash
pnpm -r typecheck
pnpm -r test
pnpm smoke
pnpm -r build
pnpm docs:check
pnpm coverage:collect
pnpm coverage:gate
```

## Pull Request Expectations

- Explain what changed and why.
- Call out risk areas and migration impact.
- Include screenshots for Mission Control UI changes.
- Include test evidence for behavior changes.

## Coding Standards

- Favor backward-compatible API changes.
- Keep policy precedence and safety boundaries intact.
- Use shared contract types from `packages/contracts`.
- Add or update tests for bug fixes and route changes.

## Governance Docs Policy

These files are required in root:

- `README.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `CHANGELOG.md`

Validate presence with:

```bash
pnpm docs:check
```

## Versioning and Changelogs

- Product releases are tracked in `CHANGELOG.md`.
- Keep release notes understandable for first-time external users (public-facing wording).
