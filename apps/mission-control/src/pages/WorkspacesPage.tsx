import { useCallback, useEffect, useMemo, useState } from "react";
import type { GuidanceDocType } from "@goatcitadel/contracts";
import {
  archiveWorkspace,
  createWorkspace,
  fetchGlobalGuidance,
  fetchWorkspaceGuidance,
  fetchWorkspaces,
  restoreWorkspace,
  updateGlobalGuidance,
  updateWorkspaceGuidance,
  type GuidanceDocumentRecord,
} from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { FieldHelp } from "../components/FieldHelp";
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCSelect } from "../components/ui";
import { GCEmptyState } from "../components/ui/GCEmptyState";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

const GLOBAL_GUIDANCE_DOC_TYPES: Array<{ value: GuidanceDocType; label: string }> = [
  { value: "goatcitadel", label: "GOATCITADEL.md" },
  { value: "agents", label: "AGENTS.md" },
  { value: "claude", label: "CLAUDE.md" },
  { value: "contributing", label: "CONTRIBUTING.md" },
  { value: "security", label: "SECURITY.md" },
  { value: "vision", label: "VISION.md" },
];

const WORKSPACE_GUIDANCE_DOC_TYPES: Array<{ value: GuidanceDocType; label: string }> = [
  { value: "goatcitadel", label: "GOATCITADEL.md" },
  { value: "agents", label: "AGENTS.md" },
  { value: "claude", label: "CLAUDE.md" },
  { value: "vision", label: "VISION.md" },
];

