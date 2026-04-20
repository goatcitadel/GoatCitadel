import type { ChatThreadTurnRecord, RoutingPreflightResult } from "@goatcitadel/contracts";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";
import { ChatTraceCard } from "../../components/ChatTraceCard";
import { ChatExecutionPlanSummary } from "../../components/chat/ChatExecutionPlanSummary";
import type { CoworkRunViewModel } from "../../components/cowork-view-model";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";

function formatRoutingTarget(providerId?: string, model?: string, apiStyle?: string): string {
  return [providerId, model, apiStyle].filter((value): value is string => Boolean(value)).join(" · ") || "not recorded";
}

function renderCoworkTimeline(viewModel: CoworkRunViewModel | null) {
  if (!viewModel || viewModel.timelineItems.items.length === 0) {
    return (
      <p className="chat-cowork-section-copy">Timeline details will appear here once Cowork records checkpoints.</p>
    );
  }
  return (
    <>
      <ul className="chat-cowork-orchestration-steps">
        {viewModel.timelineItems.items.map((item) => (
          <li key={item.id}>
            <div className="chat-cowork-step-head">
              <strong>{item.title}</strong>
              {item.status ? <span>{item.status}</span> : null}
            </div>
            {item.meta ? <p className="chat-cowork-step-meta">{item.meta}</p> : null}
            {item.note ? <p>{item.note}</p> : null}
          </li>
        ))}
      </ul>
      {viewModel.timelineItems.overflow > 0 ? (
        <p className="chat-cowork-overflow-note">+{viewModel.timelineItems.overflow} earlier timeline item(s)</p>
      ) : null}
    </>
  );
}

export function ChatDockRunTraceSection(props: {
  isChatSurface: boolean;
  isCoworkSurface?: boolean;
  selectedTurn: ChatThreadTurnRecord;
  coworkViewModel?: CoworkRunViewModel | null;
  routePreflight?: RoutingPreflightResult | null;
  providerLabelById?: Map<string, string>;
}) {
  const {
    isChatSurface,
    isCoworkSurface = false,
    selectedTurn,
    coworkViewModel = null,
    routePreflight = null,
    providerLabelById,
  } = props;
  const trace = selectedTurn.trace;
  const requestedRoute = formatRoutingTarget(
    trace.routing.primaryProviderId,
    trace.routing.primaryModel,
    trace.routing.primaryApiStyle,
  );
  const effectiveRoute = formatRoutingTarget(
    trace.routing.effectiveProviderId,
    trace.routing.effectiveModel ?? trace.model,
    trace.routing.effectiveApiStyle,
  );
  const fallbackSummary = trace.routing.fallbackUsed
    ? `Fallback used${trace.routing.fallbackReason ? ` · ${trace.routing.fallbackReason}` : ""}`
    : trace.routing.fallbackReason
      ? `Fallback armed · ${trace.routing.fallbackReason}`
      : "Fallback off";
  const currentRoute = routePreflight
    ? formatRoutingTarget(
        routePreflight.effectiveProviderId
          ? (providerLabelById?.get(routePreflight.effectiveProviderId) ?? routePreflight.effectiveProviderId)
          : undefined,
        routePreflight.effectiveModel,
      )
    : undefined;

  if (!isCoworkSurface) {
    return (
      <Panel
        className="chat-v11-agentic-card chat-v11-trace-card chat-v11-panel-trace"
        title={isChatSurface ? "Run status" : "Run trace"}
        actions={
          <StatusChip
            tone={
              selectedTurn.trace.status === "completed"
                ? "success"
                : selectedTurn.trace.status === "failed"
                  ? "critical"
                  : "warning"
            }
          >
            {selectedTurn.trace.status}
          </StatusChip>
        }
      >
        <ChatTraceCard trace={selectedTurn.trace} defaultCollapsed={isChatSurface} />
      </Panel>
    );
  }

  return (
    <Panel
      className="chat-v11-agentic-card chat-v11-trace-card chat-v11-panel-trace"
      title="Run details"
      subtitle="Summary, routing, tools, and raw trace for the selected turn."
      actions={
        <StatusChip
          tone={trace.status === "completed" ? "success" : trace.status === "failed" ? "critical" : "warning"}
        >
          {trace.status}
        </StatusChip>
      }
    >
      <Tabs defaultValue="summary" className="chat-run-details-tabs">
        <TabsList>
          <TabsTrigger value="summary">Summary</TabsTrigger>
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="routing">Routing</TabsTrigger>
          <TabsTrigger value="tools">Tools</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="chat-run-details-content">
          <div className="chat-run-details-grid">
            <div className="chat-run-details-card">
              <span>Status</span>
              <strong>{trace.status}</strong>
            </div>
            <div className="chat-run-details-card">
              <span>Requested</span>
              <strong>{requestedRoute}</strong>
            </div>
            <div className="chat-run-details-card">
              <span>Effective</span>
              <strong>{effectiveRoute}</strong>
            </div>
            <div className="chat-run-details-card">
              <span>Fallback</span>
              <strong>{fallbackSummary}</strong>
            </div>
          </div>
          {trace.failure ? (
            <div className="chat-trace-section">
              <strong>Recovery</strong>
              <p>{trace.failure.message}</p>
            </div>
          ) : null}
          {routePreflight?.normalizationReason ? (
            <div className="chat-trace-section">
              <strong>Preflight warning</strong>
              <p>{routePreflight.normalizationReason}</p>
            </div>
          ) : null}
          {coworkViewModel?.selectionLabel ? (
            <p className="chat-cowork-section-copy">{coworkViewModel.selectionLabel}</p>
          ) : null}
        </TabsContent>

        <TabsContent value="plan" className="chat-run-details-content">
          {trace.executionPlan ? (
            <ChatExecutionPlanSummary plan={trace.executionPlan} />
          ) : (
            <p className="chat-cowork-section-copy">No execution plan is attached to this turn yet.</p>
          )}
        </TabsContent>

        <TabsContent value="timeline" className="chat-run-details-content">
          {renderCoworkTimeline(coworkViewModel)}
        </TabsContent>

        <TabsContent value="routing" className="chat-run-details-content">
          {currentRoute ? (
            <div className="chat-trace-section">
              <strong>Will use current selected route</strong>
              <p>{currentRoute}</p>
            </div>
          ) : null}
          <div className="chat-trace-section">
            <strong>Original turn route</strong>
            <p>{effectiveRoute}</p>
          </div>
          <div className="chat-trace-section">
            <strong>Requested route</strong>
            <p>{requestedRoute}</p>
          </div>
          <div className="chat-trace-section">
            <strong>Fallback</strong>
            <p>{fallbackSummary}</p>
          </div>
          {routePreflight?.normalizationReason ? (
            <div className="chat-trace-section">
              <strong>Normalization</strong>
              <p>{routePreflight.normalizationReason}</p>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="tools" className="chat-run-details-content">
          {trace.toolRuns.length > 0 ? (
            <ul className="chat-trace-list">
              {trace.toolRuns.map((run) => (
                <li key={run.toolRunId}>
                  <span>{run.toolName}</span>
                  <span>{run.status}</span>
                  {run.error ? <p>{run.error}</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="chat-cowork-section-copy">No tool runs were recorded for this turn.</p>
          )}
        </TabsContent>

        <TabsContent value="raw" className="chat-run-details-content">
          <pre className="chat-run-details-raw">
            {JSON.stringify(
              {
                trace,
                cowork: coworkViewModel?.raw ?? null,
              },
              null,
              2,
            )}
          </pre>
        </TabsContent>
      </Tabs>
    </Panel>
  );
}
