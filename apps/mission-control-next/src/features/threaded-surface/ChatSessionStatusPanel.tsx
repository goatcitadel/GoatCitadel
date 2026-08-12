import type { ChatSessionStatusSection } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { StatusChip } from "../native-routes/primitives";

type PanelState = NonNullable<MissionThreadedActiveSessionSurfaceProps["sessionStatusPanel"]>;

export function ChatSessionStatusPanel({ panel }: { panel: PanelState }) {
  if (!panel.open) return null;
  const status = panel.status;
  return (
    <section className="mc-next-chat-status" aria-label="Chat session status" aria-live="polite">
      <div className="mc-next-chat-status__header">
        <div>
          <span>Gateway truth</span>
          <h2>Session status</h2>
        </div>
        <div className="mc-next-chat-status__actions">
          <button
            type="button"
            className="mc-next-threaded-secondary"
            disabled={panel.loading}
            onClick={panel.onRefresh}
          >
            {panel.loading ? "Refreshing…" : "Refresh"}
          </button>
          <button
            type="button"
            className="mc-next-threaded-secondary"
            onClick={panel.onClose}
            aria-label="Close session status"
          >
            Close
          </button>
        </div>
      </div>
      {panel.error ? <p role="alert">Gateway status unavailable: {panel.error}</p> : null}
      {!status && panel.loading ? <p role="status">Reading canonical session state…</p> : null}
      {status ? (
        <div className="mc-next-chat-status__grid">
          <StatusSection title="Model" section={status.model}>
            {(value) => (
              <>
                <strong>
                  {value.providerId} / {value.model}
                </strong>
                <span>Selected by {label(value.selectionSource)}</span>
              </>
            )}
          </StatusSection>
          <StatusSection title="Context" section={status.context}>
            {(value) => (
              <>
                <strong>
                  {formatNumber(value.usedTokens)} / {formatNumber(value.contextWindowTokens)} tokens
                </strong>
                <span>
                  {value.attachmentCount} attachment{value.attachmentCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </StatusSection>
          <StatusSection title="Work" section={status.work}>
            {(value) => {
              const active = Object.values(value.turnCounts).reduce((total, count) => total + count, 0);
              return (
                <>
                  <strong>
                    {active} active or waiting turn{active === 1 ? "" : "s"}
                  </strong>
                  <span>
                    {value.durableRuns.length} linked durable run{value.durableRuns.length === 1 ? "" : "s"}
                  </span>
                </>
              );
            }}
          </StatusSection>
          <StatusSection title="Attention" section={status.attention}>
            {(value) => {
              const backgroundAttentionRequired = value.backgroundTasks.filter((task) => task.attention.required);
              return (
                <>
                  <strong>
                    {value.pendingApprovals.length} approval{value.pendingApprovals.length === 1 ? "" : "s"} ·{" "}
                    {value.pendingUserInputs.length} input request{value.pendingUserInputs.length === 1 ? "" : "s"}
                  </strong>
                  <span>
                    {value.backgroundTasks.length} background task{value.backgroundTasks.length === 1 ? "" : "s"} ·{" "}
                    {backgroundAttentionRequired.length} need attention
                  </span>
                  {backgroundAttentionRequired[0] ? (
                    <span role="status">
                      {backgroundAttentionRequired[0].label}:{" "}
                      {label(backgroundAttentionRequired[0].attention.requiredReason ?? "waiting")}
                    </span>
                  ) : null}
                  {!value.backgroundTaskProjection.complete ? (
                    <span>Some background status is unavailable: {value.backgroundTaskProjection.reason}</span>
                  ) : null}
                </>
              );
            }}
          </StatusSection>
          <StatusSection title="Orchestration" section={status.orchestration}>
            {(value) => {
              const activeRuns = value.runs.filter((run) => run.status === "running").length;
              const activeSteps = value.runs.reduce((total, run) => total + run.activeSteps, 0);
              return (
                <>
                  <strong>
                    {activeRuns} active run{activeRuns === 1 ? "" : "s"}
                  </strong>
                  <span>
                    {activeSteps} active step{activeSteps === 1 ? "" : "s"}
                  </span>
                </>
              );
            }}
          </StatusSection>
          <StatusSection title="Capabilities" section={status.capabilities}>
            {(value) => (
              <>
                <strong>
                  {value.callableTools.length} callable tool{value.callableTools.length === 1 ? "" : "s"}
                </strong>
                <span>
                  {value.trustedSkills.length} trusted skill{value.trustedSkills.length === 1 ? "" : "s"} · memory{" "}
                  {value.memory.mode}
                </span>
              </>
            )}
          </StatusSection>
          <StatusSection title="Usage" section={status.usage}>
            {(value) => (
              <>
                <strong>
                  {formatMetric(value.inputTokens)} in · {formatMetric(value.outputTokens)} out
                </strong>
                <span>
                  {formatCost(value.costUsd)} · {value.attemptCount} attempt{value.attemptCount === 1 ? "" : "s"}
                </span>
              </>
            )}
          </StatusSection>
          <StatusSection title="Build" section={status.build}>
            {(value) => (
              <>
                <strong>
                  {value.version}
                  {value.shortSha ? ` · ${value.shortSha}` : ""}
                </strong>
                <span>
                  {value.kind} · {value.integrity}
                </span>
              </>
            )}
          </StatusSection>
        </div>
      ) : null}
      {status ? (
        <StatusChip tone="muted">Updated {new Date(status.generatedAt).toLocaleTimeString()}</StatusChip>
      ) : null}
    </section>
  );
}

function StatusSection<T>({
  title,
  section,
  children,
}: {
  title: string;
  section: ChatSessionStatusSection<T>;
  children: (value: T) => React.ReactNode;
}) {
  return (
    <article className="mc-next-chat-status__section">
      <span>{title}</span>
      {section.availability === "available" ? (
        children(section.value)
      ) : (
        <>
          <strong>Unavailable</strong>
          <span>{section.reason}</span>
        </>
      )}
    </article>
  );
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "unavailable" : new Intl.NumberFormat().format(value);
}

function formatMetric(metric: { value?: number; availability: { complete: boolean } }): string {
  return metric.value === undefined || !metric.availability.complete ? "unavailable" : formatNumber(metric.value);
}

function formatCost(metric: { value?: number; availability: { complete: boolean } }): string {
  return metric.value === undefined || !metric.availability.complete
    ? "Cost unavailable"
    : `$${metric.value.toFixed(4)}`;
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}
