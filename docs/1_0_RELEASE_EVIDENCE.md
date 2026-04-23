# GoatCitadel 1.0 Release Evidence

Last updated: 2026-04-22

This document maps the public `1.0` claims to the repo-visible code paths, tests, and named verification lanes that back them.

For this document:

- `proof` means a named end-to-end verification lane with a bespoke scenario body under [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs)
- `evidence` means the supporting repo-visible code paths, unit/integration tests, and manifests that anchor those claims

Current shell posture for this map:

- `apps/mission-control-next` is the canonical `1.0` shell.
- `apps/mission-control` remains a compatibility-only shell. Legacy code and tests are cited here only when they are explicitly needed for parity or rollback continuity evidence.

## Recovery Truth

- Live admin restore is blocked at [apps/gateway/src/routes/admin.ts](../apps/gateway/src/routes/admin.ts).
- Shared path jailing and blocked restore payload shaping live in [apps/gateway/src/services/backup-paths.ts](../apps/gateway/src/services/backup-paths.ts).
- Offline restore and verify execution live in [apps/gateway/src/services/backup-retention-service.ts](../apps/gateway/src/services/backup-retention-service.ts), [apps/gateway/src/admin-backup-cli.ts](../apps/gateway/src/admin-backup-cli.ts), and the early CLI intercept in [apps/gateway/src/admin-cli.ts](../apps/gateway/src/admin-cli.ts).
- Route-level evidence lives in [apps/gateway/src/routes/admin.test.ts](../apps/gateway/src/routes/admin.test.ts).
- CLI evidence lives in [apps/gateway/src/admin-cli.integration.test.ts](../apps/gateway/src/admin-cli.integration.test.ts).

## Backup Contract Evidence

- Backup manifests record `1.0` contract coverage metadata in [apps/gateway/src/services/backup-retention-service.ts](../apps/gateway/src/services/backup-retention-service.ts).
- Backup verify reports both integrity truth and `contractVerified` coverage truth in [apps/gateway/src/services/gateway/backup-verify.ts](../apps/gateway/src/services/gateway/backup-verify.ts).
- Unit-test evidence for valid, legacy, and contract-incomplete archives lives in [apps/gateway/src/services/gateway/backup-verify.test.ts](../apps/gateway/src/services/gateway/backup-verify.test.ts).
- Stack-backed restore proof lives in `pnpm verify:backup:roundtrip` via [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs).

## Visible Surface Evidence

- The canonical release-bearing primary surface manifest lives in [scripts/verification/lib/release-surface-manifest.mjs](../scripts/verification/lib/release-surface-manifest.mjs).
- `verify:surface:regression` and `verify:visual:regression` both derive from that same manifest in [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs).
- `verify:ui:parity` is the named compatibility proof lane for the seeded next-vs-legacy surface set while the legacy shell remains shipped for rollback/comparison.
- `verify:visual:regression` is the read-only screenshot gate in [scripts/verification/run.mjs](../scripts/verification/run.mjs); intentional baseline maintenance now goes through `verify:visual:rebaseline`, which threads explicit baseline-write intent into [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs) instead of letting the normal lane rewrite proof artifacts.
- Checked-in visual baselines live under [scripts/verification/baselines/visual](../scripts/verification/baselines/visual).

## Durable Ownership Evidence

- Mission-session Chat / Cowork / Code durable dispatch ownership lives in [apps/gateway/src/services/chat-turn-dispatch-service.ts](../apps/gateway/src/services/chat-turn-dispatch-service.ts).
- Unit-test evidence for durable-owned shipped modes, integration writeback bookkeeping boundaries, and fail-closed durable allocation behavior lives in [apps/gateway/src/services/chat-turn-dispatch-service.test.ts](../apps/gateway/src/services/chat-turn-dispatch-service.test.ts).
- Mission Control now labels external-bound sessions as non-resumable in [apps/mission-control/src/pages/ChatPage.tsx](../apps/mission-control/src/pages/ChatPage.tsx), and replay still skips integration sessions in [apps/gateway/src/services/gateway-service.ts](../apps/gateway/src/services/gateway-service.ts).
- Stack-backed recovery evidence lives in `pnpm verify:operator:proof` and `pnpm verify:durable:recovery`.
- `pnpm verify:runtime:truth` is the named runtime proof lane for the approval-gated durable restart/recovery path, including Mission Control Next label checks against backend truth.

