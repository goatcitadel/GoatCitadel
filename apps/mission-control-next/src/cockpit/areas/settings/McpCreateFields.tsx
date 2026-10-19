import { useId } from "react";
import type { McpCreateForm } from "../../../features/native-routes/settings/sections/mcp-editor-drafts";
import { isRuntimeInvokableMcpServer } from "../../../features/native-routes/settings/helpers/mcp-helpers";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { urlFieldError, useBlurValidation } from "./field-validation";

/** Why a new server can't be saved as enabled, or nothing when it can. */
export function mcpEnableBlockedReason(draft: McpCreateForm): string | undefined {
  if (isRuntimeInvokableMcpServer(draft)) return undefined;
  if (draft.trustTier === "quarantined") return "Quarantined servers are saved disabled.";
  if (draft.transport !== "stdio" && !draft.url.trim()) return "Enter a server URL to save it as enabled.";
  return "Its sign-in isn't ready yet: token sign-in needs an allowed environment key, and OAuth needs its sign-in URLs and a completed sign-in.";
}

export function McpCreateFields({
  draft,
  disabled,
  onChange,
}: {
  draft: McpCreateForm;
  disabled: boolean;
  onChange: (value: McpCreateForm) => void;
}) {
  const id = useId();
  const labelCheck = useBlurValidation((value) => (value.trim() ? undefined : "Enter a server label."));
  const commandCheck = useBlurValidation((value) => (value.trim() ? undefined : "Enter the command that starts it."));
  const urlCheck = useBlurValidation((value) =>
    urlFieldError(value, { required: true, protocols: ["https:", "http:", "goatcitadel:"] }),
  );
  const enableReason = mcpEnableBlockedReason(draft);
  return (
    <fieldset disabled={disabled} className="space-y-3 text-sm text-fg-secondary">
      <legend className="sr-only">New saved MCP server</legend>
      <Field label="Server label" required error={labelCheck.error}>
        {(fieldProps) => (
          <input
            {...fieldProps}
            // The required marker stays out of the name: it reads as the plain label text.
            aria-label="Server label"
            className={cockpitInputClass}
            value={draft.label}
            onBlur={(event) => labelCheck.onBlur(event.target.value)}
            onChange={(event) => {
              onChange({ ...draft, label: event.target.value });
              labelCheck.onChange(event.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Transport">
        {(fieldProps) => (
          <select
            {...fieldProps}
            className={cockpitInputClass}
            value={draft.transport}
            onChange={(event) => onChange({ ...draft, transport: event.target.value as McpCreateForm["transport"] })}
          >
            <option value="stdio">Local process (stdio)</option>
            <option value="http">Remote HTTP</option>
            <option value="sse">Remote SSE</option>
          </select>
        )}
      </Field>
      {draft.transport === "stdio" ? (
        <>
          <Field label="Command" required error={commandCheck.error}>
            {(fieldProps) => (
              <input
                {...fieldProps}
                aria-label="Command"
                autoComplete="off"
                spellCheck={false}
                className={cockpitInputClass}
                value={draft.command}
                onBlur={(event) => commandCheck.onBlur(event.target.value)}
                onChange={(event) => {
                  onChange({ ...draft, command: event.target.value });
                  commandCheck.onChange(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Arguments (one per line)">
            {(fieldProps) => (
              <textarea
                {...fieldProps}
                spellCheck={false}
                className={`${cockpitInputClass} min-h-24`}
                value={draft.args.join("\n")}
                onChange={(event) => onChange({ ...draft, args: event.target.value.split("\n") })}
              />
            )}
          </Field>
        </>
      ) : (
        <Field label="Server URL" required error={urlCheck.error}>
          {(fieldProps) => (
            <input
              {...fieldProps}
              aria-label="Server URL"
              type="url"
              autoComplete="off"
              spellCheck={false}
              className={cockpitInputClass}
              value={draft.url}
              onBlur={(event) => urlCheck.onBlur(event.target.value)}
              onChange={(event) => {
                onChange({ ...draft, url: event.target.value });
                urlCheck.onChange(event.target.value);
              }}
            />
          )}
        </Field>
      )}
      <div>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={draft.enabled && !enableReason}
            disabled={Boolean(enableReason)}
            aria-describedby={enableReason ? `${id}-enable-reason` : undefined}
            onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
          />
          Save as enabled
        </label>
        {enableReason ? (
          <p id={`${id}-enable-reason`} className="text-xs text-fg-muted">
            {enableReason}
          </p>
        ) : null}
      </div>
      <p className="text-xs text-fg-muted">
        Enabling saves metadata; it does not connect a server. Keep credential values out of commands and arguments.
        Template authentication references remain under Gateway policy.
      </p>
    </fieldset>
  );
}
