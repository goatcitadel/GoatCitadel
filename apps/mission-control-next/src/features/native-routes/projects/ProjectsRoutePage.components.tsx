import type { ReactNode } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import { EmptyState } from "../primitives";
import type { NativeRoutePagesProps } from "../types";
import { formatDateTime } from "./ProjectsRoutePage.helpers";
import type { ProjectFilterView } from "./use-project-pin-archive";

export function filterEmptyLabel(view: ProjectFilterView): string {
  switch (view) {
    case "pinned":
      return "No pinned projects yet. Pin a project from its card to keep it close.";
    case "archived":
      return "No archived projects in this workspace.";
    case "active":
      return "No active projects in this workspace.";
    default:
      return "No projects found in this workspace.";
  }
}

export function ProjectGlyphButton({
  label,
  pressed,
  busy,
  onClick,
  children,
}: {
  label: string;
  pressed: boolean;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`mc-next-project-card-glyph${pressed ? " is-pressed" : ""}`}
      aria-pressed={pressed}
      aria-label={label}
      disabled={busy}
      onClick={(event) => {
        event?.stopPropagation?.();
        onClick();
      }}
    >
      {children}
      <span className="mc-next-sr-only">{label}</span>
    </button>
  );
}

export function ProjectHomeMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="mc-next-settings-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

export function NewSessionButton({
  mode,
  label,
  disabled,
  onSelect,
}: {
  mode: ChatMode;
  label: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className="mc-next-new-session-button"
      data-mode={mode}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="mc-next-new-session-button-swatch" aria-hidden="true" />
      <MessageSquarePlus size={16} />
      {label}
    </button>
  );
}

export function ProjectThreadGroup({
  mode,
  label,
  sessions,
  route,
  navigate,
}: {
  mode: ChatMode;
  label: string;
  sessions: ChatSessionRecord[];
  route: NativeRoutePagesProps["route"];
  navigate: NativeRoutePagesProps["navigate"];
}) {
  void mode;
  return (
    <section className="mc-next-directory-lane">
      <div className="mc-next-directory-lane-head">
        <strong>{label}</strong>
        <span>{sessions.length}</span>
      </div>
      {sessions.length ? (
        <div className="mc-next-directory-lane-list">
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className="mc-next-directory-lane-item"
              onClick={() =>
                navigate({
                  area: "chat",
                  sessionId: session.sessionId,
                  projectId: session.projectId,
                  theme: route.theme,
                })
              }
            >
              <div className="mc-next-directory-lane-meta">
                <span>{session.lifecycleStatus}</span>
                <span>{formatDateTime(session.lastActivityAt)}</span>
              </div>
              <strong>{session.title?.trim() || session.sessionKey}</strong>
              <p>{session.tags?.length ? session.tags.join(", ") : "No tags yet."}</p>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState size="compact" title={`No ${label.toLowerCase()} threads in this project.`} />
      )}
    </section>
  );
}