## Approval Governance Evidence

- Operator-only approval control routes live in [apps/gateway/src/routes/approvals.ts](../apps/gateway/src/routes/approvals.ts).
- Route-level auth evidence for operator access, device/companion denial, and signed companion mutation denial lives in [apps/gateway/src/routes/privileged-auth.test.ts](../apps/gateway/src/routes/privileged-auth.test.ts).
- The capability-token remote resolution path remains separate from the operator-only control routes in [apps/gateway/src/routes/approvals.test.ts](../apps/gateway/src/routes/approvals.test.ts).
- Stack-backed operator-proof denial coverage for device and companion principals now includes the approval control plane in [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs).
- `pnpm verify:auth:matrix` is the named privileged-route auth proof lane. It derives representative endpoints from the route-access manifest and asserts outcomes by access class.

## Hardening Pass Evidence

- Streaming completion retry/fallback now fail closed after any partial emission in [apps/gateway/src/services/llm-completion-service.ts](../apps/gateway/src/services/llm-completion-service.ts), with regression evidence for partial-stream tool-protocol failure and cross-provider failure in [apps/gateway/src/services/llm-completion-service.test.ts](../apps/gateway/src/services/llm-completion-service.test.ts).
- Operator-facing JSON mutation dedupe now blocks duplicate execution through [apps/gateway/src/plugins/idempotency.ts](../apps/gateway/src/plugins/idempotency.ts) and the persisted key-claim store in [packages/storage/src/mutation-idempotency-repo.ts](../packages/storage/src/mutation-idempotency-repo.ts), with route/plugin evidence in [apps/gateway/src/plugins/idempotency.test.ts](../apps/gateway/src/plugins/idempotency.test.ts) and storage evidence in [packages/storage/src/mutation-idempotency-repo.test.ts](../packages/storage/src/mutation-idempotency-repo.test.ts).
- Learned-memory policy ownership now routes through [apps/gateway/src/services/memory-lifecycle-service.ts](../apps/gateway/src/services/memory-lifecycle-service.ts) using session `memoryMode` instead of ad hoc write-time decisions, with coverage in [apps/gateway/src/services/memory-lifecycle-service.test.ts](../apps/gateway/src/services/memory-lifecycle-service.test.ts).
- Memory item lifecycle truth now includes explicit `lifecycleState` plus expired-active visibility in [packages/contracts/src/memory.ts](../packages/contracts/src/memory.ts), [apps/gateway/src/services/memory-lifecycle-service.ts](../apps/gateway/src/services/memory-lifecycle-service.ts), and [packages/storage/src/memory-maintenance-repo.ts](../packages/storage/src/memory-maintenance-repo.ts), with coverage in [apps/gateway/src/services/memory-lifecycle-service.test.ts](../apps/gateway/src/services/memory-lifecycle-service.test.ts).
- `pnpm verify:memory:truth` is the named memory proof lane for TTL patching, expiry transition, lifecycle truth, and admin visibility after expiry.
- MCP and generic tool execution are now governed by the same policy engine in [apps/gateway/src/services/tool-invocation-coordinator-service.ts](../apps/gateway/src/services/tool-invocation-coordinator-service.ts), with MCP re-checking the normalized `mcp.invoke` request immediately before runtime dispatch and parity coverage in [apps/gateway/src/services/tool-invocation-coordinator-service.test.ts](../apps/gateway/src/services/tool-invocation-coordinator-service.test.ts).
- Prompt compaction now preserves tool/message identity breadcrumbs in [apps/gateway/src/services/chat-compaction.ts](../apps/gateway/src/services/chat-compaction.ts), with regression coverage in [apps/gateway/src/services/gateway-service.compaction.test.ts](../apps/gateway/src/services/gateway-service.compaction.test.ts).
- Mission Control routing transparency now surfaces requested versus effective routing in [apps/mission-control/src/components/ChatTraceCard.tsx](../apps/mission-control/src/components/ChatTraceCard.tsx) and [apps/mission-control/src/components/chat/ChatThreadView.tsx](../apps/mission-control/src/components/chat/ChatThreadView.tsx), with UI evidence in [apps/mission-control/src/components/ChatTraceCard.test.tsx](../apps/mission-control/src/components/ChatTraceCard.test.tsx) and [apps/mission-control/src/components/chat/ChatThreadView.test.tsx](../apps/mission-control/src/components/chat/ChatThreadView.test.tsx).
- Shared realtime truth derivation now lives in [packages/mission-control-shared/src/state/realtime-derived.ts](../packages/mission-control-shared/src/state/realtime-derived.ts), with current-shell degraded labeling in [apps/mission-control-next/src/app/MissionControlNextApp.tsx](../apps/mission-control-next/src/app/MissionControlNextApp.tsx) and regression coverage in [packages/mission-control-shared/src/state/realtime-derived.test.ts](../packages/mission-control-shared/src/state/realtime-derived.test.ts).
- `pnpm verify:realtime:truth` is the named realtime proof lane for explicit metadata, compatibility fallback, replay-gap behavior, and degraded labeling in the canonical shell.
- Mission Control approval failure resilience now keeps resolution context visible in [apps/mission-control/src/pages/ApprovalsPage.tsx](../apps/mission-control/src/pages/ApprovalsPage.tsx), with failure-path evidence in [apps/mission-control/src/pages/ApprovalsPage.test.tsx](../apps/mission-control/src/pages/ApprovalsPage.test.tsx).
- Cowork orchestration truth now refreshes through the existing app refresh bus in [apps/mission-control/src/pages/chat/useChatDockWorkbenchController.ts](../apps/mission-control/src/pages/chat/useChatDockWorkbenchController.ts), preserving last-known-good run/checkpoint state on partial refresh failures with hook-level evidence in [apps/mission-control/src/pages/chat/useChatDockWorkbenchController.test.tsx](../apps/mission-control/src/pages/chat/useChatDockWorkbenchController.test.tsx).
- Chat outbound execution now keeps prior pending-approval context visible until execution actually commits in [apps/mission-control/src/pages/chat/useChatOutboundExecution.ts](../apps/mission-control/src/pages/chat/useChatOutboundExecution.ts), with regression evidence in [apps/mission-control/src/pages/chat/useChatOutboundExecution.test.tsx](../apps/mission-control/src/pages/chat/useChatOutboundExecution.test.tsx).
- Approval-effect replay now has an explicit regression proving already-executed pending tool actions are not re-fired when replayed effect processing runs again in [apps/gateway/src/services/approval-resolution-effects-service.test.ts](../apps/gateway/src/services/approval-resolution-effects-service.test.ts).