export function WorkspacesPage(props: { activeWorkspaceId: string; onWorkspaceChange: (workspaceId: string) => void }) {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceSlug, setWorkspaceSlug] = useState("");
  const [workspaceDescription, setWorkspaceDescription] = useState("");
  const [docScope, setDocScope] = useState<"global" | "workspace">("workspace");
  const [docType, setDocType] = useState<GuidanceDocType>("goatcitadel");
  const [editorContent, setEditorContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<typeof fetchWorkspaces>>["items"]>([]);
  const [globalGuidance, setGlobalGuidance] = useState<GuidanceDocumentRecord[]>([]);
  const [workspaceGuidance, setWorkspaceGuidance] = useState<GuidanceDocumentRecord[]>([]);

  const load = useCallback(
    async (options?: { background?: boolean; includeGuidance?: boolean }) => {
      const background = options?.background ?? false;
      const includeGuidance = options?.includeGuidance ?? !background;
      if (background) {
        setIsRefreshing(true);
      } else {
        setIsInitialLoading(true);
      }
      try {
        const [workspaceResponse, globalResponse, scopedGuidance] = await Promise.all([
          fetchWorkspaces("all", 300),
          includeGuidance ? fetchGlobalGuidance() : Promise.resolve(null),
          includeGuidance ? fetchWorkspaceGuidance(props.activeWorkspaceId) : Promise.resolve(null),
        ]);
        setWorkspaces(workspaceResponse.items);
        if (globalResponse) {
          setGlobalGuidance(globalResponse.items);
        }
        if (scopedGuidance) {
          setWorkspaceGuidance(scopedGuidance.workspace);
        }
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (background) {
          setIsRefreshing(false);
        } else {
          setIsInitialLoading(false);
        }
      }
    },
    [props.activeWorkspaceId],
  );

  useEffect(() => {
    void load({ background: false, includeGuidance: true });
  }, [load]);

  useRefreshSubscription(
    "system",
    async () => {
      await load({ background: true, includeGuidance: false });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1200,
      staleMs: 20000,
      pollIntervalMs: 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  const selectedDocument = useMemo(() => {
    const source = docScope === "global" ? globalGuidance : workspaceGuidance;
    return source.find((item) => item.docType === docType) ?? null;
  }, [docScope, docType, globalGuidance, workspaceGuidance]);

  const visibleDocTypes = useMemo(
    () => (docScope === "global" ? GLOBAL_GUIDANCE_DOC_TYPES : WORKSPACE_GUIDANCE_DOC_TYPES),
    [docScope],
  );

  useEffect(() => {
    if (visibleDocTypes.some((item) => item.value === docType)) {
      return;
    }
    setDocType(visibleDocTypes[0]?.value ?? "goatcitadel");
  }, [docType, visibleDocTypes]);

  useEffect(() => {
    setEditorContent(selectedDocument?.content ?? "");
    setDirty(false);
  }, [selectedDocument?.content, selectedDocument?.absolutePath]);

  const activeWorkspace = useMemo(
    () => workspaces.find((item) => item.workspaceId === props.activeWorkspaceId) ?? null,
    [props.activeWorkspaceId, workspaces],
  );

  const handleCreateWorkspace = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    setSuccess(null);
    try {
      const created = await createWorkspace({
        name: workspaceName,
        slug: workspaceSlug || undefined,
        description: workspaceDescription || undefined,
      });
      setWorkspaceName("");
      setWorkspaceSlug("");
      setWorkspaceDescription("");
      props.onWorkspaceChange(created.workspaceId);
      setSuccess(`Workspace ${created.name} created.`);
      await load({ background: true, includeGuidance: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsCreating(false);
    }
  }, [load, props, workspaceDescription, workspaceName, workspaceSlug]);

  const handleArchiveWorkspace = useCallback(
    async (workspaceId: string) => {
      setError(null);
      setSuccess(null);
      try {
        const archived = await archiveWorkspace(workspaceId);
        setSuccess(`Workspace ${archived.name} archived.`);
        if (archived.workspaceId === props.activeWorkspaceId) {
          props.onWorkspaceChange("default");
        }
        await load({ background: true, includeGuidance: false });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load, props],
  );

  const handleRestoreWorkspace = useCallback(
    async (workspaceId: string) => {
      setError(null);
      setSuccess(null);
      try {
        const restored = await restoreWorkspace(workspaceId);
        setSuccess(`Workspace ${restored.name} restored.`);
        await load({ background: true, includeGuidance: false });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [load],
  );

  const handleSaveGuidance = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    setSuccess(null);
    try {
      if (docScope === "global") {
        await updateGlobalGuidance(docType, editorContent);
      } else {
        await updateWorkspaceGuidance(props.activeWorkspaceId, docType, editorContent);
      }
      setSuccess(`Saved ${docType} guidance (${docScope}).`);
      setDirty(false);
      await load({ background: true, includeGuidance: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  }, [docScope, docType, editorContent, load, props.activeWorkspaceId]);

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Workspace Control"
        title={pageCopy.workspaces.title}
        subtitle={pageCopy.workspaces.subtitle}
        hint="Switch operational context, create workspace overrides, and edit workspace-scoped guidance without losing the current shell state."
        density="compact"
        actions={
          <div className="workflow-summary-strip">
            <StatusChip tone="success">{activeWorkspace?.name ?? props.activeWorkspaceId}</StatusChip>
            <StatusChip tone="muted">{workspaces.length} workspaces</StatusChip>
            <StatusChip tone={docScope === "workspace" ? "warning" : "muted"}>
              {docScope === "workspace" ? "Workspace override" : "Global default"}
            </StatusChip>
          </div>
        }
      />
      <PageGuideCard
        pageId="workspaces"
        what={pageCopy.workspaces.guide?.what ?? ""}
        when={pageCopy.workspaces.guide?.when ?? ""}
        mostCommonAction={pageCopy.workspaces.guide?.mostCommonAction}
        actions={pageCopy.workspaces.guide?.actions ?? []}
        terms={pageCopy.workspaces.guide?.terms}
      />
      <div className="workflow-status-stack">
        {isInitialLoading ? <p>Loading workspaces...</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing workspace data...</p> : null}
        {isFallbackRefreshing ? (
          <p className="status-banner warning">Live updates degraded, checking workspace data periodically.</p>
        ) : null}
        {error ? <p className="status-banner warning">{error}</p> : null}
        {success ? <p className="status-banner success">{success}</p> : null}
        <FieldHelp>
          Use workspaces to separate guidance and operational context. Most users only need a few stable workspaces
          rather than many narrowly scoped ones.
        </FieldHelp>
      </div>

      <Panel
        title="Workspace Switcher"
        subtitle="Select the active workspace or create a new one without leaving the current shell."
        actions={<StatusChip tone="success">Active: {activeWorkspace?.name ?? props.activeWorkspaceId}</StatusChip>}
      >
        <OperatorSplitLayout
          className="workspaces-operator-layout"
          primary={
            workspaces.length === 0 ? (
              <GCEmptyState
                title="No workspaces are available yet"
                subtitle="Create a workspace to separate guidance and operational context without leaving the current shell."
                action={
                  <button
                    type="button"
                    className="gc-button"
                    onClick={() => void load({ background: true, includeGuidance: false })}
                  >
                    Refresh workspaces
                  </button>
                }
                meta={<FieldHelp>The workspace creation form stays available in the inspector.</FieldHelp>}
              />
            ) : (
              <ul className="compact-list">
                {workspaces.map((workspace) => (
                  <li
                    key={workspace.workspaceId}
                    className={workspace.workspaceId === props.activeWorkspaceId ? "active-item" : ""}
                  >
                    <div>
                      <strong>{workspace.name}</strong>
                      <p className="office-subtitle">
                        {workspace.slug} • {workspace.lifecycleStatus}
                      </p>
                    </div>
                    <div className="row-actions">
                      <ActionButton
                        label={workspace.workspaceId === props.activeWorkspaceId ? "Selected" : "Use"}
                        disabled={workspace.workspaceId === props.activeWorkspaceId}
                        onClick={() => props.onWorkspaceChange(workspace.workspaceId)}
                      />
                      {workspace.lifecycleStatus === "active" && workspace.workspaceId !== "default" ? (
                        <ActionButton
                          label="Archive"
                          danger
                          onClick={() => void handleArchiveWorkspace(workspace.workspaceId)}
                        />
                      ) : null}
                      {workspace.lifecycleStatus === "archived" ? (
                        <ActionButton
                          label="Restore"
                          onClick={() => void handleRestoreWorkspace(workspace.workspaceId)}
                        />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
          inspector={
            <div className="stack-sm">
              <h4>Create Workspace</h4>
              <label className="field">
                Name
                <input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="Personal"
                />
              </label>
              <label className="field">
                Slug (optional)
                <input
                  value={workspaceSlug}
                  onChange={(event) => setWorkspaceSlug(event.target.value)}
                  placeholder="personal"
                />
              </label>
              <label className="field">
                Description (optional)
                <textarea
                  value={workspaceDescription}
                  onChange={(event) => setWorkspaceDescription(event.target.value)}
                  rows={4}
                />
              </label>
              <ActionButton
                label={isCreating ? "Creating..." : "Create workspace"}
                disabled={isCreating || !workspaceName.trim()}
                onClick={() => void handleCreateWorkspace()}
              />
            </div>
          }
        />
      </Panel>

      <Panel
        title="Guidance Editor"
        subtitle={docScope === "workspace" ? `Workspace override (${props.activeWorkspaceId})` : "Global default"}
        rank="muted"
        padding="compact"
        collapsible
        defaultExpanded={false}
      >
        <div className="row-actions">
          <label className="field compact">
            Scope
            <GCSelect
              value={docScope}
              onChange={(value) => setDocScope(value as "global" | "workspace")}
              options={[
                { value: "workspace", label: "Workspace" },
                { value: "global", label: "Global" },
              ]}
            />
          </label>
          <label className="field compact">
            Document
            <GCSelect
              value={docType}
              onChange={(value) => setDocType(value as GuidanceDocType)}
              options={visibleDocTypes.map((item) => ({ value: item.value, label: item.label }))}
            />
          </label>
          <ActionButton
            label={isSaving ? "Saving..." : "Save guidance"}
            disabled={isSaving || !dirty}
            onClick={() => void handleSaveGuidance()}
          />
        </div>
        <FieldHelp>
          File: <code>{selectedDocument?.absolutePath ?? "not created yet"}</code>
        </FieldHelp>
        <textarea
          value={editorContent}
          onChange={(event) => {
            setEditorContent(event.target.value);
            setDirty(true);
          }}
          rows={20}
          placeholder="Write guidance markdown here..."
        />
      </Panel>
    </section>
  );
}
