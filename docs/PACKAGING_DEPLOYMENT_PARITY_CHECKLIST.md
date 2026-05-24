# Packaging & Remote Deployment Parity Checklist

Use this checklist to verify packaging, installation, startup, and remote-hardened configuration for GoatCitadel epic `GC-P1-09`.

## Preflight Verification
- [ ] Confirm active deployment profile in current runtime.
- [ ] Record System-page posture summary.
- [ ] Record current gateway settings snapshot.

## 1. Clean Local Installation & Smoke Test
- [ ] Deploy local gateway and built Mission Control assets.
- [ ] Run clean installer or startup smoke path in the current environment (`windows-x64` / `windows-arm64`).
- [ ] Expose user-facing launchers from the mutable GoatCitadel home (separate `app/`, `config/`, `skills/`, `workspaces/`, `data/`).
- [ ] Confirm first successful operator launch path.

## 2. Remote-Hardened Posture Verification
- [ ] Promote the runtime into `remote_hardened` posture.
- [ ] Verify that a non-empty network allowlist is set.
- [ ] Disable loopback bypass (`allowLoopbackBypass: false`).
- [ ] Use a secure auth mode (e.g. `preshared` or similar secure configuration; auth mode must NOT be `none`).
- [ ] Rerun the clean installer/startup smoke path under `remote_hardened` and verify that the policy engine blocks illegal/unauthorized egress.

## 3. Rollback & Recovery Verification
- [ ] Simulate or trigger a failed startup or broken auth/policy posture.
- [ ] Verify that the fallback mechanism allows operators to recover the gateway settings.
- [ ] Document the exact recovery steps taken and the operator-visible status.

## 4. Final Proof Assembly
- [ ] Fill in the `templates/verification/packaging-deployment-proof-bundle.md` template.
- [ ] Include installer logs, startup traces, and policy blocker evidence.
- [ ] Export the final markdown bundle to `artifacts/follow-on-parity/packaging/`.
