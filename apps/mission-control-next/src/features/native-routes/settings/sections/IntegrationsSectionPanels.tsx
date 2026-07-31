// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { ExternalLink, Plus, RefreshCw, ShieldCheck, Square } from "lucide-react";
import type {
  ExternalConnectorActionSummary,
  ExternalConnectorServiceSummary,
  ExternalSideEffectRunHealthSummary,
  ExternalSideEffectRunRecord,
  GoogleMeetPrerequisiteStatusResponse,
  GoogleMeetSessionRecord,
  IntegrationActionInvokeResult,
  IntegrationPluginRecord,
} from "@goatcitadel/contracts";
import {
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsNotice,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { formatDateTime } from "../../SettingsNativePage";

export function OperatorActionResultPanel({
  result,
}: {
  result: IntegrationActionInvokeResult & { actionLabel: string };
}) {
  const output = result.output ?? {};
  const durableWriteback = result.durableWriteback;
  return (
    <div className="mc-next-settings-panel-body">
      <SettingsNotice
        notice={{
          tone: result.status === "failed" ? "error" : result.status === "blocked" ? "warning" : "success",
          message: `${result.actionLabel}: ${result.message}`,
        }}
      />
      <NativeMetricGrid
        items={[
          { label: "Action", value: result.actionLabel, meta: result.actionId },
          { label: "Status", value: result.status, meta: result.message },
          {
            label: "Envelope",
            value: durableWriteback?.envelopeId ?? "not recorded",
            meta: durableWriteback?.status ?? "no durable writeback",
          },
          {
            label: "Replay",
            value: durableWriteback?.replayOutcome ?? readOutputText(output, "replayOutcome") ?? "not recorded",
            meta: `Resume: ${durableWriteback?.resumeState ?? readOutputText(output, "resumeState") ?? "unknown"}`,
          },
          {
            label: "Undo",
            value: result.reversibility?.label ?? durableWriteback?.reversibility?.label ?? "Cannot undo",
            meta:
              result.reversibility?.detail ??
              durableWriteback?.reversibility?.detail ??
              "No durable inverse operation is registered for this action.",
          },
          {
            label: "Idempotency",
            value: durableWriteback?.idempotencyKey ?? readOutputText(output, "idempotencyKey") ?? "not recorded",
            meta: readOutputText(output, "sideEffectRunId") ?? "No side-effect run id in response",
          },
          {
            label: "Workflow evidence",
            value: readOutputText(output, "workflowRunId") ?? "not returned",
            meta: [
              readOutputText(output, "workflowRunStatus")
                ? `Status ${readOutputText(output, "workflowRunStatus")}`
                : undefined,
              readOutputText(output, "workflowRunStatusSource")
                ? `Source ${labelForWorkflowStatusSource(readOutputText(output, "workflowRunStatusSource") ?? "")}`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · "),
          },
        ]}
      />
    </div>
  );
}

export function PluginTrustPanel({ plugins }: { plugins: IntegrationPluginRecord[] }) {
  const warningCount = plugins.reduce((count, plugin) => count + (plugin.trustWarnings?.length ?? 0), 0);
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Plugin trust"
      subtitle="Installed plugin source, integrity, readiness, and dashboard theme truth."
      stats={[
        { label: "Installed", value: String(plugins.length) },
        { label: "Warnings", value: String(warningCount) },
      ]}
    >
      <SettingsActionList
        ariaLabel="Installed integration plugins"
        items={plugins.map((plugin) => {
          const source = plugin.sourceMetadata;
          const warnings = plugin.trustWarnings ?? [];
          return {
            id: plugin.pluginId,
            label: plugin.label,
            description: [
              `${source?.display ?? plugin.source ?? "Unknown source"} · ${source?.type ?? "unknown"}`,
              `Integrity: ${plugin.integrityStatus ?? source?.integrityStatus ?? "unknown"}`,
              `State: ${plugin.enabled ? "enabled" : "disabled"}`,
              plugin.theme
                ? `Theme: ${plugin.theme.dashboardVariant ?? "default"}${plugin.theme.accentColor ? `, ${plugin.theme.accentColor}` : ""}`
                : "Theme: default",
            ].join(" | "),
            meta: warnings.length
              ? warnings.map((warning) => `${warning.severity}: ${warning.message}`).join(" | ")
              : "Setup readiness: no trust warnings",
            actionLabel: plugin.enabled ? "Enabled" : "Disabled",
          };
        })}
        emptyLabel="No integration plugins installed."
      />
    </NativeCard>
  );
}

export function DormantExternalConnectorsPanel({
  services,
  busyId,
  onReviewService,
  onReviewAction,
  onStageAction,
}: {
  services: ExternalConnectorServiceSummary[];
  busyId?: string | null;
  onReviewService: (service: ExternalConnectorServiceSummary, status: "reviewed" | "hidden") => void;
  onReviewAction: (action: ExternalConnectorActionSummary, status: "reviewed" | "hidden") => void;
  onStageAction: (action: ExternalConnectorActionSummary) => void;
}) {
  const visibleServices = services.filter((service) => service.reviewState.status !== "hidden").slice(0, 8);
  const actions = visibleServices
    .flatMap((service) => service.actions?.slice(0, 3) ?? [])
    .filter((action) => action.reviewState.status !== "hidden")
    .slice(0, 10);
  const actionCount = services.reduce((count, service) => count + service.actionCount, 0);
  const stagedCount = services.reduce(
    (count, service) =>
      count + (service.actions ?? []).filter((action) => action.reviewState.status === "staged").length,
    0,
  );
  const source = services[0]?.source;

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Dormant connector catalog"
      subtitle="Imported MSCR services are default-off, non-callable, and staged only as capability proposals."
      scrollBody
      bodyMaxHeight="min(48vh, 28rem)"
      stats={[
        { label: "Services", value: String(services.length) },
        { label: "Actions", value: String(actionCount) },
        { label: "Staged", value: String(stagedCount) },
      ]}
    >
      <SettingsNotice
        notice={{
          tone: "info",
          message: source
            ? `${source.label} pinned at ${source.commit.slice(0, 12)}. Imported handlers are not executed by GoatCitadel.`
            : "No external connector source is loaded.",
        }}
      />
      {visibleServices.length ? (
        <div className="mc-next-settings-stack">
          {visibleServices.map((service) => {
            const serviceBusyId = `service:${service.sourceId}:${service.serviceId}`;
            return (
              <div key={service.catalogId} className="mc-next-settings-panel-body">
                <NativeMetricGrid
                  items={[
                    { label: "Service", value: service.label, meta: service.description || service.serviceId },
                    {
                      label: "Actions",
                      value: String(service.actionCount),
                      meta: `${service.activeActionCount} active upstream`,
                    },
                    {
                      label: "Review",
                      value: service.reviewState.status,
                      meta: service.reviewState.note ?? "No operator note",
                    },
                  ]}
                />
                <SettingsButtonRow>
                  <NativeButton
                    variant="secondary"
                    disabled={busyId === serviceBusyId || service.reviewState.status === "reviewed"}
                    onClick={() => onReviewService(service, "reviewed")}
                  >
                    <ShieldCheck size={16} />
                    Mark reviewed
                  </NativeButton>
                  <NativeButton
                    variant="ghost"
                    disabled={busyId === serviceBusyId}
                    onClick={() => onReviewService(service, "hidden")}
                  >
                    <Square size={16} />
                    Hide
                  </NativeButton>
                </SettingsButtonRow>
              </div>
            );
          })}
        </div>
      ) : (
        <SettingsEmptyState label="No visible dormant external connectors." />
      )}
      {actions.length ? (
        <div className="mc-next-settings-stack">
          {actions.map((action) => {
            const actionBusyId = `action:${action.sourceId}:${action.serviceId}:${action.actionId}`;
            const staged = action.reviewState.status === "staged";
            return (
              <div key={action.catalogId} className="mc-next-settings-panel-body">
                <NativeMetricGrid
                  items={[
                    { label: "Action", value: action.label, meta: action.description || action.actionId },
                    {
                      label: "Fields",
                      value: String(action.configurationFields.length),
                      meta: action.active ? "Active upstream" : "Inactive upstream",
                    },
                    {
                      label: "Handler hash",
                      value: action.handlerSha256?.slice(0, 12) ?? "missing",
                      meta: action.upstreamPath,
                    },
                  ]}
                />
                <SettingsButtonRow>
                  <NativeButton
                    variant="default"
                    disabled={busyId === actionBusyId || staged}
                    onClick={() => onStageAction(action)}
                  >
                    <Plus size={16} />
                    {staged ? "Staged" : "Stage proposal"}
                  </NativeButton>
                  <NativeButton
                    variant="secondary"
                    disabled={busyId === actionBusyId || action.reviewState.status === "reviewed"}
                    onClick={() => onReviewAction(action, "reviewed")}
                  >
                    <ShieldCheck size={16} />
                    Reviewed
                  </NativeButton>
                  <NativeButton
                    variant="ghost"
                    disabled={busyId === actionBusyId}
                    onClick={() => onReviewAction(action, "hidden")}
                  >
                    <Square size={16} />
                    Hide
                  </NativeButton>
                </SettingsButtonRow>
              </div>
            );
          })}
        </div>
      ) : null}
    </NativeCard>
  );
}

