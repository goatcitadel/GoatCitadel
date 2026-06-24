# Security Policy

Last updated: 2026-06-23

## Supported Versions

GoatCitadel now ships at `1.x`. Security support follows the current stable line first, then the immediately prior prerelease line for critical fixes only when a stable upgrade is not yet practical.

| Version line | Supported |
|---|---|
| `1.x` | Yes |
| `0.9.x-beta.x` | Critical fixes only |
| Earlier prerelease builds | No |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately first.

Recommended report content:

- Affected component and version/commit.
- Reproduction steps.
- Impact assessment.
- Suggested mitigation (if known).

Current reporting path:

- Open a private GitHub security advisory in the repository.

Response target:

- Initial triage within 2 business days.
- Fix, mitigation, or remediation ETA within 7 calendar days once reproduced.

Do not publish exploit details before coordinated remediation.

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
