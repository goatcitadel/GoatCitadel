import { createHash } from "node:crypto";
import os from "node:os";
import {
  redactStructuredSecrets,
  type ApprovalRequest,
  type ChatGeneratedArtifactRecord,
  type ChatStreamUsageRecord,
  type ChatToolRunRecord,
  type DurableCheckpointRecord,
  type DurableRunRecord,
  type DurableRunTimelineEvent,
  type MemoryContextPack,
  type OpsDesignQualitySnapshot,
  type OpsQualitySecurityExecutionItem,
  type OpsQualityOtelExportResponse,
  type OpsQualityOtelSpan,
  type OpsQualitySnapshotResponse,
  type PromptPackSecurityEvalPackRecord,
  type PromptPackSecurityQualityGateRecord,
  type RuntimeLifecycleResponse,
  type RuntimeLifecycleTurnSummary,
  type RuntimeLifecycleToolRunSummary,
} from "@goatcitadel/contracts";
import { readDesignQualityEvidence } from "@goatcitadel/skills";
import type { Storage } from "@goatcitadel/storage";
import type { BackupRetentionService } from "./backup-retention-service.js";
import type { DurableOperatorService } from "./durable-operator-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import type { OperatorSummaryCache } from "./gateway/operator-summary-cache.js";
import type { PromptPackService } from "./prompt-pack-service.js";
import type { RealtimeEventService } from "./realtime-event-service.js";
import type { RuntimeLifecycleReadService } from "./runtime-lifecycle-read-service.js";
import { projectDurableRouteResponse } from "./durable-public-projection.js";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const dashboardRouteMethods = [
  "costSummary",
  "costUsageAvailability",
  "getDashboardState",
  "getMemoryQmdStats",
  "getObserveRunTrace",
  "getObserveRunTraceExport",
  "getOpsQualityExport",
  "getOpsQualitySnapshot",
  "getSystemVitals",
  "isFeatureEnabled",
  "listBackups",
  "listMemoryFiles",
  "listOperators",
  "listRealtimeEvents",
  "listSessions",
] as const;

export type DashboardRouteMethod = (typeof dashboardRouteMethods)[number];
export type DashboardRoutePort = RoutePort<DashboardRouteMethod>;
export type DashboardRouteService = RouteService<DashboardRouteMethod>;

export interface DashboardRoutePortDependencies {
  backupRetentionService: BackupRetentionService;
  durableOperatorService: Pick<DurableOperatorService, "getRun" | "listRunCheckpoints" | "listRunTimeline">;
  memoryLifecycleService: MemoryLifecycleService;
  operatorSummaryCache: OperatorSummaryCache;
  promptPackService: Pick<PromptPackService, "listPromptPacks" | "listSecurityEvalPacks" | "listSecurityQualityGates">;
  realtimeEventService: RealtimeEventService;
  rootDir: string;
  runtimeLifecycleReadService: Pick<RuntimeLifecycleReadService, "getRuntimeLifecycle">;
  storage: Storage;
  isFeatureEnabled: (flag: string) => boolean;
  readDesignQualityEvidence?: typeof readDesignQualityEvidence;
}

export type RunTraceAvailabilityState = "available" | "not_available" | "unknown";

