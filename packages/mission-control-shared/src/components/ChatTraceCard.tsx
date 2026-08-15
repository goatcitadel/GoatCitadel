import { useId, useState } from "react";
import {
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatUsageCostSource,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { ChatToolArtifactInspector } from "./chat/ChatToolArtifactInspector";
import { getChatToolRunDiagnostics, getTraceFallbackAttemptCount } from "./chat/chat-tool-diagnostics";
import { projectChatToolEffectTruth } from "./chat/chat-tool-effect-truth";
import { ChatExecutionPlanSummary } from "./chat/ChatExecutionPlanSummary";
import {
  formatMemoryCitationMeta,
  formatMemorySignals,
  isMemoryCitation,
  normalizeCitationDisplayText,
} from "./chat/assistant-display-text";

function isExternalCitationUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  return /^https?:\/\//i.test(url);
}

function formatTime(value?: string): string {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleTimeString();
}

function formatRoutingTarget(providerId?: string, model?: string): string | null {
  const parts = [providerId, model].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatTokenCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "n/a";
}

function formatCostUsd(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value === 0) {
    return "$0";
  }
  return `$${value < 0.01 ? value.toFixed(6) : value.toFixed(4)}`;
}

function formatLatency(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function formatCostSource(value: ChatUsageCostSource | undefined): string {
  switch (value) {
    case "provider_reported":
      return "provider reported";
    case "estimated":
      return "estimated";
    case "mixed":
      return "mixed";
    case "unknown":
      return "unknown";
    default:
      return "not recorded";
  }
}

function formatDecisionKind(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDecisionSignals(
  signals: NonNullable<ChatTurnTraceRecord["decisionTrace"]>[number]["signals"],
): string | null {
  if (signals.length === 0) {
    return null;
  }
  return signals
    .map((signal) => {
      const value = signal.value === undefined || signal.value === null ? null : String(signal.value);
      const weight = signal.weight ? ` (${signal.weight})` : "";
      return `${signal.source}:${signal.key}${value ? `=${value}` : ""}${weight}`;
    })
    .join("; ");
}

function formatDecisionAlternatives(
  alternatives: NonNullable<ChatTurnTraceRecord["decisionTrace"]>[number]["alternatives"],
): string | null {
  if (alternatives.length === 0) {
    return null;
  }
  return alternatives
    .map((alternative) => {
      const blockedBy = alternative.blockedBy ? ` blocked by ${alternative.blockedBy}` : "";
      return `${alternative.label} (${alternative.outcome}${blockedBy}): ${alternative.reasonNotChosen}`;
    })
    .join("; ");
}

function formatDecisionLinks(decision: NonNullable<ChatTurnTraceRecord["decisionTrace"]>[number]): string | null {
  const entries: string[] = [];
  const push = (label: string, value: string | undefined) => {
    if (value) {
      entries.push(`${label}: ${value}`);
    }
  };
  push("session", decision.scope.sessionId);
  push("turn", decision.scope.turnId);
  push("run", decision.scope.runId);
  push("plan", decision.scope.planId);
  push("step", decision.scope.stepId);
  push("tool", decision.scope.toolRunId);
  push("approval", decision.scope.approvalId);
  push("task", decision.scope.taskId);
  push("durable", decision.scope.durableRunId);
  for (const ref of decision.evidenceRefs) {
    const label = ref.label ? `${ref.refType} ${ref.label}` : ref.refType;
    const rendered = `${label}: ${ref.refId}`;
    if (!entries.includes(rendered)) {
      entries.push(rendered);
    }
  }
  return entries.length > 0 ? entries.join(" · ") : null;
}

function summarizeTraceRouting(trace: ChatTurnTraceRecord): {
  requestedLabel: string | null;
  effectiveLabel: string | null;
  mismatchLabel: string | null;
} {
  const requestedLabel = formatRoutingTarget(trace.routing.primaryProviderId, trace.routing.primaryModel);
  const effectiveLabel =
    formatRoutingTarget(trace.routing.effectiveProviderId, trace.routing.effectiveModel) ?? trace.model ?? null;
  const mismatch =
    trace.routing.fallbackUsed || (requestedLabel && effectiveLabel ? requestedLabel !== effectiveLabel : false);
  if (!mismatch) {
    return {
      requestedLabel,
      effectiveLabel,
      mismatchLabel: null,
    };
  }
  const effectiveText = effectiveLabel ?? "not recorded";
  const requestedText = requestedLabel ?? "auto";
  const reasonSuffix = trace.routing.fallbackReason ? ` · ${trace.routing.fallbackReason}` : "";
  return {
    requestedLabel,
    effectiveLabel,
    mismatchLabel: `Requested ${requestedText} -> Effective ${effectiveText}${reasonSuffix}`,
  };
}

export function ChatTraceCard({
  trace,
  workspaceId,
  defaultCollapsed = true,
}: {
  trace: ChatTurnTraceRecord;
  workspaceId: string;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [decisionTraceOpen, setDecisionTraceOpen] = useState(false);
  const traceBodyId = useId();
  const decisionTraceId = useId();
  const fallbackAttemptCount = getTraceFallbackAttemptCount(trace);
  const routingSummary = summarizeTraceRouting(trace);
  const runtimeUsage = trace.completion?.usage;
  const hasRuntimeEvidence =
    Boolean(runtimeUsage) ||
    trace.completion?.latencyMs !== undefined ||
    trace.completion?.providerCallCount !== undefined;
  return (
    <article className="chat-trace-card">
      <header className="chat-trace-head">
        <div>
          <p className="chat-trace-title">Run Trace</p>
          <p className="chat-trace-meta">
            {trace.status} · {routingSummary.effectiveLabel ?? "model n/a"} · {formatTime(trace.startedAt)}
          </p>
          {routingSummary.mismatchLabel ? <p className="chat-trace-meta">{routingSummary.mismatchLabel}</p> : null}
        </div>
        <button
          type="button"
          className="gc-button"
          aria-expanded={!collapsed}
          aria-controls={traceBodyId}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? "Show trace" : "Hide trace"}
        </button>
      </header>
      {collapsed ? (
        <div id={traceBodyId} hidden />
      ) : (
        <div id={traceBodyId} className="chat-trace-body">
          <div className="chat-trace-grid">
            <span>Mode: {trace.mode}</span>
            <span>Web: {trace.webMode}</span>
            <span>Memory: {trace.memoryMode}</span>
            <span>Thinking: {trace.thinkingLevel}</span>
            <span>Started: {formatTime(trace.startedAt)}</span>
            <span>Finished: {formatTime(trace.finishedAt)}</span>
            <span>Live data intent: {trace.routing.liveDataIntent ? "yes" : "no"}</span>
            <span>Fallback used: {trace.routing.fallbackUsed ? "yes" : "no"}</span>
            <span>Fallback tiers attempted: {fallbackAttemptCount || "none"}</span>
          </div>
          {trace.failure ? (
            <div className="chat-trace-section">
              <strong>Recovery state</strong>
              {trace.failure.recommendedAction ? (
                <>
                  <p>Next step: {getChatTurnRecoveryActionLabel(trace.failure.recommendedAction)}</p>
                  <p>{getChatTurnRecoveryActionSummary(trace.failure.recommendedAction)}</p>
                </>
              ) : null}
              <p>Failure class: {trace.failure.failureClass}</p>
              <p>{trace.failure.message}</p>
              {trace.failure.provider ? (
                <p>
                  Provider error:{" "}
                  {[trace.failure.provider.code, trace.failure.provider.message].filter(Boolean).join(" - ") ||
                    "details unavailable"}
                </p>
              ) : null}
              <p>Retryable: {trace.failure.retryable === false ? "no" : "yes"}</p>
            </div>
          ) : null}
          {trace.loopGuard?.events?.length ? (
            <div className="chat-trace-section">
              <strong>Loop guard</strong>
              <p>
                Enabled: {trace.loopGuard.enabled ? "yes" : "no"} · History: {trace.loopGuard.historySize}
              </p>
              <ul className="chat-trace-list">
                {trace.loopGuard.events.map((event, index) => (
                  <li key={`${event.detector}-${event.severity}-${index}`}>
                    <span>{event.detector}</span>
                    <span>{event.severity}</span>
                    <p>Suppressed: {event.suppressed ? "yes" : "no"}</p>
                    <p>{event.message}</p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {trace.decisionTrace?.length ? (
            <details
              className="chat-trace-section chat-decision-trace"
              open={decisionTraceOpen}
              onToggle={(event) => setDecisionTraceOpen(event.currentTarget.open)}
            >
              <summary aria-expanded={decisionTraceOpen} aria-controls={decisionTraceId}>
                Decision Trace ({trace.decisionTrace.length})
              </summary>
              <ul id={decisionTraceId} className="chat-trace-list">
                {trace.decisionTrace.map((decision) => {
                  const alternatives = formatDecisionAlternatives(decision.alternatives);
                  const signals = formatDecisionSignals(decision.signals);
                  const links = formatDecisionLinks(decision);
                  return (
                    <li key={decision.decisionId}>
                      <span>{formatDecisionKind(decision.kind)}</span>
                      <span>{formatTime(decision.createdAt)}</span>
                      <p>Chosen action: {decision.selected}</p>
                      <p>Rationale: {decision.rationale}</p>
                      {alternatives ? <p>Alternatives considered: {alternatives}</p> : null}
                      {signals ? <p>Signals: {signals}</p> : null}
                      {links ? <p>Links: {links}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
          {trace.executionPlan ? (
            <div className="chat-trace-section">
              <strong>Execution plan</strong>
              <ChatExecutionPlanSummary plan={trace.executionPlan} />
            </div>
          ) : null}
          <div className="chat-trace-section">
            <strong>Routing</strong>
            <p>
              {routingSummary.requestedLabel
                ? `Requested: ${routingSummary.requestedLabel}`
                : "Requested: not recorded"}
            </p>
            <p>
              {routingSummary.effectiveLabel
                ? `Effective: ${routingSummary.effectiveLabel}`
                : "Effective: not recorded"}
            </p>
            {trace.routing.effectiveApiStyle ? <p>Upstream API: {trace.routing.effectiveApiStyle}</p> : null}
            {trace.routing.fallbackReason ? <p>Fallback reason: {trace.routing.fallbackReason}</p> : null}
          </div>
          {hasRuntimeEvidence ? (
            <div className="chat-trace-section">
              <strong>Runtime evidence</strong>
              <p>Input tokens: {formatTokenCount(runtimeUsage?.inputTokens)}</p>
              <p>Output tokens: {formatTokenCount(runtimeUsage?.outputTokens)}</p>
              <p>Cached input tokens: {formatTokenCount(runtimeUsage?.cachedInputTokens)}</p>
              <p>{`Cost: ${formatCostUsd(runtimeUsage?.costUsd)} (${formatCostSource(runtimeUsage?.costSource)})`}</p>
              <p>Provider latency: {formatLatency(trace.completion?.latencyMs)}</p>
              {trace.completion?.providerCallCount !== undefined ? (
                <p>Provider calls: {trace.completion.providerCallCount}</p>
              ) : null}
            </div>
          ) : null}
          {trace.toolRuns.length > 0 ? (
            <div className="chat-trace-section">
              <strong>Tool timeline</strong>
              <ul className="chat-trace-list">
                {trace.toolRuns.map((run) => {
                  const diagnostics = getChatToolRunDiagnostics(run);
                  const effectTruth = projectChatToolEffectTruth(run);
                  return (
                    <li key={run.toolRunId}>
                      <span>{run.toolName}</span>
                      <span>{run.status}</span>
                      <span>{formatTime(run.startedAt)}</span>
                      {diagnostics.outputVirtualized || diagnostics.storedAsArtifact ? (
                        <p className="chat-tool-artifact-row">
                          {diagnostics.outputVirtualized ? (
                            <span className="chat-tool-artifact-badge">Output summarized</span>
                          ) : null}
                          {diagnostics.storedAsArtifact ? (
                            <span className="chat-tool-artifact-badge">Stored as artifact</span>
                          ) : null}
                        </p>
                      ) : null}
                      {diagnostics.engineLabel ? (
                        <p>
                          Engine: {diagnostics.engineLabel}
                          {diagnostics.engineTier ? ` (${diagnostics.engineTier})` : ""}
                        </p>
                      ) : null}
                      {diagnostics.url ? <p>URL: {diagnostics.url}</p> : null}
                      {diagnostics.finalUrl && diagnostics.finalUrl !== diagnostics.url ? (
                        <p>Final URL: {diagnostics.finalUrl}</p>
                      ) : null}
                      {diagnostics.httpStatus !== undefined ? <p>HTTP status: {diagnostics.httpStatus}</p> : null}
                      {diagnostics.browserFailureClass ? (
                        <p>Browser failure: {diagnostics.browserFailureClass}</p>
                      ) : null}
                      {diagnostics.summary ? <p>{diagnostics.summary}</p> : null}
                      {diagnostics.artifactId ? (
                        <ChatToolArtifactInspector
                          artifactId={diagnostics.artifactId}
                          workspaceId={workspaceId}
                          artifactPath={diagnostics.artifactPath}
                          originalByteLength={diagnostics.originalByteLength}
                          run={run}
                        />
                      ) : null}
                      {run.error ? <p>Error: {run.error}</p> : null}
                      {run.failureGuidance ? <p>Next move: {run.failureGuidance}</p> : null}
                      {effectTruth ? (
                        <div className={`chat-tool-effect-truth is-${effectTruth.tone}`}>
                          <strong>Effect truth: {effectTruth.tone}</strong>
                          <p>{effectTruth.facts}</p>
                          {effectTruth.guidance ? <p>{effectTruth.guidance}</p> : null}
                          {effectTruth.tone === "concrete" ? (
                            <p>
                              A concrete receipt is recorded; verify it against the canonical owner ledger before
                              relying on its ID.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {trace.citations.length > 0 ? (
            <div className="chat-trace-section">
              <strong>Citations</strong>
              <ul className="chat-citation-list">
                {trace.citations.map((citation) => {
                  const title = normalizeCitationDisplayText(citation.title);
                  const snippet = normalizeCitationDisplayText(citation.snippet);
                  const memoryCitation = isMemoryCitation(citation);
                  const citationLabel =
                    title ??
                    (memoryCitation ? (citation.knowledge?.sourceRef ?? citation.url) : (citation.url ?? "source"));
                  const memoryWhyUsed = memoryCitation
                    ? (citation.provenance?.selectionReason ?? "Memory selection reason was not recorded.")
                    : null;
                  const memoryMeta = formatMemoryCitationMeta(citation.provenance);
                  const memorySignals = formatMemorySignals(citation.provenance?.matchSignals);
                  return (
                    <li key={citation.citationId} className={memoryCitation ? "is-memory" : undefined}>
                      {isExternalCitationUrl(citation.url) ? (
                        <a href={citation.url} target="_blank" rel="noreferrer">
                          {citationLabel || citation.url}
                        </a>
                      ) : (
                        <span>{citationLabel}</span>
                      )}
                      {citation.knowledge ? (
                        <p className="chat-trace-meta">
                          {citation.knowledge.sourceRef}
                          {citation.knowledge.sectionLabel ? ` · ${citation.knowledge.sectionLabel}` : ""}
                          {citation.knowledge.retrievalMode === "full_text" ? " · full text" : " · retrieval"}
                        </p>
                      ) : null}
                      {snippet ? <p>{snippet}</p> : null}
                      {memoryWhyUsed ? <p>Why used: {memoryWhyUsed}</p> : null}
                      {memoryMeta ? <p>{memoryMeta}</p> : null}
                      {memorySignals ? <p>{memorySignals}</p> : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {trace.orchestration ? (
            <div className="chat-trace-section">
              <strong>Orchestration</strong>
              <p>
                {trace.orchestration.workflowTemplate}
                {" · "}
                {trace.orchestration.visibility}
                {" · "}
                {trace.orchestration.status}
              </p>
              <p>{trace.orchestration.routeDecision.selectedRoles.join(" -> ")}</p>
              {trace.orchestration.routeDecision.specialistCandidates?.length ? (
                <p>
                  Specialists:{" "}
                  {trace.orchestration.routeDecision.specialistCandidates
                    .map((item) => `${item.title} (${item.baseRole})`)
                    .join(" · ")}
                </p>
              ) : null}
              {trace.orchestration.finalSummary ? <p>{trace.orchestration.finalSummary}</p> : null}
              <ul className="chat-trace-list">
                {trace.orchestration.steps.map((step) => (
                  <li key={step.stepId}>
                    <span>{step.role}</span>
                    <span>
                      {step.providerId ?? "provider auto"}
                      {step.model ? ` · ${step.model}` : ""}
                    </span>
                    <span>{step.status}</span>
                    {step.specialistTitle ? (
                      <p>
                        Specialist: {step.specialistTitle} ({step.specialistRole ?? "specialist"})
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </article>
  );
}
