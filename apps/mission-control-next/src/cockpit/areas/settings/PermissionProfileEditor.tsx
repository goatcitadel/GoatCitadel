import { useState, type SetStateAction } from "react";
import type { PermissionProfileSnapshotRecord } from "@goatcitadel/contracts";
import { useSessionDraft } from "../../../features/native-routes/library/session-drafts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import {
  createEmptyPermissionProfileDraft,
  createPermissionProfileDraftFromRecord,
  permissionProfileDraftToMutation,
} from "../../../features/native-routes/settings/helpers/permission-helpers";
import { usePermissionManagement } from "../../../features/native-routes/settings/use-permission-management";
import { PermissionManagementReview } from "../../../features/native-routes/settings/PermissionManagementReview";
import type { PermissionManagementOperation } from "../../../features/native-routes/settings/permission-management-binding";
import { PermissionProfileFields } from "./PermissionProfileFields";
import { Button } from "../../ui/Button";

export function PermissionProfileEditor({
  workspaceId,
  profiles,
  available,
  deploymentProfile,
  reload,
}: {
  workspaceId: string;
  profiles: PermissionProfileSnapshotRecord[];
  available: boolean;
  deploymentProfile?: string;
  reload: () => Promise<unknown>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const leave = useDraftLeave();
  const editable = profiles.filter(
    (profile) =>
      !profile.builtin &&
      profile.status === "active" &&
      (profile.scope === "operator" || (profile.scope === "workspace" && profile.scopeRef === workspaceId)),
  );
  const selected = editable.find((profile) => profile.profileId === selectedId);
  const baseline = selected ? createPermissionProfileDraftFromRecord(selected) : createEmptyPermissionProfileDraft();
  const editor = useSessionDraft(
    `permission-profile:${workspaceId}:${selectedId || "new"}`,
    baseline,
    selected?.revision,
    { label: selected?.label ?? "New permission profile", active: open, available: !selectedId || Boolean(selected) },
  );
  const control = usePermissionManagement({
    workspaceId,
    identity: JSON.stringify([open, selectedId, editor.value, editor.baseRevision, available]),
    reload,
  });
  const operation: PermissionManagementOperation = selected
    ? { kind: "update", profile: selected, fields: permissionProfileDraftToMutation(editor.value) }
    : { kind: "create", fields: permissionProfileDraftToMutation(editor.value) };
  const attempt = control.attemptFor(operation);
  const blocked =
    !available ||
    !workspaceId ||
    Boolean(attempt) ||
    Boolean(selectedId && !selected) ||
    editor.hasRemoteChanges ||
    Boolean(selected && editor.baseRevision !== selected.revision);
  function change(update: SetStateAction<typeof editor.value>) {
    control.invalidate();
    editor.setValue(update);
  }
  function show(profileId: string) {
    leave.request(() => {
      control.invalidate();
      setSelectedId(profileId);
      setOpen(true);
    }, [editor.key]);
  }
  async function review() {
    if (blocked) return;
    const submitted = editor.value;
    await control.request(operation, (receipt) => {
      if (!("profileId" in receipt)) return;
      editor.acceptSaved(
        selected ? createPermissionProfileDraftFromRecord(receipt) : createEmptyPermissionProfileDraft(),
        selected ? receipt.revision : undefined,
        submitted,
      );
    });
  }
  return (
    <section
      id="permission-profile-editor"
      aria-label="Manage permission profiles"
      className="space-y-3 border-t border-line pt-4"
    >
      <h3 className="font-display text-base font-semibold">Manage permission profiles</h3>
      <p className="text-sm text-fg-secondary">
        Create workspace profiles or edit your custom profiles. Built-in profiles are read-only. Saving policy defaults
        can affect later tool decisions in existing conversations.
      </p>
      <Button size="sm" disabled={!available} onClick={() => show("")}>
        New permission profile
      </Button>
      <label className="block text-sm">
        Find custom profile
        <input
          className="mt-1 w-full rounded border border-line bg-canvas p-2"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <ul className="space-y-2">
        {editable
          .filter((item) => `${item.label} ${item.description ?? ""}`.toLowerCase().includes(search.toLowerCase()))
          .slice(0, 30)
          .map((item) => (
            <li key={item.profileId}>
              <Button size="sm" onClick={() => show(item.profileId)}>
                Edit {item.label}
              </Button>
              <span className="ml-2 text-xs text-fg-muted">
                {item.scope === "operator" ? "Operator profile across workspaces" : "Workspace profile"}
              </span>
            </li>
          ))}
      </ul>
      {editable.length > 30 ? (
        <p className="text-xs text-fg-muted">Showing up to 30 matches. Search to narrow the list.</p>
      ) : null}
      {open ? (
        <div className="space-y-3 rounded-lg border border-line p-3">
          <h4 className="font-semibold">
            {selected ? `Edit ${selected.label}` : "New workspace permission profile"}
            {editor.isDirty ? " · Unsaved" : ""}
          </h4>
          <p className="text-xs text-fg-muted">
            Workspace <span className="break-all font-mono">{workspaceId}</span>. Saving requires returning to this
            editor and reviewing the exact change.
          </p>
          <fieldset disabled={Boolean(attempt)}>
            <PermissionProfileFields
              draft={editor.value}
              change={change}
              bypassUnavailable={!deploymentProfile || deploymentProfile === "remote_hardened"}
            />
          </fieldset>
          <p className="text-xs text-fg-muted">
            Blank description and read-access values retain existing values when editing.
          </p>
          {editor.hasRemoteChanges ? (
            <div role="alert">
              <p>The profile changed. The original draft is retained. Compare the current record before rebasing.</p>
              {selected ? (
                <details>
                  <summary>Current Gateway profile</summary>
                  <dl className="space-y-2 text-sm">
                    {[
                      ["Name", selected.label],
                      ["Description", selected.description || "None"],
                      [
                        "Approval behavior",
                        selected.approvalMode === "approve_all"
                          ? "Ask every time"
                          : selected.approvalMode === "approve_risky"
                            ? "Ask for risky work"
                            : "Skip normal prompts",
                      ],
                      ["Tool patterns", selected.toolPatterns.join(", ") || "None"],
                      ["Allow rules", selected.allow.join(", ") || "None"],
                      ["Deny rules", selected.deny.join(", ") || "None"],
                      ["Read access", selected.readAccessMode ?? "Gateway default"],
                      ["Default policy contexts", selected.defaultForSurfaces?.join(", ") || "None"],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="font-medium">{label}</dt>
                        <dd className="break-words">{value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="break-all font-mono text-xs">Revision {selected.revision}</p>
                </details>
              ) : null}
              <Button
                size="sm"
                onClick={() => {
                  control.invalidate();
                  editor.rebaseToCurrent();
                }}
              >
                Rebase permission draft to current profile
              </Button>
            </div>
          ) : null}
          {attempt ? <p role={attempt.phase === "uncertain" ? "alert" : "status"}>{attempt.message}</p> : null}
          {control.message ? <p role="status">{control.message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={blocked || control.checking || !editor.value.label.trim()}
              onClick={() => void review()}
            >
              Review profile change
            </Button>
            {selected ? (
              <Button
                variant="danger"
                disabled={blocked || control.checking}
                onClick={() => {
                  const submitted = editor.value;
                  void control.request({ kind: "archive", profile: selected }, () =>
                    editor.acceptSaved(createEmptyPermissionProfileDraft(), undefined, submitted),
                  );
                }}
              >
                Review profile archive
              </Button>
            ) : null}
            <Button
              onClick={() =>
                leave.request(() => {
                  control.invalidate();
                  setOpen(false);
                }, [editor.key])
              }
            >
              Close profile editor
            </Button>
          </div>
          {control.checking ? <p role="status">Reading the permission owner…</p> : null}
          <PermissionManagementReview
            control={control}
            renderButton={({ label, secondary, ...props }) => (
              <Button variant={secondary ? "secondary" : "primary"} {...props}>
                {label}
              </Button>
            )}
          />
        </div>
      ) : null}
      {leave.dialog}
    </section>
  );
}
