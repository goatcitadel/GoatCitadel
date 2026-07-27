import { useEffect, useState } from "react";
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
  const [notice, setNotice] = useState<Notice | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [createMode, setCreateMode] = useState(false);
  const [draft, setDraft] = useState({
    roleId: "",
    name: "",
    title: "",
    summary: "",
    specialties: "",
    aliases: "",
    defaultTools: "",
  });
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

  useEffect(() => {
    if (!selectedAgent || createMode) {
      return;
    }
    setDraft({
      roleId: selectedAgent.roleId,
      name: selectedAgent.name,
      title: selectedAgent.title,
      summary: selectedAgent.summary,
      specialties: selectedAgent.specialties.join(", "),
      aliases: selectedAgent.aliases.join(", "),
      defaultTools: selectedAgent.defaultTools.join(", "),
    });
  }, [createMode, selectedAgent]);

  const handleSave = async () => {
    if (!draft.roleId.trim() || !draft.name.trim() || !draft.title.trim() || !draft.summary.trim()) {
      setNotice({ tone: "warning", message: "Role, name, title, and summary are required before saving." });
      return;
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
        setCreateMode(false);
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
        setNotice({ tone: "success", message: "Agent profile updated." });
      }
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
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
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Agent profiles"
          subtitle="Reusable profiles you can inspect and maintain in Library."
          density="compact"
          stats={[
            { label: "Profiles", value: String(data?.agents.length ?? 0) },
            { label: "Catalog", value: String(data?.catalog.length ?? 0) },
          ]}
        >
          <LibrarySelectableList
            items={(data?.agents ?? []).map((item) => ({
              id: item.agentId,
              title: item.name,
              meta: item.lifecycleStatus,
              body: `${item.title} · ${item.editable ? "editable" : "built-in"} · ${item.sessionCount} sessions`,
            }))}
            selectedId={selectedAgentId}
            onSelect={(id) => {
              setCreateMode(false);
              setSelectedAgentId(id);
            }}
            emptyLabel="No agent profiles returned from the gateway."
          />
          <div className="mc-next-settings-button-row">
            <button
              type="button"
              className="mc-next-settings-filter"
              onClick={() => {
                setCreateMode(true);
                setSelectedAgentId("");
                setDraft({
                  roleId: "",
                  name: "",
                  title: "",
                  summary: "",
                  specialties: "",
                  aliases: "",
                  defaultTools: "",
                });
              }}
            >
              <Plus size={16} />
              New profile
            </button>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title="Imported catalog"
            subtitle="Imported definitions are shown before editing so duplicate or stale agents are obvious."
            density="compact"
          >
            <LibraryActionList
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
          <NativeCard
            title={createMode ? "Create agent profile" : (selectedAgent?.name ?? "Agent detail")}
            subtitle={
              createMode
                ? "Create a reusable operator profile for Work conversations, plans, and builds."
                : selectedAgent
                  ? "Review the selected agent and update editable fields."
                  : "Select an agent profile to inspect or edit it."
            }
            density="compact"
            scrollBody
            bodyMaxHeight="min(58vh, 34rem)"
          >
            {createMode || selectedAgent ? (
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
              <LibraryEmptyState label="Select an agent profile to inspect it." />
            )}
          </NativeCard>
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
    </LibrarySectionShell>
  );
}
