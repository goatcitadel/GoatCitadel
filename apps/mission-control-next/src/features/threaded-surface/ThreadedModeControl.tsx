import type { ChatMode, SurfaceClassifyResponse } from "@goatcitadel/contracts";

type ThreadedModeControlVariant = "full" | "compact";

interface ThreadedModeControlProps {
  mode: ChatMode | undefined;
  preview?: SurfaceClassifyResponse;
  onOverride?: (mode: ChatMode) => void;
  disabled?: boolean;
  variant?: ThreadedModeControlVariant;
  interactive?: boolean;
}

function confidenceLabel(preview?: SurfaceClassifyResponse): string {
  if (!preview) {
    return "Chat";
  }

  const percent = Math.round(Math.max(0, Math.min(1, preview.confidence)) * 100);
  return `Chat · ${percent}% ${preview.source}`;
}

export function ThreadedModeControl(props: ThreadedModeControlProps) {
  void props.mode;
  void props.onOverride;
  void props.disabled;
  void props.interactive;
  const resolvedMode: ChatMode = "chat";
  const label = "Chat";
  const summary =
    props.preview?.rationale ??
    "Direct conversation with planning, tools, approvals, and code context available inline.";
  const confidence = confidenceLabel(props.preview);

  const controlClassName = [
    "mc-next-threaded-mode-control",
    `variant-${props.variant ?? "full"}`,
    `mode-${resolvedMode}`,
    "is-pinned",
    "is-readonly",
  ].join(" ");

  return (
    <div className={controlClassName} data-mode={resolvedMode}>
      <span className="mc-next-threaded-mode-control-readout">
        <span className="mc-next-threaded-mode-control-eyebrow">Surface</span>
        <span className="mc-next-threaded-mode-control-label">{label}</span>
        {props.variant !== "compact" ? (
          <span className="mc-next-threaded-mode-control-detail">
            {confidence}
            {" · "}
            {summary}
          </span>
        ) : null}
      </span>
    </div>
  );
}