export function ExternalSideEffectLedgerPanel({
  runs,
  summary,
  selectedConnectionId,
  busy,
  onStartReplayAudit,
  lastReplayAuditRunId,
  onOpenReplayAudit,
}: {
  runs: ExternalSideEffectRunRecord[];
  summary?: ExternalSideEffectRunHealthSummary;
  selectedConnectionId?: string;
  busy?: boolean;
  onStartReplayAudit: (run?: ExternalSideEffectRunRecord) => void;
  lastReplayAuditRunId?: string | null;
  onOpenReplayAudit: (runId: string) => void;
}) {
  const selectedConnectionRuns = selectedConnectionId
    ? runs.filter((run) => run.connectionId === selectedConnectionId)
    : runs;
  const unknownCount = runs.filter((run) => run.status === "unknown_external_outcome").length;
  const blockedCount = runs.filter(
    (run) =>
      run.status === "blocked_duplicate" ||
      run.status === "payload_mismatch" ||
      run.status === "idempotency_unavailable",
  ).length;
  const visibleRuns = selectedConnectionRuns.length ? selectedConnectionRuns : runs;
  const replayAuditCandidates = visibleRuns.filter(isExternalSideEffectReplayAuditCandidate);
  const health = summary ?? buildExternalSideEffectFallbackSummary(runs);

  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="External side effects"
      subtitle="Read-only ledger for integration writebacks that crossed, or prepared to cross, an external boundary."
      stats={[
        { label: "Recent", value: String(runs.length) },
        { label: "Unknown", value: String(unknownCount) },
        { label: "Blocked", value: String(blockedCount) },
      ]}
    >
      <NativeMetricGrid
        items={[
          {
            label: "Success rate",
            value: formatExternalSideEffectSuccessRate(health.successRate),
            meta: `${health.total} ledger rows`,
          },
          {
            label: "Failed before boundary",
            value: String(health.failedBeforeBoundaryCount),
            meta: "Replay-audit review",
          },
          {
            label: "Unknown outcome",
            value: String(health.unknownOutcomeCount),
            meta: "Manual reconciliation",
          },
          {
            label: "Stale claimed",
            value: String(health.staleClaimedNotSentCount),
            meta: "Claimed but not sent",
          },
          {
            label: "Replay audit eligible",
            value: String(health.replayAuditEligibleCount),
            meta: "Read-only eligibility",
          },
          {
            label: "Last status check",
            value: health.lastStatusCheckAt ? formatDateTime(health.lastStatusCheckAt) : "Never",
            meta: health.posture.operatorTriggeredStatusReads ? "Operator-triggered" : "Unknown",
          },
        ]}
      />
      <SettingsActionList
        ariaLabel="External side-effect runs"
        items={visibleRuns.map((run) => {
          const workflowEvidence = formatActivepiecesWorkflowEvidence(run);
          return {
            id: run.runId,
            label: `${labelForExternalSideEffectStatus(run.status)} · ${run.actionId ?? run.boundary}`,
            description: [
              run.connectionId ? `Connection ${run.connectionId}` : "No connection recorded",
              run.catalogId ?? "Unknown catalog",
              `Attempts ${run.attemptCount}`,
              `Updated ${formatDateTime(run.updatedAt)}`,
            ].join(" · "),
            meta: [
              `Resume: ${labelForExternalSideEffectResumeState(run.resumeState)}`,
              `Undo: ${run.reversibility?.label ?? labelForExternalSideEffectReversibility(run)}`,
              `Replay: ${run.replayOutcome ?? "not recorded"}`,
              ...workflowEvidence,
              run.errorText ? `Error: ${run.errorText}` : undefined,
            ]
              .filter(Boolean)
              .join(" | "),
            actionLabel: labelForExternalSideEffectStatus(run.status),
          };
        })}
        emptyLabel="No external side-effect run records are available."
        maxHeight="min(34vh, 20rem)"
      />
      <SettingsButtonRow>
        <NativeButton
          variant="secondary"
          disabled={busy || replayAuditCandidates.length === 0}
          onClick={() => onStartReplayAudit(replayAuditCandidates[0])}
        >
          <RefreshCw size={16} />
          Start replay audit
        </NativeButton>
        {lastReplayAuditRunId ? (
          <NativeButton variant="secondary" onClick={() => onOpenReplayAudit(lastReplayAuditRunId)}>
            <ExternalLink size={16} />
            Open replay audit
          </NativeButton>
        ) : null}
      </SettingsButtonRow>
      <SettingsNotice
        notice={{
          tone: replayAuditCandidates.length ? "info" : "warning",
          message: `${health.posture.note} ${
            replayAuditCandidates.length
              ? "Replay audits create a durable eligibility check for pre-boundary or stale claimed-not-sent runs; they do not retry unknown post-boundary outcomes."
              : "No replay-audit candidates are visible. Started, completed, blocked, and unknown external outcomes remain manual reconciliation."
          }`,
        }}
      />
      {selectedConnectionId && !selectedConnectionRuns.length && runs.length ? (
        <SettingsNotice
          notice={{
            tone: "info",
            message: "The selected connection has no side-effect ledger records in the recent workspace window.",
          }}
        />
      ) : null}
    </NativeCard>
  );
}

