export const PROMPT_LAB_SUGGESTED_FILE_PATHS = {
  memoryLifecycleOperatorUi: [
    "apps/gateway/src/routes/memory.ts",
    "apps/gateway/src/services/memory-route-service.ts",
    "apps/gateway/src/services/memory-context-service.ts",
    "apps/gateway/src/services/memory-lifecycle-service.ts",
    "packages/storage/src/memory-context-repo.ts",
    "apps/mission-control-next/src/features/native-routes/library/MemoryRoutePage.tsx",
    "packages/mission-control-shared/src/hooks/useMemoryOperatorSnapshot.ts",
  ],
  guidanceRuntime: [
    "apps/gateway/src/services/guidance-doc-files.ts",
    "apps/gateway/src/services/guidance-document-helpers.ts",
    "apps/gateway/src/services/gateway-service.ts",
    "apps/gateway/src/services/chat-turn-prep-service.ts",
    "AGENTS.md",
  ],
  approvalWakeOrdering: [
    "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
    "apps/gateway/src/services/approval-resolution-effects-service.ts",
    "packages/storage/src/approval-effect-repo.ts",
    "packages/storage/src/approval-wait-run-repo.ts",
    "apps/gateway/src/services/durable-run-service.ts",
  ],
  runtimeLifecycleProvenance: [
    "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
    "apps/gateway/src/services/approval-lifecycle-service.ts",
    "apps/gateway/src/routes/approvals.ts",
    "packages/storage/src/approval-wait-run-repo.ts",
    "packages/storage/src/chat-session-repo.ts",
  ],
  strictPausedWaitingWakeEvidence: [
    "apps/gateway/src/services/durable-run-service.ts",
    "apps/gateway/src/services/approval-resolution-effects-service.ts",
    "apps/gateway/src/routes/durable.ts",
    "apps/gateway/src/services/runtime-lifecycle-read-service.ts",
    "packages/contracts/src/durable.ts",
  ],
  cronReportCowork: [
    "apps/gateway/src/services/gateway/cron-automation-service.ts",
    "apps/gateway/src/services/gateway/update-review.ts",
    "apps/gateway/src/routes/prompt-packs.ts",
    "packages/storage/src/cron-job-repo.ts",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
  ],
  durableWorkerHarnessCoverage: [
    "packages/storage/src/durable-run-repo.test.ts",
    "packages/storage/src/durable-run-repo.ts",
    "apps/gateway/src/services/durable-run-service.ts",
    "apps/gateway/src/services/durable-run-service.test.ts",
  ],
  typedWakeOutcomeEvidence: [
    "packages/contracts/src/durable.ts",
    "apps/gateway/src/services/durable-run-service.ts",
    "apps/gateway/src/services/approval-resolution-effects-service.ts",
    "apps/gateway/src/services/durable-run-service.test.ts",
    "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
  ],
  realtimeEventEnvelope: [
    "apps/gateway/src/services/gateway-service.ts",
    "apps/gateway/src/services/realtime-event-service.ts",
    "apps/gateway/src/services/realtime-events-route-service.ts",
    "apps/gateway/src/routes/events.ts",
    "packages/storage/src/realtime-event-repo.ts",
    "packages/storage/src/realtime-event-repo.test.ts",
  ],
  durableWakeOutcomePatchPlan: [
    "packages/contracts/src/durable.ts",
    "apps/gateway/src/services/durable-run-service.ts",
    "apps/gateway/src/services/approval-resolution-effects-service.ts",
    "apps/gateway/src/routes/durable.ts",
    "packages/mission-control-shared/src/api/durable.ts",
    "apps/gateway/src/services/approval-resolution-effects-service.test.ts",
  ],
  promptPackParserRegression: [
    "goatcitadel_prompt_pack_v2.md",
    "goatcitadel_prompt_pack.md",
    "apps/gateway/src/services/prompt-pack-service.ts",
  ],
  promptPackSourceLabel: [
    "apps/gateway/src/services/prompt-pack-service.ts",
    "apps/gateway/src/services/prompt-pack-service.parser-report.test.ts",
    "packages/storage/src/prompt-pack-repo.ts",
    "apps/gateway/src/routes/prompt-packs.ts",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
    "packages/contracts/src/prompt-pack.ts",
  ],
  promptPackStorageProductSurface: [
    "packages/storage/src/prompt-pack-repo.ts",
    "packages/storage/src/prompt-pack-run-repo.ts",
    "packages/storage/src/prompt-pack-score-repo.ts",
    "packages/storage/src/prompt-pack-repo.test.ts",
    "packages/storage/src/prompt-pack-run-repo.test.ts",
    "apps/gateway/src/services/prompt-pack-service.ts",
  ],
  promptPackMissionControlProductSurface: [
    "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx",
    "apps/mission-control-next/src/features/prompt-packs/prompt-packs-workbench.css",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
    "packages/contracts/src/prompt-pack.ts",
  ],
  promptPackExportProductSurface: [
    "apps/gateway/src/services/prompt-pack-service.ts",
    "apps/gateway/src/routes/prompt-packs.ts",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
    "packages/contracts/src/prompt-pack.ts",
  ],
  promptPackApiProductSurface: [
    "packages/mission-control-shared/src/api/prompt-packs.ts",
    "apps/gateway/src/routes/prompt-packs.ts",
    "apps/gateway/src/services/prompt-pack-service.ts",
    "packages/contracts/src/prompt-pack.ts",
  ],
  promptPackGateSelection: [
    "scripts/run-prompt-pack-gates.ts",
    "apps/gateway/src/services/prompt-pack-service.ts",
    "apps/gateway/src/routes/prompt-packs.ts",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
  ],
  promptPackScoringV3: [
    "apps/gateway/src/services/prompt-pack-service.ts",
    "apps/gateway/src/services/prompt-pack-service.scoring.test.ts",
    "apps/gateway/src/services/prompt-pack-service.parser-report.test.ts",
    "packages/storage/src/prompt-pack-score-repo.ts",
    "packages/storage/src/prompt-pack-auto-score-v2-repo.ts",
    "packages/contracts/src/prompt-pack.ts",
  ],
  promptPackAutoScoreRoute: [
    "apps/gateway/src/routes/prompt-packs.ts",
    "apps/gateway/src/services/prompt-pack-service.ts",
    "apps/gateway/src/services/prompt-pack-policy.ts",
    "packages/storage/src/prompt-pack-auto-score-v2-repo.ts",
    "packages/contracts/src/prompt-pack.ts",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
  ],
  promptPackAutoScoreUi: [
    "apps/mission-control-next/src/features/prompt-packs/PromptPacksWorkbenchPage.tsx",
    "apps/mission-control-next/src/features/prompt-packs/AssessmentTab.tsx",
    "packages/mission-control-shared/src/api/prompt-packs.ts",
    "packages/contracts/src/prompt-pack.ts",
  ],
} as const satisfies Record<string, readonly string[]>;

