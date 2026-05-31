import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type {
  BrowserSessionEventRecord,
  BrowserSessionGrantRecord,
  BrowserSessionGrantScope,
  BrowserSessionRecord,
  BrowserSessionStatus,
} from "@goatcitadel/contracts";
import {
  closeBrowserSession,
  createBrowserSession,
  createBrowserSessionGrant,
  fetchBrowserSessionEvents,
  fetchBrowserSessionGrants,
  fetchBrowserSessions,
  revokeBrowserSessionGrant,
  rotateBrowserSessionGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, StatusChip } from "../primitives";
import { formatDateTime, nativeLoad, nativeLoadIssues, useAsyncLoad } from "../shared/native-helpers";
import { LibraryLoadWarnings, LibraryMetricGrid } from "../shared/library-primitives";
import type { NativeRoutePagesProps } from "../types";

type BrowserSessionFilter = BrowserSessionStatus | "all";
const GRANT_SCOPES: BrowserSessionGrantScope[] = ["read", "interact", "state", "admin"];

export function BrowserSessionsRoutePage({ activeWorkspaceId, activeWorkspaceName }: NativeRoutePagesProps) {
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
  const sessions = data?.sessions ?? [];
  const activeCount = sessions.filter((item) => item.status === "active").length;
  const selectedSession = sessions.find((item) => item.sessionId === selectedSessionId) ?? sessions[0] ?? null;

  useEffect(() => {
    setSelectedSessionId((current) =>
      sessions.some((item) => item.sessionId === current) ? current : (sessions[0]?.sessionId ?? ""),
    );
  }, [sessions]);

  const detail = useBrowserSessionDetail(selectedSession?.sessionId ?? "");

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
      setSelectedSessionId(created.sessionId);
      setNotice("Browser session created. Create a scoped grant before tools can use it.");
      await reload();
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
      kicker="Ops · Sessions"
      title="Browser Sessions"
      description={`Govern in-memory browser session state, grants, and events for ${activeWorkspaceName}.`}
      loading={loading}
      error={error ?? actionError}
      metrics={[
        { label: "Visible", value: String(sessions.length) },
        { label: "Active", value: String(activeCount) },
        { label: "Grants", value: String(detail.grants.length) },
        { label: "Events", value: String(detail.events.length) },
      ]}
      actions={
        <button type="button" className="mc-next-secondary-button" onClick={() => void reload()}>
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      }
    >
      <LibraryLoadWarnings issues={[...(data?.issues ?? []), ...detail.issues]} onRetry={() => void reload()} />
      {notice ? <div className="mc-next-runtime-notice tone-success">{notice}</div> : null}
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
          scrollBody
          bodyMaxHeight="min(58vh, 34rem)"
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
          />
        </NativeCard>
      </NativeGrid>
    </NativePageFrame>
  );
}

function useBrowserSessionDetail(sessionId: string) {
  const load = useCallback(async () => {
    if (!sessionId) {
      return { issues: [], grants: [] as BrowserSessionGrantRecord[], events: [] as BrowserSessionEventRecord[] };
    }
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
    return { issues: nativeLoadIssues([grants, events]), grants: grants.data, events: events.data };
  }, [sessionId]);
  const { data, reload } = useAsyncLoad(load, [load]);
  return { issues: data?.issues ?? [], grants: data?.grants ?? [], events: data?.events ?? [], reload };
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
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`);
  return entries.length ? entries.join(" · ") : "No payload detail recorded.";
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}
