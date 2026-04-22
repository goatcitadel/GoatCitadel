import { useEffect, useMemo, useState } from "react";
import type { ChatUserInputPromptRecord } from "@goatcitadel/contracts";
import { HelpHint } from "../HelpHint";

export function ChatPendingUserInputPanel(props: {
  pendingUserInput: ChatUserInputPromptRecord | null;
  pending: boolean;
  onSubmit: (response: { kind: "single_select"; optionId: string } | { kind: "text"; text: string }) => void;
  onDismiss?: () => void;
}) {
  const { pendingUserInput, pending, onSubmit, onDismiss } = props;
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

  const submitLabel = pendingUserInput.submitLabel?.trim() || "Submit";
  const canSubmit =
    pendingUserInput.kind === "single_select" ? selectedOptionId.length > 0 : trimmedText.length > 0;
  const showDismiss = pendingUserInput.dismissible && typeof onDismiss === "function";

  return (
    <div className="chat-approval-card chat-user-input-card" role="alert" key={promptKey}>
      <div className="chat-approval-header">
        <p className="chat-approval-title">{pendingUserInput.title}</p>
      </div>
      <p className="chat-approval-reason">{pendingUserInput.question}</p>
      {pendingUserInput.kind === "single_select" ? (
        <div className="chat-user-input-options" role="radiogroup" aria-label={pendingUserInput.question}>
          {(pendingUserInput.options ?? []).map((option) => (
            <label key={option.optionId} className="chat-user-input-option">
              <input
                type="radio"
                name={pendingUserInput.promptId}
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
      ) : pendingUserInput.multiline ? (
        <textarea
          className="chat-user-input-textarea"
          value={textValue}
          placeholder={pendingUserInput.placeholder}
          disabled={pending}
          rows={4}
          onChange={(event) => setTextValue(event.target.value)}
        />
      ) : (
        <input
          className="chat-user-input-input"
          type="text"
          value={textValue}
          placeholder={pendingUserInput.placeholder}
          disabled={pending}
          onChange={(event) => setTextValue(event.target.value)}
        />
      )}
      <div className="chat-approval-actions">
        <button
          type="button"
          className="gc-button chat-approval-allow"
          disabled={pending || !canSubmit}
          onClick={() => {
            if (pendingUserInput.kind === "single_select") {
              onSubmit({ kind: "single_select", optionId: selectedOptionId });
              return;
            }
            onSubmit({ kind: "text", text: trimmedText });
          }}
        >
          {pending ? "Submitting..." : submitLabel}
        </button>
        {showDismiss ? (
          <button type="button" className="gc-button chat-approval-deny" disabled={pending} onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
      {pendingUserInput.expiresAt ? <p className="chat-approval-id">Expires {pendingUserInput.expiresAt}</p> : null}
      <p className="chat-approval-id">{pendingUserInput.promptId}</p>
    </div>
  );
}
