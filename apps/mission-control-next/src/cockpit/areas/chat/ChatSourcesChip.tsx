import { Library } from "lucide-react";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";

type SourceControls = NonNullable<MissionThreadedActiveSessionSurfaceProps["externalSourceControls"]>;

/** "Sources: none", "Sources: 2" or "Sources: 2, 1 selected", from the attached read-only sources. */
export function sourcesChipLabel(controls: Pick<SourceControls, "attachments" | "selectedAttachmentIds">): string {
  const attached = controls.attachments.length;
  const selected = controls.selectedAttachmentIds.length;
  const count = attached ? String(attached) : "none";
  return selected ? `Sources: ${count}, ${selected} selected` : `Sources: ${count}`;
}

/**
 * The composer toolbar's read-only sources control. It stands in for the always-open sources panel, which now
 * shows (with its explainer) only after the operator opens it here.
 */
export function ChatSourcesChip({
  controls,
  open,
  panelId,
  onToggle,
}: {
  controls: SourceControls;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-line-control px-2 text-fg-secondary hover:border-fg aria-expanded:border-accent max-sm:min-h-11 max-sm:px-3"
    >
      <Library aria-hidden="true" className="size-4 shrink-0" />
      {sourcesChipLabel(controls)}
    </button>
  );
}