export interface ObserveRunTraceArtifact {
  artifactId: string;
  sessionId: string;
  workspaceId?: string;
  projectId?: string;
  turnId: string;
  title: string;
  kind: string;
  language?: string;
  sourceSurface: string;
  version: number;
  supersedesArtifactId?: string;
  providerId?: string;
  model?: string;
  sourceBlockIndex?: number;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObserveRunTraceError {
  source: "durable_run" | "checkpoint" | "timeline" | "turn" | "tool";
  id: string;
  message: string;
  createdAt?: string;
}

export interface ObserveRunTraceProviderUsageItem {
  turnId: string;
  sessionId: string;
  providerId?: string;
  model?: string;
  usage?: ChatStreamUsageRecord;
  latencyMs?: number;
  providerCallCount?: number;
  costUsd?: number;
  costSource?: string;
}

export interface ObserveRunTraceResponse {
  version: "observe.run_trace.v1";
  generatedAt: string;
  runId: string;
  run: DurableRunRecord;
  durable: {
    checkpoints: {
      state: RunTraceAvailabilityState;
      items: DurableCheckpointRecord[];
    };
    timeline: {
      state: RunTraceAvailabilityState;
      items: DurableRunTimelineEvent[];
    };
  };
  lifecycle: {
    state: RunTraceAvailabilityState;
    response?: RuntimeLifecycleResponse;
    error?: string;
  };
  session: {
    state: RunTraceAvailabilityState;
    item?: RuntimeLifecycleResponse["session"];
    summary?: RuntimeLifecycleResponse["sessionSummary"];
  };
  thread: {
    state: RunTraceAvailabilityState;
    turns: RuntimeLifecycleTurnSummary[];
  };
  approvals: {
    state: RunTraceAvailabilityState;
    items: ApprovalRequest[];
    missingIds: string[];
  };
  toolCalls: {
    state: RunTraceAvailabilityState;
    items: Array<RuntimeLifecycleToolRunSummary | ChatToolRunRecord>;
  };
  memoryContext: {
    state: RunTraceAvailabilityState;
    items: MemoryContextPack[];
    error?: string;
  };
  providerUsage: {
    state: RunTraceAvailabilityState;
    items: ObserveRunTraceProviderUsageItem[];
    totals: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      costUsd?: number;
    };
  };
  artifacts: {
    state: RunTraceAvailabilityState;
    items: ObserveRunTraceArtifact[];
    error?: string;
  };
  errors: {
    state: RunTraceAvailabilityState;
    items: ObserveRunTraceError[];
  };
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    audit: {
      state: "available";
      note: string;
    };
    replay: {
      state: RunTraceAvailabilityState;
      checkpointIds: string[];
      note: string;
    };
    resume: {
      state: RunTraceAvailabilityState;
      eligible: boolean;
      endpoint?: string;
      note: string;
    };
  };
}

export interface ObserveRunTraceExportResponse {
  version: "observe.run_trace_export.v1";
  generatedAt: string;
  runId: string;
  format: "json";
  contentType: "application/json";
  filename: string;
  sourceEndpoint: string;
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    note: string;
  };
  trace: ObserveRunTraceResponse;
  content: string;
}

export interface OpsQualitySnapshotInput {
  packLimit: number;
  evalLimit: number;
}

export interface OpsQualityExportInput extends OpsQualitySnapshotInput {
  format: "otel_json";
}

export function createDashboardRoutePort(deps: DashboardRoutePortDependencies): DashboardRoutePort {
  return {
    costSummary: (scope, from, to) => deps.storage.costLedger.summary(scope, from, to),
    costUsageAvailability: (from, to) => deps.storage.costLedger.usageAvailability(from, to),
    getDashboardState: () => {
      const sessions = deps.storage.sessions.list(200);
      const now = new Date();
      const pendingApprovals = deps.storage.approvals
        .list("pending", 10000)
        .filter((approval) => !approval.expiresAt || Date.parse(approval.expiresAt) > now.getTime()).length;
      const activeSubagents = deps.storage.taskSubagents.activeCount();
      const taskStatusCounts = deps.storage.tasks.statusCounts();
      const recentEvents = deps.storage.realtimeEvents.list(100).map((event) => ({
        ...event,
        payload: redactStructuredSecrets(event.payload).value,
      }));
      const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const to = now.toISOString();
      const byDay = deps.storage.costLedger.summary("day", from, to);
      const dailyCostUsd = byDay.reduce((sum, row) => sum + row.costUsd, 0);

      return {
        timestamp: now.toISOString(),
        sessions,
        pendingApprovals,
        activeSubagents,
        taskStatusCounts,
        recentEvents,
        dailyCostUsd,
      };
    },
    getMemoryQmdStats: (from, to) => deps.memoryLifecycleService.getContextStats(from, to),
    getObserveRunTrace: (runId) => buildObserveRunTrace(deps, String(runId)),
    getObserveRunTraceExport: (runId) => buildObserveRunTraceExport(deps, String(runId)),
    getOpsQualityExport: (input) => buildOpsQualityExport(deps, input as OpsQualityExportInput),
    getOpsQualitySnapshot: (input) => buildOpsQualitySnapshot(deps, input),
    getSystemVitals: () => {
      const total = os.totalmem();
      const free = os.freemem();
      const processMem = process.memoryUsage();
      return {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        uptimeSeconds: os.uptime(),
        loadAverage: os.loadavg(),
        cpuCount: os.cpus().length,
        memoryTotalBytes: total,
        memoryFreeBytes: free,
        memoryUsedBytes: total - free,
        processRssBytes: processMem.rss,
        processHeapUsedBytes: processMem.heapUsed,
      };
    },
    isFeatureEnabled: (flag) => deps.isFeatureEnabled(flag),
    listBackups: (limit) => deps.backupRetentionService.listBackups(limit),
    listMemoryFiles: (relativeDir) => deps.memoryLifecycleService.listMemoryFiles(relativeDir),
    listOperators: () => {
      const activeSinceIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      return deps.operatorSummaryCache.get(() => deps.storage.sessions.listOperatorSummaries(activeSinceIso));
    },
    listRealtimeEvents: (limit, cursor) => deps.realtimeEventService.listRealtimeEvents(limit, cursor),
    listSessions: (limit, cursor) => deps.storage.sessions.list(limit, cursor),
  };
}

