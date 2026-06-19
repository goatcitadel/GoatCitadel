import { useState } from "react";
import { ClipboardCopy, FileText, GitBranch, RefreshCw } from "lucide-react";
import {
  exportObserveRunTrace,
  fetchObserveRunTrace,
  fetchOrchestrationRunTrace,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, ErrorState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";
import { formatDateTime, nativeLoad, nativeLoadIssues, truncateText, useAsyncLoad } from "../shared/native-helpers";
import { LibraryCodeBlock, LibraryLoadWarnings, LibraryMetricGrid } from "../shared/library-primitives";

type NativeListItem = { title: string; meta?: string; body?: string };
type RunTracePayload = Record<string, unknown>;

interface RunDetailModel {
  runId: string;
  status: string;
  mode: string;
  provider: string;
  model: string;
  requestSummary?: string;
  requestedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  turnId?: string;
  sourceSurface?: string;
  toolAutonomy: string;
  memoryWarning?: string;
  artifacts: NativeListItem[];
  timeline: NativeListItem[];
  memoryContext: NativeListItem[];
  tools: NativeListItem[];
  approvals: NativeListItem[];
  sideEffects: NativeListItem[];
  errors: NativeListItem[];
  evidenceStates: NativeListItem[];
  orchestrationDecisions: NativeListItem[];
  orchestrationPrompts: NativeListItem[];
  orchestrationModels: NativeListItem[];
  orchestrationPolicies: NativeListItem[];
  orchestrationLineage: NativeListItem[];
  orchestrationWaits: NativeListItem[];
  orchestrationFailures: NativeListItem[];
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  costSource?: string;
  latencyMs?: number;
  replayAvailable: boolean;
  resumeAvailable: boolean;
  replayReason: string;
  recoveryState?: string;
  raw: unknown;
}

export function RunDetailRoutePage({ route, activeWorkspaceId, activeWorkspaceName, navigate }: NativeRoutePagesProps) {
  const runId = route.runId?.trim();
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    if (!runId) {
      return {
        issues: [{ label: "Run trace", message: "No run id was provided in the route." }],
        trace: buildEmptyRunTrace("unknown"),
      };
    }
    const trace = await nativeLoad(
      "Run trace",
      fetchObserveRunTrace(runId).then((value) => value as unknown as RunTracePayload),
      buildEmptyRunTrace(runId),
    );
    const orchestrationTrace = await fetchOrchestrationRunTrace(runId, { workspaceId: activeWorkspaceId }).catch(
      () => null,
    );
    return {
      issues: nativeLoadIssues([trace]),
      trace: trace.data,
      orchestrationTrace,
    };
  }, [activeWorkspaceId, runId]);
  const detail = buildRunDetailModel(
    data?.trace ?? buildEmptyRunTrace(runId ?? "unknown"),
    runId ?? "unknown",
    data?.orchestrationTrace ?? null,
  );

  const copyTraceExport = async () => {
    if (!runId) {
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportError("Clipboard export is not available in this environment.");
      setExportNotice(null);
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const exported = await exportObserveRunTrace(runId);
      await navigator.clipboard.writeText(exported.content);
      setExportNotice(`Copied trace export ${exported.filename}.`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  return (
    <NativePageFrame
      area="ops"
      kicker={routeKicker(route)}
      title={runId ? `Run ${runId}` : "Run detail"}
      description={`Operator-visible request, execution, evidence, and recovery posture for ${activeWorkspaceName}.`}
      loading={loading}
      error={error}
      metrics={[
        { label: "Status", value: detail.status },
        { label: "Mode", value: detail.mode },
        { label: "Provider", value: detail.provider },
        { label: "Artifacts", value: String(detail.artifacts.length) },
      ]}
      actions={
        <>
          <NativeButton variant="secondary" onClick={() => void copyTraceExport()} disabled={!runId || exporting}>
            <ClipboardCopy className="h-4 w-4" />
            {exporting ? "Exporting..." : "Copy trace export"}
          </NativeButton>
          <NativeButton variant="secondary" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </NativeButton>
        </>
      }
    >
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {exportNotice ? <NoticeBanner tone="success" message={exportNotice} /> : null}
      {exportError ? <ErrorState size="inline" description={exportError} /> : null}
      <NativeGrid className="mc-next-run-detail-grid">
        <NativeCard
          title="Request"
          subtitle="The requested work and runtime linkage when the trace projection includes it."
          stats={[
            { label: "Run", value: detail.runId },
            { label: "Session", value: detail.sessionId ?? "Unknown" },
          ]}
        >
          <RunSummary detail={detail} />
        </NativeCard>

        <NativeCard
          title="Timeline"
          subtitle="Recorded trace and durable events, shown as evidence rather than inference."
        >
          <NativeList
            density="compact"
            items={detail.timeline}
            emptyLabel="No timeline events are attached to this trace yet."
            maxHeight="min(46vh, 28rem)"
          />
        </NativeCard>

        <NativeCard
          title="Orchestration decisions"
          subtitle="Decision trace events from the durable orchestration layer when this run has them."
          stats={[
            { label: "Decisions", value: String(detail.orchestrationDecisions.length) },
            { label: "Policies", value: String(detail.orchestrationPolicies.length) },
          ]}
        >
          <NativeList
            density="compact"
            items={detail.orchestrationDecisions}
            emptyLabel="No orchestration decision trace is attached to this run."
            maxHeight="min(46vh, 28rem)"
          />
        </NativeCard>

        <NativeCard
          title="Orchestration evidence"
          subtitle="Prompt hashes, model choices, policy gates, lineage, waits, resumes, and failures."
          className={detail.orchestrationFailures.length > 0 ? "mc-next-run-detail-attention" : undefined}
        >
          <NativeList
            density="compact"
            items={[
              ...detail.orchestrationPrompts,
              ...detail.orchestrationModels,
              ...detail.orchestrationPolicies,
              ...detail.orchestrationLineage,
              ...detail.orchestrationWaits,
              ...detail.orchestrationFailures,
            ]}
            emptyLabel="No orchestration evidence fields are attached to this run."
            maxHeight="min(46vh, 28rem)"
          />
        </NativeCard>

        <NativeCard title="Memory and context" subtitle="Memory use is shown only when the trace records it.">
          {detail.memoryContext.length === 0 ? (
            <EmptyState size="compact" title="No memory/context evidence is attached to this trace." />
          ) : (
            <NativeList
              density="compact"
              items={detail.memoryContext}
              emptyLabel="No memory/context evidence is attached to this trace."
              maxHeight="min(42vh, 26rem)"
            />
          )}
          {detail.memoryWarning ? <ErrorState size="inline" tone="caution" description={detail.memoryWarning} /> : null}
        </NativeCard>

        <NativeCard title="Tools and approvals" subtitle="Tool calls and approval checkpoints recorded for this run.">
          <NativeList
            density="compact"
            items={detail.tools}
            emptyLabel="No tool calls are attached to this run."
            maxHeight="min(42vh, 26rem)"
          />
          <NativeList
            density="compact"
            items={detail.approvals}
            emptyLabel="No approval checkpoints are attached to this run."
          />
        </NativeCard>

        <NativeCard
          title="Evidence availability"
          subtitle="Missing or unavailable trace groups stay visible without relying on raw JSON."
        >
          <NativeList
            density="compact"
            items={detail.evidenceStates}
            emptyLabel="No missing, unknown, or error-qualified evidence groups need attention."
            maxHeight="min(34vh, 20rem)"
          />
        </NativeCard>

        <NativeCard title="Side effects" subtitle="External effects stay explicit, including audit-only effects.">
          <NativeList
            density="compact"
            items={detail.sideEffects}
            emptyLabel="No side effects are attached to this run."
            maxHeight="min(42vh, 26rem)"
          />
        </NativeCard>

        <NativeCard title="Artifacts" subtitle="Generated outputs linked to this run.">
          <NativeList
            density="compact"
            items={detail.artifacts}
            emptyLabel="No artifacts are attached to this run."
            maxHeight="min(42vh, 26rem)"
          />
        </NativeCard>

        <NativeCard
          title="Errors"
          subtitle="Failures and warnings are displayed without assuming a retry path."
          className={detail.errors.length > 0 ? "mc-next-run-detail-attention" : undefined}
        >
          <NativeList
            density="compact"
            items={detail.errors}
            emptyLabel="No errors are attached to this run."
            maxHeight="min(38vh, 24rem)"
          />
        </NativeCard>

        <NativeCard title="Cost and latency" subtitle="Provider usage and timing only when the trace reports it.">
          <LibraryMetricGrid
            items={[
              { label: "Input", value: formatCount(detail.inputTokens), meta: "tokens" },
              { label: "Output", value: formatCount(detail.outputTokens), meta: "tokens" },
              { label: "Cost", value: formatCost(detail.costUsd), meta: detail.costSource ?? "source unknown" },
              { label: "Latency", value: formatDuration(detail.latencyMs), meta: "overall" },
            ]}
          />
        </NativeCard>

        <NativeCard
          title="Replay and resume posture"
          subtitle="This panel reports available evidence; it does not start replay."
        >
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone={detail.replayAvailable ? "success" : "muted"}>
              {detail.replayAvailable ? "Replay evidence recorded" : "Replay not exposed"}
            </StatusChip>
            <StatusChip tone={detail.resumeAvailable ? "warning" : "muted"}>
              {detail.resumeAvailable ? "Resume available" : "No resume action exposed"}
            </StatusChip>
            {detail.recoveryState ? <StatusChip tone="warning">{detail.recoveryState}</StatusChip> : null}
          </div>
          <p className="mc-next-approvals-summary">{detail.replayReason}</p>
          {detail.sessionId && detail.turnId && isStableSurface(detail.sourceSurface) ? (
            <NativeButton
              variant="secondary"
              onClick={() =>
                navigate({
                  area: detail.sourceSurface as "chat" | "cowork" | "code",
                  sessionId: detail.sessionId,
                  turnId: detail.turnId,
                  runId: detail.runId,
                  theme: route.theme,
                })
              }
            >
              <GitBranch className="h-4 w-4" />
              Open source thread
            </NativeButton>
          ) : null}
        </NativeCard>
      </NativeGrid>

      <details className="mc-next-approvals-details">
        <summary>
          <FileText className="h-4 w-4" />
          Expert raw trace
        </summary>
        <LibraryCodeBlock label="Trace JSON">{JSON.stringify(detail.raw, null, 2)}</LibraryCodeBlock>
      </details>
    </NativePageFrame>
  );
}

function RunSummary({ detail }: { detail: RunDetailModel }) {
  return (
    <div className="mc-next-approvals-inspector">
      <div className="mc-next-approvals-chip-row">
        <StatusChip
          tone={detail.status === "failed" ? "critical" : detail.status === "completed" ? "success" : "warning"}
        >
          {detail.status}
        </StatusChip>
        <StatusChip tone="default">{detail.mode}</StatusChip>
        <StatusChip tone="muted">{detail.provider}</StatusChip>
        <StatusChip tone="muted">{detail.model}</StatusChip>
      </div>
      <p className="mc-next-approvals-summary">
        {detail.requestSummary ? truncateText(detail.requestSummary, 420) : "The trace did not include request text."}
      </p>
      <ul className="mc-next-approvals-compact-list">
        <li>Requested: {formatDateTime(detail.requestedAt)}</li>
        <li>Finished: {formatDateTime(detail.finishedAt)}</li>
        <li>Tool autonomy: {detail.toolAutonomy}</li>
      </ul>
    </div>
  );
}

function buildEmptyRunTrace(runId: string): RunTracePayload {
  return {
    runId,
    status: "unknown",
    request: {
      summary: "Trace projection is not available yet.",
    },
  };
}

function buildRunDetailModel(raw: unknown, fallbackRunId: string, orchestrationRaw: unknown = null): RunDetailModel {
  const record = asRecord(raw) ?? {};
  const orchestrationTrace = asRecord(orchestrationRaw);
  const run = readRecord(record, "run") ?? readRecord(record, "durableRun");
  const trace = readRecord(record, "trace");
  const request = readRecord(record, "request");
  const thread = readRecord(record, "thread");
  const lifecycle = readRecord(record, "lifecycle");
  const lifecycleResponse = lifecycle ? readRecord(lifecycle, "response") : undefined;
  const turns = [...readArray(thread?.turns), ...readArray(lifecycleResponse?.turns)];
  const firstTurn = asRecord(turns[0]);
  const providerUsage = readRecord(record, "providerUsage");
  const firstProviderUsage = asRecord(readArray(providerUsage?.items)[0]);
  const posture = readRecord(record, "posture");
  const replay = readRecord(record, "replay");
  const postureReplay = posture ? readRecord(posture, "replay") : undefined;
  const postureResume = posture ? readRecord(posture, "resume") : undefined;
  const cost = readRecord(record, "cost");
  const latency = readRecord(record, "latency");
  const provider = readRecord(record, "provider");
  const providerTotals = providerUsage ? readRecord(providerUsage, "totals") : undefined;

  const runId = readString(record.runId) ?? readString(run?.runId) ?? fallbackRunId;
  const requestedAt =
    readString(request?.requestedAt) ??
    readString(trace?.startedAt) ??
    readString(firstTurn?.startedAt) ??
    readString(run?.createdAt);
  const finishedAt = readString(trace?.finishedAt) ?? readString(firstTurn?.finishedAt) ?? readString(run?.finishedAt);
  const requestSurface = readString(request?.surface) ?? readString(firstTurn?.mode);

  return {
    runId,
    status:
      readString(record.status) ??
      readString(trace?.status) ??
      readString(firstTurn?.status) ??
      readString(run?.status) ??
      "unknown",
    mode:
      readString(record.mode) ??
      readString(request?.mode) ??
      readString(trace?.mode) ??
      readString(firstTurn?.mode) ??
      readString(run?.workflowKey) ??
      "unknown",
    provider:
      readString(provider?.effectiveProviderId) ??
      readString(provider?.providerId) ??
      readString(firstProviderUsage?.providerId) ??
      readString(readRecord(firstTurn, "routing")?.effectiveProviderId) ??
      "Unknown",
    model:
      readString(provider?.effectiveModel) ??
      readString(provider?.model) ??
      readString(firstProviderUsage?.model) ??
      readString(readRecord(firstTurn, "routing")?.effectiveModel) ??
      readString(firstTurn?.model) ??
      "Unknown",
    requestSummary: readString(request?.summary) ?? readString(request?.input) ?? readString(request?.prompt),
    requestedAt,
    finishedAt,
    sessionId: readString(request?.sessionId) ?? readString(trace?.sessionId) ?? readString(firstTurn?.sessionId),
    turnId: readString(request?.turnId) ?? readString(trace?.turnId) ?? readString(firstTurn?.turnId),
    sourceSurface: requestSurface,
    toolAutonomy: readString(trace?.effectiveToolAutonomy) ?? "not recorded",
    memoryWarning:
      readString(readRecord(record, "memory")?.skippedReason) ?? readString(readRecord(record, "memoryContext")?.error),
    artifacts: getArtifactItems(record),
    timeline: getTimelineItems(record, trace, firstTurn),
    memoryContext: getMemoryContextItems(record),
    tools: getToolItems(record, trace),
    approvals: getApprovalItems(record, trace),
    sideEffects: getSideEffectItems(record),
    errors: getErrorItems(record, trace, firstTurn, run),
    evidenceStates: getEvidenceStateItems(record),
    orchestrationDecisions: getOrchestrationDecisionItems(orchestrationTrace),
    orchestrationPrompts: getOrchestrationPromptItems(orchestrationTrace),
    orchestrationModels: getOrchestrationModelItems(orchestrationTrace),
    orchestrationPolicies: getOrchestrationPolicyItems(orchestrationTrace),
    orchestrationLineage: getOrchestrationLineageItems(orchestrationTrace),
    orchestrationWaits: getOrchestrationWaitItems(orchestrationTrace),
    orchestrationFailures: getOrchestrationFailureItems(orchestrationTrace),
    inputTokens: readNumber(cost?.inputTokens) ?? readNumber(providerTotals?.inputTokens),
    outputTokens: readNumber(cost?.outputTokens) ?? readNumber(providerTotals?.outputTokens),
    costUsd:
      readNumber(cost?.costUsd) ?? readNumber(providerTotals?.costUsd) ?? readNumber(firstProviderUsage?.costUsd),
    costSource: readString(cost?.costSource) ?? readString(firstProviderUsage?.costSource),
    latencyMs:
      readNumber(latency?.durationMs) ??
      readNumber(firstProviderUsage?.latencyMs) ??
      readNumber(readRecord(firstTurn, "completion")?.latencyMs),
    replayAvailable: readBoolean(replay?.replayAvailable) ?? readString(postureReplay?.state) === "available",
    resumeAvailable: readBoolean(replay?.resumeAvailable) ?? readBoolean(postureResume?.eligible) ?? false,
    replayReason:
      readString(replay?.reason) ??
      readString(postureResume?.note) ??
      readString(postureReplay?.note) ??
      readString(run?.recoverySummary) ??
      "No replay or resume claim is made without trace evidence.",
    recoveryState: readString(run?.recoveryState),
    raw: orchestrationTrace ? { observeTrace: raw, orchestrationTrace } : raw,
  };
}

function getArtifactItems(record: RunTracePayload): NativeListItem[] {
  const artifacts = Array.isArray(record.artifacts)
    ? record.artifacts
    : readArray(readRecord(record, "artifacts")?.items);
  return artifacts.map((item, index) => {
    const artifact = asRecord(item) ?? {};
    const artifactId = readString(artifact.artifactId);
    return {
      title: readString(artifact.title) ?? artifactId ?? `Artifact ${index + 1}`,
      meta: [readString(artifact.kind), readString(artifact.status)].filter(Boolean).join(" · "),
      body: artifactId ? `artifact ${artifactId}` : "Artifact id not recorded.",
    };
  });
}

function getTimelineItems(
  record: RunTracePayload,
  trace?: RunTracePayload,
  firstTurn?: RunTracePayload,
): NativeListItem[] {
  const timeline = Array.isArray(record.timeline)
    ? record.timeline
    : readArray(readRecord(readRecord(record, "durable"), "timeline")?.items);
  const durableEvents = timeline.map((item) => {
    const event = asRecord(item) ?? {};
    return {
      title: readString(event.eventType) ?? "timeline event",
      meta: formatDateTime(readString(event.createdAt)),
      body: [readString(event.stepKey), event.payload ? JSON.stringify(event.payload) : undefined]
        .filter(Boolean)
        .join(" · "),
    };
  });
  if (durableEvents.length > 0) {
    return durableEvents;
  }
  const synthetic: NativeListItem[] = [];
  const startedAt = readString(trace?.startedAt) ?? readString(firstTurn?.startedAt);
  const finishedAt = readString(trace?.finishedAt) ?? readString(firstTurn?.finishedAt);
  const turnId = readString(trace?.turnId) ?? readString(firstTurn?.turnId);
  if (startedAt) {
    synthetic.push({
      title: "turn_started",
      meta: formatDateTime(startedAt),
      body: turnId,
    });
  }
  if (finishedAt) {
    synthetic.push({
      title: "turn_finished",
      meta: formatDateTime(finishedAt),
      body: turnId,
    });
  }
  return synthetic;
}

function getOrchestrationDecisionItems(trace?: RunTracePayload): NativeListItem[] {
  return getOrchestrationDecisions(trace).map((decision) => {
    const details = readRecord(decision, "details");
    const phaseId = readString(decision.phaseId) ?? readString(details?.phaseId);
    return {
      title: readString(decision.kind) ?? readString(decision.eventType) ?? "orchestration decision",
      meta: [
        readString(decision.source),
        readString(decision.eventType) ?? readString(decision.checkpointKind),
        phaseId ? `phase ${phaseId}` : undefined,
        formatDateTime(readString(decision.createdAt)),
      ]
        .filter(Boolean)
        .join(" · "),
      body:
        readString(decision.summary) ??
        [readString(details?.status), readString(details?.model), readString(details?.error)]
          .filter(Boolean)
          .join(" · "),
    };
  });
}

function getOrchestrationPromptItems(trace?: RunTracePayload): NativeListItem[] {
  const prompts = new Map<string, NativeListItem>();
  for (const decision of getOrchestrationDecisions(trace)) {
    const details = readRecord(decision, "details");
    const prompt = readRecord(details, "prompt");
    const promptId = readString(prompt?.promptId);
    const promptVersion = readString(prompt?.promptVersion);
    const promptHash = readString(prompt?.promptHash);
    if (!promptId || !promptHash) {
      continue;
    }
    const key = `${promptId}:${promptVersion ?? "unknown"}:${promptHash}`;
    prompts.set(key, {
      title: `Prompt ${promptId}`,
      meta: [promptVersion ? `version ${promptVersion}` : undefined, promptHash].filter(Boolean).join(" · "),
      body: [
        readString(decision.kind),
        readString(details?.phaseId) ? `phase ${readString(details?.phaseId)}` : undefined,
        readString(details?.model) ? `model ${readString(details?.model)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return [...prompts.values()];
}

function getOrchestrationModelItems(trace?: RunTracePayload): NativeListItem[] {
  const models = new Map<string, NativeListItem>();
  for (const decision of getOrchestrationDecisions(trace)) {
    const details = readRecord(decision, "details");
    const model = readString(details?.model) ?? readString(details?.selectedModel);
    const provider = readString(details?.providerId) ?? readString(details?.selectedProviderId);
    if (!model && !provider) {
      continue;
    }
    const phaseId = readString(decision.phaseId) ?? readString(details?.phaseId);
    const key = [provider, model, phaseId, readString(decision.kind)].filter(Boolean).join(":");
    models.set(key, {
      title: model ? `Model ${model}` : "Model choice",
      meta: [provider, phaseId ? `phase ${phaseId}` : undefined, readString(decision.kind)].filter(Boolean).join(" · "),
      body: [
        readNumber(details?.costUsd) !== undefined ? `cost ${formatCost(readNumber(details?.costUsd))}` : undefined,
        readNumber(details?.inputTokens) !== undefined
          ? `input ${formatCount(readNumber(details?.inputTokens))}`
          : undefined,
        readNumber(details?.outputTokens) !== undefined
          ? `output ${formatCount(readNumber(details?.outputTokens))}`
          : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }
  return [...models.values()];
}

function getOrchestrationPolicyItems(trace?: RunTracePayload): NativeListItem[] {
  return getOrchestrationDecisions(trace)
    .filter((decision) => readString(decision.kind) === "policy_checked")
    .map((decision) => {
      const details = readRecord(decision, "details");
      const patchKeys = readArray(details?.patchKeys)
        .map((value) => readString(value))
        .filter((value): value is string => Boolean(value));
      return {
        title: readString(details?.gate) ?? "policy gate",
        meta: [readString(details?.outcome), readString(details?.trigger), readString(details?.entityType)]
          .filter(Boolean)
          .join(" · "),
        body: [
          readString(details?.blockedReason),
          patchKeys.length > 0 ? `patch keys ${patchKeys.join(", ")}` : undefined,
          readBoolean(details?.approvalRequired) ? "approval required" : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });
}

function getOrchestrationLineageItems(trace?: RunTracePayload): NativeListItem[] {
  return getOrchestrationDecisions(trace).flatMap((decision) => {
    const details = readRecord(decision, "details");
    const childSessionId = readString(details?.childSessionId);
    const childTurnId = readString(details?.childTurnId);
    const childRunId = readString(details?.childRunId);
    if (!childSessionId && !childTurnId && !childRunId) {
      return [];
    }
    return [
      {
        title: readString(details?.phaseId) ? `Child lineage for ${readString(details?.phaseId)}` : "Child lineage",
        meta: readString(decision.kind),
        body: [
          childSessionId ? `session ${childSessionId}` : undefined,
          childTurnId ? `turn ${childTurnId}` : undefined,
          childRunId ? `run ${childRunId}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      },
    ];
  });
}

function getOrchestrationWaitItems(trace?: RunTracePayload): NativeListItem[] {
  return getOrchestrationDecisions(trace).flatMap((decision) => {
    const details = readRecord(decision, "details");
    const kind = readString(decision.kind);
    const approvalId = readString(details?.approvalId);
    const resumeRequested = readBoolean(details?.resumeRequested);
    if (kind !== "phase_wait_registered" && kind !== "run_resumed" && !approvalId && !resumeRequested) {
      return [];
    }
    return [
      {
        title: kind === "run_resumed" || resumeRequested ? "Resume evidence" : "Wait evidence",
        meta: [
          kind,
          readString(details?.phaseId) ? `phase ${readString(details?.phaseId)}` : undefined,
          approvalId ? `approval ${approvalId}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        body: readString(decision.summary) ?? readString(details?.status),
      },
    ];
  });
}

function getOrchestrationFailureItems(trace?: RunTracePayload): NativeListItem[] {
  return getOrchestrationDecisions(trace).flatMap((decision) => {
    const details = readRecord(decision, "details");
    const kind = readString(decision.kind);
    const error = readString(details?.error) ?? readString(details?.blockedReason);
    if (!error && kind !== "phase_failed" && kind !== "run_failed" && kind !== "run_cancelled") {
      return [];
    }
    return [
      {
        title: kind ?? "orchestration failure",
        meta: [readString(details?.phaseId), readString(details?.status)].filter(Boolean).join(" · "),
        body: error ?? readString(decision.summary) ?? "Failure reason was not recorded.",
      },
    ];
  });
}

function getOrchestrationDecisions(trace?: RunTracePayload): RunTracePayload[] {
  return readArray(trace?.decisions)
    .map((item) => asRecord(item))
    .filter((item): item is RunTracePayload => Boolean(item));
}

function getMemoryContextItems(record: RunTracePayload): NativeListItem[] {
  const memoryItems = readArray(readRecord(record, "memory")?.items);
  const contextItems = readArray(readRecord(record, "context")?.items);
  const memoryContextItems = readArray(readRecord(record, "memoryContext")?.items);
  return [...memoryItems, ...contextItems, ...memoryContextItems].flatMap((item, index) => {
    const entry = asRecord(item) ?? {};
    const label =
      readString(entry.title) ??
      readString(entry.label) ??
      readString(entry.contextId) ??
      readString(entry.id) ??
      `Context item ${index + 1}`;
    const source = readString(entry.source) ?? readString(entry.sourceRef) ?? readString(entry.kind);
    const baseItem = {
      title: label,
      meta: ["context", source, readString(entry.status) ?? readString(readRecord(entry, "quality")?.status)]
        .filter(Boolean)
        .join(" · "),
      body:
        readString(entry.summary) ??
        readString(entry.content) ??
        readString(entry.contextText) ??
        (entry.metadata ? JSON.stringify(entry.metadata) : undefined),
    };
    const citationItems = readArray(entry.citations).map((citation, citationIndex) =>
      buildMemoryCitationItem(citation, label, citationIndex),
    );
    return [baseItem, ...citationItems];
  });
}

function buildMemoryCitationItem(citation: unknown, contextLabel: string, index: number): NativeListItem {
  const entry = asRecord(citation) ?? {};
  const provenance = readRecord(entry, "provenance");
  const sourceRef = readString(entry.sourceRef) ?? readString(entry.candidateId) ?? `citation ${index + 1}`;
  const whyUsed = readString(provenance?.selectionReason) ?? "No selection reason was recorded.";
  const snippet = readString(entry.snippet);
  const matchSignals = readRecord(provenance, "matchSignals");
  const matchSignalText = formatMemoryMatchSignals(matchSignals);
  return {
    title: `Why used: ${sourceRef}`,
    meta: [
      contextLabel,
      readString(entry.sourceType),
      formatScore(readNumber(entry.score)),
      formatMemoryRetrievalStrategy(readString(provenance?.retrievalStrategy)),
      readString(provenance?.freshness),
      readString(provenance?.relationScope),
    ]
      .filter(Boolean)
      .join(" · "),
    body: [whyUsed, matchSignalText, snippet ? truncateText(snippet, 220) : undefined].filter(Boolean).join(" · "),
  };
}

function getToolItems(record: RunTracePayload, trace?: RunTracePayload): NativeListItem[] {
  const tools = Array.isArray(record.tools)
    ? record.tools
    : [...readArray(readRecord(record, "toolCalls")?.items), ...readArray(trace?.toolRuns)];
  return tools.map((item, index) => {
    const tool = asRecord(item) ?? {};
    const approvalId = readString(tool.approvalId);
    return {
      title: readString(tool.toolName) ?? readString(tool.toolRunId) ?? `Tool ${index + 1}`,
      meta: [readString(tool.status), approvalId ? `approval ${approvalId}` : undefined].filter(Boolean).join(" · "),
      body:
        readString(tool.error) ??
        readString(tool.failureGuidance) ??
        (readBoolean(tool.reused)
          ? `Reused from ${readString(tool.reusedFromToolRunId) ?? "previous run"}`
          : undefined),
    };
  });
}

function getApprovalItems(record: RunTracePayload, trace?: RunTracePayload): NativeListItem[] {
  const approvals = Array.isArray(record.approvals)
    ? record.approvals
    : readArray(readRecord(record, "approvals")?.items);
  const pending = readRecord(trace, "pendingApprovalSummary");
  const allApprovals = pending ? [...approvals, pending] : approvals;
  return allApprovals.map((item, index) => {
    const approval = asRecord(item) ?? {};
    const approvalId = readString(approval.approvalId);
    return {
      title: readString(approval.kind) ?? approvalId ?? `Approval ${index + 1}`,
      meta: [readString(approval.status), readString(approval.riskLevel)].filter(Boolean).join(" · "),
      body: approvalId ? `approval ${approvalId}` : "Approval id not recorded.",
    };
  });
}

function getSideEffectItems(record: RunTracePayload): NativeListItem[] {
  const rawSideEffects = readArray(record.sideEffects);
  const posture = readRecord(record, "posture");
  const postureAudit = posture ? readRecord(posture, "audit") : undefined;
  const sideEffects =
    rawSideEffects.length > 0
      ? rawSideEffects
      : readString(posture?.sideEffectPosture) === "audit_only"
        ? [
            {
              description: "Run trace inspection posture",
              mode: "audit_only",
              status: readString(postureAudit?.state) ?? "available",
              note: readString(postureAudit?.note),
            },
          ]
        : [];
  return sideEffects.map((item, index) => {
    const effect = asRecord(item) ?? {};
    const mode =
      readBoolean(effect.auditOnly) || readString(effect.mode) === "audit_only"
        ? "Audit-only"
        : (readString(effect.mode) ?? "Recorded");
    return {
      title:
        readString(effect.description) ??
        readString(effect.effectKind) ??
        readString(effect.kind) ??
        `Side effect ${index + 1}`,
      meta: [mode, readString(effect.status), readString(effect.targetKind)].filter(Boolean).join(" · "),
      body: [
        readString(effect.targetId) ? `target ${readString(effect.targetId)}` : undefined,
        readString(effect.error) ?? readString(effect.note),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

function getEvidenceStateItems(record: RunTracePayload): NativeListItem[] {
  const items: NativeListItem[] = [];
  addAvailabilityItem(items, "Durable checkpoints", readRecord(readRecord(record, "durable"), "checkpoints"));
  addAvailabilityItem(items, "Durable timeline", readRecord(readRecord(record, "durable"), "timeline"));
  addAvailabilityItem(items, "Lifecycle", readRecord(record, "lifecycle"));
  addAvailabilityItem(items, "Session", readRecord(record, "session"));
  addAvailabilityItem(items, "Thread", readRecord(record, "thread"));
  addAvailabilityItem(items, "Approvals", readRecord(record, "approvals"));
  addAvailabilityItem(items, "Tool calls", readRecord(record, "toolCalls"));
  addAvailabilityItem(items, "Memory context", readRecord(record, "memoryContext"));
  addAvailabilityItem(items, "Provider usage", readRecord(record, "providerUsage"));
  addAvailabilityItem(items, "Artifacts", readRecord(record, "artifacts"));
  addAvailabilityItem(items, "Errors", readRecord(record, "errors"));

  const approvals = readRecord(record, "approvals");
  const missingApprovalIds = readArray(approvals?.missingIds)
    .map((value) => readString(value))
    .filter((value): value is string => Boolean(value));
  if (missingApprovalIds.length > 0) {
    items.push({
      title: "Missing approval evidence",
      meta: "approvals · missing ids",
      body: missingApprovalIds.join(", "),
    });
  }

  return items;
}

function addAvailabilityItem(items: NativeListItem[], label: string, section?: RunTracePayload): void {
  const state = readString(section?.state);
  const detail = readString(section?.error) ?? readString(section?.note);
  if (!state || state === "available") {
    return;
  }
  if (state === "not_available" && !detail) {
    return;
  }
  items.push({
    title: `${label} ${formatAvailabilityState(state)}`,
    meta: state,
    body: detail ?? "The trace explicitly marked this evidence group as unavailable or unknown.",
  });
}

function formatAvailabilityState(state: string): string {
  if (state === "not_available") {
    return "not available";
  }
  return state;
}

function getErrorItems(
  record: RunTracePayload,
  trace?: RunTracePayload,
  firstTurn?: RunTracePayload,
  run?: RunTracePayload,
): NativeListItem[] {
  const errors = Array.isArray(record.errors) ? record.errors : readArray(readRecord(record, "errors")?.items);
  const traceFailure = readRecord(trace, "failure") ?? readRecord(firstTurn, "failure");
  const allErrors = [
    ...errors,
    traceFailure
      ? {
          kind: readString(traceFailure.failureClass),
          message: readString(traceFailure.message),
          retryable: readBoolean(traceFailure.retryable),
          recommendedAction: readString(traceFailure.recommendedAction),
        }
      : null,
    readString(run?.lastError)
      ? { kind: "durable", message: readString(run?.lastError), status: readString(run?.status) }
      : null,
  ].filter((item): item is RunTracePayload => Boolean(item));
  return allErrors.map((item) => {
    const source = readString(item.source) ?? readString(item.kind) ?? readString(item.code) ?? "Run error";
    const message = readString(item.message) ?? "Error detail was not recorded.";
    const action = readString(item.recommendedAction);
    return {
      title: source,
      meta: [readString(item.status), readBoolean(item.retryable) ? "retryable" : undefined]
        .filter(Boolean)
        .join(" · "),
      body: action ? `${message} · ${action}` : message,
    };
  });
}

function asRecord(value: unknown): RunTracePayload | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RunTracePayload) : undefined;
}

function readRecord(record: RunTracePayload | undefined, key: string): RunTracePayload | undefined {
  return record ? asRecord(record[key]) : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function formatCount(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "Unknown";
}

function formatCost(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(4)}` : "Unknown";
}

function formatDuration(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)} ms` : "Unknown";
}

function formatScore(value?: number): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `score ${value.toFixed(3)}` : undefined;
}

function formatMemoryRetrievalStrategy(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "semantic_hints") {
    return "semantic hints";
  }
  if (value === "semantic_vector") {
    return "semantic vector";
  }
  if (value === "lexical_recency") {
    return "lexical/recency";
  }
  return value;
}

function formatMemoryMatchSignals(signals?: RunTracePayload): string | undefined {
  if (!signals) {
    return undefined;
  }
  const parts = [
    formatSignalValue("lexical", readNumber(signals.lexicalScore)),
    formatSignalValue("vector", readNumber(signals.semanticVectorScore)),
    formatSignalValue("hint", readNumber(signals.semanticHintScore)),
    formatSignalValue("recency", readNumber(signals.recencyScore)),
    formatSignalValue("diversity", readNumber(signals.diversityScore)),
  ].filter(Boolean);
  return parts.length > 0 ? `signals ${parts.join(", ")}` : undefined;
}

function formatSignalValue(label: string, value?: number): string | undefined {
  return typeof value === "number" && Number.isFinite(value) ? `${label} ${value.toFixed(3)}` : undefined;
}

function isStableSurface(value: unknown): value is "chat" | "cowork" | "code" {
  return value === "chat" || value === "cowork" || value === "code";
}
