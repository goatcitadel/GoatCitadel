import type { ChatMode, SurfaceClassifyResponse } from "@goatcitadel/contracts";
import { useMemo, useState } from "react";

type ThreadedModeControlVariant = "full" | "compact";

interface ThreadedModeControlProps {
  mode: ChatMode | undefined;
  preview?: SurfaceClassifyResponse;
  onOverride?: (mode: ChatMode) => void;
  disabled?: boolean;
  variant?: ThreadedModeControlVariant;
  interactive?: boolean;
}

const MODE_META: Record<
  ChatMode,
  {
    label: string;
    summary: string;
    consequence: string;
  }
> = {
  chat: {
    label: "Chat",
    summary: "Direct conversation with lightweight runtime context.",
    consequence: "Keeps the transcript fast and low-friction.",
  },
  cowork: {
    label: "Cowork",
    summary: "Guided agentic work with checkpoints and operator oversight.",
    consequence: "Surfaces decomposition, retries, approvals, and proof.",
  },
  code: {
    label: "Code",
    summary: "Implementation-focused mode with governed code context.",
    consequence: "Keeps project binding, gates, diffs, and validation visible.",
  },
};

const MODES: ChatMode[] = ["chat", "cowork", "code"];

function confidenceLabel(preview?: SurfaceClassifyResponse): string {
  if (!preview) {
    return "Awaiting draft";
  }

  const percent = Math.round(Math.max(0, Math.min(1, preview.confidence)) * 100);
  return `${percent}% ${preview.source}`;
}

function modeLabel(mode: ChatMode): string {
  return MODE_META[mode].label;
}

function resolvedLabel(mode: ChatMode | undefined, preview?: SurfaceClassifyResponse): string {
  if (mode) {
    return modeLabel(mode);
  }

  if (preview?.mode) {
    return `Auto -> ${modeLabel(preview.mode)}`;
  }

  return "Auto-routing";
}

function resolvedSummary(mode: ChatMode | undefined, preview?: SurfaceClassifyResponse): string {
  if (mode) {
    return MODE_META[mode].summary;
  }

  if (preview) {
    return preview.rationale;
  }

  return "Type a prompt to preview the best surface.";
}

export function ThreadedModeControl(props: ThreadedModeControlProps) {
  const [open, setOpen] = useState(false);
  const resolvedMode = props.mode ?? props.preview?.mode ?? "chat";
  const autoRouting = !props.mode;
  const label = resolvedLabel(props.mode, props.preview);
  const summary = resolvedSummary(props.mode, props.preview);
  const confidence = confidenceLabel(props.preview);
  const alternatives = useMemo(() => {
    return props.preview?.alternatives.filter((mode) => mode !== props.preview?.mode) ?? [];
  }, [props.preview]);

  const controlClassName = [
    "mc-next-threaded-mode-control",
    `variant-${props.variant ?? "full"}`,
    `mode-${resolvedMode}`,
    autoRouting ? "is-auto" : "is-pinned",
    props.interactive !== false && props.onOverride && !props.disabled ? "is-interactive" : "is-readonly",
  ].join(" ");

  if (props.interactive === false || !props.onOverride || props.disabled) {
    return (
      <div className={controlClassName} data-mode={resolvedMode}>
        <span className="mc-next-threaded-mode-control-readout">
          <span className="mc-next-threaded-mode-control-eyebrow">Mode</span>
          <span className="mc-next-threaded-mode-control-label">{label}</span>
          {props.variant !== "compact" ? <span className="mc-next-threaded-mode-control-detail">{summary}</span> : null}
        </span>
      </div>
    );
  }

  return (
    <div className={controlClassName} data-mode={resolvedMode}>
      <button
        type="button"
        className="mc-next-threaded-mode-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="mc-next-threaded-mode-control-eyebrow">{autoRouting ? "Auto route" : "Mode"}</span>
        <span className="mc-next-threaded-mode-control-label">{label}</span>
        <span className="mc-next-threaded-mode-control-detail">{confidence}</span>
      </button>
      {open ? (
        <div className="mc-next-threaded-mode-menu" role="menu" aria-label="Choose conversation mode">
          <div className="mc-next-threaded-mode-preview">
            <span>{autoRouting ? "Preview" : "Pinned"}</span>
            <strong>{modeLabel(resolvedMode)}</strong>
            <p>{summary}</p>
            {props.preview && alternatives.length > 0 ? (
              <small>Also considered {alternatives.map(modeLabel).join(", ")}</small>
            ) : null}
          </div>
          {MODES.map((mode) => {
            const active = mode === resolvedMode;
            return (
              <button
                key={mode}
                type="button"
                role="menuitem"
                className="mc-next-threaded-mode-item"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  setOpen(false);
                  if (mode !== props.mode) {
                    props.onOverride?.(mode);
                  }
                }}
              >
                <span>
                  <strong>{MODE_META[mode].label}</strong>
                  <em>{MODE_META[mode].summary}</em>
                </span>
                <small>{MODE_META[mode].consequence}</small>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
