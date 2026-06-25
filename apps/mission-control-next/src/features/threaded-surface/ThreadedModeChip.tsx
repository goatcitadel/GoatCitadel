import type { ChatMode } from "@goatcitadel/contracts";
import { useState } from "react";

const MODES: ChatMode[] = ["chat", "cowork", "code"];
const LABEL: Record<ChatMode, string> = { chat: "Chat", cowork: "Cowork", code: "Code" };

export function ThreadedModeChip({
  mode,
  preview,
  onOverride,
  disabled,
}: {
  mode: ChatMode | undefined;
  preview?: ChatMode;
  onOverride: (mode: ChatMode) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const resolved = mode ?? "chat";
  const label = mode ? LABEL[mode] : `Auto${preview ? ` → ${LABEL[preview]}` : ""}`;
  return (
    <div className="mc-next-mode-chip">
      <button
        type="button"
        className="mc-next-mode-chip-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>◇</span> {label}
      </button>
      {open ? (
        <div role="menu" className="mc-next-mode-chip-menu">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              aria-current={m === resolved}
              className={`mc-next-mode-chip-item${m === resolved ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                if (m !== mode) onOverride(m);
              }}
            >
              {LABEL[m]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
