import type { ChatMode } from "@goatcitadel/contracts";

type ThreadedModeControlVariant = "full" | "compact";

interface ThreadedModeControlProps {
  mode: ChatMode | undefined;
  onOverride?: (mode: ChatMode) => void;
  disabled?: boolean;
  variant?: ThreadedModeControlVariant;
  interactive?: boolean;
}

export function ThreadedModeControl(props: ThreadedModeControlProps) {
  void props.mode;
  void props.onOverride;
  void props.disabled;
  void props.interactive;
  const resolvedMode: ChatMode = "chat";
  const label = "Chat";
  const summary = "Direct conversation with planning, tools, approvals, and code context available inline.";

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
            {label}
            {" · "}
            {summary}
          </span>
        ) : null}
      </span>
    </div>
  );
}
