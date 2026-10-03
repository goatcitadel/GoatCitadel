import { useState, type FormEvent } from "react";
import {
  isBackgroundChatUserInputPrompt,
  type ChatUserInputPromptRecord,
  type ChatUserInputPromptResponse,
} from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";

export function ChatPendingQuestion({
  prompt,
  pending,
  onSubmit,
}: {
  prompt: ChatUserInputPromptRecord;
  pending: boolean;
  onSubmit: (response: ChatUserInputPromptResponse) => void;
}) {
  const [value, setValue] = useState("");
  const secure = Boolean(prompt.secureConfiguration);
  const background = isBackgroundChatUserInputPrompt(prompt);
  const canSubmit = !pending && (secure ? value.length > 0 : value.trim().length > 0);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    if (secure) {
      const secret = value;
      setValue("");
      onSubmit({ kind: "secure_configuration", secret });
    } else if (prompt.kind === "single_select") onSubmit({ kind: "single_select", optionId: value });
    else onSubmit({ kind: "text", text: value.trim() });
  };
  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-md border border-status-waiting bg-raised p-3 text-sm"
      aria-label="Pending question"
    >
      <h3 className="font-display font-semibold text-fg">{prompt.title || "Your input is needed"}</h3>
      {background ? (
        <p role="status" aria-live="polite" className="mt-1 text-xs text-fg-muted">
          Optional · Work continues
        </p>
      ) : null}
      <p className="mt-1 text-fg-secondary">{prompt.question}</p>
      {background ? (
        <p className="mt-1 text-xs text-fg-muted">
          Answer while this turn is active. Your reply is saved and can be used at the next model step. Do not enter
          credentials here.
        </p>
      ) : null}
      {prompt.secureConfiguration ? (
        <>
          <label className="mt-2 block text-xs text-fg-secondary">
            {prompt.secureConfiguration.secretFieldLabel}
            <input
              type="password"
              autoComplete="new-password"
              value={value}
              disabled={pending}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1 block min-h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
            />
          </label>
          <p className="mt-1 text-xs text-fg-muted">
            Sent directly to the Gateway for live verification and OS keychain storage. It is excluded from Chat, model
            context, and memory.
          </p>
        </>
      ) : prompt.kind === "single_select" ? (
        <div role="radiogroup" aria-label={prompt.question} className="mt-2 grid gap-1">
          {(prompt.options ?? []).map((option) => (
            <label
              key={option.optionId}
              className="flex items-start gap-2 rounded-md border border-line-subtle p-2 text-fg-secondary"
            >
              <input
                type="radio"
                name={`prompt-${prompt.promptId}`}
                value={option.optionId}
                checked={value === option.optionId}
                disabled={pending}
                onChange={() => setValue(option.optionId)}
                className="mt-1"
              />
              <span>
                <strong className="block text-fg">{option.label}</strong>
                {option.description ? <span className="block text-xs text-fg-muted">{option.description}</span> : null}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <label className="mt-2 block text-xs text-fg-secondary">
          Your response
          {prompt.multiline ? (
            <textarea
              value={value}
              disabled={pending}
              placeholder={prompt.placeholder}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1 block min-h-20 w-full rounded-md border border-line bg-canvas p-2 text-sm text-fg"
            />
          ) : (
            <input
              type="text"
              value={value}
              disabled={pending}
              placeholder={prompt.placeholder}
              onChange={(event) => setValue(event.target.value)}
              className="mt-1 block min-h-9 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg"
            />
          )}
        </label>
      )}
      <Button type="submit" variant="primary" size="sm" disabled={!canSubmit} className="mt-3">
        {pending ? "Submitting…" : prompt.submitLabel?.trim() || "Submit response"}
      </Button>
    </form>
  );
}
