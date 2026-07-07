import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type {
  BrowserSessionEventRecord,
  BrowserSessionGrantRecord,
  BrowserSessionGrantScope,
  BrowserSessionRecord,
  BrowserSessionStateProjection,
  BrowserSessionStatus,
} from "@goatcitadel/contracts";
import {
  closeBrowserSession,
  createBrowserSession,
  createBrowserSessionGrant,
  fetchBrowserSessionEvents,
  fetchBrowserSessionGrants,
  fetchBrowserSessionState,
  fetchBrowserSessions,
  revokeBrowserSessionGrant,
  rotateBrowserSessionGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { formatDateTime, nativeLoad, nativeLoadIssues, useAsyncLoad } from "../shared/native-helpers";
import { LibraryLoadWarnings, LibraryMetricGrid } from "../shared/library-primitives";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

type BrowserSessionFilter = BrowserSessionStatus | "all";
const GRANT_SCOPES: BrowserSessionGrantScope[] = ["read", "interact", "state", "admin"];
const GRANT_SCOPE_RANK: Record<BrowserSessionGrantScope, number> = {
  read: 1,
  interact: 2,
  state: 3,
  admin: 4,
};
const EMPTY_BROWSER_SESSIONS: BrowserSessionRecord[] = [];

export function BrowserSessionsRoutePage({ route, activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
  const [filter, setFilter] = useState<BrowserSessionFilter>("active");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [sessionDraft, setSessionDraft] = useState({ label: "Shared browser session" });
  const [grantDraft, setGrantDraft] = useState({
    actorId: "operator",
    scopes: ["read"] as BrowserSessionGrantScope[],
    allowedHosts: "",
    ttlSeconds: 900,
  });

  const load = useCallback(async () => {
    const sessions = await nativeLoad(
      "Browser sessions",
      fetchBrowserSessions({ workspaceId: activeWorkspaceId, status: filter, limit: 100 }),
      [] as BrowserSessionRecord[],
    );
    return { issues: nativeLoadIssues([sessions]), sessions: sessions.data };
  }, [activeWorkspaceId, filter]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const sessions = data?.sessions ?? EMPTY_BROWSER_SESSIONS;
  const activeCount = sessions.filter((item) => item.status === "active").length;
  const selectedSession = sessions.find((item) => item.sessionId === selectedSessionId) ?? sessions[0] ?? null;

  useEffect(() => {
    setSelectedSessionId((current) =>
      sessions.some((item) => item.sessionId === current) ? current : (sessions[0]?.sessionId ?? ""),
    );
  }, [sessions]);

  const detail = useBrowserSessionDetail(selectedSession?.sessionId ?? "");
  const posture = selectedSession ? buildBrowserSessionPosture(selectedSession, detail.grants, detail.events) : null;
  const stateProjection = detail.stateProjection;

  const createSession = async () => {
    const label = sessionDraft.label.trim();
    if (!label) {
      setActionError("Session label is required.");
      return;
    }
    setBusyAction("create-session");
    setActionError(null);
    setNotice(null);
    try {
      const created = await createBrowserSession({ workspaceId: activeWorkspaceId, label });
      setFilter("active");
      setSelectedSessionId(created.sessionId);
      setNotice("Browser session created. Create a scoped grant before tools can use it.");
      if (filter === "active") {
        await reload();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const closeSelectedSession = async () => {
    if (!selectedSession) {
      return;
    }
    setBusyAction("close-session");
    setActionError(null);
    setNotice(null);
    try {
      await closeBrowserSession(selectedSession.sessionId);
      setNotice("Browser session closed and active grants revoked.");
      await reload();
      await detail.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const createGrant = async () => {
    if (!selectedSession) {
      return;
    }
    const actorId = grantDraft.actorId.trim();
    if (!actorId) {
      setActionError("Grant actor is required.");
      return;
    }
    if (grantDraft.scopes.length === 0) {
      setActionError("Choose at least one grant scope.");
      return;
    }
    setBusyAction("create-grant");
    setActionError(null);
    setNotice(null);
    try {
      await createBrowserSessionGrant(selectedSession.sessionId, {
        actorId,
        scopes: grantDraft.scopes,
        allowedHosts: parseHostList(grantDraft.allowedHosts),
        ttlSeconds: grantDraft.ttlSeconds > 0 ? grantDraft.ttlSeconds : undefined,
      });
      setNotice("Scoped browser-session grant created.");
      await detail.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  const handleGrantAction = async (grant: BrowserSessionGrantRecord, action: "rotate" | "revoke") => {
    if (!selectedSession) {
      return;
    }
    setBusyAction(`${action}:${grant.grantId}`);
    setActionError(null);
    setNotice(null);
    try {
      if (action === "rotate") {
        await rotateBrowserSessionGrant(selectedSession.sessionId, grant.grantId);
        setNotice("Grant rotated with the same actor, scopes, and host posture.");
      } else {
        await revokeBrowserSessionGrant(selectedSession.sessionId, grant.grantId);
        setNotice("Grant revoked.");
      }
      await detail.reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <NativePageFrame
      area="ops"
      icon={ShieldCheck}
      kicker={routeKicker(route)}
      title="Browser Sessions"
      description={`Govern in-memory browser session state, grants, and events for ${activeWorkspaceName}.`}
      loading={loading}
      // Only a failed load (error) is fatal and replaces the page (Finding 10). A failed
      // action (actionError) is non-fatal — the session board is still valid and stays
      // visible with an inline error banner below, so operators keep their draft/selection.
      error={error}
      metrics={[
        { label: "Visible", value: String(sessions.length) },
        { label: "Active", value: String(activeCount) },
        { label: "Grants", value: String(detail.grants.length) },
        { label: "Events", value: String(detail.events.length) },
      ]}
      actions={
        <NativeButton variant="secondary" onClick={() => void reload()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </NativeButton>
      }
    >
      <LibraryLoadWarnings issues={[...(data?.issues ?? []), ...detail.issues]} onRetry={() => void reload()} />
      {actionError ? (
        <div data-testid="browser-sessions-action-error">
          <NoticeBanner tone="error" message={actionError} />
        </div>
      ) : null}
      {notice ? <NoticeBanner tone="success" message={notice} /> : null}
      <NativeGrid>
        <NativeCard
          title="Sessions"
          subtitle="Session IDs govern browser state and grants; they are not Chat session or durable run IDs."
          stats={[
            { label: "Workspace", value: activeWorkspaceId },
            { label: "Filter", value: filter },
          ]}
        >
          <div className="mc-next-browser-session-controls">
            <div className="mc-next-settings-filter-bar" role="radiogroup" aria-label="Browser session filter">
              {(["active", "closed", "all"] as BrowserSessionFilter[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={`mc-next-settings-filter${filter === item ? " active" : ""}`}
                  aria-pressed={filter === item}
                  onClick={() => setFilter(item)}
                >
                  {labelForFilter(item)}
                </button>
              ))}
            </div>
            <label className="mc-next-settings-field">
              <span>New session label</span>
              <input
                className="mc-next-settings-input"
                value={sessionDraft.label}
                onChange={(event) => setSessionDraft({ label: event.target.value })}
                placeholder="Research browser"
              />
            </label>
            <button
              type="button"
              className="mc-next-directory-action"
              disabled={busyAction === "create-session"}
              onClick={() => void createSession()}
            >
              <span>Create governed session</span>
            </button>
          </div>
          {sessions.length > 0 ? (
            <div className="mc-next-browser-session-list" data-native-scroll="true">
              {sessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  className={`mc-next-browser-session-row${
                    selectedSession?.sessionId === session.sessionId ? " active" : ""
                  }`}
                  onClick={() => setSelectedSessionId(session.sessionId)}
                >
                  <strong>{session.label}</strong>
                  <span>
                    {session.status} · {formatDateTime(session.updatedAt)}
                  </span>
                  <small>{shortId(session.sessionId)}</small>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState size="compact" title="No browser sessions match this filter." />
          )}
        </NativeCard>

        <NativeCard
          title={selectedSession?.label ?? "Session detail"}
          subtitle="Visible posture is limited to grants and events; cookie or storage values are not shown here."
          stats={[
            { label: "State", value: selectedSession?.status ?? "none" },
            { label: "Actor", value: selectedSession?.createdBy ?? "unknown" },
          ]}
        >
          {selectedSession ? (
            <>
              <div className="mc-next-approvals-chip-row">
                <StatusChip tone={selectedSession.status === "active" ? "success" : "muted"}>
                  {selectedSession.status}
                </StatusChip>
                <StatusChip tone="muted">{shortId(selectedSession.sessionId)}</StatusChip>
              </div>
              <LibraryMetricGrid
                items={[
                  {
                    label: "Created",
                    value: formatDateTime(selectedSession.createdAt),
                    meta: selectedSession.createdBy,
                  },
                  { label: "Updated", value: formatDateTime(selectedSession.updatedAt), meta: "session record" },
                  { label: "Closed", value: formatDateTime(selectedSession.closedAt), meta: "if closed" },
                  { label: "Workspace", value: selectedSession.workspaceId ?? "Unscoped", meta: "session binding" },
                ]}
              />
              <button
                type="button"
                className="mc-next-directory-action"
                disabled={selectedSession.status !== "active" || busyAction === "close-session"}
                onClick={() => void closeSelectedSession()}
              >
                <span>Close session and revoke grants</span>
              </button>
            </>
          ) : (
            <EmptyState size="compact" title="Select or create a browser session." />
          )}
        </NativeCard>

        <NativeCard
          title="State and tool posture"
          subtitle="Derived from session records, scoped grants, and retained guard events; browser state values remain hidden."
          stats={[
            { label: "Callable", value: posture?.callableState ?? "none" },
            { label: "State", value: stateProjection?.state.availability ?? "unknown" },
          ]}
        >
          {posture ? (
            <>
              <div className="mc-next-approvals-chip-row">
                <StatusChip tone={posture.callableTone}>{posture.callableState}</StatusChip>
                <StatusChip tone={posture.guardBlockCount > 0 ? "warning" : "muted"}>
                  {posture.guardBlockCount} guard blocks
                </StatusChip>
              </div>
              <LibraryMetricGrid
                items={[
                  { label: "Active grants", value: String(posture.activeGrantCount), meta: posture.highestScope },
                  { label: "Hosts", value: posture.hostPosture, meta: posture.hostSummary },
                  { label: "Latest access", value: posture.latestToolEvidence, meta: "from retained events" },
                  {
                    label: "State values",
                    value: "Hidden",
                    meta: stateProjection
                      ? `${stateProjection.state.retention} ${stateProjection.state.source}`
                      : "cookies, storage, and page values are not exposed",
                  },
                ]}
              />
              <p className="mc-next-settings-field-note">{posture.summary}</p>
            </>
          ) : (
            <EmptyState size="compact" title="Select a browser session to inspect posture." />
          )}
        </NativeCard>

        <NativeCard
          title="Read-only state projection"
          subtitle="Counts and origins come from volatile browser-session memory; sensitive values stay hidden."
          stats={[
            { label: "Availability", value: stateProjection?.state.availability ?? "unknown" },
            {
              label: "Updated",
              value: stateProjection?.state.updatedAt
                ? formatDateTime(stateProjection.state.updatedAt)
                : "Not retained",
            },
          ]}
        >
          {stateProjection ? (
            <>
              <div className="mc-next-approvals-chip-row">
                <StatusChip tone={stateProjection.state.availability === "present" ? "success" : "muted"}>
                  {formatStateAvailability(stateProjection.state.availability)}
                </StatusChip>
                <StatusChip tone="muted">values hidden</StatusChip>
              </div>
              <LibraryMetricGrid
                items={[
                  {
                    label: "Cookies",
                    value: String(stateProjection.state.cookies.count),
                    meta: formatLimitedList(stateProjection.state.cookies.domains, "domains"),
                  },
                  {
                    label: "Local storage",
                    value: `${stateProjection.state.localStorage.originCount} origins`,
                    meta: `${stateProjection.state.localStorage.keyCount} keys`,
                  },
                  {
                    label: "Session storage",
                    value: `${stateProjection.state.sessionStorage.originCount} origins`,
                    meta: `${stateProjection.state.sessionStorage.keyCount} keys`,
                  },
                  {
                    label: "Recent events",
                    value: String(stateProjection.eventSummary.recentEventCount),
                    meta: `${stateProjection.eventSummary.grantedAccessCount} granted · ${stateProjection.eventSummary.guardBlockCount} blocked`,
                  },
                ]}
              />
              <NativeList
                density="compact"
                items={[
                  {
                    title: "Local storage origins",
                    meta: formatLimitedList(stateProjection.state.localStorage.origins, "origins"),
                    body: "Keys are counted but values are not exposed.",
                  },
                  {
                    title: "Session storage origins",
                    meta: formatLimitedList(stateProjection.state.sessionStorage.origins, "origins"),
                    body: "Session storage is volatile and may disappear after restart.",
                  },
                  {
                    title: "Context",
                    meta: formatBrowserContextSummary(stateProjection),
                    body: "Locale and timezone are shown when configured; headers, credentials, and geolocation values remain hidden.",
                  },
                ]}
                emptyLabel="No state projection detail is available."
                ariaLabel="Browser session state projection"
              />
            </>
          ) : (
            <EmptyState size="compact" title="Select a browser session to inspect retained state." />
          )}
        </NativeCard>

        <NativeCard
          title="Scoped grants"
          subtitle="Grants are actor-scoped and optionally host-scoped; they do not enable unrestricted browser control."
          scrollBody
          bodyMaxHeight="min(58vh, 34rem)"
        >
          {selectedSession?.status === "active" ? (
            <BrowserGrantForm
              draft={grantDraft}
              busy={busyAction === "create-grant"}
              onChange={(patch) => setGrantDraft((current) => ({ ...current, ...patch }))}
              onSubmit={() => void createGrant()}
            />
          ) : (
            <p className="mc-next-settings-field-note">Closed sessions cannot receive new grants.</p>
          )}
          <BrowserGrantList grants={detail.grants} busyAction={busyAction} onGrantAction={handleGrantAction} />
        </NativeCard>

        <NativeCard
          title="Event timeline"
          subtitle="Retained session events show grant changes and policy blocks without exposing browser state values."
        >
          <NativeList
            density="compact"
            items={detail.events.map((event) => ({
              title: event.eventType,
              meta: [event.actorId, formatDateTime(event.createdAt)].filter(Boolean).join(" · "),
              body: formatEventPayload(event),
            }))}
            emptyLabel="No browser session events are attached to this session."
            ariaLabel="Browser session events"
            maxHeight="min(58vh, 34rem)"
            virtualized
          />
        </NativeCard>
      </NativeGrid>
    </NativePageFrame>
  );
}

function useBrowserSessionDetail(sessionId: string) {
  const load = useCallback(async () => {
    if (!sessionId) {
      return {
        issues: [],
        stateProjection: null as BrowserSessionStateProjection | null,
        grants: [] as BrowserSessionGrantRecord[],
        events: [] as BrowserSessionEventRecord[],
      };
    }
    const stateProjection = await nativeLoad(
      "Browser session state",
      fetchBrowserSessionState(sessionId),
      null as BrowserSessionStateProjection | null,
    );
    const grants = await nativeLoad(
      "Browser session grants",
      fetchBrowserSessionGrants(sessionId, { status: "all", limit: 100 }),
      [] as BrowserSessionGrantRecord[],
    );
    const events = await nativeLoad(
      "Browser session events",
      fetchBrowserSessionEvents(sessionId, 100),
      [] as BrowserSessionEventRecord[],
    );
    return {
      issues: nativeLoadIssues([stateProjection, grants, events]),
      stateProjection: stateProjection.data,
      grants: grants.data,
      events: events.data,
    };
  }, [sessionId]);
  const { data, reload } = useAsyncLoad(load, [load]);
  return {
    issues: data?.issues ?? [],
    stateProjection: data?.stateProjection ?? null,
    grants: data?.grants ?? [],
    events: data?.events ?? [],
    reload,
  };
}

function BrowserGrantForm({
  draft,
  busy,
  onChange,
  onSubmit,
}: {
  draft: {
    actorId: string;
    scopes: BrowserSessionGrantScope[];
    allowedHosts: string;
    ttlSeconds: number;
  };
  busy: boolean;
  onChange: (
    draft: Partial<{
      actorId: string;
      scopes: BrowserSessionGrantScope[];
      allowedHosts: string;
      ttlSeconds: number;
    }>,
  ) => void;
  onSubmit: () => void;
}) {
  const toggleScope = (scope: BrowserSessionGrantScope) => {
    const scopes = draft.scopes.includes(scope)
      ? draft.scopes.filter((item) => item !== scope)
      : [...draft.scopes, scope];
    onChange({ scopes });
  };
  return (
    <div className="mc-next-browser-grant-form">
      <div className="mc-next-settings-field-grid">
        <label className="mc-next-settings-field">
          <span>Actor</span>
          <input
            className="mc-next-settings-input"
            value={draft.actorId}
            onChange={(event) => onChange({ actorId: event.target.value })}
            placeholder="operator or agent id"
          />
        </label>
        <label className="mc-next-settings-field">
          <span>TTL seconds</span>
          <input
            className="mc-next-settings-input"
            type="number"
            min={0}
            value={draft.ttlSeconds}
            onChange={(event) => onChange({ ttlSeconds: Number.parseInt(event.target.value, 10) || 0 })}
          />
        </label>
        <label className="mc-next-settings-field span-2">
          <span>Allowed hosts</span>
          <input
            className="mc-next-settings-input"
            value={draft.allowedHosts}
            onChange={(event) => onChange({ allowedHosts: event.target.value })}
            placeholder="example.com, docs.example.com"
          />
        </label>
      </div>
      <div className="mc-next-settings-filter-bar" aria-label="Grant scopes">
        {GRANT_SCOPES.map((scope) => (
          <button
            key={scope}
            type="button"
            className={`mc-next-settings-filter${draft.scopes.includes(scope) ? " active" : ""}`}
            aria-pressed={draft.scopes.includes(scope)}
            onClick={() => toggleScope(scope)}
          >
            {scope}
          </button>
        ))}
      </div>
      <button type="button" className="mc-next-directory-action" disabled={busy} onClick={onSubmit}>
        <span>Create scoped grant</span>
      </button>
    </div>
  );
}

function BrowserGrantList({
  grants,
  busyAction,
  onGrantAction,
}: {
  grants: BrowserSessionGrantRecord[];
  busyAction: string | null;
  onGrantAction: (grant: BrowserSessionGrantRecord, action: "rotate" | "revoke") => void;
}) {
  if (grants.length === 0) {
    return <EmptyState size="compact" title="No grants are recorded for this browser session." />;
  }
  return (
    <div className="mc-next-browser-grant-list">
      {grants.map((grant) => {
        const active = isGrantActive(grant);
        return (
          <div key={grant.grantId} className="mc-next-browser-grant-row">
            <div>
              <strong>{grant.actorId}</strong>
              <span>
                {grant.scopes.join(", ")} · {grant.allowedHosts.length ? grant.allowedHosts.join(", ") : "all hosts"}
              </span>
              <small>
                {grant.revokedAt
                  ? `revoked ${formatDateTime(grant.revokedAt)}`
                  : `expires ${formatDateTime(grant.expiresAt)}`}
              </small>
            </div>
            <div className="mc-next-browser-grant-actions">
              <StatusChip tone={active ? "success" : "muted"}>{active ? "active" : "inactive"}</StatusChip>
              <button
                type="button"
                className="mc-next-settings-filter"
                disabled={!active || busyAction === `rotate:${grant.grantId}`}
                onClick={() => onGrantAction(grant, "rotate")}
              >
                Rotate
              </button>
              <button
                type="button"
                className="mc-next-settings-filter"
                disabled={!active || busyAction === `revoke:${grant.grantId}`}
                onClick={() => onGrantAction(grant, "revoke")}
              >
                Revoke
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isGrantActive(grant: BrowserSessionGrantRecord): boolean {
  if (grant.revokedAt) {
    return false;
  }
  return !grant.expiresAt || Date.parse(grant.expiresAt) > Date.now();
}

function buildBrowserSessionPosture(
  session: BrowserSessionRecord,
  grants: BrowserSessionGrantRecord[],
  events: BrowserSessionEventRecord[],
) {
  const activeGrants = grants.filter(isGrantActive);
  const highestScope = activeGrants
    .flatMap((grant) => grant.scopes)
    .sort((a, b) => GRANT_SCOPE_RANK[b] - GRANT_SCOPE_RANK[a])[0];
  const activeHosts = new Set(activeGrants.flatMap((grant) => grant.allowedHosts));
  const hasAllHostsGrant = activeGrants.some((grant) => grant.allowedHosts.length === 0);
  const guardBlockCount = events.filter((event) => event.eventType === "tool_guard_blocked").length;
  const latestToolEvidence = readLatestBrowserToolEvidence(events);
  const callableState =
    session.status === "closed" ? "Closed" : activeGrants.length > 0 ? "Governed grants ready" : "Grant required";
  const callableTone = session.status === "closed" ? "muted" : activeGrants.length > 0 ? "success" : "warning";
  const hostPosture =
    activeGrants.length === 0 ? "No active hosts" : hasAllHostsGrant ? "All hosts grant" : `${activeHosts.size} hosts`;
  const hostSummary =
    activeHosts.size > 0 ? [...activeHosts].slice(0, 4).join(", ") : hasAllHostsGrant ? "not host-scoped" : "none";
  return {
    activeGrantCount: activeGrants.length,
    callableState,
    callableTone,
    guardBlockCount,
    highestScope: highestScope ? `highest scope: ${highestScope}` : "no active scopes",
    hostPosture,
    hostSummary,
    latestToolEvidence,
    summary:
      activeGrants.length > 0
        ? "Tools still need an actor grant, host posture, policy checks, and guardrail pass before browser state changes."
        : "No callable browser-session grant is active; tools cannot use this session yet.",
  } satisfies {
    activeGrantCount: number;
    callableState: string;
    callableTone: "success" | "warning" | "muted";
    guardBlockCount: number;
    highestScope: string;
    hostPosture: string;
    hostSummary: string;
    latestToolEvidence: string;
    summary: string;
  };
}

function readLatestBrowserToolEvidence(events: BrowserSessionEventRecord[]): string {
  for (const event of events) {
    if (event.eventType !== "tool_access_granted") {
      continue;
    }
    const toolName = readPayloadString(event.payload, "toolName") ?? readPayloadString(event.payload, "tool");
    const runId = readPayloadString(event.payload, "runId");
    const toolCallId = readPayloadString(event.payload, "toolCallId");
    const evidence = [
      toolName,
      runId ? `run ${shortId(runId)}` : undefined,
      toolCallId ? `call ${shortId(toolCallId)}` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    if (evidence) {
      return evidence;
    }
  }
  return "No granted access event";
}

function readPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function formatStateAvailability(availability: BrowserSessionStateProjection["state"]["availability"]): string {
  if (availability === "present") {
    return "State retained";
  }
  if (availability === "empty") {
    return "Empty state";
  }
  return "Not retained";
}

function formatLimitedList(values: string[], fallbackLabel: string): string {
  if (values.length === 0) {
    return `no ${fallbackLabel}`;
  }
  const visible = values.slice(0, 3).join(", ");
  const remaining = values.length > 3 ? ` +${values.length - 3}` : "";
  return `${visible}${remaining}`;
}

function formatBrowserContextSummary(projection: BrowserSessionStateProjection): string {
  const context = projection.state.context;
  return (
    [
      context.locale ? `locale ${context.locale}` : undefined,
      context.timezoneId ? `timezone ${context.timezoneId}` : undefined,
      context.geolocationConfigured ? "geolocation configured" : undefined,
      context.extraHTTPHeadersCount > 0 ? `${context.extraHTTPHeadersCount} headers configured` : undefined,
      context.httpCredentialsConfigured ? "credentials configured" : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "No browser context overrides"
  );
}

function parseHostList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function labelForFilter(filter: BrowserSessionFilter): string {
  if (filter === "active") {
    return "Active";
  }
  if (filter === "closed") {
    return "Closed";
  }
  return "All";
}

function formatEventPayload(event: BrowserSessionEventRecord): string {
  const entries = Object.entries(event.payload)
    .filter(
      ([key, value]) =>
        !isSensitiveBrowserStatePayloadKey(key) && value !== undefined && value !== null && value !== "",
    )
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  const hiddenCount = Object.keys(event.payload).filter(isSensitiveBrowserStatePayloadKey).length;
  const hidden = hiddenCount > 0 ? [`${hiddenCount} browser state value${hiddenCount === 1 ? "" : "s"} hidden`] : [];
  return [...entries, ...hidden].length ? [...entries, ...hidden].join(" · ") : "No payload detail recorded.";
}

function isSensitiveBrowserStatePayloadKey(key: string): boolean {
  return /cookie|storage|localstorage|sessionstorage|domvalue|pagevalue|screenshot|html|content/i.test(key);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}
