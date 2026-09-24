import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import type { CitadelRecord } from "@goatcitadel/contracts";
import { archiveCitadel, archiveWorkspace, createCitadel, createWorkspace, fetchWorkspaces, isApiRequestError, listCitadels, restoreCitadel, restoreWorkspace, updateCitadel, updateWorkspace } from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { getErrorMessage, type Notice, SettingsButtonRow, SettingsEmptyState, SettingsField, SettingsFieldGrid, SettingsFilterBar, SettingsNotice, type SettingsSectionProps, SettingsSectionShell, SettingsStack, useAsyncLoad } from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { hasSessionDraft, discardSessionDraft, useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { formatDateTime } from "../../SettingsNativePage";

const CITADEL_KIND_OPTIONS: Array<CitadelRecord["kind"]> = [
  "personal",
  "company",
  "team",
  "client",
  "household",
  "creator",
  "learning",
  "project",
  "custom",
];

type DirectoryView = "active" | "archived" | "all";
type PendingArchive =
  | { kind: "citadel"; id: string; label: string; expectedRevision: string }
  | { kind: "workspace"; id: string; label: string; expectedRevision: number };

function createEmptyCitadelDraft() {
  return { name: "", description: "", slug: "", kind: "custom" };
}

function isCitadelSaveConflict(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409 || !error.body || typeof error.body !== "object" || !("details" in error.body)) return false;
  const details = error.body.details;
  return Boolean(details && typeof details === "object" && "reason" in details && details.reason === "CITADEL_RECORD_REVISION_CONFLICT");
}

function createCitadelEditDraft(citadel: CitadelRecord | null) {
  return {
    name: citadel?.name ?? "",
    description: citadel?.description ?? "",
    slug: citadel?.slug ?? "",
    kind: citadel?.kind ?? "custom",
  };
}

function createEmptyWorkspaceDraft() {
  return { name: "", description: "", slug: "" };
}

function createWorkspaceEditDraft(workspace: { name: string; description?: string; slug: string } | null) {
  return {
    name: workspace?.name ?? "",
    description: workspace?.description ?? "",
    slug: workspace?.slug ?? "",
  };
}