function buildExternalSideEffectFallbackSummary(
  runs: ExternalSideEffectRunRecord[],
): ExternalSideEffectRunHealthSummary {
  const completed = runs.filter((run) => run.status === "completed").length;
  return {
    generatedAt: new Date().toISOString(),
    total: runs.length,
    successRate: runs.length ? completed / runs.length : 0,
    failedBeforeBoundaryCount: runs.filter((run) => run.status === "failed_before_boundary").length,
    unknownOutcomeCount: runs.filter((run) => run.status === "unknown_external_outcome").length,
    staleClaimedNotSentCount: 0,
    replayAuditEligibleCount: runs.filter(isExternalSideEffectReplayAuditCandidate).length,
    lastStatusCheckAt: runs
      .map((run) => run.updatedAt)
      .filter(Boolean)
      .sort()
      .at(-1),
    manualReconciliationCount: runs.filter((run) => run.status === "unknown_external_outcome").length,
    posture: {
      readOnly: true,
      operatorTriggeredStatusReads: true,
      hiddenPolling: false,
      managedWorkflowLifecycle: false,
      note: "External bridge health is derived from visible ledger rows; no hidden polling is active.",
    },
  };
}

function formatExternalSideEffectSuccessRate(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }
  return `${Math.round(value * 100)}%`;
}

