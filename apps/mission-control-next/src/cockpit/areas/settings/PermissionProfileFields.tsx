import type { Dispatch, SetStateAction } from "react";
import type { FilesystemReadAccessMode, ToolApprovalMode } from "@goatcitadel/contracts";
import {
  togglePermissionProfileSurface,
  type PermissionProfileEditorDraft,
} from "../../../features/native-routes/settings/helpers/permission-helpers";
import { PERMISSION_CONTEXT_PRESENTATION } from "../../../features/native-routes/settings/sections/PermissionProfileDraftFields";
import { Field } from "../../ui/Field";
const inputClass = "mt-1 min-h-10 w-full rounded-md border border-line-control bg-canvas px-2 text-sm text-fg";
const fieldClass = inputClass.replace("mt-1 ", "");
export function PermissionProfileFields({
  draft,
  change,
  bypassUnavailable,
}: {
  draft: PermissionProfileEditorDraft;
  change: Dispatch<SetStateAction<PermissionProfileEditorDraft>>;
  bypassUnavailable: boolean;
}) {
  return (
    <div className="space-y-3">
      <Field label="Profile name">
        {(field) => (
          <input
            {...field}
            className={fieldClass}
            value={draft.label}
            onChange={(event) => change((old) => ({ ...old, label: event.target.value }))}
          />
        )}
      </Field>
      <Field label="Profile description">
        {(field) => (
          <textarea
            {...field}
            className={fieldClass}
            value={draft.description}
            onChange={(event) => change((old) => ({ ...old, description: event.target.value }))}
          />
        )}
      </Field>
      <Field
        label="Approval behavior"
        help="Connectors set to let reads or changes run on their own are the exception."
      >
        {(field) => (
          <select
            {...field}
            className={fieldClass}
            value={draft.approvalMode}
            onChange={(event) => change((old) => ({ ...old, approvalMode: event.target.value as ToolApprovalMode }))}
          >
            <option value="approve_all">Ask every time</option>
            <option value="approve_risky">Ask for risky work</option>
            <option value="bypass" disabled={bypassUnavailable}>
              Skip normal prompts
            </option>
          </select>
        )}
      </Field>
      {(["toolPatterns", "allow", "deny"] as const).map((key) => (
        <Field
          key={key}
          label={key === "toolPatterns" ? "Tool patterns" : key === "allow" ? "Allow rules" : "Deny rules"}
          help="One pattern per line, or separate with commas."
        >
          {(field) => (
            <textarea
              {...field}
              className={fieldClass}
              value={draft[key]}
              onChange={(event) => change((old) => ({ ...old, [key]: event.target.value }))}
            />
          )}
        </Field>
      ))}
      <Field label="Read access">
        {(field) => (
          <select
            {...field}
            className={fieldClass}
            value={draft.readAccessMode}
            onChange={(event) =>
              change((old) => ({ ...old, readAccessMode: event.target.value as FilesystemReadAccessMode | "" }))
            }
          >
            <option value="">Keep GoatCitadel default or existing value</option>
            <option value="roots_only">Allowed roots only</option>
            <option value="approval_required">Require approval outside roots</option>
            <option value="full_disk">Full disk subject to hard boundaries</option>
          </select>
        )}
      </Field>
      <fieldset>
        <legend>Default policy contexts</legend>
        {(["chat", "tools", "mcp", "all"] as const).map((surface) => (
          <label key={surface} className="mt-2 flex items-start gap-2">
            <input
              type="checkbox"
              checked={draft.defaultForSurfaces.includes(surface)}
              onChange={(event) =>
                change((old) => ({
                  ...old,
                  defaultForSurfaces: togglePermissionProfileSurface(
                    old.defaultForSurfaces,
                    surface,
                    event.target.checked,
                  ),
                }))
              }
            />
            {PERMISSION_CONTEXT_PRESENTATION[surface].label}
          </label>
        ))}
      </fieldset>
      <details>
        <summary>Retained legacy contexts</summary>
        <p className="my-2 text-xs text-fg-muted">
          Compatibility keys for saved selections and older clients. They do not govern current Chat.
        </p>
        {(["cowork", "code"] as const).map((surface) => (
          <label key={surface} className="mt-2 flex gap-2">
            <input
              type="checkbox"
              checked={draft.defaultForSurfaces.includes(surface)}
              onChange={(event) =>
                change((old) => ({
                  ...old,
                  defaultForSurfaces: togglePermissionProfileSurface(
                    old.defaultForSurfaces,
                    surface,
                    event.target.checked,
                  ),
                }))
              }
            />
            {PERMISSION_CONTEXT_PRESENTATION[surface].label}
          </label>
        ))}
      </details>
    </div>
  );
}