export function createDashboardRouteService(port: DashboardRoutePort): DashboardRouteService {
  return createRouteService(port, dashboardRouteMethods);
}

function buildOpsQualitySnapshot(
  deps: DashboardRoutePortDependencies,
  input: OpsQualitySnapshotInput,
): OpsQualitySnapshotResponse {
  const generatedAt = new Date().toISOString();
  const promptPacksResult = safeRead(() => deps.promptPackService.listPromptPacks(input.packLimit));
  const evalProofResult = safeRead(() => deps.storage.llmEvalProofRuns.list(input.evalLimit));
  const securityEvalPacksResult = safeRead(() => deps.promptPackService.listSecurityEvalPacks());
  const securityQualityGatesResult = safeRead(() => deps.promptPackService.listSecurityQualityGates());
  const designQualityResult = safeRead(() =>
    (deps.readDesignQualityEvidence ?? readDesignQualityEvidence)(deps.rootDir),
  );
  const promptPacks = promptPacksResult.value ?? [];
  const evalProofRuns = evalProofResult.value ?? [];
  const securityEvalPacks = securityEvalPacksResult.value?.items ?? [];
  const securityQualityGates = securityQualityGatesResult.value?.items ?? [];
  const securityExecution = buildSecurityExecutionItems(securityEvalPacks, securityQualityGates);
  const designQuality = designQualityResult.value ?? buildUnknownDesignQualitySnapshot(designQualityResult.error);
  const warnings = [
    ...(securityEvalPacksResult.value?.warnings ?? []),
    ...(securityQualityGatesResult.value?.warnings ?? []),
    ...designQuality.warnings,
  ];

  return {
    version: "ops.quality_snapshot.v1",
    generatedAt,
    sourceEndpoint: "/api/v1/ops/quality",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      note: "Ops quality snapshot composes stored prompt-pack, eval-proof, and security-gate evidence. It does not run providers, score tests, approve releases, or mutate runtime state.",
    },
    metricScope: {
      scope: "bounded_read",
      promptPackLimit: input.packLimit,
      evalRunLimit: input.evalLimit,
      note: "Counts and totals summarize the rows returned by this bounded read, not guaranteed all-time storage cardinality.",
    },
    metrics: {
      promptPackCount: promptPacks.length,
      promptPackTestCount: promptPacks.reduce((sum, pack) => sum + (pack.testCount ?? 0), 0),
      redTeamPackCount: securityEvalPacks.length,
      redTeamTestCount: securityEvalPacks.reduce((sum, pack) => sum + pack.testCount, 0),
      evalRunCount: evalProofRuns.length,
      paretoModelCount: evalProofRuns.reduce(
        (sum, run) => sum + run.results.filter((result) => result.paretoOptimal).length,
        0,
      ),
      securityGateCount: securityQualityGates.length,
      passingSecurityGateCount: securityQualityGates.filter((gate) => gate.status === "passed").length,
      securityExecutionReadyCount: securityExecution.filter((item) => item.state === "passing").length,
      securityExecutionBlockedCount: securityExecution.filter((item) => item.blockers.length > 0).length,
      designQualityCheckCount: designQuality.summary.totalChecks,
      designQualityBlockingCount: designQuality.summary.blockingCount,
    },
    promptPacks: {
      state: promptPacksResult.error ? "unknown" : promptPacks.length > 0 ? "available" : "not_available",
      items: promptPacks,
      ...(promptPacksResult.error ? { error: promptPacksResult.error.message } : {}),
    },
    evalProof: {
      state: evalProofResult.error ? "unknown" : evalProofRuns.length > 0 ? "available" : "not_available",
      items: evalProofRuns,
      ...(evalProofResult.error ? { error: evalProofResult.error.message } : {}),
    },
    securityEvalPacks: {
      state: securityEvalPacksResult.error ? "unknown" : securityEvalPacks.length > 0 ? "available" : "not_available",
      items: securityEvalPacks,
      warnings: securityEvalPacksResult.value?.warnings ?? [],
      ...(securityEvalPacksResult.error ? { error: securityEvalPacksResult.error.message } : {}),
    },
    securityQualityGates: {
      state: securityQualityGatesResult.error
        ? "unknown"
        : securityQualityGates.length > 0
          ? "available"
          : "not_available",
      items: securityQualityGates,
      warnings: securityQualityGatesResult.value?.warnings ?? [],
      ...(securityQualityGatesResult.error ? { error: securityQualityGatesResult.error.message } : {}),
    },
    securityExecution: {
      state:
        securityEvalPacksResult.error || securityQualityGatesResult.error
          ? "unknown"
          : securityExecution.length > 0
            ? "available"
            : "not_available",
      items: securityExecution,
      warnings: [
        "Security execution depth is computed from stored defensive-security prompt-pack reports; it does not run providers or score tests.",
      ],
      ...(securityEvalPacksResult.error || securityQualityGatesResult.error
        ? {
            error: [securityEvalPacksResult.error?.message, securityQualityGatesResult.error?.message]
              .filter(Boolean)
              .join("; "),
          }
        : {}),
    },
    designQuality,
    warnings,
    nextChecks: [
      {
        label: "Prompt gates",
        command: "pnpm prompt:gates",
        reason: "Use targeted prompt-pack gates for behavior changes that affect Chat, Cowork, or Code.",
      },
      {
        label: "Runtime truth",
        command: "pnpm verify:runtime:truth",
        reason: "Use runtime truth for gateway, durable execution, and runtime API changes.",
      },
      {
        label: "Surface regression",
        command: "pnpm verify:surface:regression",
        reason: "Use surface regression for visible operator route changes.",
      },
      {
        label: "Design quality",
        command: "pnpm verify:design:quality",
        reason: "Use the read-only design-quality checker for skill, routing, anti-slop, and proof-lane evidence.",
      },
      {
        label: "Visual regression",
        command: "pnpm verify:visual:regression",
        reason: "Use visual regression for visible layout or baseline-sensitive Mission Control changes.",
      },
    ],
  };
}

