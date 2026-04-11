# GoatCitadel 1.0 Release Evidence

Last updated: 2026-04-11

This document maps the public `1.0` claims to the repo-visible code paths and verification lanes that prove them.

## Recovery Truth

- Live admin restore is blocked at [apps/gateway/src/routes/admin.ts](../apps/gateway/src/routes/admin.ts).
- Shared path jailing and blocked restore payload shaping live in [apps/gateway/src/services/backup-paths.ts](../apps/gateway/src/services/backup-paths.ts).
- Offline restore and verify execution live in [apps/gateway/src/services/backup-retention-service.ts](../apps/gateway/src/services/backup-retention-service.ts) and [apps/gateway/src/admin-cli.ts](../apps/gateway/src/admin-cli.ts).
- Route proof lives in [apps/gateway/src/routes/admin.test.ts](../apps/gateway/src/routes/admin.test.ts).
- CLI proof lives in [apps/gateway/src/admin-cli.test.ts](../apps/gateway/src/admin-cli.test.ts).

## Backup Contract Proof

- Backup manifests record `1.0` contract coverage metadata in [apps/gateway/src/services/backup-retention-service.ts](../apps/gateway/src/services/backup-retention-service.ts).
- Backup verify reports both integrity truth and `contractVerified` coverage truth in [apps/gateway/src/services/gateway/backup-verify.ts](../apps/gateway/src/services/gateway/backup-verify.ts).
- Unit proof for valid, legacy, and contract-incomplete archives lives in [apps/gateway/src/services/gateway/backup-verify.test.ts](../apps/gateway/src/services/gateway/backup-verify.test.ts).
- Stack-backed restore proof lives in `pnpm verify:backup:roundtrip` via [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs).

## Visible Surface Proof

- The canonical release-bearing primary surface manifest lives in [scripts/verification/lib/release-surface-manifest.mjs](../scripts/verification/lib/release-surface-manifest.mjs).
- `verify:surface:regression` and `verify:visual:regression` both derive from that same manifest in [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs).
- Checked-in visual baselines live under [scripts/verification/baselines/visual](../scripts/verification/baselines/visual).

## Durable Ownership Proof

- Shipped Chat / Cowork / Code durable dispatch ownership lives in [apps/gateway/src/services/chat-turn-dispatch-service.ts](../apps/gateway/src/services/chat-turn-dispatch-service.ts).
- Unit proof for durable-owned shipped modes and fail-closed durable allocation behavior lives in [apps/gateway/src/services/chat-turn-dispatch-service.test.ts](../apps/gateway/src/services/chat-turn-dispatch-service.test.ts).
- Stack-backed recovery proof lives in `pnpm verify:operator:proof` and `pnpm verify:durable:recovery`.

## Release Metadata and Governance Truth

- Public release posture is defined in [README.md](../README.md), [CHANGELOG.md](../CHANGELOG.md), and [docs/1_0_CONTRACT.md](./1_0_CONTRACT.md).
- Governance freshness and implementation-anchor checks live in [scripts/validate-governance-docs.mjs](../scripts/validate-governance-docs.mjs).
