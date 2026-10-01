import { useId } from "react";
import type { McpCreateForm } from "../../../features/native-routes/settings/sections/mcp-editor-drafts";
import { isRuntimeInvokableMcpServer } from "../../../features/native-routes/settings/helpers/mcp-helpers";

export function McpCreateFields({
  draft,
  disabled,
  onChange,
}: {
  draft: McpCreateForm;
  disabled: boolean;
  onChange: (value: McpCreateForm) => void;
}) {
  const id = useId(),
    field = "mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-fg disabled:opacity-60";
  return (
    <fieldset disabled={disabled} className="space-y-3 text-sm text-fg-secondary">
      <legend className="sr-only">New saved MCP server</legend>
      <div>
        <label htmlFor={`${id}-label`}>Server label</label>
        <input
          id={`${id}-label`}
          className={field}
          value={draft.label}
          onChange={(event) => onChange({ ...draft, label: event.target.value })}
        />
      </div>
      <div>
        <label htmlFor={`${id}-transport`}>Transport</label>
        <select
          id={`${id}-transport`}
          className={field}
          value={draft.transport}
          onChange={(event) => onChange({ ...draft, transport: event.target.value as McpCreateForm["transport"] })}
        >
          <option value="stdio">Local process (stdio)</option>
          <option value="http">Remote HTTP</option>
          <option value="sse">Remote SSE</option>
        </select>
      </div>
      {draft.transport === "stdio" ? (
        <>
          <div>
            <label htmlFor={`${id}-command`}>Command</label>
            <input
              id={`${id}-command`}
              className={field}
              value={draft.command}
              onChange={(event) => onChange({ ...draft, command: event.target.value })}
            />
          </div>
          <div>
            <label htmlFor={`${id}-args`}>Arguments (one per line)</label>
            <textarea
              id={`${id}-args`}
              className={`${field} min-h-24 py-2`}
              value={draft.args.join("\n")}
              onChange={(event) => onChange({ ...draft, args: event.target.value.split("\n") })}
            />
          </div>
        </>
      ) : (
        <div>
          <label htmlFor={`${id}-url`}>Server URL</label>
          <input
            id={`${id}-url`}
            type="url"
            className={field}
            value={draft.url}
            onChange={(event) => onChange({ ...draft, url: event.target.value })}
          />
        </div>
      )}
      <label className="flex min-h-10 items-center gap-2">
        <input
          type="checkbox"
          checked={draft.enabled && isRuntimeInvokableMcpServer(draft)}
          disabled={!isRuntimeInvokableMcpServer(draft)}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        Save as enabled
      </label>
      <p className="text-xs text-fg-muted">
        Enabling saves metadata; it does not connect a server. Keep credential values out of commands and arguments.
        Template authentication references remain under Gateway policy.
      </p>
    </fieldset>
  );
}
