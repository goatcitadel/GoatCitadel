import { useState } from "react";
import {
  getChatTurnRecoveryActionLabel,
  getChatTurnRecoveryActionSummary,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { ChatToolArtifactInspector } from "./chat/ChatToolArtifactInspector";
import { getChatToolRunDiagnostics, getTraceFallbackAttemptCount } from "./chat/chat-tool-diagnostics";
import { ChatExecutionPlanSummary } from "./chat/ChatExecutionPlanSummary";

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
                {trace.citations.map((citation) => (
                  <li key={citation.citationId}>
                    {isExternalCitationUrl(citation.url) ? (
                      <a href={citation.url} target="_blank" rel="noreferrer">
                        {citation.title || citation.url}
                      </a>
                    ) : (
                      <span>{citation.title ?? "source"}</span>
                    )}
                    {citation.knowledge ? (
                      <p className="chat-trace-meta">
                        {citation.knowledge.sourceRef}
                        {citation.knowledge.sectionLabel ? ` · ${citation.knowledge.sectionLabel}` : ""}
                        {citation.knowledge.retrievalMode === "full_text" ? " · full text" : " · retrieval"}
                      </p>
                    ) : null}
                    {citation.snippet ? <p>{citation.snippet}</p> : null}
                  </li>
                ))}
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
