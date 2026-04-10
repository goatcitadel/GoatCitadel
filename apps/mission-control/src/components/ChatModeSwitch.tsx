import type { ChatMode } from "@goatcitadel/contracts";

export function ChatModeSwitch({
  value,
  disabled,
  onChange,
}: {
  value: ChatMode;
  disabled?: boolean;
  onChange: (mode: ChatMode) => void;
}) {
  return (
    <div className="chat-mode-switch" role="tablist" aria-label="Chat mode">
      {(["chat", "cowork", "code"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          role="tab"
          aria-selected={value === mode}
          className={["gc-button", (value === mode ? "active" : "")].filter(Boolean).join(" ")}
          disabled={disabled}
          onClick={() => onChange(mode)}
        >
          {mode === "chat" ? "Chat" : mode === "cowork" ? "Cowork" : "Code"}
        </button>
      ))}
    </div>
  );
}