function buildOpsQualityExport(
  deps: DashboardRoutePortDependencies,
  input: OpsQualityExportInput,
): OpsQualityOtelExportResponse {
  const snapshot = buildOpsQualitySnapshot(deps, input);
  const spans = buildOpsQualityOtelSpans(snapshot);
  const payload = {
    version: "ops.quality_export.otel_json.v1" as const,
    generatedAt: snapshot.generatedAt,
    format: input.format,
    resource: {
      serviceName: "goatcitadel" as const,
      source: "ops_quality" as const,
    },
    metricScope: snapshot.metricScope,
    spans,
  };
  const content = JSON.stringify(payload, null, 2);
  return {
    version: "ops.quality_export.otel_json.v1",
    generatedAt: snapshot.generatedAt,
    format: "otel_json",
    contentType: "application/json",
    filename: "goatcitadel-ops-quality-otel.json",
    sourceEndpoint: "/api/v1/ops/quality",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      note: "OTel JSON is an export transport for stored Ops quality evidence. Gateway diagnostics, durable logs, Ops Quality, and evidence records remain the source of truth.",
    },
    resource: payload.resource,
    metricScope: snapshot.metricScope,
    spans,
    content,
  };
}

function buildOpsQualityOtelSpans(snapshot: OpsQualitySnapshotResponse): OpsQualityOtelSpan[] {
  const rootTraceId = stableTraceId(["ops_quality", snapshot.generatedAt]);
  const spans: OpsQualityOtelSpan[] = [
    buildOpsQualitySpan(rootTraceId, "ops.quality.snapshot", snapshot.generatedAt, {
      "goatcitadel.source_endpoint": snapshot.sourceEndpoint,
      "goatcitadel.prompt_pack_count": snapshot.metrics.promptPackCount,
      "goatcitadel.eval_run_count": snapshot.metrics.evalRunCount,
      "goatcitadel.security_gate_count": snapshot.metrics.securityGateCount,
      "goatcitadel.design_quality_check_count": snapshot.metrics.designQualityCheckCount,
      "goatcitadel.read_only": true,
    }),
  ];
  for (const pack of snapshot.promptPacks.items) {
    spans.push(
      buildOpsQualitySpan(rootTraceId, "ops.quality.prompt_pack", snapshot.generatedAt, {
        "goatcitadel.pack_id": pack.packId,
        "goatcitadel.pack_name": pack.name,
        "goatcitadel.test_count": pack.testCount ?? 0,
      }),
    );
  }
  for (const run of snapshot.evalProof.items) {
    spans.push(
      buildOpsQualitySpan(rootTraceId, "ops.quality.eval_proof", snapshot.generatedAt, {
        "goatcitadel.eval_run_id": run.runId,
        "goatcitadel.result_count": run.results.length,
        "goatcitadel.pareto_count": run.results.filter((result) => result.paretoOptimal).length,
      }),
    );
  }
  for (const gate of snapshot.securityQualityGates.items) {
    spans.push(
      buildOpsQualitySpan(rootTraceId, "ops.quality.security_gate", snapshot.generatedAt, {
        "goatcitadel.gate_id": gate.gateId,
        "goatcitadel.pack_key": gate.packKey,
        "goatcitadel.status": gate.status,
        "goatcitadel.release_gate": gate.releaseGate,
      }),
    );
  }
  for (const check of snapshot.designQuality.checks) {
    spans.push(
      buildOpsQualitySpan(rootTraceId, "ops.quality.design_check", snapshot.generatedAt, {
        "goatcitadel.check_id": check.id,
        "goatcitadel.severity": check.severity,
        "goatcitadel.status": check.status,
        "goatcitadel.owner": check.owner,
      }),
    );
  }
  return spans;
}