## Ecosystem Evidence Map

### Providers

- Live provider verification is repo-visible in [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs), including the deep-core provider lane and live-provider scenario set.
- Nightly execution for that lane is wired in [.github/workflows/verification-nightly-core.yml](../.github/workflows/verification-nightly-core.yml).

### Channels

- Visible built-in channel setup and guided-copy truth live in [apps/gateway/src/services/channel-setup-definitions.ts](../apps/gateway/src/services/channel-setup-definitions.ts) and [docs/COMMUNICATION_CHANNEL_SETUP_GUIDE.md](./COMMUNICATION_CHANNEL_SETUP_GUIDE.md).
- Mission Control now renders Channel Setup as a guided-only rollout surface in [apps/mission-control/src/pages/ChannelSetupPage.tsx](../apps/mission-control/src/pages/ChannelSetupPage.tsx).
- UI evidence that non-guided built-ins stay out of the visible Channel Setup surface and that future/parity-deficit copy is absent lives in [apps/mission-control/src/pages/ChannelSetupPage.test.tsx](../apps/mission-control/src/pages/ChannelSetupPage.test.tsx).
- Unit-test evidence for guided validation, live-auth/live-send levels, and removal of the stale planned-parity wording lives in [apps/gateway/src/services/channel-setup-definitions.test.ts](../apps/gateway/src/services/channel-setup-definitions.test.ts).
- Runtime probe coverage for the live-auth channel lanes lives in [apps/gateway/src/services/channel-bot-live-probes.test.ts](../apps/gateway/src/services/channel-bot-live-probes.test.ts).
- `verify:catalog:parity` remains the release lane for visible non-channel runtime-backed catalog actions; channel proof is currently split across guided setup tests and live probe coverage rather than one monolithic parity certifier.