function isExternalSideEffectReplayAuditCandidate(run: ExternalSideEffectRunRecord): boolean {
  return run.status === "failed_before_boundary" || run.status === "claimed_not_sent";
}

function labelForExternalSideEffectStatus(status: ExternalSideEffectRunRecord["status"]): string {
  switch (status) {
    case "claimed_not_sent":
      return "Claimed";
    case "external_call_started":
      return "Started";
    case "completed":
      return "Completed";
    case "failed_before_boundary":
      return "Failed before boundary";
    case "unknown_external_outcome":
      return "Unknown outcome";
    case "blocked_duplicate":
      return "Duplicate blocked";
    case "payload_mismatch":
      return "Payload mismatch";
    case "idempotency_unavailable":
      return "Idempotency unavailable";
    default:
      return "Unknown";
  }
}

function labelForExternalSideEffectResumeState(state: ExternalSideEffectRunRecord["resumeState"]): string {
  switch (state) {
    case "manual_retry_after_recorded_failure":
      return "manual retry";
    case "in_progress":
      return "in progress";
    case "payload_mismatch":
      return "payload mismatch";
    case "idempotency_unavailable":
      return "idempotency unavailable";
    case "completed":
      return "completed";
    default:
      return "not resumable";
  }
}

function labelForExternalSideEffectReversibility(run: ExternalSideEffectRunRecord): string {
  if (run.status === "unknown_external_outcome" || run.resumeState === "manual_review_unknown_external_outcome") {
    return "Manual reconciliation";
  }
  if (
    run.replayPolicy === "idempotent_external" &&
    (run.status === "claimed_not_sent" ||
      run.status === "failed_before_boundary" ||
      run.resumeState === "manual_retry_after_recorded_failure")
  ) {
    return "Replay audit only";
  }
  return "Cannot undo";
}

