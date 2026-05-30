import type { ReactNode } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { ChatMode } from "@goatcitadel/contracts";
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
      <MessageSquarePlus className="h-4 w-4" />
      {label}
    </button>
  );
}
