# Packaging And Deployment Parity Checklist

Last updated: 2026-03-30
Scope: `GC-P1-09` packaging and remote deployment parity

## Purpose

Use this checklist when claiming progress on installer, packaging, release, or remote deployment parity.

This is not a product launch checklist. It is a proof checklist for follow-on parity work.

## Operator Flow

1. Generate the current packaging proof-lane draft from Mission Control System to capture deployment posture, auth state, and allowlist notes.
1. Run the clean install and first-startup checks in the current target environment.
1. Run the remote_hardened and rollback/recovery checks below and fill the proof bundle template.

## Required Proof Areas

Every parity claim in this lane should capture evidence for all of these:

1. Clean install
2. First startup
3. Auth posture
4. Network posture
5. Remote-hardened behavior
6. Rollback or recovery path

## Clean Install Proof

- Start from a machine or VM without a prior GoatCitadel install.
- Record OS, architecture, and installer/build artifact used.
- Record whether the install path is local-only, trusted-local, or remote-hardened.
- Capture whether the install completes without manual source edits.
- Capture the exact failure if the install requires operator intervention.

Minimum artifact:
- timestamped install log or terminal transcript

## First Startup Proof

- Launch the installed build without patching environment-specific source files.
- Confirm the gateway starts successfully.
- Confirm Mission Control can load core pages.
- Confirm the system surface reports the expected deployment profile and auth mode.

Minimum artifact:
- startup log plus one screenshot or structured note from the System page

## Auth Posture Proof

- Record the configured auth mode.
- Record whether loopback bypass is enabled or disabled.
- Confirm the posture matches the intended deployment target.
- Treat `auth.mode = none` as non-parity for any shared or remote target.

Minimum artifact:
- config snapshot or runtime status output showing auth mode and loopback-bypass state

## Network Posture Proof

- Record network allowlist entries if any are required by the target posture.
- Confirm the service is reachable only in the intended way for that profile.
- Record any deliberate exceptions, such as loopback-only exposure for trusted-local use.

Minimum artifact:
- settings snapshot or runtime report showing allowlist count and deployment profile

## Remote-Hardened Proof

Run this lane before calling packaging or deployment parity complete:

- Start with `deploymentProfile = remote_hardened`.
- Confirm auth is enabled.
- Confirm loopback bypass is disabled.
- Confirm browser-control expectations match hardened policy.
- Confirm unsupported local-only assumptions are rejected cleanly.

Minimum artifact:
- one successful remote-hardened startup proof
- one explicit policy-boundary proof

## Rollback / Recovery Proof

- Document how to stop the deployment safely.
- Document how to revert to the previous package/build.
- Document how to recover from a failed startup or bad config push.
- Record whether recovery was tested or remains theoretical.

Minimum artifact:
- rollback steps plus one verified recovery note

## Claim Levels

### Safe To Claim

- Installer smoke proof exists for at least one target environment.
- Startup proof exists for the same environment.
- Auth and network posture are recorded.
- Any missing hardened proof is called out explicitly.

### Not Safe To Claim

- "Deployment parity complete" without a remote-hardened proof run
- "Public-share ready" while loopback bypass remains enabled
- "Cross-environment parity" from a single developer machine install

## Suggested Evidence Bundle

For each tranche, store or link:

- install transcript
- startup transcript
- System page snapshot or equivalent runtime note
- auth/network posture note
- remote-hardened proof note
- rollback note

Reusable template:
- `templates/verification/packaging-deployment-proof-bundle.md`

## Recommended Next Tranche

After this checklist is in use:

1. Keep the System-page proof-lane draft aligned with runtime truth as deployment/auth guardrails evolve.
2. Add a saved issue or release-note wrapper if packaging parity runs need a stricter filing workflow.
