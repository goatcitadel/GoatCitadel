# Security Policy

Last updated: 2026-04-11

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