export type PromptLabSuggestedFilePathSeed = keyof typeof PROMPT_LAB_SUGGESTED_FILE_PATHS;

export const PROMPT_LAB_LOCAL_SEARCH_QUERIES = {
  promptPackOperatorSurface: ["prompt-pack-service.ts", "prompt-packs.ts", "chat.prompt-pack-benchmark.test.ts"],
  approvalWakeFlow: [
    "approval-resolution-effects-service.ts",
    "approval-lifecycle-service.ts",
    "approval-wait-run-repo.ts",
    "approval-effect-repo.ts",
  ],
  workspaceRoutesGuidance: [
    "workspaces.ts",
    "workspaces.test.ts",
    "workspace-repo.ts",
    "workspace-repo.test.ts",
    "guidance",
  ],
  guidanceRuntime: [
    "guidance-document-helpers.ts",
    "guidance-doc-files.ts",
    "gateway-service.ts",
    "resolveRuntimeGuidance",
    "listWorkspaceGuidance",
    "AGENTS.md",
  ],
  memoryLifecycle: [
    "memory.ts",
    "memory-context-repo.ts",
    "MemoryRoutePage.tsx",
    "useMemoryOperatorSnapshot.ts",
    "memory",
  ],
  cronReport: [
    "cron-job-repo.ts",
    "cron-automation-service.ts",
    "update-review.ts",
    "prompt-packs.ts",
    "api/prompt-packs.ts",
    "costs.ts",
    "costs/summary",
    "update-review-daily",
  ],
  rank1Hardening: [
    "durable-run-service.ts",
    "approval-resolution-effects-service.ts",
    "runtime-lifecycle-read-service.ts",
    "durable.ts",
    "wake",
  ],
  lifecycleCanonicalLinkage: [
    "runtime-lifecycle-read-service.test.ts",
    "runtime-lifecycle-read-service.ts",
    "approval_linkage",
    "fallback_payload",
    "fallback_preview",
  ],
  runtimeLifecycleProvenance: [
    "runtime-lifecycle-read-service.ts",
    "approval-lifecycle-service.ts",
    "approvals.ts",
    "approval_linkage",
    "fallback_payload",
    "fallback_preview",
    "sessionIdSource",
  ],
  strictPausedWaitingWakeEvidence: [
    "durable-run-service.ts",
    "approval-resolution-effects-service.ts",
    "routes/durable.ts",
    "runtime-lifecycle-read-service.ts",
    "DurableWakeResult",
    "wakeDurableRun paused waiting",
  ],
  realtimeEventMetadata: [
    "events.test.ts",
    "events.ts",
    "gateway-service.ts",
    "realtime-event-repo.test.ts",
    "realtime-event-repo.ts",
    "tool-invocation-coordinator-service.test.ts",
  ],
  realtimeEventEnvelope: [
    "eventClass",
    "eventAuthority",
    "links",
    "gateway-service.ts",
    "realtime-event-service.ts",
    "realtime-events-route-service.ts",
    "events.ts",
    "realtime-event-repo.ts",
  ],
  durableRunMinimal: [
    "durable-run-service.test.ts",
    "durable-run-service.ts",
    "durable-run-repo.test.ts",
    "durable-run-repo.ts",
    "approval-resolution-effects-service.test.ts",
    "approval-resolution-effects-service.ts",
    "approval-effect-repo.ts",
    "approval-wait-run-repo.ts",
  ],
  promptPackGateSelection: [
    "run-prompt-pack-gates.ts",
    "selectPromptPackTargets",
    "resolvePromptPack",
    "selectPromptPackGateTargetCodes",
    "prompt-pack-service.ts",
    "expansion-pack",
    "baseline",
  ],
  promptPackScoringV3: [
    "prompt-pack-service.scoring.test.ts",
    "prompt-pack-service.parser-report.test.ts",
    "evaluatePromptPackRuleScores",
    "mergePromptPackAutoScoresV3",
    "derivePromptPackFailureAttributionV3",
    "PromptPackReasonCode",
    "latest score rows",
  ],
  promptPackAutoScoreRoute: [
    "prompt-packs.ts",
    "autoScorePromptPackTest",
    "PROMPT_PACK_DEFAULT_SCORING_SCHEMA_VERSION",
    "prompt-pack-auto-score-v2-repo.ts",
    "PromptPackAutoScoreRecord",
  ],
  promptPackAutoScoreUi: [
    "PromptPacksWorkbenchPage.tsx",
    "AssessmentTab.tsx",
    "formatPromptPackAttribution",
    "autoScorePromptPackTest",
    "PromptPackFailureAttributionRecordV3",
  ],
} as const satisfies Record<string, readonly string[]>;

