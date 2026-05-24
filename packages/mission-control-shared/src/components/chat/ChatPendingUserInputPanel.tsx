import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import { HelpHint } from "../HelpHint";

export function ChatPendingUserInputPanel(props: {
  pendingUserInput: ChatUserInputPromptRecord | null;
  pending: boolean;
  variant?: "default" | "compact";
  onSubmit: (response: { kind: "single_select"; optionId: string } | { kind: "text"; text: string }) => void;
  onDismiss?: () => void;
}) {
  const { pendingUserInput, pending, variant, onSubmit, onDismiss } = props;
  const [selectedOptionId, setSelectedOptionId] = useState<string>("");
  const [textValue, setTextValue] = useState("");

  const promptKey = pendingUserInput?.promptId ?? "none";
  const trimmedText = useMemo(() => textValue.trim(), [textValue]);

  useEffect(() => {
    setSelectedOptionId("");
    setTextValue("");
  }, [promptKey]);

  if (!pendingUserInput) {
    return null;
  }

  const activePrompt = pendingUserInput;
  const submitLabel = activePrompt.submitLabel?.trim() || "Submit";
  const canSubmit = activePrompt.kind === "single_select" ? selectedOptionId.length > 0 : trimmedText.length > 0;
  const showDismiss = activePrompt.dismissible && typeof onDismiss === "function";

  function handleSubmit() {
    if (activePrompt.kind === "single_select") {
      onSubmit({ kind: "single_select", optionId: selectedOptionId });
      return;
    }
    onSubmit({ kind: "text", text: trimmedText });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") {
      return;
    }
    event.stopPropagation();
    if (showDismiss && !pending) {
      onDismiss();
      return;
    }
    const activeElement = globalThis.document?.activeElement;
    if (activeElement instanceof HTMLElement && event.currentTarget.contains(activeElement)) {
      activeElement.blur();
    }
  }

  return (
    <div
      className={`chat-approval-card chat-user-input-card chat-blocking-prompt chat-blocking-prompt-user-input${variant === "compact" ? " compact" : ""}`}
      data-variant={variant ?? "default"}
      role="alert"
      aria-live="assertive"
      key={promptKey}
      onKeyDown={handleKeyDown}
    >
      <div className="chat-approval-header">
        <p className="chat-approval-title">{activePrompt.title}</p>
        <span className="chat-approval-countdown">Answer required</span>
      </div>
      <p className="chat-approval-reason">{activePrompt.question}</p>
      {activePrompt.kind === "single_select" ? (
        <div className="chat-user-input-options" role="radiogroup" aria-label={activePrompt.question}>
          {(activePrompt.options ?? []).map((option) => (
            <label key={option.optionId} className="chat-user-input-option">
              <input
                type="radio"
                name={activePrompt.promptId}
                value={option.optionId}
                checked={selectedOptionId === option.optionId}
                disabled={pending}
                onChange={() => setSelectedOptionId(option.optionId)}
              />
              <span className="chat-user-input-option-copy">
                <span className="chat-user-input-option-row">
                  <strong>{option.label}</strong>
                  {option.helpText ? (
                    <HelpHint
                      label={`More about ${option.label}`}
                      text={option.helpText}
                      symbol="i"
                      className="chat-user-input-help-hint"
                    />
                  ) : null}
                </span>
                <span className="chat-user-input-option-description">{option.description}</span>
              </span>
            </label>
          ))}
        </div>
      ) : activePrompt.multiline ? (
        <textarea
          className="chat-user-input-textarea"
          value={textValue}
          placeholder={activePrompt.placeholder}
          disabled={pending}
          rows={4}
          onChange={(event) => setTextValue(event.target.value)}
        />
      ) : (
        <input
          className="chat-user-input-input"
          type="text"
          value={textValue}
          placeholder={activePrompt.placeholder}
          disabled={pending}
          onChange={(event) => setTextValue(event.target.value)}
        />
      )}
      <div className="chat-approval-actions">
        <button
          type="button"
          className="gc-button chat-approval-allow"
          disabled={pending || !canSubmit}
          onClick={handleSubmit}
        >
          {pending ? "Submitting..." : submitLabel}
        </button>
        {showDismiss ? (
          <button type="button" className="gc-button chat-approval-deny" disabled={pending} onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
      {activePrompt.expiresAt ? <p className="chat-approval-id">Expires {activePrompt.expiresAt}</p> : null}
      <p className="chat-approval-id">{activePrompt.promptId}</p>
    </div>
  );
}
