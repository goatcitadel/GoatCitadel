import { useId } from "react";
import type { ToolGrantDraft } from "../../../features/native-routes/settings/tool-grant-binding";

export function ToolGrantFields({
  draft,
  workspaceId,
  disabled,
  onChange,
}: {
  draft: ToolGrantDraft;
  workspaceId: string;
  disabled: boolean;
  onChange: (draft: ToolGrantDraft) => void;
}) {
  const id = useId();
  const inputClass =
    "mt-1 min-h-10 w-full rounded-md border border-line bg-raised px-3 text-sm text-fg disabled:opacity-50";
  return (
    <fieldset disabled={disabled} className="grid min-w-0 gap-3 sm:grid-cols-2">
      <legend className="sr-only">New tool grant</legend>
      <div>
        <label htmlFor={`${id}-pattern`} className="text-sm text-fg-secondary">
          Tool pattern
        </label>
        <input
          id={`${id}-pattern`}
          className={inputClass}
          value={draft.toolPattern}
          placeholder="session.status or memory.*"
          onChange={(event) => onChange({ ...draft, toolPattern: event.target.value })}
        />
      </div>
      <div>
        <label htmlFor={`${id}-decision`} className="text-sm text-fg-secondary">
          Decision
        </label>
        <select
          id={`${id}-decision`}
          className={inputClass}
          value={draft.decision}
          onChange={(event) => onChange({ ...draft, decision: event.target.value })}
        >
          <option value="allow">Allow</option>
          <option value="deny">Deny</option>
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-scope`} className="text-sm text-fg-secondary">
          Scope
        </label>
        <select
          id={`${id}-scope`}
          className={inputClass}
          value={draft.scope}
          onChange={(event) =>
            onChange({
              ...draft,
              scope: event.target.value,
              scopeRef: event.target.value === "workspace" ? workspaceId : "",
            })
          }
        >
          <option value="workspace">Workspace</option>
          <option value="session">Session</option>
          <option value="agent">Agent</option>
          <option value="task">Task</option>
          <option value="global">Global</option>
        </select>
      </div>
      <div>
        <label htmlFor={`${id}-scope-ref`} className="text-sm text-fg-secondary">
          Scope ID
        </label>
        <input
          id={`${id}-scope-ref`}
          className={inputClass}
          disabled={draft.scope === "global"}
          value={draft.scopeRef}
          onChange={(event) => onChange({ ...draft, scopeRef: event.target.value })}
        />
        <p className="mt-1 text-xs text-fg-muted">
          Global applies across contexts. Other scopes require the exact recorded ID.
        </p>
      </div>
      <div>
        <label htmlFor={`${id}-type`} className="text-sm text-fg-secondary">
          Grant type
        </label>
        <select
          id={`${id}-type`}
          className={inputClass}
          value={draft.grantType}
          onChange={(event) => onChange({ ...draft, grantType: event.target.value })}
        >
          <option value="persistent">Until revoked</option>
          <option value="ttl">Expires at a time</option>
          <option value="one_time">One use</option>
        </select>
      </div>
      {draft.grantType === "ttl" ? (
        <div>
          <label htmlFor={`${id}-expiry`} className="text-sm text-fg-secondary">
            Expires at
          </label>
          <input
            id={`${id}-expiry`}
            className={inputClass}
            value={draft.expiresAt}
            placeholder="ISO date and time"
            onChange={(event) => onChange({ ...draft, expiresAt: event.target.value })}
          />
        </div>
      ) : null}
    </fieldset>
  );
}
