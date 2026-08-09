import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ChatUserInputPromptRecord, ChatUserInputPromptResponse } from "@goatcitadel/contracts";
import { HelpHint } from "../HelpHint";
import { IdentifierChip } from "../IdentifierChip";

export function ChatPendingUserInputPanel(props: {
  pendingUserInput: ChatUserInputPromptRecord | null;
  pending: boolean;
  variant?: "default" | "compact";
  onSubmit: (response: ChatUserInputPromptResponse) => void;
  onDismiss?: () => void;
}) {
  const { pendingUserInput, pending, variant, onSubmit, onDismiss } = props;
  const [selectedOptionId, setSelectedOptionId] = useState<string>("");
  const [textValue, setTextValue] = useState("");
  const [secureEntry, setSecureEntry] = useState<{ promptKey: string; value: string }>({
    promptKey: "none",
    value: "",
  });

  const promptKey = pendingUserInput?.promptId ?? "none";
  const secureValue = secureEntry.promptKey === promptKey ? secureEntry.value : "";
  const trimmedText = useMemo(() => textValue.trim(), [textValue]);

  useEffect(() => {
    setSelectedOptionId("");
    setTextValue("");
    setSecureEntry({ promptKey, value: "" });
  }, [promptKey]);

  if (!pendingUserInput) {
    return null;
  }

  const activePrompt = pendingUserInput;
  const submitLabel = activePrompt.submitLabel?.trim() || "Submit";
  const isSecureConfiguration = activePrompt.secureConfiguration !== undefined;
  const canSubmit = isSecureConfiguration
    ? secureValue.length > 0
    : activePrompt.kind === "single_select"
      ? selectedOptionId.length > 0
      : trimmedText.length > 0;
  const showDismiss = activePrompt.dismissible && typeof onDismiss === "function";

  function handleSubmit() {
    if (activePrompt.secureConfiguration) {
      const secret = secureValue;
      setSecureEntry({ promptKey, value: "" });
      onSubmit({ kind: "secure_configuration", secret });
      return;
    }
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
      {activePrompt.secureConfiguration ? (
        <div className="chat-user-input-secure">
          <label className="chat-user-input-option-row" htmlFor={`chat-secure-configuration-${activePrompt.promptId}`}>
            <strong>{activePrompt.secureConfiguration.secretFieldLabel}</strong>
          </label>
          <input
            id={`chat-secure-configuration-${activePrompt.promptId}`}
            className="chat-user-input-input"
            type="password"
            autoComplete="new-password"
            value={secureValue}
            placeholder={activePrompt.placeholder}
            disabled={pending}
            aria-describedby={`chat-secure-configuration-note-${activePrompt.promptId}`}
            onChange={(event) => setSecureEntry({ promptKey, value: event.target.value })}
          />
          <p
            id={`chat-secure-configuration-note-${activePrompt.promptId}`}
            className="chat-user-input-option-description"
          >
            This value goes directly to the Gateway and is stored in your OS keychain for this GoatCitadel installation.
            It is excluded from Chat, the model, and memory. Gateway will verify{" "}
            {activePrompt.secureConfiguration.targetLabel} with a live probe before use.
          </p>
          {activePrompt.secureConfiguration.acquisitionUrl && activePrompt.secureConfiguration.acquisitionLabel ? (
            <p className="chat-user-input-option-description">
              Need a credential?{" "}
              <a href={activePrompt.secureConfiguration.acquisitionUrl} target="_blank" rel="noreferrer noopener">
                {activePrompt.secureConfiguration.acquisitionLabel}
              </a>
              .
            </p>
          ) : null}
        </div>
      ) : activePrompt.kind === "single_select" ? (
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
      <IdentifierChip className="chat-approval-id" value={activePrompt.promptId} label="Prompt" />
    </div>
  );
}
