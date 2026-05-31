import { useState } from "react";
import { ClipboardCopy, Database, FileText, GitBranch, RefreshCw } from "lucide-react";
import { exportObserveRunTrace, fetchObserveRunTrace } from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, StatusChip } from "../primitives";
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

export function RunDetailRoutePage({ route, activeWorkspaceName, navigate }: NativeRoutePagesProps) {
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
    return {
      issues: nativeLoadIssues([trace]),
      trace: trace.data,
    };
  }, [runId]);
  const detail = buildRunDetailModel(data?.trace ?? buildEmptyRunTrace(runId ?? "unknown"), runId ?? "unknown");

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
      kicker="Ops · Run detail"
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
          <button
            type="button"
            className="mc-next-secondary-button"
            onClick={() => void copyTraceExport()}
            disabled={!runId || exporting}
          >
            <ClipboardCopy className="h-4 w-4" />
            {exporting ? "Exporting..." : "Copy trace export"}
          </button>
          <button type="button" className="mc-next-secondary-button" onClick={() => void reload()}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </>
      }
    >
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {exportNotice ? <div className="mc-next-runtime-notice tone-success">{exportNotice}</div> : null}
      {exportError ? <div className="mc-next-directory-alert">{exportError}</div> : null}
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
          {detail.memoryWarning ? (
            <div className="mc-next-directory-alert">
              <Database className="h-4 w-4" />
              <span>{detail.memoryWarning}</span>
            </div>
          ) : null}
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
            <button
              type="button"
              className="mc-next-button-secondary"
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
            </button>
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

function buildRunDetailModel(raw: unknown, fallbackRunId: string): RunDetailModel {
  const record = asRecord(raw) ?? {};
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
    raw,
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
  return {
    title: `Why used: ${sourceRef}`,
    meta: [
      contextLabel,
      readString(entry.sourceType),
      formatScore(readNumber(entry.score)),
      readString(provenance?.freshness),
      readString(provenance?.relationScope),
    ]
      .filter(Boolean)
      .join(" · "),
    body: snippet ? `${whyUsed} · ${truncateText(snippet, 220)}` : whyUsed,
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

function isStableSurface(value: unknown): value is "chat" | "cowork" | "code" {
  return value === "chat" || value === "cowork" || value === "code";
}
