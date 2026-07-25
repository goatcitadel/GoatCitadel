# Contributing to GoatCitadel

Thanks for contributing.

Last updated: 2026-07-25

By participating in this project you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).
Contributions are accepted under the [Apache License 2.0](./LICENSE).

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
pnpm lint
pnpm typecheck
pnpm -r test
pnpm smoke
pnpm -r build
pnpm docs:check
pnpm coverage:collect
pnpm coverage:gate
```

`pnpm verify:fast` is the broadest always-on lane — it runs the test suite,
`docs:check`, the production coverage gate, and the real-Postgres storage lane.
For installer, desktop, release, auth, backup, provider, or Code Mode changes,
run the repo's named verification lanes rather than relying on a green build.
`AGENTS.md` lists the available lanes under *Validation Expectations*.

Status checks that gate `main` are documented in
[`.github/REQUIRED_CHECKS.md`](./.github/REQUIRED_CHECKS.md).

## Pull Requests

Open PRs from a branch, not from `main`.

Two templates are provided:

| Template | Use it when | Path |
| --- | --- | --- |
| Default | A human is authoring the change | `.github/pull_request_template.md` |
| Agent | A coding agent (Claude Code, Codex, …) authored the change | `.github/PULL_REQUEST_TEMPLATE/agent.md` |

The default template is applied automatically. To use the agent template,
append `?template=agent.md` to the compare URL, or:

```bash
gh pr create --body-file .github/PULL_REQUEST_TEMPLATE/agent.md
```

Expectations either way:

- Explain what changed and why.
- Call out risk areas and migration impact.
- Include screenshots for Mission Control UI changes.
- Include real test evidence for behavior changes — the command and its output,
  not an assertion that it passed.
- State what you did *not* validate. A documented gap is reviewable; a silent
  one is not.

## AI-Assisted Contributions

Agent-authored PRs are welcome and are held to the same bar as any other:

- A named human is accountable for the PR and has reviewed the diff.
- Verification claims must reflect commands that actually ran.
- Agents should read `AGENTS.md` first — particularly *How Agents Should Work*,
  *Source of Truth Order*, and *Claims Agents Must Not Make Without Fresh Proof*.

Fabricated evidence is treated as a conduct issue, not a quality issue. See the
addendum in [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Coding Standards

- Favor backward-compatible API changes.
- Keep policy precedence and safety boundaries intact.
- Use shared contract types from `packages/contracts`.
- Add or update tests for bug fixes and route changes.
- Keep diffs surgical; avoid unrelated formatting churn.

## Reporting Security Issues

Do not open a public issue for a suspected vulnerability. Follow
[SECURITY.md](./SECURITY.md), which routes through a private GitHub security
advisory. Before acting on an existing GitHub Security finding, read
[`docs/security/findings-triage.md`](./docs/security/findings-triage.md).

## Governance Docs Policy

These files are required in root:

- `README.md`
- `AGENTS.md`
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
- `LICENSE`
- `CHANGELOG.md`

Validate presence with:

```bash
pnpm docs:check
```

`docs:check` also asserts specific verbatim phrases in `README.md`, `AGENTS.md`,
and the `docs/` contract files. If it fails on a phrase you did not intend to
change, restore the wording rather than relaxing the assertion —
`scripts/validate-governance-docs.mjs` exists to stop public claims drifting
away from implementation truth.

## Versioning and Changelogs

- Product releases are tracked in `CHANGELOG.md`.
- Keep release notes understandable for first-time external users (public-facing wording).
