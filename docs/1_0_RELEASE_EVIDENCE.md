# GoatCitadel 1.0 Release Evidence

Last updated: 2026-04-12

This document maps the public `1.0` claims to the repo-visible code paths and verification lanes that prove them.

## Recovery Truth

- Live admin restore is blocked at [apps/gateway/src/routes/admin.ts](../apps/gateway/src/routes/admin.ts).
- Shared path jailing and blocked restore payload shaping live in [apps/gateway/src/services/backup-paths.ts](../apps/gateway/src/services/backup-paths.ts).
- Offline restore and verify execution live in [apps/gateway/src/services/backup-retention-service.ts](../apps/gateway/src/services/backup-retention-service.ts), [apps/gateway/src/admin-backup-cli.ts](../apps/gateway/src/admin-backup-cli.ts), and the early CLI intercept in [apps/gateway/src/admin-cli.ts](../apps/gateway/src/admin-cli.ts).
- Route proof lives in [apps/gateway/src/routes/admin.test.ts](../apps/gateway/src/routes/admin.test.ts).
- CLI proof lives in [apps/gateway/src/admin-cli.integration.test.ts](../apps/gateway/src/admin-cli.integration.test.ts).

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

- Mission-session Chat / Cowork / Code durable dispatch ownership lives in [apps/gateway/src/services/chat-turn-dispatch-service.ts](../apps/gateway/src/services/chat-turn-dispatch-service.ts).
- Unit proof for durable-owned shipped modes, integration writeback bookkeeping boundaries, and fail-closed durable allocation behavior lives in [apps/gateway/src/services/chat-turn-dispatch-service.test.ts](../apps/gateway/src/services/chat-turn-dispatch-service.test.ts).
- Mission Control now labels external-bound sessions as non-resumable in [apps/mission-control/src/pages/ChatPage.tsx](../apps/mission-control/src/pages/ChatPage.tsx), and replay still skips integration sessions in [apps/gateway/src/services/gateway-service.ts](../apps/gateway/src/services/gateway-service.ts).
- Stack-backed recovery proof lives in `pnpm verify:operator:proof` and `pnpm verify:durable:recovery`.

## Approval Governance Proof

- Operator-only approval control routes live in [apps/gateway/src/routes/approvals.ts](../apps/gateway/src/routes/approvals.ts).
- Route-level auth proof for operator access, device/companion denial, and signed companion mutation denial lives in [apps/gateway/src/routes/privileged-auth.test.ts](../apps/gateway/src/routes/privileged-auth.test.ts).
- The capability-token remote resolution path remains separate from the operator-only control routes in [apps/gateway/src/routes/approvals.test.ts](../apps/gateway/src/routes/approvals.test.ts).
- Stack-backed operator-proof denial coverage for device and companion principals now includes the approval control plane in [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs).

## Ecosystem Proof Map

### Providers

- Live provider verification is repo-visible in [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs), including the deep-core provider lane and live-provider scenario set.
- Nightly execution for that lane is wired in [.github/workflows/verification-nightly-core.yml](../.github/workflows/verification-nightly-core.yml).

### Channels

- Visible built-in channel setup and guided-copy truth live in [apps/gateway/src/services/channel-setup-definitions.ts](../apps/gateway/src/services/channel-setup-definitions.ts) and [docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md).
- Mission Control now renders Channel Setup as a guided-only rollout surface in [apps/mission-control/src/pages/ChannelSetupPage.tsx](../apps/mission-control/src/pages/ChannelSetupPage.tsx).
- UI proof that non-guided built-ins stay out of the visible Channel Setup surface and that future/parity-deficit copy is absent lives in [apps/mission-control/src/pages/ChannelSetupPage.test.tsx](../apps/mission-control/src/pages/ChannelSetupPage.test.tsx).
- Unit proof for guided validation, live-auth/live-send levels, and removal of the stale planned-parity wording lives in [apps/gateway/src/services/channel-setup-definitions.test.ts](../apps/gateway/src/services/channel-setup-definitions.test.ts).
- Runtime probe coverage for the live-auth channel lanes lives in [apps/gateway/src/services/channel-bot-live-probes.test.ts](../apps/gateway/src/services/channel-bot-live-probes.test.ts).
- `verify:catalog:parity` remains the release lane for visible non-channel runtime-backed catalog actions; channel proof is currently split across guided setup tests and live probe coverage rather than one monolithic parity certifier.

### MCP

- Visible `1.0` MCP authoring now stays on local `stdio` plus the built-in Approval Inbox template in [apps/mission-control/src/pages/McpPage.tsx](../apps/mission-control/src/pages/McpPage.tsx) and [apps/gateway/src/services/gateway-service.ts](../apps/gateway/src/services/gateway-service.ts).
- The internal Approval Inbox remains runtime-invokable through its dedicated coordinator path in [apps/gateway/src/services/mcp-approval-inbox.ts](../apps/gateway/src/services/mcp-approval-inbox.ts) and [apps/gateway/src/services/tool-invocation-coordinator-service.ts](../apps/gateway/src/services/tool-invocation-coordinator-service.ts).
- Generic non-stdio runtime invocation is still rejected in [apps/gateway/src/services/mcp-runtime.ts](../apps/gateway/src/services/mcp-runtime.ts), which is why those transports are removed from the visible `1.0` authoring/template surface instead of being implied as supported.
- Unit proof for the visibility rule lives in [apps/gateway/src/services/mcp-template-visibility.test.ts](../apps/gateway/src/services/mcp-template-visibility.test.ts), and Mission Control surface proof lives in [apps/mission-control/src/mission-control-hardening.test.tsx](../apps/mission-control/src/mission-control-hardening.test.tsx).

### Extensions

- The published author boundary is the `@goatcitadel/extensions-sdk` package under [packages/extensions-sdk](../packages/extensions-sdk).
- Package-level proof for manifest and file-loading helpers lives in [packages/extensions-sdk/src/addons.test.ts](../packages/extensions-sdk/src/addons.test.ts) and [packages/extensions-sdk/src/integration-plugins.test.ts](../packages/extensions-sdk/src/integration-plugins.test.ts).
- Starter-pack export and gateway-side author-contract proof live in [apps/gateway/src/services/extension-starter-pack.test.ts](../apps/gateway/src/services/extension-starter-pack.test.ts) and [apps/gateway/src/services/integration-plugin-author-contract.test.ts](../apps/gateway/src/services/integration-plugin-author-contract.test.ts).
- The current `1.0` claim is the published package contract plus tested reference scaffolds/export path, not a broader live install/enable/disable smoke guarantee for every extension shape.

## Release Metadata and Governance Truth

- Public release posture is defined in [README.md](../README.md), [CHANGELOG.md](../CHANGELOG.md), and [docs/1_0_CONTRACT.md](./1_0_CONTRACT.md).
- Governance freshness and implementation-anchor checks live in [scripts/validate-governance-docs.mjs](../scripts/validate-governance-docs.mjs).
