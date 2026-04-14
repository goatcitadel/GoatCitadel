import { StatusChip } from "../StatusChip";

interface ChatSessionRailRow {
  key: string;
  type: "header" | "session" | "empty";
  title: string;
  tone?: "success" | "warning";
  count?: number;
  sessionId?: string;
  subtitle?: string;
  meta?: string;
  pinned?: boolean;
}

type SessionRailMode = "chat" | "cowork" | "code";

function formatRelativeSessionTime(timestamp: string): string {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "Recently active";
  }
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) {
    return "Just now";
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function describeMissionSessionMeta(
  session: {
    projectName?: string | null;
    lastActivityAt?: string;
    pinned?: boolean;
  },
  mode: SessionRailMode,
): string {
  const relativeTime = session.lastActivityAt ? formatRelativeSessionTime(session.lastActivityAt) : "Recently active";
  if (mode === "cowork") {
    return session.projectName ? `${session.projectName} · ${relativeTime}` : `Task lane ready · ${relativeTime}`;
  }
  if (mode === "code") {
    return session.projectName
      ? `Bound to ${session.projectName} · ${relativeTime}`
      : `No project binding · ${relativeTime}`;
  }
  return relativeTime;
}

function describeExternalSessionMeta(
  session: {
    channel?: string | null;
    account?: string | null;
    lastActivityAt?: string;
  },
  mode: SessionRailMode,
): string {
  const channelLabel = [session.channel, session.account].filter(Boolean).join(" / ") || "External connection";
  const relativeTime = session.lastActivityAt ? formatRelativeSessionTime(session.lastActivityAt) : "Recently active";
  if (mode === "code") {
    return `${channelLabel} · Readback context · ${relativeTime}`;
  }
  if (mode === "cowork") {
    return `${channelLabel} · Coordination source · ${relativeTime}`;
  }
  return `${channelLabel} · ${relativeTime}`;
}

export function ChatSessionRail({
  missionSessions,
  externalSessions,
  selectedSessionId,
  onSelectSession,
  renderSessionLabel,
  mode,
}: {
  missionSessions: Array<{
    sessionId: string;
    projectName?: string | null;
    pinned?: boolean;
    lastActivityAt?: string;
  }>;
  externalSessions: Array<{
    sessionId: string;
    channel?: string | null;
    account?: string | null;
    pinned?: boolean;
    lastActivityAt?: string;
  }>;
  selectedSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  renderSessionLabel: (sessionId: string) => string;
  mode: SessionRailMode;
}) {
  const rows: ChatSessionRailRow[] = [
    {
      key: "mission-header",
      type: "header",
      title: "Mission",
      tone: "success",
      count: missionSessions.length,
    },
    ...missionSessions.map((session) => ({
      key: `mission-${session.sessionId}`,
      type: "session" as const,
      title: renderSessionLabel(session.sessionId),
      sessionId: session.sessionId,
      subtitle: session.projectName ?? "No project yet",
      meta: describeMissionSessionMeta(session, mode),
      pinned: session.pinned,
    })),
    ...(missionSessions.length === 0
      ? [
          {
            key: "mission-empty",
            type: "empty" as const,
            title: "No mission chats match this filter yet.",
          },
        ]
      : []),
    {
      key: "external-header",
      type: "header",
      title: "External",
      tone: "warning",
      count: externalSessions.length,
    },
    ...externalSessions.map((session) => ({
      key: `external-${session.sessionId}`,
      type: "session" as const,
      title: renderSessionLabel(session.sessionId),
      sessionId: session.sessionId,
      subtitle: [session.channel, session.account].filter(Boolean).join("/") || "External session",
      meta: describeExternalSessionMeta(session, mode),
      pinned: session.pinned,
    })),
    ...(externalSessions.length === 0
      ? [
          {
            key: "external-empty",
            type: "empty" as const,
            title: "No external chats are connected right now.",
          },
        ]
      : []),
  ];

  return (
    <div className="chat-v11-session-rail">
      <div className="chat-v11-session-virtuoso">
        {rows.map((row) => {
          if (row.type === "header") {
            return (
              <div key={row.key} className="chat-v11-rail-section">
                <div className="chat-v11-rail-title">
                  <h4>{row.title}</h4>
                  <StatusChip tone={row.tone ?? "muted"}>{row.count ?? 0}</StatusChip>
                </div>
              </div>
            );
          }

          if (row.type === "empty") {
            return (
              <div key={row.key} className="chat-v11-empty-item">
                {row.title}
              </div>
            );
          }

          const isSelected = selectedSessionId === row.sessionId;
          return (
            <div key={row.key} className="chat-v11-session-row">
              <button
                type="button"
                className={["gc-button", isSelected ? "active" : ""].filter(Boolean).join(" ")}
                onClick={() => row.sessionId && onSelectSession(row.sessionId)}
              >
                <span className="chat-v11-session-row-title">
                  {row.title}
                  {row.pinned ? <StatusChip tone="warning">Pinned</StatusChip> : null}
                </span>
                {row.meta ? <span className="chat-v11-session-row-meta">{row.meta}</span> : null}
                {isSelected && row.subtitle ? (
                  <span className="chat-v11-session-row-preview">{row.subtitle}</span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