function buildOpsQualitySpan(
  traceId: string,
  name: string,
  generatedAt: string,
  attributes: OpsQualityOtelSpan["attributes"],
): OpsQualityOtelSpan {
  return {
    traceId,
    spanId: stableSpanId([traceId, name, JSON.stringify(attributes)]),
    name,
    kind: "internal",
    startTimeUnixNano: isoToUnixNano(generatedAt),
    endTimeUnixNano: isoToUnixNano(generatedAt),
    attributes,
  };
}

function stableTraceId(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

function stableSpanId(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

function isoToUnixNano(value: string): string | undefined {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return `${BigInt(parsed) * 1_000_000n}`;
}

function buildUnknownDesignQualitySnapshot(error: Error | undefined): OpsDesignQualitySnapshot {
  return {
    state: "unknown",
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      source: "repo_files",
      callsProviders: false,
      mutationPerformed: false,
      note: "Design quality evidence could not be read; no providers, browsers, source writes, or baseline updates were attempted.",
    },
    summary: {
      totalChecks: 1,
      passingCount: 0,
      advisoryCount: 0,
      blockingCount: 0,
      unknownCount: 1,
      p0Count: 0,
      p1Count: 1,
      p2Count: 0,
      p3Count: 0,
    },
    checks: [
      {
        id: "design-quality.snapshot",
        label: "Design quality snapshot",
        severity: "P1",
        status: "unknown",
        owner: "skills/design-quality",
        evidence: "packages/skills/src/design-quality.ts",
        nextAction: "Inspect the design-quality checker error and rerun pnpm verify:design:quality.",
      },
    ],
    warnings: [],
    ...(error ? { error: error.message } : {}),
  };
}

function buildSecurityExecutionItems(
  packs: PromptPackSecurityEvalPackRecord[],
  gates: PromptPackSecurityQualityGateRecord[],
): OpsQualitySecurityExecutionItem[] {
  const gatesByPackKey = new Map(gates.map((gate) => [gate.packKey, gate]));
  return packs.map((pack) => {
    const gate = gatesByPackKey.get(pack.packKey);
    const evidence = gate?.evidence;
    const testCount = evidence?.testCount ?? pack.testCount;
    const completedRuns = evidence?.completedRuns ?? 0;
    const scoredRuns = Math.max(0, completedRuns - (evidence?.needsScoreCount ?? completedRuns));
    const runCoverage = testCount > 0 ? completedRuns / testCount : 0;
    const scoredCoverage = testCount > 0 ? scoredRuns / testCount : 0;
    const state = mapSecurityExecutionState(pack, gate);
    return {
      packKey: pack.packKey,
      title: pack.title,
      state,
      importedPackId: pack.importedPackId,
      testCount,
      completedRuns,
      failedRuns: evidence?.failedRuns ?? 0,
      needsScoreCount: evidence?.needsScoreCount ?? testCount,
      passCount: evidence?.passCount ?? 0,
      failCount: evidence?.failCount ?? 0,
      reviewCount: evidence?.reviewCount ?? 0,
      runCoverage,
      scoredCoverage,
      effectivePassRate: evidence?.effectivePassRate ?? 0,
      passThreshold: evidence?.passThreshold ?? 75,
      modeCounts: pack.modeCounts,
      toolTierCounts: pack.toolTierCounts,
      capabilityTargets: pack.capabilityTargets,
      likelyFailureClasses: pack.likelyFailureClasses,
      failingCodes: evidence?.failingCodes ?? [],
      blockers: gate?.blockers?.length ? gate.blockers : (pack.blockers ?? []),
      nextActions: gate?.nextActions ?? [],
      posture: {
        readOnly: true,
        sideEffectPosture: "audit_only",
        source: "stored_prompt_pack_report",
        callsProviders: false,
        mutationPerformed: false,
        note: "Security execution depth summarizes stored defensive-security prompt-pack run and scoring evidence; it does not run providers, score tests, approve releases, or certify security.",
      },
    };
  });
}

function mapSecurityExecutionState(
  pack: PromptPackSecurityEvalPackRecord,
  gate?: PromptPackSecurityQualityGateRecord,
): OpsQualitySecurityExecutionItem["state"] {
  if (pack.status === "unavailable") {
    return "definition_missing";
  }
  if (!gate || gate.status === "not_imported") {
    return "definition_only";
  }
  if (gate.status === "not_run") {
    return "run_required";
  }
  if (gate.status === "needs_score") {
    return "scoring_required";
  }
  if (gate.status === "review") {
    return "review_required";
  }
  if (gate.status === "failed") {
    return "failing";
  }
  if (gate.status === "passed") {
    return "passing";
  }
  return "unknown";
}

async function buildObserveRunTraceExport(
  deps: DashboardRoutePortDependencies,
  runId: string,
): Promise<ObserveRunTraceExportResponse> {
  const trace = await buildObserveRunTrace(deps, runId);
  const generatedAt = new Date().toISOString();
  const sourceEndpoint = `/api/v1/observe/runs/${encodeURIComponent(runId)}/trace`;
  const exportPayload = {
    version: "observe.run_trace_export.v1" as const,
    generatedAt,
    runId,
    format: "json" as const,
    contentType: "application/json" as const,
    sourceEndpoint,
    posture: {
      readOnly: true as const,
      sideEffectPosture: "audit_only" as const,
      note: "Trace export is a read-only serialization of the observe projection and does not replay, resume, approve, or execute work.",
    },
    trace,
  };
  return {
    ...exportPayload,
    filename: `goatcitadel-run-trace-${safeRunTraceFilenameSegment(runId)}.json`,
    content: JSON.stringify(exportPayload, null, 2),
  };
}

async function buildObserveRunTrace(
  deps: DashboardRoutePortDependencies,
  runId: string,
): Promise<ObserveRunTraceResponse> {
  const run = deps.durableOperatorService.getRun(runId);
  const checkpointResult = safeRead(() => deps.durableOperatorService.listRunCheckpoints(runId, 500));
  const timelineResult = safeRead(() => deps.durableOperatorService.listRunTimeline(runId, 500));
  const lifecycleResult = await safeReadAsync(() => deps.runtimeLifecycleReadService.getRuntimeLifecycle({ runId }));
  const lifecycle = lifecycleResult.value;
  const checkpoints = checkpointResult.value ?? [];
  const timeline = timelineResult.value ?? [];
  const approvalIds = lifecycle ? dedupe(lifecycle.linked.approvalIds) : collectStringIds(run, "approvalId");
  const approvals = loadApprovals(deps.storage, approvalIds);
  const turnIds = lifecycle ? dedupe(lifecycle.linked.turnIds) : collectStringIds(run, "turnId");
  const artifactsResult = loadArtifacts(deps.storage, turnIds);
  const memoryResult = safeRead(() => deps.storage.memoryContexts.listByRun(runId));
  const providerUsage = buildProviderUsage(lifecycle);
  const errors = collectRunTraceErrors(run, checkpoints, timeline, lifecycle);
  const replayCheckpointIds = checkpoints
    .filter((checkpoint) => checkpoint.checkpointKind === "manual_replay_requested")
    .map((checkpoint) => checkpoint.checkpointId);
  const resumeEligible = run.status === "paused";

  const trace: ObserveRunTraceResponse = {
    version: "observe.run_trace.v1",
    generatedAt: new Date().toISOString(),
    runId,
    run,
    durable: {
      checkpoints: {
        state: checkpointResult.error ? "unknown" : checkpoints.length > 0 ? "available" : "not_available",
        items: checkpoints,
      },
      timeline: {
        state: timelineResult.error ? "unknown" : timeline.length > 0 ? "available" : "not_available",
        items: timeline,
      },
    },
    lifecycle: {
      state: lifecycleResult.error ? "unknown" : lifecycle ? "available" : "not_available",
      ...(lifecycle ? { response: lifecycle } : {}),
      ...(lifecycleResult.error ? { error: lifecycleResult.error.message } : {}),
    },
    session: {
      state: lifecycleResult.error ? "unknown" : lifecycle?.session ? "available" : "not_available",
      ...(lifecycle?.session ? { item: lifecycle.session } : {}),
      ...(lifecycle?.sessionSummary ? { summary: lifecycle.sessionSummary } : {}),
    },
    thread: {
      state: lifecycleResult.error ? "unknown" : (lifecycle?.turns.length ?? 0) > 0 ? "available" : "not_available",
      turns: lifecycle?.turns ?? [],
    },
    approvals: {
      state: approvalIds.length === 0 ? "not_available" : approvals.items.length > 0 ? "available" : "unknown",
      items: approvals.items,
      missingIds: approvals.missingIds,
    },
    toolCalls: {
      state: lifecycleResult.error ? "unknown" : (lifecycle?.toolRuns.length ?? 0) > 0 ? "available" : "not_available",
      items: lifecycle?.toolRuns ?? [],
    },
    memoryContext: {
      state: memoryResult.error ? "unknown" : (memoryResult.value?.length ?? 0) > 0 ? "available" : "not_available",
      items: memoryResult.value ?? [],
      ...(memoryResult.error ? { error: memoryResult.error.message } : {}),
    },
    providerUsage,
    artifacts: {
      state: artifactsResult.error ? "unknown" : artifactsResult.items.length > 0 ? "available" : "not_available",
      items: artifactsResult.items,
      ...(artifactsResult.error ? { error: artifactsResult.error.message } : {}),
    },
    errors: {
      state: errors.length > 0 ? "available" : "not_available",
      items: errors,
    },
    posture: {
      readOnly: true,
      sideEffectPosture: "audit_only",
      audit: {
        state: "available",
        note: "GET /api/v1/observe/runs/:runId/trace is a read-only projection and does not replay, resume, approve, or execute work.",
      },
      replay: {
        state: replayCheckpointIds.length > 0 ? "available" : "not_available",
        checkpointIds: replayCheckpointIds,
        note:
          replayCheckpointIds.length > 0
            ? "Replay evidence is present in durable checkpoints."
            : "No replay checkpoint evidence is attached to this run.",
      },
      resume: {
        state: resumeEligible ? "available" : "not_available",
        eligible: resumeEligible,
        ...(resumeEligible ? { endpoint: `/api/v1/durable/runs/${encodeURIComponent(runId)}/resume` } : {}),
        note: resumeEligible
          ? "Resume is available through the durable control endpoint; this trace request did not resume the run."
          : `Run status ${run.status} is not resumable by the durable resume control.`,
      },
    },
  };
  return projectDurableRouteResponse(trace);
}

function safeRunTraceFilenameSegment(value: string): string {
  const safe = value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe || "unknown";
}

function loadApprovals(
  storage: Storage,
  approvalIds: string[],
): {
  items: ApprovalRequest[];
  missingIds: string[];
} {
  const items: ApprovalRequest[] = [];
  const missingIds: string[] = [];
  for (const approvalId of approvalIds) {
    const result = safeRead(() => storage.approvals.get(approvalId));
    if (result.value) {
      items.push(result.value);
    } else {
      missingIds.push(approvalId);
    }
  }
  return { items, missingIds };
}

function loadArtifacts(
  storage: Storage,
  turnIds: string[],
): {
  items: ObserveRunTraceArtifact[];
  error?: Error;
} {
  if (turnIds.length === 0) {
    return { items: [] };
  }
  const result = safeRead(() => storage.chatGeneratedArtifacts.listByTurnIds(turnIds));
  if (result.error) {
    return { items: [], error: result.error };
  }
  const items = [...(result.value?.values() ?? [])].flat().map(toArtifactTrace);
  return { items };
}

function toArtifactTrace(artifact: ChatGeneratedArtifactRecord): ObserveRunTraceArtifact {
  return {
    artifactId: artifact.artifactId,
    sessionId: artifact.sessionId,
    workspaceId: artifact.workspaceId,
    projectId: artifact.projectId,
    turnId: artifact.turnId,
    title: artifact.title,
    kind: artifact.kind,
    language: artifact.language,
    sourceSurface: artifact.sourceSurface,
    version: artifact.version,
    supersedesArtifactId: artifact.supersedesArtifactId,
    providerId: artifact.providerId,
    model: artifact.model,
    sourceBlockIndex: artifact.sourceBlockIndex,
    contentHash: artifact.contentHash,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function buildProviderUsage(lifecycle: RuntimeLifecycleResponse | undefined): ObserveRunTraceResponse["providerUsage"] {
  if (!lifecycle) {
    return {
      state: "unknown",
      items: [],
      totals: {},
    };
  }
  const items = lifecycle.turns.map((turn) => ({
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    providerId: turn.routing?.effectiveProviderId ?? turn.routing?.primaryProviderId,
    model: turn.routing?.effectiveModel ?? turn.model ?? turn.routing?.primaryModel,
    usage: turn.completion?.usage,
    latencyMs: turn.completion?.latencyMs,
    providerCallCount: turn.completion?.providerCallCount,
    costUsd: turn.completion?.usage?.costUsd,
    costSource: turn.completion?.usage?.costSource,
  }));
  const usageItems = items.filter((item) => item.usage || item.latencyMs !== undefined || item.providerCallCount);
  const totals = usageItems.reduce<ObserveRunTraceResponse["providerUsage"]["totals"]>(
    (acc, item) => ({
      inputTokens: addOptional(acc.inputTokens, item.usage?.inputTokens),
      outputTokens: addOptional(acc.outputTokens, item.usage?.outputTokens),
      cachedInputTokens: addOptional(acc.cachedInputTokens, item.usage?.cachedInputTokens),
      costUsd: addOptional(acc.costUsd, item.usage?.costUsd),
    }),
    {},
  );
  return {
    state: usageItems.length > 0 ? "available" : lifecycle.turns.length > 0 ? "unknown" : "not_available",
    items: usageItems,
    totals,
  };
}

function collectRunTraceErrors(
  run: DurableRunRecord,
  checkpoints: DurableCheckpointRecord[],
  timeline: DurableRunTimelineEvent[],
  lifecycle: RuntimeLifecycleResponse | undefined,
): ObserveRunTraceError[] {
  const errors: ObserveRunTraceError[] = [];
  if (run.lastError) {
    errors.push({ source: "durable_run", id: run.runId, message: run.lastError, createdAt: run.updatedAt });
  }
  for (const checkpoint of checkpoints) {
    const error = readStringField(checkpoint.state, "error");
    if (error) {
      errors.push({
        source: "checkpoint",
        id: checkpoint.checkpointId,
        message: error,
        createdAt: checkpoint.createdAt,
      });
    }
  }
  for (const event of timeline) {
    const error = readStringField(event.payload, "error");
    if (error) {
      errors.push({ source: "timeline", id: event.eventId, message: error, createdAt: event.createdAt });
    }
  }
  for (const turn of lifecycle?.turns ?? []) {
    if (turn.failure?.message) {
      errors.push({ source: "turn", id: turn.turnId, message: turn.failure.message, createdAt: turn.finishedAt });
    }
  }
  for (const toolRun of lifecycle?.toolRuns ?? []) {
    if ("error" in toolRun && typeof toolRun.error === "string") {
      errors.push({ source: "tool", id: toolRun.toolRunId, message: toolRun.error, createdAt: toolRun.finishedAt });
    }
  }
  return errors;
}

function collectStringIds(run: DurableRunRecord, key: string): string[] {
  return dedupe([findStringValue(run.payload, key), findStringValue(run.metadata, key)].filter(isPresentString));
}

function findStringValue(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === "object") {
        stack.push(child);
      }
    }
  }
  return undefined;
}

function readStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function addOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (typeof right !== "number") {
    return left;
  }
  return (left ?? 0) + right;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function isPresentString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeRead<T>(read: () => T): { value?: T; error?: Error } {
  try {
    return { value: read() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

async function safeReadAsync<T>(read: () => Promise<T>): Promise<{ value?: T; error?: Error }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}