export function WorkspacesSection({ activeCitadelId, activeCitadelName, activeWorkspaceId, activeWorkspaceName, setActiveCitadelId, setActiveWorkspaceId }: SettingsSectionProps) {
  const scope = activeCitadelId ?? "legacy";
  const [directory, setDirectory] = useSessionViewState<"workspaces" | "citadels">("workspaces:directory", "workspaces");
  const [view, setView] = useSessionViewState<DirectoryView>("workspaces:" + scope + ":filter", "all");
  const [citadelView, setCitadelView] = useSessionViewState<DirectoryView>("citadels:filter", "all");
  const [selectedCitadelId, setSelectedCitadelId] = useSessionViewState("citadels:selection", "");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useSessionViewState("workspaces:" + scope + ":selection", "");
  const [search, setSearch] = useSessionViewState("workspaces:" + scope + ":search", "");
  const [inspector, setInspector] = useState<"citadel" | "workspace" | null>(null);
  const [editor, setEditor] = useState<"citadel-new" | "citadel-edit" | "workspace-new" | "workspace-edit" | null>(null);
  const editorRef = useRef(editor); editorRef.current = editor;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const leave = useDraftLeave();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingArchive, setPendingArchive] = useState<PendingArchive | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const archiveBusyRef = useRef(false);
  const [citadelConflict, setCitadelConflict] = useState<{ key: string; revision: string } | null>(null);
  const load = useCallback(() => activeCitadelId ? fetchWorkspaces("all", 500, activeCitadelId) : fetchWorkspaces("all", 500), [activeCitadelId]);
  const loadCitadels = useCallback(() => listCitadels("all", 500), []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const { loading: citadelsLoading, error: citadelsError, data: citadelsData, reload: reloadCitadels } = useAsyncLoad(loadCitadels, [loadCitadels]);
  const selectedCitadel = citadelsData?.items?.find(item => item.citadelId === selectedCitadelId) ?? null;
  const selectedWorkspace = data?.items?.find(item => item.workspaceId === selectedWorkspaceId) ?? null;
  const workspaceKey = "workspace:" + scope + ":" + selectedWorkspaceId + ":edit";
  const citadelKey = "citadel:" + selectedCitadelId + ":edit";
  const citadelCreate = useSessionDraft("citadel:global:new", createEmptyCitadelDraft(), undefined, { label: "New Citadel", active: editor === "citadel-new", onSave: () => handleCreateCitadel() });
  const citadelEdit = useSessionDraft(citadelKey, createCitadelEditDraft(selectedCitadel), selectedCitadel?.revision, { label: selectedCitadel?.name ?? "Citadel", active: editor === "citadel-edit", available: Boolean(selectedCitadel), onSave: () => handleSaveCitadel() });
  const hasCitadelConflict = citadelConflict?.key === citadelEdit.key;
  const workspaceCreate = useSessionDraft("workspace:" + scope + ":new", createEmptyWorkspaceDraft(), undefined, { label: "New workspace in " + (activeCitadelName ?? scope), active: editor === "workspace-new", onSave: () => handleCreate() });
  const workspaceEdit = useSessionDraft(workspaceKey, createWorkspaceEditDraft(selectedWorkspace), selectedWorkspace?.revision, { label: selectedWorkspace?.name ?? "Workspace", active: editor === "workspace-edit", available: Boolean(selectedWorkspace), onSave: () => handleSave() });
  const { value: citadelCreateForm, setValue: setCitadelCreateForm } = citadelCreate;
  const { value: citadelEditForm, setValue: setCitadelEditForm } = citadelEdit;
  const { value: createForm, setValue: setCreateForm } = workspaceCreate;
  const { value: editForm, setValue: setEditForm } = workspaceEdit;
  const activeDraft = editor === "citadel-new" ? citadelCreate : editor === "citadel-edit" ? citadelEdit : editor === "workspace-new" ? workspaceCreate : workspaceEdit;
  const transition = (next: () => void) => leave.request(next, editor ? [activeDraft.key] : []);
  const closeEditor = () => transition(() => setEditor(null));
  useEffect(() => { setInspector(null); setEditor(null); }, [scope]);
  const filtered = useMemo(() => (data?.items ?? []).filter(item => (view === "all" || item.lifecycleStatus === view) && [item.name, item.slug, item.description].join(" ").toLowerCase().includes(search.toLowerCase())), [data?.items, view, search]);
  const filteredCitadels = useMemo(() => (citadelsData?.items ?? []).filter(item => citadelView === "all" || item.lifecycleStatus === citadelView), [citadelsData?.items, citadelView]);
  const run = async (action: () => Promise<boolean>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true);
    try { return await action(); } catch (cause) { setNotice({ tone: "error", message: getErrorMessage(cause) }); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  async function handleCreateCitadel(): Promise<boolean> {
    if (!citadelCreateForm.name.trim()) { setNotice({ tone: "warning", message: "Citadel name is required." }); return false; }
    const submitted = citadelCreateForm;
    return run(async () => {
      const created = await createCitadel({ name: submitted.name.trim(), description: submitted.description.trim() || undefined, slug: submitted.slug.trim() || undefined, kind: submitted.kind as CitadelRecord["kind"] });
      const saved = citadelCreate.acceptSaved(createEmptyCitadelDraft(), undefined, submitted);
      setNotice({ tone: "success", message: "Citadel " + created.name + " created." });
      await reloadCitadels();
      if (saved && editorRef.current === "citadel-new") { setEditor(null); setSelectedCitadelId(created.citadelId); setInspector("citadel"); }
      return saved;
    });
  }
  async function handleSaveCitadel(): Promise<boolean> {
    if (!selectedCitadel || citadelEdit.hasRemoteChanges || hasCitadelConflict || typeof citadelEdit.baseRevision !== "string") { setNotice({ tone: "warning", message: "Review the current Citadel before applying this draft." }); return false; }
    const expectedRevision = citadelEdit.baseRevision;
    const submitted = citadelEditForm;
    return run(async () => {
      try {
        const updated = await updateCitadel(selectedCitadel.citadelId, { expectedRevision, name: submitted.name.trim() || undefined, description: submitted.description.trim(), slug: submitted.slug.trim() || undefined, kind: submitted.kind as CitadelRecord["kind"] });
        const saved = citadelEdit.acceptSaved(createCitadelEditDraft(updated), updated.revision, submitted);
        setCitadelConflict(null);
        setNotice({ tone: "success", message: "Citadel " + updated.name + " updated." }); await reloadCitadels(); return saved;
      } catch (cause) {
        if (isCitadelSaveConflict(cause)) {
          setCitadelConflict({ key: citadelEdit.key, revision: expectedRevision });
          await reloadCitadels(); setNotice({ tone: "warning", message: "This Citadel changed elsewhere. Your draft is preserved. Review the current revision before applying it." }); return false;
        }
        throw cause;
      }
    });
  }
  async function handleCreate(): Promise<boolean> {
    if (!createForm.name.trim()) { setNotice({ tone: "warning", message: "Workspace name is required." }); return false; }
    const submitted = createForm;
    return run(async () => {
      const created = await createWorkspace({ ...(activeCitadelId ? { citadelId: activeCitadelId } : {}), name: submitted.name.trim(), description: submitted.description.trim() || undefined, slug: submitted.slug.trim() || undefined });
      const saved = workspaceCreate.acceptSaved(createEmptyWorkspaceDraft(), undefined, submitted);
      setNotice({ tone: "success", message: "Workspace " + created.name + " created." }); await reload();
      if (saved && editorRef.current === "workspace-new") { setEditor(null); setSelectedWorkspaceId(created.workspaceId); setInspector("workspace"); }
      return saved;
    });
  }
  async function handleSave(): Promise<boolean> {
    if (!selectedWorkspace || workspaceEdit.hasRemoteChanges) { setNotice({ tone: "warning", message: "Review the current workspace before applying this draft." }); return false; }
    const submitted = editForm;
    return run(async () => {
      try {
        const description = submitted.description.trim();
        const updated = await updateWorkspace(selectedWorkspace.workspaceId, { expectedRevision: workspaceEdit.baseRevision as number, name: submitted.name.trim() || undefined, description, slug: submitted.slug.trim() || undefined });
        const saved = workspaceEdit.acceptSaved(createWorkspaceEditDraft(updated), updated.revision, submitted);
        setNotice({ tone: "success", message: description ? "Workspace " + updated.name + " updated." : "Workspace " + updated.name + " updated. Description cleared." }); await reload(); return saved;
      } catch (cause) {
        if (isApiRequestError(cause) && cause.status === 409) {
          await reload(); setNotice({ tone: "warning", message: "This workspace changed elsewhere. Your draft is preserved. Review the current revision before applying it." }); return false;
        }
        throw cause;
      }
    });
  }
  const restore = (kind: "citadel" | "workspace") => void run(async () => {
    try {
      if (kind === "citadel" && selectedCitadel?.revision) { await restoreCitadel(selectedCitadel.citadelId, selectedCitadel.revision); await reloadCitadels(); }
      else if (kind === "workspace" && selectedWorkspace) { await restoreWorkspace(selectedWorkspace.workspaceId, selectedWorkspace.revision); await reload(); }
      else return false;
      setNotice({ tone: "success", message: (kind === "citadel" ? "Citadel" : "Workspace") + " restored." }); return true;
    } catch (cause) {
      if (isApiRequestError(cause) && cause.status === 409) { await (kind === "citadel" ? reloadCitadels() : reload()); setNotice({ tone: "warning", message: "This " + (kind === "citadel" ? "Citadel" : "workspace") + " changed elsewhere. Review the current revision and restore again." }); return false; }
      throw cause;
    }
  });
  const handleConfirmArchive = async () => {
    if (!pendingArchive || archiveBusyRef.current) return;
    archiveBusyRef.current = true; setArchiveBusy(true);
    try {
      if (pendingArchive.kind === "citadel") { await archiveCitadel(pendingArchive.id, pendingArchive.expectedRevision); discardSessionDraft("citadel:" + pendingArchive.id + ":edit"); await reloadCitadels(); }
      else { await archiveWorkspace(pendingArchive.id, pendingArchive.expectedRevision); discardSessionDraft("workspace:" + scope + ":" + pendingArchive.id + ":edit"); await reload(); }
      setNotice({ tone: "success", message: pendingArchive.label + " archived." }); setPendingArchive(null); setInspector(null);
    } catch (cause) {
      if (isApiRequestError(cause) && cause.status === 409) { await (pendingArchive.kind === "citadel" ? reloadCitadels() : reload()); setPendingArchive(null); setNotice({ tone: "warning", message: "This " + (pendingArchive.kind === "citadel" ? "Citadel" : "workspace") + " changed elsewhere. Review the current revision and archive again." }); }
      else setNotice({ tone: "error", message: getErrorMessage(cause) });
    } finally { archiveBusyRef.current = false; setArchiveBusy(false); }
  };
  return <SettingsSectionShell loading={loading || citadelsLoading} error={error || citadelsError} onRetry={() => { void reload(); void reloadCitadels(); }}>
    {notice ? <SettingsNotice notice={notice} /> : null}
    {editor ? <FocusedDetail title={editor === "workspace-new" ? "New workspace" : editor === "citadel-new" ? "New Citadel" : editor === "workspace-edit" ? "Edit workspace" : "Edit Citadel"} onClose={closeEditor}>
      <SettingsStack>
      <p>{editor.startsWith("workspace") ? "Citadel: " + (activeCitadelName ?? scope) : "Citadels contain workspaces, projects, and their governed settings."}</p>
      {activeDraft.hasRemoteChanges || (editor === "citadel-edit" && hasCitadelConflict) ? <NativeCard title="Current saved values" subtitle="">
        <p>The record changed while this draft was open. Review these values before retrying.</p>
        <dl><dt>Name</dt><dd>{editor === "workspace-edit" ? selectedWorkspace?.name : selectedCitadel?.name}</dd><dt>Description</dt><dd>{(editor === "workspace-edit" ? selectedWorkspace?.description : selectedCitadel?.description) || "None"}</dd><dt>Slug</dt><dd>{editor === "workspace-edit" ? selectedWorkspace?.slug : selectedCitadel?.slug}</dd>
          {editor === "citadel-edit" ? <><dt>Kind</dt><dd>{selectedCitadel?.kind}</dd><dt>Status</dt><dd>{selectedCitadel?.lifecycleStatus}</dd><dt>Default workspace</dt><dd>{selectedCitadel?.defaultWorkspaceId || "None"}</dd></> : null}</dl>
        <NativeButton disabled={editor === "citadel-edit" && (!selectedCitadel?.revision || (hasCitadelConflict && selectedCitadel.revision === citadelConflict.revision))}
          onClick={() => { activeDraft.rebaseToCurrent(); if (editor === "citadel-edit") setCitadelConflict(null); }}>{editor === "workspace-edit" ? "Apply draft to current workspace" : "Apply draft to current Citadel"}</NativeButton>
        {editor === "citadel-edit" ? <NativeButton variant="secondary" onClick={() => void reloadCitadels()}>Reload latest Citadel</NativeButton> : null}
      </NativeCard> : null}
      {editor === "citadel-new" ? (<SettingsFieldGrid>
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
                  {CITADEL_KIND_OPTIONS.map((kind) => (
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
            </SettingsFieldGrid>) : editor === "citadel-edit" ? (<SettingsFieldGrid>
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
                      {CITADEL_KIND_OPTIONS.map((kind) => (
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
                </SettingsFieldGrid>) : editor === "workspace-new" ? (<SettingsFieldGrid>
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
            </SettingsFieldGrid>) : (<SettingsFieldGrid>
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
              </SettingsFieldGrid>)}
      <SettingsButtonRow><NativeButton disabled={busy || activeDraft.hasRemoteChanges || (editor === "workspace-edit" && !selectedWorkspace) || (editor === "citadel-edit" && (!selectedCitadel?.revision || hasCitadelConflict))} onClick={() => void (editor === "workspace-new" ? handleCreate() : editor === "workspace-edit" ? handleSave() : editor === "citadel-new" ? handleCreateCitadel() : handleSaveCitadel())}><Save size={16} />{editor === "workspace-new" ? "Create workspace" : editor === "citadel-new" ? "Create Citadel" : editor === "workspace-edit" ? "Save changes" : "Save Citadel"}</NativeButton><NativeButton variant="secondary" onClick={closeEditor}>Close editor</NativeButton></SettingsButtonRow>
      </SettingsStack>
    </FocusedDetail> : <SettingsStack>
      <SettingsButtonRow><NativeButton onClick={() => { setInspector(null); setEditor(directory === "citadels" ? "citadel-new" : "workspace-new"); }}><Plus size={16} />{directory === "citadels" ? "New Citadel" : "New workspace"}{(directory === "citadels" ? citadelCreate.isDirty : workspaceCreate.isDirty) ? " · Unsaved" : ""}</NativeButton><NativeButton variant="secondary" onClick={() => { void reload(); void reloadCitadels(); }}>Refresh</NativeButton></SettingsButtonRow>
      <SettingsFilterBar options={[{id:"workspaces",label:"Workspaces"},{id:"citadels",label:"Citadel manager"}]} value={directory} onChange={next => { setDirectory(next as "workspaces" | "citadels"); setInspector(null); }} />
      {directory === "workspaces" ? <NativeCard title="Workspace directory" subtitle={"Citadel: " + (activeCitadelName ?? scope)} stats={[{label:"Total",value:error ? "Unavailable" : data ? (Array.isArray(data.items) ? String(data.items.length) : "Unavailable") : "Loading"},{label:"Active workspace",value:activeWorkspaceName}]}>
        <SettingsField label="Search workspaces"><input className="mc-next-settings-input" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, slug, or description" /></SettingsField>
        <SettingsFilterBar options={[{id:"all",label:"All",ariaLabel:"All workspaces"},{id:"active",label:"Active",ariaLabel:"Active workspaces"},{id:"archived",label:"Archived",ariaLabel:"Archived workspaces"}]} value={view} onChange={next => setView(next as DirectoryView)} />
        <NativeSelectableList items={filtered.map(item => ({id:item.workspaceId,title:item.name,meta:[item.lifecycleStatus,item.workspaceId === activeWorkspaceId ? "Current" : "",hasSessionDraft("workspace:" + scope + ":" + item.workspaceId + ":edit") ? "Unsaved" : ""].filter(Boolean).join(" · "),body:item.description || item.slug}))} selectedId={inspector === "workspace" ? selectedWorkspaceId : undefined} onSelect={id => { setSelectedWorkspaceId(id); setInspector("workspace"); }} emptyLabel={error ? "Workspace records are unavailable." : "No workspaces in this view."} maxHeight="min(65vh, 42rem)" />
      </NativeCard> : <NativeCard title="Citadel manager" subtitle="" stats={[{label:"Citadels",value:citadelsError ? "Unavailable" : citadelsData ? (Array.isArray(citadelsData.items) ? String(citadelsData.items.length) : "Unavailable") : "Loading"}]}>
        <SettingsFilterBar options={[{id:"all",label:"All",ariaLabel:"All Citadels"},{id:"active",label:"Active",ariaLabel:"Active Citadels"},{id:"archived",label:"Archived",ariaLabel:"Archived Citadels"}]} value={citadelView} onChange={next => setCitadelView(next as DirectoryView)} />
        <NativeSelectableList items={filteredCitadels.map(item => ({id:item.citadelId,title:item.name,meta:[item.lifecycleStatus,item.citadelId === activeCitadelId ? "Current" : "",hasSessionDraft("citadel:" + item.citadelId + ":edit") ? "Unsaved" : ""].filter(Boolean).join(" · "),body:item.description || item.slug}))} selectedId={inspector === "citadel" ? selectedCitadelId : undefined} onSelect={id => { setSelectedCitadelId(id); setInspector("citadel"); }} emptyLabel={citadelsError ? "Citadel records are unavailable." : "No Citadels in this view."} maxHeight="min(65vh, 42rem)" />
      </NativeCard>}
    </SettingsStack>}
    <DetailInspector open={!editor && inspector !== null} title={inspector === "citadel" ? selectedCitadel?.name ?? "Citadel unavailable" : selectedWorkspace?.name ?? "Workspace unavailable"} onClose={() => setInspector(null)}>
      {inspector === "workspace" && selectedWorkspace ? <SettingsStack>
        <p>{selectedWorkspace.description || "No description"}</p><p>{selectedWorkspace.lifecycleStatus}{selectedWorkspace.workspaceId === activeWorkspaceId ? " · Current workspace" : ""}</p>
        <SettingsButtonRow><NativeButton onClick={() => { setInspector(null); setEditor("workspace-edit"); }}>Edit workspace{workspaceEdit.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="secondary" aria-label={"Make active workspace " + selectedWorkspace.name} onClick={() => { setActiveWorkspaceId(selectedWorkspace.workspaceId); setInspector(null); }}><CheckCircle2 size={16} />Make active</NativeButton></SettingsButtonRow>
        <dl><dt>Workspace ID</dt><dd>{selectedWorkspace.workspaceId}</dd><dt>Slug</dt><dd>{selectedWorkspace.slug}</dd><dt>Citadel</dt><dd>{selectedWorkspace.citadelId ?? scope}</dd><dt>Created</dt><dd>{formatDateTime(selectedWorkspace.createdAt)}</dd><dt>Updated</dt><dd>{formatDateTime(selectedWorkspace.updatedAt)}</dd><dt>Revision</dt><dd>{selectedWorkspace.revision}</dd></dl>
        {selectedWorkspace.lifecycleStatus === "archived" ? <NativeButton disabled={busy} variant="secondary" aria-label={"Restore workspace " + selectedWorkspace.name} onClick={() => restore("workspace")}><RotateCcw size={16} />Restore</NativeButton> : <NativeButton variant="destructive" aria-label={"Archive workspace " + selectedWorkspace.name} onClick={() => setPendingArchive({kind:"workspace",id:selectedWorkspace.workspaceId,label:selectedWorkspace.name,expectedRevision:selectedWorkspace.revision})}><Trash2 size={16} />Archive</NativeButton>}
      </SettingsStack> : inspector === "citadel" && selectedCitadel ? <SettingsStack>
        <p>{selectedCitadel.description || "No description"}</p><p>{selectedCitadel.lifecycleStatus}{selectedCitadel.citadelId === activeCitadelId ? " · Current Citadel" : ""}</p>
        <SettingsButtonRow><NativeButton onClick={() => { setInspector(null); setEditor("citadel-edit"); }}>Edit Citadel{citadelEdit.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="secondary" aria-label={"Make active Citadel " + selectedCitadel.name} onClick={() => { setActiveCitadelId?.(selectedCitadel.citadelId); setInspector(null); }}><CheckCircle2 size={16} />Make active</NativeButton></SettingsButtonRow>
        <dl><dt>Citadel ID</dt><dd>{selectedCitadel.citadelId}</dd><dt>Kind</dt><dd>{selectedCitadel.kind}</dd><dt>Slug</dt><dd>{selectedCitadel.slug}</dd><dt>Created</dt><dd>{formatDateTime(selectedCitadel.createdAt)}</dd><dt>Updated</dt><dd>{formatDateTime(selectedCitadel.updatedAt)}</dd></dl>
        {selectedCitadel.lifecycleStatus === "archived" ? <NativeButton disabled={busy || !selectedCitadel.revision} variant="secondary" aria-label={"Restore Citadel " + selectedCitadel.name} onClick={() => restore("citadel")}><RotateCcw size={16} />Restore</NativeButton> : <NativeButton disabled={!selectedCitadel.revision} variant="destructive" aria-label={"Archive Citadel " + selectedCitadel.name} onClick={() => setPendingArchive({kind:"citadel",id:selectedCitadel.citadelId,label:selectedCitadel.name,expectedRevision:selectedCitadel.revision})}><Trash2 size={16} />Archive</NativeButton>}
      </SettingsStack> : <SettingsEmptyState label="The selected record is unavailable. Refresh or choose another record." />}
      <NativeDisclosureCard id="workspace-lifecycle" title="Lifecycle"><p>Archive keeps records available in the archived view. Permanent deletion is not available here.</p></NativeDisclosureCard>
    </DetailInspector>
    {leave.dialog}
    <ConfirmModal open={pendingArchive !== null} danger pending={archiveBusy} title={"Archive " + (pendingArchive?.kind === "citadel" ? "Citadel" : "workspace") + "?"} message={"Archive " + (pendingArchive?.label ?? "this item") + "? It remains available in the archived view. Any retained edit draft for this record will be discarded."} confirmLabel={pendingArchive?.kind === "citadel" ? "Confirm archive Citadel" : "Confirm archive workspace"} onCancel={() => setPendingArchive(null)} onConfirm={() => void handleConfirmArchive()} />
  </SettingsSectionShell>;
}