export type PromptLabLocalSearchQuerySeed = keyof typeof PROMPT_LAB_LOCAL_SEARCH_QUERIES;

const CRON_REPORT_EVIDENCE_MATCHERS = {
  cron: /(?:^|\/)(?:apps\/gateway\/src\/services\/gateway\/cron-automation-service|packages\/storage\/src\/cron-job-repo)\.ts$/i,
  execution:
    /(?:^|\/)(?:apps\/gateway\/src\/services\/gateway\/update-review|apps\/gateway\/src\/services\/cron-scheduler-service)\.ts$/i,
  report:
    /(?:^|\/)(?:apps\/gateway\/src\/routes\/prompt-packs|packages\/mission-control-shared\/src\/api\/prompt-packs|apps\/gateway\/src\/routes\/costs|packages\/mission-control-shared\/src\/api\/system)\.ts$/i,
} as const;

export function resolvePromptLabCronReportEvidencePaths(evidencePaths: readonly string[]): {
  cronPath: string;
  executionPath: string;
  reportPath: string;
} {
  return {
    cronPath:
      evidencePaths.find((path) => CRON_REPORT_EVIDENCE_MATCHERS.cron.test(path)) ??
      "apps/gateway/src/services/gateway/cron-automation-service.ts",
    executionPath:
      evidencePaths.find((path) => CRON_REPORT_EVIDENCE_MATCHERS.execution.test(path)) ??
      "apps/gateway/src/services/gateway/update-review.ts",
    reportPath:
      evidencePaths.find((path) => CRON_REPORT_EVIDENCE_MATCHERS.report.test(path)) ??
      "apps/gateway/src/routes/prompt-packs.ts",
  };
}
