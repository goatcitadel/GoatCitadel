# Security Policy

Last updated: 2026-07-25

## Supported Versions

The published product line is the `0.1.0-rc.1` release candidate, shipped as the GitHub prerelease `GoatCitadel 0.1.0 RC`. Workspace libraries such as `@goatcitadel/extensions-sdk` are versioned and published independently on their own `1.0.0` line. Security support follows the current published release candidate first; source builds are supported at the current `main` commit only.

| Line | Supported |
|---|---|
| `0.1.0-rc.x` release candidate | Yes |
| Published workspace packages on `1.0.0` (for example `@goatcitadel/extensions-sdk`) | Yes |
| `main` source builds | Best effort, current commit only |
| The historical `v1.0.0` git tag and earlier prerelease builds | No |

Fixes land on the current release candidate line. There is no long-term support branch, and older tags are not backported.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately first.

Recommended report content:

- Affected component and version/commit.
- Reproduction steps.
- Impact assessment.
- Suggested mitigation (if known).

Current reporting path:

- Open a private GitHub security advisory in the repository.

Do not open a public issue or pull request for an unfixed vulnerability.

Response target:

- Initial triage within 2 business days.
- Fix, mitigation, or remediation ETA within 7 calendar days once reproduced.

Do not publish exploit details before coordinated remediation.

Reports about contributor behavior rather than a technical vulnerability belong in the [Code of Conduct](./CODE_OF_CONDUCT.md) enforcement path instead.

## Safe Harbor

Good-faith security research on your own installation is welcome. We will not pursue action against research that stays within these limits:

- Test only against instances you own or operate. GoatCitadel is local-first; there is no shared hosted service to test against.
- Do not access, modify, or exfiltrate another person's data.
- Do not run denial-of-service, spam, or social-engineering tests against maintainers or users.
- Give us a reasonable window to remediate before public disclosure.

This is a good-faith statement from the maintainers, not a legal contract, and it does not bind third parties whose services you might reach through an integration.

## Disclosure Process

1. Acknowledge report and reproduce.
2. Classify severity and affected surfaces.
3. Patch and validate with tests.
4. Publish fix notes in `CHANGELOG.md`.
5. Credit reporter if approved.

## Severity Guidance

- Critical: auth bypass, policy bypass, remote code execution, secret exfiltration.
- High: privilege escalation, approval bypass, data corruption with broad impact.
- Medium: scoped data leak or significant availability issues.
- Low: minor information exposure or hard-to-exploit edge case.

## Security Invariants

- Deny-wins policy precedence is mandatory.
- Approval-required actions remain gated.
- Tool grants and sandbox limits are never weakened by local docs.

## Accepted Limitations

These are known, deliberately-accepted residual risks. Each was reviewed and judged
low enough that the mitigation cost outweighs the benefit; revisit if the threat model
changes.

- **macOS keychain write exposes the secret on argv (local, same-user, transient).**
  `secret-store-service.setMacCredential` runs `security add-generic-password … -w <secret>`,
  so the secret is briefly visible to a same-user `ps` during the synchronous spawn.
  macOS `security(1)` has no non-interactive way to read the add-password from stdin
  (the `-w`-prompts-on-TTY path does not exist under a spawned child), so the value must
  be passed on argv. The exposure window is narrow, local-only, and same-user; the error
  path already redacts the secret. A native Security-framework binding (e.g. keytar) would
  remove the window but adds platform-specific native build/packaging fragility that is
  disproportionate to the threat on a single-operator host. **Accepted 2026-06-23.**
  Revisit if GoatCitadel must defend against hostile same-user processes on shared macOS
  hosts. (Windows PasswordVault and Linux `secret-tool` already keep the secret off argv.)

## Triaging GitHub Security Findings

Before opening a PR that touches gateway rate-limit configuration, stream pipeline error handling, Dependabot/version-security alerts, `.github/secret_scanning.yml`, or the synthetic token fixtures in `apps/gateway/src/services/improvement-common.redaction.security.test.ts`, read [`docs/security/findings-triage.md`](docs/security/findings-triage.md). It documents the recurring CodeQL `js/missing-rate-limiting` and `js/unhandled-error-in-stream-pipeline` patterns, the narrow secret-scanning allowlist convention, and the evidence-backed rules for Dependabot updates or dismissals. Re-deriving these decisions every time wastes review cycles and risks regressing prior fixes.