### MCP

- Visible `1.0` MCP authoring now stays on local `stdio` plus the built-in Approval Inbox template in [apps/mission-control/src/pages/McpPage.tsx](../apps/mission-control/src/pages/McpPage.tsx) and [apps/gateway/src/services/gateway-service.ts](../apps/gateway/src/services/gateway-service.ts).
- The internal Approval Inbox remains runtime-invokable through its dedicated coordinator path in [apps/gateway/src/services/mcp-approval-inbox.ts](../apps/gateway/src/services/mcp-approval-inbox.ts) and [apps/gateway/src/services/tool-invocation-coordinator-service.ts](../apps/gateway/src/services/tool-invocation-coordinator-service.ts).
- Generic non-stdio runtime invocation is still rejected in [apps/gateway/src/services/mcp-runtime.ts](../apps/gateway/src/services/mcp-runtime.ts), which is why those transports are removed from the visible `1.0` authoring/template surface instead of being implied as supported.
- Unit-test evidence for the visibility rule lives in [apps/gateway/src/services/mcp-template-visibility.test.ts](../apps/gateway/src/services/mcp-template-visibility.test.ts), and Mission Control surface evidence lives in [apps/mission-control/src/mission-control-hardening.test.tsx](../apps/mission-control/src/mission-control-hardening.test.tsx).

### Extensions

- The published author boundary is the `@goatcitadel/extensions-sdk` package under [packages/extensions-sdk](../packages/extensions-sdk).
- Package-level evidence for manifest and file-loading helpers lives in [packages/extensions-sdk/src/addons.test.ts](../packages/extensions-sdk/src/addons.test.ts) and [packages/extensions-sdk/src/integration-plugins.test.ts](../packages/extensions-sdk/src/integration-plugins.test.ts).
- Starter-pack export and gateway-side author-contract evidence live in [apps/gateway/src/services/extension-starter-pack.test.ts](../apps/gateway/src/services/extension-starter-pack.test.ts) and [apps/gateway/src/services/integration-plugin-author-contract.test.ts](../apps/gateway/src/services/integration-plugin-author-contract.test.ts).
- The current `1.0` claim is the published package contract plus tested reference scaffolds/export path, not a broader live install/enable/disable smoke guarantee for every extension shape.

## Release Metadata and Governance Evidence

- Public release posture is defined in [README.md](../README.md), [CHANGELOG.md](../CHANGELOG.md), and [docs/1_0_CONTRACT.md](./1_0_CONTRACT.md).
- Governance freshness and implementation-anchor checks live in [scripts/validate-governance-docs.mjs](../scripts/validate-governance-docs.mjs).

## Closeout Validation Evidence

- Closeout validation keeps the contract and handbook anchored through `pnpm docs:check`.
- The hardening pass now ships named runtime-truth, auth-matrix, ui-parity, memory-truth, realtime-truth, and architecture-metrics lanes through [scripts/verification/run.mjs](../scripts/verification/run.mjs) and [scripts/verification/lib/scenarios.mjs](../scripts/verification/lib/scenarios.mjs). Each named truth lane now runs a bespoke scenario body instead of delegating to older shared coverage.
- The visual regression lane remains read-only and any intentional baseline updates must go through `verify:visual:rebaseline` before a clean rerun against the checked-in assets under [scripts/verification/baselines/visual](../scripts/verification/baselines/visual).
- No known non-blocking failures remain explicitly accepted for this pass.