function formatActivepiecesWorkflowEvidence(run: ExternalSideEffectRunRecord): string[] {
  if (run.catalogId !== "automation.activepieces" && !run.routePath.includes("automation.activepieces")) {
    return [];
  }
  const payload = run.responsePayload ?? {};
  const workflowRunId =
    readOutputText(payload, "workflowRunId") ?? readExternalReferenceValue(run.externalReferenceId, "workflowRunId");
  const workflowRunStatus = readOutputText(payload, "workflowRunStatus");
  const workflowRunUrl = formatDisplayedWorkflowUrl(readOutputText(payload, "workflowRunUrl"));
  const workflowRunStatusSource =
    readOutputText(payload, "workflowRunStatusSource") ??
    (workflowRunId || workflowRunStatus || workflowRunUrl ? "webhook_response" : undefined);
  if (!workflowRunId && !workflowRunStatus && !workflowRunUrl) {
    return [];
  }
  return [
    workflowRunId ? `Workflow: ${workflowRunId}` : undefined,
    workflowRunStatus ? `Status: ${workflowRunStatus}` : undefined,
    workflowRunStatusSource ? `Source: ${labelForWorkflowStatusSource(workflowRunStatusSource)}` : undefined,
    workflowRunUrl ? `URL: ${workflowRunUrl}` : undefined,
    "Status sync: webhook response only",
  ].filter((item): item is string => Boolean(item));
}

function readExternalReferenceValue(referenceId: string | undefined, expectedKey: string): string | undefined {
  if (!referenceId) {
    return undefined;
  }
  const separatorIndex = referenceId.indexOf(":");
  if (separatorIndex <= 0) {
    return undefined;
  }
  const key = referenceId.slice(0, separatorIndex);
  const value = referenceId.slice(separatorIndex + 1).trim();
  return key === expectedKey && value ? value : undefined;
}

function labelForWorkflowStatusSource(source: string): string {
  if (source === "webhook_response") {
    return "webhook response";
  }
  if (source === "activepieces_api") {
    return "Activepieces API";
  }
  return source;
}

function formatDisplayedWorkflowUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function readOutputText(output: Record<string, unknown>, key: string): string | undefined {
  const value = output[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function GoogleMeetStatusPanel({
  status,
  sessions,
  form,
  busySessionId,
  onFormChange,
  onStartOpenAIRealtime,
  onStopSession,
  onConsultSession,
}: {
  status: GoogleMeetPrerequisiteStatusResponse | null;
  sessions: GoogleMeetSessionRecord[];
  form: { meetingUrl: string; displayName: string; accountRef: string };
  busySessionId?: string | null;
  onFormChange: (next: { meetingUrl: string; displayName: string; accountRef: string }) => void;
  onStartOpenAIRealtime: () => void;
  onStopSession: (session: GoogleMeetSessionRecord) => void;
  onConsultSession: (session: GoogleMeetSessionRecord) => void;
}) {
  const actionableSession =
    sessions.find((session) => session.state === "running" || session.state === "consulting") ?? sessions[0] ?? null;
  return (
    <NativeCard
      density="compact"
      className="mc-next-settings-panel"
      title="Google Meet voice"
      subtitle="OpenAI Realtime meeting voice stays gated by OAuth, provider, browser, audio, and explicit user start."
      stats={[
        { label: "State", value: status?.state ?? "unknown" },
        { label: "Sessions", value: String(sessions.length) },
      ]}
    >
      <SettingsFieldGrid>
        <SettingsField label="Meet URL" span={2}>
          <input
            className="mc-next-settings-input"
            value={form.meetingUrl}
            onChange={(event) => onFormChange({ ...form, meetingUrl: event.target.value })}
            placeholder="https://meet.google.com/abc-defg-hij"
          />
        </SettingsField>
        <SettingsField label="Display name">
          <input
            className="mc-next-settings-input"
            value={form.displayName}
            onChange={(event) => onFormChange({ ...form, displayName: event.target.value })}
            placeholder="Optional"
          />
        </SettingsField>
        <SettingsField label="Account ref">
          <input
            className="mc-next-settings-input"
            value={form.accountRef}
            onChange={(event) => onFormChange({ ...form, accountRef: event.target.value })}
            placeholder="OAuth account reference"
          />
        </SettingsField>
      </SettingsFieldGrid>
      <SettingsButtonRow>
        <NativeButton variant="default" disabled={Boolean(busySessionId)} onClick={onStartOpenAIRealtime}>
          <Plus size={16} />
          Start OpenAI Realtime
        </NativeButton>
        {actionableSession ? (
          <>
            <NativeButton
              variant="secondary"
              disabled={Boolean(busySessionId)}
              onClick={() => onConsultSession(actionableSession)}
            >
              <ExternalLink size={16} />
              Consult Chat
            </NativeButton>
            <NativeButton
              variant="secondary"
              disabled={Boolean(busySessionId)}
              onClick={() => onStopSession(actionableSession)}
            >
              <Square size={16} />
              Stop session
            </NativeButton>
          </>
        ) : null}
      </SettingsButtonRow>
      {status ? (
        <>
          <NativeMetricGrid
            items={[
              {
                label: "Provider",
                value: status.provider ?? "unknown",
                meta: status.failureReason ?? `Checked ${formatDateTime(status.checkedAt)}`,
              },
              {
                label: "Auth profile",
                value: status.authProfile?.available ? "available" : "missing",
                meta: status.authProfile?.accountRef ?? "OAuth handoff has not provided an account reference",
              },
            ]}
          />
          <SettingsActionList
            ariaLabel="Google Meet prerequisites"
            items={(status.prerequisites ?? []).map((item) => ({
              id: item.id,
              label: labelForMeetPrerequisite(item.id),
              description: item.message,
              meta: item.ready ? "ready" : "blocked",
              actionLabel: item.ready ? "Ready" : "Blocked",
            }))}
          />
          <SettingsActionList
            ariaLabel="Google Meet sessions"
            items={sessions.map((session) => ({
              id: session.sessionId,
              label: session.displayName ?? session.meetingUrl,
              description:
                session.failureReason ?? `${session.provider} · ${session.transcript.length} transcript chunks`,
              meta: `${session.state} · updated ${formatDateTime(session.updatedAt)}`,
              actionLabel: session.state,
            }))}
            emptyLabel="No Google Meet sessions recorded."
          />
        </>
      ) : (
        <SettingsEmptyState label="Google Meet prerequisite status is unavailable from the gateway." />
      )}
    </NativeCard>
  );
}

function labelForMeetPrerequisite(id: string): string {
  switch (id) {
    case "oauth_profile":
      return "OAuth profile";
    case "provider_key":
      return "Provider key";
    case "browser_transport":
      return "Browser transport";
    case "audio_transport":
      return "Audio transport";
    case "user_start":
      return "User start";
    default:
      return id;
  }
}
