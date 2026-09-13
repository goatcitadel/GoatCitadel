import { useEffect, useRef, useState } from "react";
import { DetailInspector } from "../../../components/DetailInspector";
import { NativeButton } from "../primitives";
import { useDraftLeave } from "./DraftLeaveDialog";
import { useSessionDraft, hasSessionDraft } from "./session-drafts";
import { Plus, RefreshCw, Save, Undo2 } from "lucide-react";
import {
  archiveAgentProfile,
  createAgentProfile,
  fetchAgents,
  fetchImportedAgentCatalog,
  restoreAgentProfile,
  updateAgentProfile,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, QuickJumpCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  dedupeAgentProfiles,
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  splitCommaList,
  useAsyncLoad,
  type Notice,
} from "../shared/native-helpers";
import {
  LibraryActionList,
  LibraryButtonRow,
  LibraryEmptyState,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryNotice,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

export function LibraryAgentsSection({ activeWorkspaceId, route, navigate }: NativeRoutePagesProps) {
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [createMode, setCreateMode] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const leave = useDraftLeave();
  const catalogFocusRef = useRef<HTMLDivElement | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [agents, catalog] = await Promise.all([
      nativeLoad("Agent profiles", fetchAgents("all", 160), { items: [] }),
      nativeLoad(
        "Imported agent catalog",
        fetchImportedAgentCatalog({
          workspaceId: activeWorkspaceId,
          limit: 40,
          state: "all",
        }),
        { workspaceId: activeWorkspaceId, divisions: [], items: [] },
      ),
    ]);
    return {
      issues: nativeLoadIssues([agents, catalog]),
      agents: dedupeAgentProfiles(agents.data.items),
      catalog: catalog.data.items,
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!data?.agents.length) {
      setSelectedAgentId("");
      return;
    }
    setSelectedAgentId((current) =>
      data.agents.some((item) => item.agentId === current) ? current : (data.agents[0]?.agentId ?? ""),
    );
  }, [data]);

  const selectedAgent = data?.agents.find((item) => item.agentId === selectedAgentId) ?? null;
  const catalogFocused = route.view === "catalog";

  useEffect(() => {
    if (!catalogFocused || loading) {
      return;
    }
    catalogFocusRef.current?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    catalogFocusRef.current?.focus?.({ preventScroll: true });
  }, [catalogFocused, loading]);

  const emptyProfile = { roleId: "", name: "", title: "", summary: "", specialties: "", aliases: "", defaultTools: "" };
  const canonicalProfile = !createMode && selectedAgent ? {
      roleId: selectedAgent.roleId,
      name: selectedAgent.name,
      title: selectedAgent.title,
      summary: selectedAgent.summary,
      specialties: selectedAgent.specialties.join(", "),
      aliases: selectedAgent.aliases.join(", "),
      defaultTools: selectedAgent.defaultTools.join(", "),
    } : emptyProfile;
  const profileDraft = useSessionDraft(`agent-profile:${activeWorkspaceId}:${createMode ? "new" : selectedAgentId}`, canonicalProfile, JSON.stringify(canonicalProfile), {
    label: createMode ? "New agent profile" : "Agent profile", active: detailOpen && (editing || createMode), available: createMode || Boolean(selectedAgent), onSave: () => handleSave(),
  });
  const draft = profileDraft.value;
  const setDraft = profileDraft.setValue;

  const handleSave = async () => {
    if (!draft.roleId.trim() || !draft.name.trim() || !draft.title.trim() || !draft.summary.trim()) {
      setNotice({ tone: "warning", message: "Role, name, title, and summary are required before saving." });
      return false;
    }
    try {
      if (createMode) {
        const created = await createAgentProfile({
          roleId: draft.roleId.trim(),
          name: draft.name.trim(),
          title: draft.title.trim(),
          summary: draft.summary.trim(),
          specialties: splitCommaList(draft.specialties),
          aliases: splitCommaList(draft.aliases),
          defaultTools: splitCommaList(draft.defaultTools),
        });
        if (!profileDraft.acceptSaved(emptyProfile, undefined, draft)) return false;
        setCreateMode(false);
        setEditing(false);
        setSelectedAgentId(created.agentId);
        setNotice({ tone: "success", message: "Agent profile created." });
      } else if (selectedAgent) {
        await updateAgentProfile(selectedAgent.agentId, {
          name: draft.name.trim(),
          title: draft.title.trim(),
          summary: draft.summary.trim(),
          specialties: splitCommaList(draft.specialties),
          aliases: splitCommaList(draft.aliases),
          defaultTools: splitCommaList(draft.defaultTools),
        });
        if (!profileDraft.acceptSaved(draft, undefined, draft)) return false;
        setEditing(false);
        setNotice({ tone: "success", message: "Agent profile updated." });
      }
      await reload();
      return true;
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
      return false;
    }
  };

  const handleArchiveToggle = async () => {
    if (!selectedAgent) {
      return;
    }
    try {
      if (selectedAgent.lifecycleStatus === "archived") {
        await restoreAgentProfile(selectedAgent.agentId);
        setNotice({ tone: "success", message: "Agent profile restored." });
      } else {
        await archiveAgentProfile(selectedAgent.agentId);
        setNotice({ tone: "success", message: "Agent profile archived." });
      }
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  return (
    <LibrarySectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-view-tabs" role="group" aria-label="Agent views"><NativeButton variant="ghost" aria-pressed={!catalogFocused} onClick={() => leave.request(() => navigate({ ...route, view: undefined }))}>Profiles</NativeButton><NativeButton variant="ghost" aria-pressed={catalogFocused} onClick={() => leave.request(() => navigate({ ...route, view: "catalog" }))}>Imported catalog</NativeButton></div>
      <div className="mc-next-calm-directory">
        {!catalogFocused ? <NativeCard
          title="Agent profiles"
          subtitle="Reusable profiles you can inspect and maintain in Library."
          density="compact"
          stats={[
            { label: "Profiles", value: String(data?.agents.length ?? 0) },
            { label: "Catalog", value: String(data?.catalog.length ?? 0) },
          ]}
        >
          <LibraryField label="Search agents"><input type="search" className="mc-next-settings-input" value={query} onChange={(event) => setQuery(event.target.value)} /></LibraryField>
          <LibrarySelectableList
            items={(data?.agents ?? []).filter((item) => !query.trim() || [item.name, item.roleId, item.title, item.summary].some((value) => value.toLowerCase().includes(query.trim().toLowerCase()))).map((item) => ({
              id: item.agentId,
              title: item.name + (hasSessionDraft("agent-profile:" + activeWorkspaceId + ":" + item.agentId) ? " · Unsaved" : ""),
              meta: item.lifecycleStatus,
              body: `${item.title} · ${item.editable ? "editable" : "built-in"} · ${item.sessionCount} sessions`,
            }))}
            selectedId={selectedAgentId}
            onSelect={(id) => leave.request(() => { setCreateMode(false); setEditing(false); setSelectedAgentId(id); setDetailOpen(true); })}
            emptyLabel="No agent profiles returned from the gateway."
          />
          <div className="mc-next-settings-button-row">
            <button
              type="button"
              className="mc-next-settings-filter"
              onClick={() => leave.request(() => { setCreateMode(true); setEditing(true); setDetailOpen(true); })}
            >
              <Plus size={16} />
              {hasSessionDraft("agent-profile:" + activeWorkspaceId + ":new") ? "Resume new profile · Unsaved" : "New profile"}
            </button>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </NativeCard> : null}
        <div className="mc-next-settings-stack">
          <div hidden={!catalogFocused}
            ref={catalogFocusRef}
            id="imported-agent-catalog"
            className="mc-next-library-route-focus"
            tabIndex={catalogFocused ? -1 : undefined}
            data-route-focus={catalogFocused ? "catalog" : undefined}
          >
            <NativeCard
              title={catalogFocused ? "Imported agent catalog" : "Imported catalog"}
              subtitle={
                catalogFocused
                  ? "Catalog-focused view. Review imported definitions and lifecycle state before editing profiles."
                  : "Imported definitions are shown before editing so duplicate or stale agents are obvious."
              }
              density="compact"
            >
              <LibraryActionList
                ariaLabel="Imported agent catalog"
                items={(data?.catalog ?? []).map((item) => ({
                  id: item.entryId,
                  label: item.definition.frontmatter.name,
                  description: item.definition.frontmatter.description,
                  meta: `${item.division} · ${item.state}`,
                }))}
                emptyLabel="No imported agent catalog entries are available for this workspace."
                maxHeight="min(28vh, 15rem)"
              />
            </NativeCard>
          </div>
          <DetailInspector open={detailOpen} title={createMode ? "New agent profile" : selectedAgent?.name ?? "Agent unavailable"} subtitle={profileDraft.isDirty ? "Unsaved changes" : selectedAgent?.lifecycleStatus} onClose={() => leave.request(() => setDetailOpen(false), [profileDraft.key])}>
            {createMode || editing ? (
              <>
                <LibraryFieldGrid>
                  <LibraryField label="Role ID">
                    <input
                      className="mc-next-settings-input"
                      value={draft.roleId}
                      onChange={(event) => setDraft((current) => ({ ...current, roleId: event.target.value }))}
                      disabled={!createMode}
                    />
                  </LibraryField>
                  <LibraryField label="Name">
                    <input
                      className="mc-next-settings-input"
                      value={draft.name}
                      onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Title">
                    <input
                      className="mc-next-settings-input"
                      value={draft.title}
                      onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Specialties">
                    <input
                      className="mc-next-settings-input"
                      value={draft.specialties}
                      onChange={(event) => setDraft((current) => ({ ...current, specialties: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Aliases">
                    <input
                      className="mc-next-settings-input"
                      value={draft.aliases}
                      onChange={(event) => setDraft((current) => ({ ...current, aliases: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Default tools">
                    <input
                      className="mc-next-settings-input"
                      value={draft.defaultTools}
                      onChange={(event) => setDraft((current) => ({ ...current, defaultTools: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                  <LibraryField label="Summary" span={2}>
                    <textarea
                      className="mc-next-settings-textarea"
                      value={draft.summary}
                      onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                      disabled={!createMode && !selectedAgent?.editable}
                    />
                  </LibraryField>
                </LibraryFieldGrid>
                <LibraryButtonRow>
                  {createMode || selectedAgent?.editable ? (
                    <button type="button" className="mc-next-settings-filter" onClick={() => void handleSave()}>
                      <Save size={16} />
                      {createMode ? "Create agent" : "Save changes"}
                    </button>
                  ) : null}
                  {!createMode && selectedAgent ? (
                    <button
                      type="button"
                      className="mc-next-settings-filter"
                      onClick={() => void handleArchiveToggle()}
                    >
                      <Undo2 size={16} />
                      {selectedAgent.lifecycleStatus === "archived" ? "Restore" : "Archive"}
                    </button>
                  ) : null}
                </LibraryButtonRow>
              </>
            ) : (
              selectedAgent ? <><p>{selectedAgent.summary}</p><dl className="mc-next-profile-summary">{Object.entries(canonicalProfile).filter(([key]) => key !== "summary").map(([key, value]) => <div key={key}><dt>{key.replace(/([A-Z])/g, " $1")}</dt><dd>{value || "None specified"}</dd></div>)}</dl><LibraryButtonRow>{selectedAgent.editable ? <NativeButton onClick={() => setEditing(true)}>{profileDraft.isDirty ? "Resume editing · Unsaved" : "Edit profile"}</NativeButton> : null}<NativeButton variant="outline" onClick={() => void handleArchiveToggle()}>{selectedAgent.lifecycleStatus === "archived" ? "Restore" : "Archive"}</NativeButton></LibraryButtonRow></> : <LibraryEmptyState label="Select an agent profile to inspect it." />
            )}
          </DetailInspector>
          <QuickJumpCard
            title="Related routes"
            subtitle="Keep adjacent Library surfaces within reach from this route."
            actions={[
              { label: "Skills", route: { area: "library", section: "skills", theme: route.theme } },
              { label: "Capabilities", route: { area: "library", section: "capabilities", theme: route.theme } },
              { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
              { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
            ]}
            navigate={navigate}
          />
        </div>
      </div>
    {leave.dialog}</LibrarySectionShell>
  );
}
