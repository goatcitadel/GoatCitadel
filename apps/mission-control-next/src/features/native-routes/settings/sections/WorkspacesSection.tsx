import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import type { CitadelRecord } from "@goatcitadel/contracts";
import { fetchWorkspaces, listCitadels } from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { hasSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { formatDateTime } from "../helpers/input-format";
import { useWorkspaceEditor } from "../use-workspace-editor";
import { CHECKING_FOR_CHANGES, useDirectoryLifecycle } from "../use-directory-lifecycle";
import { directoryRecordId, type DirectoryLifecycleReview } from "../directory-lifecycle-binding";
import { useCitadelEditor } from "../use-citadel-editor";
import { CITADEL_KINDS } from "../citadel-editor-binding";

type DirectoryView = "active" | "archived" | "all";

export function WorkspacesSection({
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  activeWorkspaceName,
  setActiveCitadelId,
  setActiveWorkspaceId,
}: SettingsSectionProps) {
  const scope = activeCitadelId ?? "legacy";
  const [directory, setDirectory] = useSessionViewState<"workspaces" | "citadels">(
    "workspaces:directory",
    "workspaces",
  );
  const [view, setView] = useSessionViewState<DirectoryView>("workspaces:" + scope + ":filter", "all");
  const [citadelView, setCitadelView] = useSessionViewState<DirectoryView>("citadels:filter", "all");
  const [selectedCitadelId, setSelectedCitadelId] = useSessionViewState("citadels:selection", "");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useSessionViewState("workspaces:" + scope + ":selection", "");
  const [search, setSearch] = useSessionViewState("workspaces:" + scope + ":search", "");
  const [inspector, setInspector] = useState<"citadel" | "workspace" | null>(null);
  const [editor, setEditor] = useState<"citadel-new" | "citadel-edit" | "workspace-new" | "workspace-edit" | null>(
    null,
  );
  const leave = useDraftLeave();
  const load = useCallback(
    () => (activeCitadelId ? fetchWorkspaces("all", 500, activeCitadelId) : fetchWorkspaces("all", 500)),
    [activeCitadelId],
  );
  const loadCitadels = useCallback(() => listCitadels("all", 500), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const {
    loading: citadelsLoading,
    error: citadelsError,
    data: citadelsData,
    reload: reloadCitadels,
  } = useAsyncLoad(loadCitadels, [loadCitadels]);
  const lifecycle = useDirectoryLifecycle({
    ownerKey: scope,
    available: !loading && !error && !citadelsLoading && !citadelsError,
    checking: loading || citadelsLoading,
    reload: (kind) => (kind === "citadel" ? reloadCitadels() : reload()),
    onConfirmed: () => setInspector(null),
  });
  const selectedCitadel = citadelsData?.items?.find((item) => item.citadelId === selectedCitadelId) ?? null;
  const selectedWorkspace = data?.items?.find((item) => item.workspaceId === selectedWorkspaceId) ?? null;
  const citadelAction = useCitadelEditor({
    ownerKey: scope,
    selected: selectedCitadel,
    selectedId: selectedCitadelId,
    mode: editor === "citadel-new" ? "create" : editor === "citadel-edit" ? "edit" : null,
    available: !citadelsLoading && !citadelsError && Array.isArray(citadelsData?.items),
    reload: reloadCitadels,
    onCreated: (created) => {
      setEditor(null);
      setSelectedCitadelId(created.citadelId);
      setInspector("citadel");
    },
  });
  const {
    createDraft: citadelCreate,
    editDraft: citadelEdit,
    create: handleCreateCitadel,
    save: handleSaveCitadel,
  } = citadelAction;
  const hasCitadelConflict = citadelAction.hasConflict,
    citadelEditLocked = citadelAction.locked;
  const workspaceAction = useWorkspaceEditor({
    citadelId: activeCitadelId,
    citadelName: activeCitadelName,
    selected: selectedWorkspace,
    selectedId: selectedWorkspaceId,
    mode: editor === "workspace-new" ? "create" : editor === "workspace-edit" ? "edit" : null,
    available: !loading && !error && !citadelsLoading && !citadelsError,
    reload,
    onCreated: (created) => {
      setEditor(null);
      setSelectedWorkspaceId(created.workspaceId);
      setInspector("workspace");
    },
  });
  const {
    createDraft: workspaceCreate,
    editDraft: workspaceEdit,
    create: handleCreate,
    save: handleSave,
  } = workspaceAction;
  const busy = citadelAction.pending || workspaceAction.pending;
  const { value: citadelCreateForm, setValue: setCitadelCreateForm } = citadelCreate;
  const { value: citadelEditForm, setValue: setCitadelEditForm } = citadelEdit;
  const { value: createForm, setValue: setCreateForm } = workspaceCreate;
  const { value: editForm, setValue: setEditForm } = workspaceEdit;
  const activeDraft =
    editor === "citadel-new"
      ? citadelCreate
      : editor === "citadel-edit"
        ? citadelEdit
        : editor === "workspace-new"
          ? workspaceCreate
          : workspaceEdit;
  const transition = (next: () => void) => leave.request(next, editor ? [activeDraft.key] : []);
  const closeEditor = () => transition(() => setEditor(null));
  useEffect(() => {
    setInspector(null);
    setEditor(null);
  }, [scope]);
  const filtered = useMemo(
    () =>
      (data?.items ?? []).filter(
        (item) =>
          (view === "all" || item.lifecycleStatus === view) &&
          [item.name, item.slug, item.description].join(" ").toLowerCase().includes(search.toLowerCase()),
      ),
    [data?.items, view, search],
  );
  const filteredCitadels = useMemo(
    () => (citadelsData?.items ?? []).filter((item) => citadelView === "all" || item.lifecycleStatus === citadelView),
    [citadelsData?.items, citadelView],
  );
  const workspaceLifecycle =
    selectedWorkspace && activeCitadelId
      ? {
          kind: "workspace" as const,
          scope: activeCitadelId,
          record: selectedWorkspace,
          action: selectedWorkspace.lifecycleStatus === "active" ? ("archive" as const) : ("restore" as const),
        }
      : null;
  const citadelLifecycle = selectedCitadel
    ? {
        kind: "citadel" as const,
        record: selectedCitadel,
        action: selectedCitadel.lifecycleStatus === "active" ? ("archive" as const) : ("restore" as const),
      }
    : null;
  const lifecycleButton = (target: DirectoryLifecycleReview | null) =>
    target ? (
      <SettingsStack>
        <NativeButton
          disabled={
            busy ||
            lifecycle.locked(target) ||
            (target.kind === "workspace" && target.record.workspaceId === "default" && target.action === "archive")
          }
          variant={target.action === "archive" ? "destructive" : "secondary"}
          aria-label={
            (target.action === "archive" ? "Archive " : "Restore ") +
            (target.kind === "citadel" ? "Citadel " : "workspace ") +
            target.record.name
          }
          onClick={() => lifecycle.request(target)}
        >
          {target.action === "archive" ? <Trash2 size={16} /> : <RotateCcw size={16} />}
          {target.action === "archive" ? "Archive" : "Restore"}
        </NativeButton>
        {lifecycle.locked(target) ? <p role="status">{lifecycle.attempt(target).message}</p> : null}
      </SettingsStack>
    ) : null;
  return (
    <SettingsSectionShell
      loading={loading || citadelsLoading}
      error={error || citadelsError}
      onRetry={() => {
        void reload();
        void reloadCitadels();
      }}
    >
      {citadelAction.notice ? (
        <SettingsNotice
          notice={{ tone: citadelAction.uncertain ? "warning" : "info", message: citadelAction.notice }}
        />
      ) : null}
      {lifecycle.notice ? <SettingsNotice notice={{ tone: "info", message: lifecycle.notice }} /> : null}
      {workspaceAction.notice ? (
        <SettingsNotice
          notice={{ tone: workspaceAction.uncertain ? "warning" : "info", message: workspaceAction.notice }}
        />
      ) : null}
      {editor ? (
        <FocusedDetail
          title={
            editor === "workspace-new"
              ? "New workspace"
              : editor === "citadel-new"
                ? "New Citadel"
                : editor === "workspace-edit"
                  ? "Edit workspace"
                  : "Edit Citadel"
          }
          onClose={closeEditor}
        >
          <SettingsStack>
            <p>
              {editor.startsWith("workspace")
                ? "Citadel: " + (activeCitadelName ?? scope)
                : "Citadels contain workspaces, projects, and their governed settings."}
            </p>
            {activeDraft.hasRemoteChanges || (editor === "citadel-edit" && hasCitadelConflict) ? (
              <NativeCard title="Current saved values" subtitle="">
                <p>The record changed while this draft was open. Review these values before retrying.</p>
                <dl>
                  <dt>Name</dt>
                  <dd>{editor === "workspace-edit" ? selectedWorkspace?.name : selectedCitadel?.name}</dd>
                  <dt>Description</dt>
                  <dd>
                    {(editor === "workspace-edit" ? selectedWorkspace?.description : selectedCitadel?.description) ||
                      "None"}
                  </dd>
                  <dt>Slug</dt>
                  <dd>{editor === "workspace-edit" ? selectedWorkspace?.slug : selectedCitadel?.slug}</dd>
                  {editor === "citadel-edit" ? (
                    <>
                      <dt>Kind</dt>
                      <dd>{selectedCitadel?.kind}</dd>
                      <dt>Status</dt>
                      <dd>{selectedCitadel?.lifecycleStatus}</dd>
                      <dt>Default workspace</dt>
                      <dd>{selectedCitadel?.defaultWorkspaceId || "None"}</dd>
                    </>
                  ) : null}
                </dl>
                <NativeButton
                  disabled={
                    editor === "citadel-edit" &&
                    (!selectedCitadel?.revision || (hasCitadelConflict && !citadelAction.canRebase))
                  }
                  onClick={() => {
                    if (editor === "citadel-edit") citadelAction.rebase();
                    else activeDraft.rebaseToCurrent();
                  }}
                >
                  {editor === "workspace-edit" ? "Apply draft to current workspace" : "Apply draft to current Citadel"}
                </NativeButton>
                {editor === "citadel-edit" ? (
                  <NativeButton variant="secondary" onClick={() => void reloadCitadels()}>
                    Reload latest Citadel
                  </NativeButton>
                ) : null}
              </NativeCard>
            ) : null}
            {editor === "citadel-new" ? (
              <SettingsFieldGrid>
                <SettingsField label="New Citadel">
                  <input
                    className="mc-next-settings-input"
                    value={citadelCreateForm.name}
                    onChange={(event) => setCitadelCreateForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Kind">
                  <select
                    className="mc-next-settings-input"
                    value={citadelCreateForm.kind}
                    onChange={(event) =>
                      setCitadelCreateForm((current) => ({
                        ...current,
                        kind: event.target.value as CitadelRecord["kind"],
                      }))
                    }
                  >
                    {CITADEL_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </SettingsField>
                <SettingsField label="Slug">
                  <input
                    className="mc-next-settings-input"
                    value={citadelCreateForm.slug}
                    onChange={(event) => setCitadelCreateForm((current) => ({ ...current, slug: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Description">
                  <input
                    className="mc-next-settings-input"
                    value={citadelCreateForm.description}
                    onChange={(event) =>
                      setCitadelCreateForm((current) => ({ ...current, description: event.target.value }))
                    }
                  />
                </SettingsField>
              </SettingsFieldGrid>
            ) : editor === "citadel-edit" ? (
              <SettingsFieldGrid>
                <SettingsField label="Selected name">
                  <input
                    className="mc-next-settings-input"
                    value={citadelEditForm.name}
                    onChange={(event) => setCitadelEditForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Selected kind">
                  <select
                    className="mc-next-settings-input"
                    value={citadelEditForm.kind}
                    onChange={(event) =>
                      setCitadelEditForm((current) => ({
                        ...current,
                        kind: event.target.value as CitadelRecord["kind"],
                      }))
                    }
                  >
                    {CITADEL_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </SettingsField>
                <SettingsField label="Selected slug">
                  <input
                    className="mc-next-settings-input"
                    value={citadelEditForm.slug}
                    onChange={(event) => setCitadelEditForm((current) => ({ ...current, slug: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Selected description">
                  <input
                    className="mc-next-settings-input"
                    value={citadelEditForm.description}
                    onChange={(event) =>
                      setCitadelEditForm((current) => ({ ...current, description: event.target.value }))
                    }
                  />
                </SettingsField>
              </SettingsFieldGrid>
            ) : editor === "workspace-new" ? (
              <SettingsFieldGrid>
                <SettingsField label="Name">
                  <input
                    aria-label="New workspace name"
                    className="mc-next-settings-input"
                    value={createForm.name}
                    onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Slug">
                  <input
                    className="mc-next-settings-input"
                    value={createForm.slug}
                    onChange={(event) => setCreateForm((current) => ({ ...current, slug: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Description" span={2}>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={createForm.description}
                    onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </SettingsField>
              </SettingsFieldGrid>
            ) : (
              <SettingsFieldGrid>
                <SettingsField label="Name">
                  <input
                    className="mc-next-settings-input"
                    value={editForm.name}
                    onChange={(event) => setEditForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Slug">
                  <input
                    className="mc-next-settings-input"
                    value={editForm.slug}
                    onChange={(event) => setEditForm((current) => ({ ...current, slug: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Description" span={2}>
                  <textarea
                    className="mc-next-settings-textarea"
                    value={editForm.description}
                    onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))}
                  />
                </SettingsField>
              </SettingsFieldGrid>
            )}
            <SettingsButtonRow>
              <NativeButton
                disabled={
                  busy ||
                  (editor.startsWith("citadel") && citadelAction.locked) ||
                  (editor.startsWith("workspace") && workspaceAction.locked) ||
                  activeDraft.hasRemoteChanges ||
                  (editor === "workspace-edit" && !selectedWorkspace) ||
                  (editor === "citadel-edit" && (citadelEditLocked || !selectedCitadel?.revision || hasCitadelConflict))
                }
                onClick={() =>
                  void (editor === "workspace-new"
                    ? handleCreate()
                    : editor === "workspace-edit"
                      ? handleSave()
                      : editor === "citadel-new"
                        ? handleCreateCitadel()
                        : handleSaveCitadel())
                }
              >
                <Save size={16} />
                {editor === "workspace-new"
                  ? "Create workspace"
                  : editor === "citadel-new"
                    ? "Create Citadel"
                    : editor === "workspace-edit"
                      ? "Save changes"
                      : "Save Citadel"}
              </NativeButton>
              <NativeButton variant="secondary" onClick={closeEditor}>
                Close editor
              </NativeButton>
            </SettingsButtonRow>
          </SettingsStack>
        </FocusedDetail>
      ) : (
        <SettingsStack>
          <SettingsButtonRow>
            <NativeButton
              onClick={() => {
                setInspector(null);
                setEditor(directory === "citadels" ? "citadel-new" : "workspace-new");
              }}
            >
              <Plus size={16} />
              {directory === "citadels" ? "New Citadel" : "New workspace"}
              {(directory === "citadels" ? citadelCreate.isDirty : workspaceCreate.isDirty) ? " · Unsaved" : ""}
            </NativeButton>
            <NativeButton
              variant="secondary"
              onClick={() => {
                void reload();
                void reloadCitadels();
              }}
            >
              Refresh
            </NativeButton>
          </SettingsButtonRow>
          <SettingsFilterBar
            options={[
              { id: "workspaces", label: "Workspaces" },
              { id: "citadels", label: "Citadel manager" },
            ]}
            value={directory}
            onChange={(next) => {
              setDirectory(next as "workspaces" | "citadels");
              setInspector(null);
            }}
          />
          {directory === "workspaces" ? (
            <NativeCard
              title="Workspace directory"
              subtitle={"Citadel: " + (activeCitadelName ?? scope)}
              stats={[
                {
                  label: "Total",
                  value: error
                    ? "Unavailable"
                    : data
                      ? Array.isArray(data.items)
                        ? String(data.items.length)
                        : "Unavailable"
                      : "Loading",
                },
                { label: "Active workspace", value: activeWorkspaceName },
              ]}
            >
              <SettingsField label="Search workspaces">
                <input
                  className="mc-next-settings-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Name, slug, or description"
                />
              </SettingsField>
              <SettingsFilterBar
                options={[
                  { id: "all", label: "All", ariaLabel: "All workspaces" },
                  { id: "active", label: "Active", ariaLabel: "Active workspaces" },
                  { id: "archived", label: "Archived", ariaLabel: "Archived workspaces" },
                ]}
                value={view}
                onChange={(next) => setView(next as DirectoryView)}
              />
              <NativeSelectableList
                items={filtered.map((item) => ({
                  id: item.workspaceId,
                  title: item.name,
                  meta: [
                    item.lifecycleStatus,
                    item.workspaceId === activeWorkspaceId ? "Current" : "",
                    hasSessionDraft("workspace:" + scope + ":" + item.workspaceId + ":edit") ? "Unsaved" : "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  body: item.description || item.slug,
                }))}
                selectedId={inspector === "workspace" ? selectedWorkspaceId : undefined}
                onSelect={(id) => {
                  setSelectedWorkspaceId(id);
                  setInspector("workspace");
                }}
                emptyLabel={error ? "Workspace records are unavailable." : "No workspaces in this view."}
                maxHeight="min(65vh, 42rem)"
              />
            </NativeCard>
          ) : (
            <NativeCard
              title="Citadel manager"
              subtitle=""
              stats={[
                {
                  label: "Citadels",
                  value: citadelsError
                    ? "Unavailable"
                    : citadelsData
                      ? Array.isArray(citadelsData.items)
                        ? String(citadelsData.items.length)
                        : "Unavailable"
                      : "Loading",
                },
              ]}
            >
              <SettingsFilterBar
                options={[
                  { id: "all", label: "All", ariaLabel: "All Citadels" },
                  { id: "active", label: "Active", ariaLabel: "Active Citadels" },
                  { id: "archived", label: "Archived", ariaLabel: "Archived Citadels" },
                ]}
                value={citadelView}
                onChange={(next) => setCitadelView(next as DirectoryView)}
              />
              <NativeSelectableList
                items={filteredCitadels.map((item) => ({
                  id: item.citadelId,
                  title: item.name,
                  meta: [
                    item.lifecycleStatus,
                    item.citadelId === activeCitadelId ? "Current" : "",
                    hasSessionDraft("citadel:" + item.citadelId + ":edit") ? "Unsaved" : "",
                  ]
                    .filter(Boolean)
                    .join(" · "),
                  body: item.description || item.slug,
                }))}
                selectedId={inspector === "citadel" ? selectedCitadelId : undefined}
                onSelect={(id) => {
                  setSelectedCitadelId(id);
                  setInspector("citadel");
                }}
                emptyLabel={citadelsError ? "Citadel records are unavailable." : "No Citadels in this view."}
                maxHeight="min(65vh, 42rem)"
              />
            </NativeCard>
          )}
        </SettingsStack>
      )}
      <DetailInspector
        open={!editor && inspector !== null}
        title={
          inspector === "citadel"
            ? (selectedCitadel?.name ?? "Citadel unavailable")
            : (selectedWorkspace?.name ?? "Workspace unavailable")
        }
        onClose={() => setInspector(null)}
      >
        {inspector === "workspace" && selectedWorkspace ? (
          <SettingsStack>
            <p>{selectedWorkspace.description || "No description"}</p>
            <p>
              {selectedWorkspace.lifecycleStatus}
              {selectedWorkspace.workspaceId === activeWorkspaceId ? " · Current workspace" : ""}
            </p>
            <SettingsButtonRow>
              <NativeButton
                onClick={() => {
                  setInspector(null);
                  setEditor("workspace-edit");
                }}
              >
                Edit workspace{workspaceEdit.isDirty ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton
                variant="secondary"
                aria-label={"Make active workspace " + selectedWorkspace.name}
                onClick={() => {
                  setActiveWorkspaceId(selectedWorkspace.workspaceId);
                  setInspector(null);
                }}
              >
                <CheckCircle2 size={16} />
                Make active
              </NativeButton>
            </SettingsButtonRow>
            <dl>
              <dt>Workspace ID</dt>
              <dd>{selectedWorkspace.workspaceId}</dd>
              <dt>Slug</dt>
              <dd>{selectedWorkspace.slug}</dd>
              <dt>Citadel</dt>
              <dd>{selectedWorkspace.citadelId ?? scope}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(selectedWorkspace.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{formatDateTime(selectedWorkspace.updatedAt)}</dd>
              <dt>Revision</dt>
              <dd>{selectedWorkspace.revision}</dd>
            </dl>
            {lifecycleButton(workspaceLifecycle)}
          </SettingsStack>
        ) : inspector === "citadel" && selectedCitadel ? (
          <SettingsStack>
            <p>{selectedCitadel.description || "No description"}</p>
            <p>
              {selectedCitadel.lifecycleStatus}
              {selectedCitadel.citadelId === activeCitadelId ? " · Current Citadel" : ""}
            </p>
            <SettingsButtonRow>
              <NativeButton
                onClick={() => {
                  setInspector(null);
                  setEditor("citadel-edit");
                }}
              >
                Edit Citadel{citadelEdit.isDirty ? " · Unsaved" : ""}
              </NativeButton>
              <NativeButton
                variant="secondary"
                aria-label={"Make active Citadel " + selectedCitadel.name}
                onClick={() => {
                  setActiveCitadelId?.(selectedCitadel.citadelId);
                  setInspector(null);
                }}
              >
                <CheckCircle2 size={16} />
                Make active
              </NativeButton>
            </SettingsButtonRow>
            <dl>
              <dt>Citadel ID</dt>
              <dd>{selectedCitadel.citadelId}</dd>
              <dt>Kind</dt>
              <dd>{selectedCitadel.kind}</dd>
              <dt>Slug</dt>
              <dd>{selectedCitadel.slug}</dd>
              <dt>Created</dt>
              <dd>{formatDateTime(selectedCitadel.createdAt)}</dd>
              <dt>Updated</dt>
              <dd>{formatDateTime(selectedCitadel.updatedAt)}</dd>
            </dl>
            {lifecycleButton(citadelLifecycle)}
          </SettingsStack>
        ) : (
          <SettingsEmptyState label="The selected record is unavailable. Refresh or choose another record." />
        )}
        <NativeDisclosureCard id="workspace-lifecycle" title="Lifecycle">
          <p>Archive keeps records available in the archived view. Permanent deletion is not available here.</p>
        </NativeDisclosureCard>
      </DetailInspector>
      {leave.dialog}
      <ConfirmModal
        open={Boolean(lifecycle.review)}
        danger={lifecycle.review?.action === "archive"}
        pending={lifecycle.pending}
        title={
          (lifecycle.review?.action === "restore" ? "Restore " : "Archive ") +
          (lifecycle.review?.kind === "citadel" ? "Citadel?" : "workspace?")
        }
        message={
          (lifecycle.review?.record.name ?? "Record") +
          " · " +
          (lifecycle.review ? directoryRecordId(lifecycle.review) : "") +
          " · Reviewed revision " +
          (lifecycle.review?.record.revision ?? "Unavailable") +
          ". " +
          (lifecycle.review?.action === "archive"
            ? "The record stays in the archived view. Stored work is retained; any retained edit draft for this record will be discarded after confirmation."
            : "Restore this record to the active directory. Your current selection is retained.") +
          (lifecycle.checking ? " " + CHECKING_FOR_CHANGES : "")
        }
        confirmDisabled={!lifecycle.available}
        confirmLabel={
          "Confirm " +
          (lifecycle.review?.action ?? "archive") +
          (lifecycle.review?.kind === "citadel" ? " Citadel" : " workspace")
        }
        onCancel={lifecycle.cancel}
        onConfirm={() => void lifecycle.confirm()}
      />
    </SettingsSectionShell>
  );
}
