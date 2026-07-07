// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, RotateCcw, Save, Trash2 } from "lucide-react";
import type { CitadelRecord } from "@goatcitadel/contracts";
import {
  archiveCitadel,
  archiveWorkspace,
  createCitadel,
  createWorkspace,
  fetchWorkspaces,
  listCitadels,
  restoreCitadel,
  restoreWorkspace,
  updateCitadel,
  updateWorkspace,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  getErrorMessage,
  type Notice,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsFilterBar,
  SettingsGrid,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
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

export function WorkspacesSection({
  activeCitadelId,
  activeCitadelName,
  activeWorkspaceId,
  setActiveCitadelId,
  setActiveWorkspaceId,
}: SettingsSectionProps) {
  const [view, setView] = useState<"active" | "archived" | "all">("all");
  const [citadelView, setCitadelView] = useState<"active" | "archived" | "all">("all");
  const load = useCallback(
    async () => (activeCitadelId ? fetchWorkspaces("all", 500, activeCitadelId) : fetchWorkspaces("all", 500)),
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
  const [selectedCitadelId, setSelectedCitadelId] = useState(activeCitadelId ?? "");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [citadelCreateForm, setCitadelCreateForm] = useState({
    name: "",
    description: "",
    slug: "",
    kind: "custom",
  });
  const [citadelEditForm, setCitadelEditForm] = useState({
    name: "",
    description: "",
    slug: "",
    kind: "custom",
  });
  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    slug: "",
  });
  const [editForm, setEditForm] = useState({
    name: "",
    description: "",
    slug: "",
  });

  const filtered = useMemo(() => {
    const items = data?.items ?? [];
    if (view === "all") {
      return items;
    }
    return items.filter((item) => item.lifecycleStatus === view);
  }, [data?.items, view]);
  const filteredCitadels = useMemo(() => {
    const items = citadelsData?.items ?? [];
    if (citadelView === "all") {
      return items;
    }
    return items.filter((item) => item.lifecycleStatus === citadelView);
  }, [citadelView, citadelsData?.items]);
  const selectedCitadel = (citadelsData?.items ?? []).find((item) => item.citadelId === selectedCitadelId) ?? null;
  const selectedWorkspace = (data?.items ?? []).find((item) => item.workspaceId === selectedWorkspaceId) ?? null;

  useEffect(() => {
    setSelectedCitadelId((current) => activeCitadelId || current);
  }, [activeCitadelId]);

  useEffect(() => {
    if (!filteredCitadels.length) {
      setSelectedCitadelId("");
      return;
    }
    setSelectedCitadelId((current) =>
      current && filteredCitadels.some((item) => item.citadelId === current)
        ? current
        : filteredCitadels[0]?.citadelId || "",
    );
  }, [filteredCitadels]);

  useEffect(() => {
    if (!selectedCitadel) {
      setCitadelEditForm({ name: "", description: "", slug: "", kind: "custom" });
      return;
    }
    setCitadelEditForm({
      name: selectedCitadel.name,
      description: selectedCitadel.description ?? "",
      slug: selectedCitadel.slug,
      kind: selectedCitadel.kind,
    });
  }, [selectedCitadel]);

  useEffect(() => {
    if (!filtered.length) {
      setSelectedWorkspaceId("");
      return;
    }
    setSelectedWorkspaceId((current) =>
      current && filtered.some((item) => item.workspaceId === current) ? current : filtered[0]?.workspaceId || "",
    );
  }, [filtered]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setEditForm({ name: "", description: "", slug: "" });
      return;
    }
    setEditForm({
      name: selectedWorkspace.name,
      description: selectedWorkspace.description ?? "",
      slug: selectedWorkspace.slug,
    });
  }, [selectedWorkspace]);

  const handleCreateCitadel = async () => {
    if (!citadelCreateForm.name.trim()) {
      setNotice({ tone: "warning", message: "Citadel name is required." });
      return;
    }
    try {
      const created = await createCitadel({
        name: citadelCreateForm.name.trim(),
        description: citadelCreateForm.description.trim() || undefined,
        slug: citadelCreateForm.slug.trim() || undefined,
        kind: citadelCreateForm.kind as CitadelRecord["kind"],
      });
      setNotice({ tone: "success", message: `Citadel ${created.name} created.` });
      setCitadelCreateForm({ name: "", description: "", slug: "", kind: "custom" });
      await reloadCitadels();
      setSelectedCitadelId(created.citadelId);
      setActiveCitadelId?.(created.citadelId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSaveCitadel = async () => {
    if (!selectedCitadel) {
      return;
    }
    try {
      const updated = await updateCitadel(selectedCitadel.citadelId, {
        name: citadelEditForm.name.trim() || undefined,
        description: citadelEditForm.description.trim() || undefined,
        slug: citadelEditForm.slug.trim() || undefined,
        kind: citadelEditForm.kind as CitadelRecord["kind"],
      });
      setNotice({ tone: "success", message: `Citadel ${updated.name} updated.` });
      await reloadCitadels();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleArchiveCitadel = async () => {
    if (!selectedCitadel) {
      return;
    }
    if (!window.confirm(`Archive Citadel ${selectedCitadel.name}?`)) {
      return;
    }
    try {
      await archiveCitadel(selectedCitadel.citadelId);
      setNotice({ tone: "success", message: `Citadel ${selectedCitadel.name} archived.` });
      await reloadCitadels();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  const handleRestoreCitadel = async () => {
    if (!selectedCitadel) {
      return;
    }
    try {
      await restoreCitadel(selectedCitadel.citadelId);
      setNotice({ tone: "success", message: `Citadel ${selectedCitadel.name} restored.` });
      await reloadCitadels();
    } catch (restoreError) {
      setNotice({ tone: "error", message: getErrorMessage(restoreError) });
    }
  };

  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      setNotice({ tone: "warning", message: "Workspace name is required." });
      return;
    }
    try {
      const created = await createWorkspace({
        ...(activeCitadelId ? { citadelId: activeCitadelId } : {}),
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        slug: createForm.slug.trim() || undefined,
      });
      setNotice({ tone: "success", message: `Workspace ${created.name} created.` });
      setCreateForm({ name: "", description: "", slug: "" });
      await reload();
      setSelectedWorkspaceId(created.workspaceId);
      setActiveWorkspaceId(created.workspaceId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSave = async () => {
    if (!selectedWorkspace) {
      return;
    }
    try {
      const updated = await updateWorkspace(selectedWorkspace.workspaceId, {
        name: editForm.name.trim() || undefined,
        description: editForm.description.trim() || undefined,
        slug: editForm.slug.trim() || undefined,
      });
      setNotice({ tone: "success", message: `Workspace ${updated.name} updated.` });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleArchive = async () => {
    if (!selectedWorkspace) {
      return;
    }
    if (!window.confirm(`Archive workspace ${selectedWorkspace.name}?`)) {
      return;
    }
    try {
      await archiveWorkspace(selectedWorkspace.workspaceId);
      setNotice({ tone: "success", message: `Workspace ${selectedWorkspace.name} archived.` });
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  const handleRestore = async () => {
    if (!selectedWorkspace) {
      return;
    }
    try {
      await restoreWorkspace(selectedWorkspace.workspaceId);
      setNotice({ tone: "success", message: `Workspace ${selectedWorkspace.name} restored.` });
      await reload();
    } catch (restoreError) {
      setNotice({ tone: "error", message: getErrorMessage(restoreError) });
    }
  };

  return (
    <SettingsSectionShell
      loading={loading || citadelsLoading}
      error={error || citadelsError}
      onRetry={() => {
        void reload();
        void reloadCitadels();
      }}
    >
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsNotice
        notice={{
          tone: "info",
          message:
            "Workspace lifecycle is archive-based right now. The gateway supports create, edit, archive, and restore; permanent delete is not exposed yet.",
        }}
      />
      <SettingsGrid variant="detail-wide">
        <SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Citadel manager"
            subtitle="Create, select, archive, and restore the top-level operating worlds that contain workspaces."
            stats={[
              { label: "Citadels", value: String(citadelsData?.items?.length ?? 0) },
              { label: "Active", value: activeCitadelId ?? "legacy" },
            ]}
          >
            <SettingsFilterBar
              options={[
                { id: "all", label: "All" },
                { id: "active", label: "Active" },
                { id: "archived", label: "Archived" },
              ]}
              value={citadelView}
              onChange={(next) => setCitadelView(next as "active" | "archived" | "all")}
            />
            <NativeSelectableList
              items={filteredCitadels.map((item) => ({
                id: item.citadelId,
                title: item.name,
                meta: item.lifecycleStatus,
                body: item.description || item.slug,
              }))}
              selectedId={selectedCitadelId}
              onSelect={setSelectedCitadelId}
              emptyLabel="No Citadels in this view."
              maxHeight="14rem"
            />
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
                  onChange={(event) => setCitadelCreateForm((current) => ({ ...current, kind: event.target.value }))}
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
            </SettingsFieldGrid>
            {selectedCitadel ? (
              <>
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
                      onChange={(event) => setCitadelEditForm((current) => ({ ...current, kind: event.target.value }))}
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
                </SettingsFieldGrid>
                <SettingsButtonRow>
                  <NativeButton variant="default" onClick={() => setActiveCitadelId?.(selectedCitadel.citadelId)}>
                    <CheckCircle2 size={16} />
                    Make active
                  </NativeButton>
                  <NativeButton variant="secondary" onClick={() => void handleSaveCitadel()}>
                    <Save size={16} />
                    Save Citadel
                  </NativeButton>
                  {selectedCitadel.lifecycleStatus === "archived" ? (
                    <NativeButton variant="secondary" onClick={() => void handleRestoreCitadel()}>
                      <RotateCcw size={16} />
                      Restore
                    </NativeButton>
                  ) : (
                    <NativeButton variant="destructive" onClick={() => void handleArchiveCitadel()}>
                      <Trash2 size={16} />
                      Archive
                    </NativeButton>
                  )}
                </SettingsButtonRow>
              </>
            ) : null}
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={() => void handleCreateCitadel()}>
                <Plus size={16} />
                Create Citadel
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Create workspace"
            subtitle={
              activeCitadelName
                ? `Add a functional workspace inside ${activeCitadelName}.`
                : "Add a new workspace before digging through the directory."
            }
          >
            <SettingsFieldGrid>
              <SettingsField label="Name">
                <input
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
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={() => void handleCreate()}>
                <Plus size={16} />
                Create workspace
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Workspace directory"
            subtitle="Switch between active and archived workspaces, then edit the selected one."
            scrollBody
            bodyMaxHeight="min(54vh, 30rem)"
            stats={[
              { label: "Total", value: String(data?.items?.length ?? 0) },
              ...(activeCitadelId ? [{ label: "Citadel", value: activeCitadelId }] : []),
              { label: "Active workspace", value: activeWorkspaceId },
            ]}
          >
            <SettingsFilterBar
              options={[
                { id: "all", label: "All" },
                { id: "active", label: "Active" },
                { id: "archived", label: "Archived" },
              ]}
              value={view}
              onChange={(next) => setView(next as "active" | "archived" | "all")}
            />
            <NativeSelectableList
              items={filtered.map((item) => ({
                id: item.workspaceId,
                title: item.name,
                meta: item.lifecycleStatus,
                body: item.description || item.slug,
              }))}
              selectedId={selectedWorkspaceId}
              onSelect={setSelectedWorkspaceId}
              emptyLabel="No workspaces in this view."
              maxHeight="min(42vh, 23rem)"
            />
          </NativeCard>
        </SettingsStack>
        <NativeCard
          density="compact"
          className="mc-next-settings-panel"
          title={selectedWorkspace?.name ?? "Workspace editor"}
          subtitle="Rename, describe, archive, restore, or make the selected workspace active."
        >
          {selectedWorkspace ? (
            <>
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
              <NativeMetricGrid
                items={[
                  {
                    label: "Workspace ID",
                    value: selectedWorkspace.workspaceId,
                    meta: selectedWorkspace.lifecycleStatus,
                  },
                  {
                    label: "Created",
                    value: formatDateTime(selectedWorkspace.createdAt),
                    meta: `Updated ${formatDateTime(selectedWorkspace.updatedAt)}`,
                  },
                ]}
              />
              <SettingsButtonRow>
                <NativeButton variant="default" onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save changes
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => setActiveWorkspaceId(selectedWorkspace.workspaceId)}>
                  <CheckCircle2 size={16} />
                  Make active
                </NativeButton>
                {selectedWorkspace.lifecycleStatus === "archived" ? (
                  <NativeButton variant="secondary" onClick={() => void handleRestore()}>
                    <RotateCcw size={16} />
                    Restore
                  </NativeButton>
                ) : (
                  <NativeButton variant="destructive" onClick={() => void handleArchive()}>
                    <Trash2 size={16} />
                    Archive
                  </NativeButton>
                )}
              </SettingsButtonRow>
            </>
          ) : (
            <SettingsEmptyState label="Choose a workspace to edit or create a new one." />
          )}
        </NativeCard>
      </SettingsGrid>
    </SettingsSectionShell>
  );
}
