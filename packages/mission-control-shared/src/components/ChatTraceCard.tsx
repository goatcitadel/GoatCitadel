import { useState } from "react";
import {
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatCitationRecord,
  type ChatUsageCostSource,
  type ChatTurnTraceRecord,
  type MemoryCitationProvenance,
  type MemoryRetrievalMatchSignals,
} from "@goatcitadel/contracts";
import { ChatToolArtifactInspector } from "./chat/ChatToolArtifactInspector";
import { getChatToolRunDiagnostics, getTraceFallbackAttemptCount } from "./chat/chat-tool-diagnostics";
import { ChatExecutionPlanSummary } from "./chat/ChatExecutionPlanSummary";
import { normalizeCitationDisplayText } from "./chat/assistant-display-text";

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

function isMemoryCitation(citation: ChatCitationRecord): boolean {
  return (
    citation.sourceType === "memory" || citation.url?.startsWith("memory://") === true || Boolean(citation.provenance)
  );
}

function formatMemoryRetrievalStrategy(value: MemoryCitationProvenance["retrievalStrategy"]): string | null {
  switch (value) {
    case "semantic_hints":
      return "semantic hints";
    case "lexical_recency":
      return "lexical/recency";
    default:
      return null;
  }
}

function formatMemoryScore(value: number | undefined): string | null {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : null;
}

function formatMemorySignals(signals: MemoryRetrievalMatchSignals | undefined): string | null {
  if (!signals) {
    return null;
  }
  return [
    ["total", signals.totalScore],
    ["lexical", signals.lexicalScore],
    ["hint", signals.semanticHintScore],
    ["recency", signals.recencyScore],
    ["diversity", signals.diversityScore],
  ]
    .map(([label, value]) => {
      const score = typeof value === "number" ? formatMemoryScore(value) : null;
      return score ? `${label} ${score}` : null;
    })
    .filter((value): value is string => Boolean(value))
    .join(" · ");
}

function formatMemoryCitationMeta(provenance: MemoryCitationProvenance | undefined): string | null {
  if (!provenance) {
    return null;
  }
  return [
    formatMemoryRetrievalStrategy(provenance.retrievalStrategy),
    provenance.relationScope,
    provenance.freshness,
    provenance.sourceTimestamp ? `source ${provenance.sourceTimestamp}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
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
        <button type="button" onClick={() => setCollapsed((value) => !value)} className="gc-button">
          {collapsed ? "Show trace" : "Hide trace"}
        </button>
      </header>
      {collapsed ? null : (
        <div className="chat-trace-body">
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
                        />
                      ) : null}
                      {run.error ? <p>Error: {run.error}</p> : null}
                      {run.failureGuidance ? <p>Next move: {run.failureGuidance}</p> : null}
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
