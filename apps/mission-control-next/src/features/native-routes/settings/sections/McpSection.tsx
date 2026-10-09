import { McpCreatePanel } from "./McpCreatePanel";
import { McpPreviewPanels } from "./McpPreviewPanels";
import { McpElicitationEditor } from "./McpElicitationEditor";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Plus, Save, Trash2 } from "lucide-react";
import type { McpServerRecord } from "@goatcitadel/contracts";
import {
  fetchMcpElicitations,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchMcpTools,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
  humanizeEnumToken,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { McpConnectionControls } from "../McpConnectionControls";
import { McpOAuthControls } from "../McpOAuthControls";
import { McpConfigurationReport } from "../McpConfigurationReport";
import { useMcpModeEvidence } from "../use-mcp-mode-evidence";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { hasSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { DetailInspector } from "../../../../components/DetailInspector";
import { McpServerReview } from "./McpServerReview";
import { useMcpEditor } from "../use-mcp-editor";
import { useMcpDeletion } from "../use-mcp-deletion";
import { useMcpCreation } from "../use-mcp-creation";
import { McpPolicyFields } from "../McpPolicyFields";
import "./integration-confirmation.css";
import {
  formatMcpElicitationMeta,
  isRuntimeInvokableMcpServer,
} from "../helpers/mcp-helpers";
import { formatDateTime } from "../helpers/input-format";
import { McpOutcomeCheck } from "../McpOutcomeCheck";

export function McpSection(props: SettingsSectionProps) {
  const [panel, setPanel] = useState<"create" | "edit" | "detail" | "previews" | "elicitation" | null>(null);
  const [templatesRequested, setTemplatesRequested] = useState(false);
  const [previewRequested, setPreviewRequested] = useState(false);
  const modeEvidence = useMcpModeEvidence(props.activeWorkspaceId, previewRequested);
  const [selectedServerId, setSelectedServerId] = useSessionViewState("mcp:" + props.activeWorkspaceId + ":server", "");
  const [selectedElicitationId, setSelectedElicitationId] = useSessionViewState(
    "mcp:" + props.activeWorkspaceId + ":elicitation",
    "",
  );
  const [detailTab, setDetailTab] = useState<"connection" | "tools" | "diagnostics">("connection");
  const selectionRef = useRef(selectedServerId);
  selectionRef.current = selectedServerId;
  const scopeRef = useRef({ workspaceId: props.activeWorkspaceId, serverId: selectedServerId });
  if (scopeRef.current.workspaceId !== props.activeWorkspaceId || scopeRef.current.serverId !== selectedServerId)
    scopeRef.current = { workspaceId: props.activeWorkspaceId, serverId: selectedServerId };
  const currentScope = scopeRef.current;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrentScope = () => mounted.current && scopeRef.current === currentScope;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const leave = useDraftLeave();
  const load = useCallback(async () => {
    const [servers, templates, pendingElicitations] = await Promise.all([
      nativeLoad("MCP servers", fetchMcpServers(), { items: [] }),
      nativeLoad("MCP templates", templatesRequested ? fetchMcpTemplates() : Promise.resolve({ items: [] }), {
        items: [],
      }),
      nativeLoad("MCP elicitations", fetchMcpElicitations({ status: "pending" }), { items: [] }),
    ]);
    return {
      workspaceId: props.activeWorkspaceId,
      issues: nativeLoadIssues([servers, templates, pendingElicitations]),
      servers: servers.data.items,
      templates: templates.data.items,
      pendingElicitations: pendingElicitations.data.items,
    };
  }, [templatesRequested, props.activeWorkspaceId]);
  const { loading, error, data, reload, updateData } = useAsyncLoad(load, [load]);
  const applyServer = useCallback(
    (serverId: string, server: McpServerRecord | null) => {
      updateData((current) => ({
        ...current,
        servers: server
          ? current.servers.some((item) => item.serverId === serverId)
            ? current.servers.map((item) => (item.serverId === serverId ? server : item))
            : [...current.servers, server]
          : current.servers.filter((item) => item.serverId !== serverId),
      }));
    },
    [updateData],
  );
  const [notice, setNotice] = useState<Notice | null>(null);
  const [tools, setTools] = useState<Array<{ toolName: string; description?: string }> | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsVersion, setToolsVersion] = useState(0);
  const selectedServer = data?.servers?.find((item) => item.serverId === selectedServerId) ?? null;
  const gatewayOwned =
    selectedServerId === "goatcitadel-internal-approval-inbox" ||
    selectedServerId === "goatcitadel-internal-durable-tasks";
  const selectedElicitation =
    data?.pendingElicitations?.find((item) => item.elicitationId === selectedElicitationId) ?? null;
  const selectedRemotePreviewItem = previewRequested
    ? modeEvidence.data?.remotePreview?.items.find((item) => item.source === "server" && item.id === selectedServerId)
    : undefined;
  const selectedServerRuntimeReady =
    selectedRemotePreviewItem?.runtimeSupported ??
    (selectedServer ? isRuntimeInvokableMcpServer(selectedServer) : false);
  const creation = useMcpCreation({
    workspaceId: props.activeWorkspaceId,
    active: panel === "create",
    available: !loading && Boolean(data) && !data?.issues.some((issue) => issue.label === "MCP servers"),
    onNotice: setNotice,
    onSaveRequest: () => handleCreate(),
    onCreated: (server, clean) => {
      applyServer(server.serverId, server);
      if (clean && panelRef.current === "create") {
        setSelectedServerId(server.serverId);
        setPanel("detail");
      }
    },
  });
  const createDraft = creation.draft;
  const editor = useMcpEditor({
    workspaceId: props.activeWorkspaceId,
    serverId: selectedServerId,
    server: selectedServer,
    active: panel === "edit",
    runtimeReady: selectedServerRuntimeReady,
    applyServer,
    onNotice: setNotice,
    onSaveRequest: () => handleSave(),
  });
  const { draft: editDraft, review, mutation, requiresReview } = editor;
  const deletion = useMcpDeletion({
    workspaceId: props.activeWorkspaceId,
    server: selectedServer,
    available: !loading && !requiresReview && panel === "detail",
    onNotice: setNotice,
    onConflict: review.refresh,
    onDeleted: (serverId) => {
      applyServer(serverId, null);
      if (selectionRef.current === serverId) setPanel(null);
    },
  });
  const createForm = createDraft.value,
    setCreateForm = createDraft.setValue;
  const editForm = editDraft.value,
    setEditForm = editDraft.setValue;
  const reviewPanel = requiresReview ? (
    <McpServerReview
      server={selectedServer}
      loading={review.loading}
      error={review.error}
      missing={review.missing}
      onReload={() => void review.refresh()}
      onAccept={editor.acceptReview}
    />
  ) : null;
  const openCreate = () =>
    leave.request(() => {
      setTemplatesRequested(true);
      setPanel("create");
    });
  const selectServer = (id: string) =>
    leave.request(() => {
      setSelectedServerId(id);
      setPanel("detail");
      setDetailTab("connection");
    });
  const closePanel = () => leave.request(() => { setPanel(null); setPreviewRequested(false); });
  useEffect(() => {
    setPanel(null);
    setNotice(null);
  }, [props.activeWorkspaceId]);
  useEffect(() => {
    busyRef.current = false;
    setBusy(false);
  }, [currentScope]);
  useEffect(() => {
    setTools(null);
    setToolsError(null);
    setDetailTab("connection");
  }, [selectedServerId]);
  useEffect(() => {
    if (panel !== "detail" || detailTab !== "tools" || !selectedServerId) return;
    let live = true;
    setTools(null);
    setToolsError(null);
    void fetchMcpTools(selectedServerId)
      .then((result) => {
        if (live) setTools(result.items);
      })
      .catch((cause) => {
        if (live) setToolsError(getErrorMessage(cause));
      });
    return () => {
      live = false;
    };
  }, [panel, detailTab, selectedServerId, toolsVersion]);
  const hashAction = useRef(() => {});
  hashAction.current = () => {
    const hash = globalThis.location?.hash;
    if (hash === "#mcp-create") openCreate();
    else if (hash === "#mcp-previews" || hash === "#mcp-remote-preview")
      leave.request(() => {
        setPreviewRequested(true);
        setPanel("previews");
      });
  };
  useEffect(() => {
    const target = () => hashAction.current();
    target();
    globalThis.window?.addEventListener?.("hashchange", target);
    return () => globalThis.window?.removeEventListener?.("hashchange", target);
  }, []);

  const handleCreate = async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      return await creation.save();
    } finally {
      if (isCurrentScope()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const handleSave = async (): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      return await editor.save();
    } finally {
      if (isCurrentScope()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {mutation.phase === "uncertain" ? (
        <SettingsNotice notice={{ tone: "error", message: mutation.message! }} />
      ) : null}
      {selectedServerId ? <McpOutcomeCheck target={{ kind: "server", serverId: selectedServerId }} refresh={reload} /> : null}
      {creation.mutation.phase === "uncertain" ? (
        <SettingsNotice notice={{ tone: "error", message: creation.mutation.message! }} />
      ) : null}
      <McpOutcomeCheck target={{ kind: "create" }} refresh={reload} />
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {panel === "create" ? (
            <FocusedDetail title="Add MCP server" onClose={closePanel}>
              <McpCreatePanel
                createForm={createForm}
                setCreateForm={setCreateForm}
                busy={busy || creation.mutation.locked}
                handleCreate={handleCreate}
                data={data}
              />
            </FocusedDetail>
          ) : panel === "edit" ? (
            <FocusedDetail title={"Edit " + (selectedServer?.label ?? "server")} onClose={closePanel}>
              <SettingsStack>
                {reviewPanel}
                {selectedServer ? (
                  <>
                    <SettingsFieldGrid>
                      <SettingsField label="Label">
                        <input
                          aria-label="MCP server label"
                          className="mc-next-settings-input"
                          value={editForm.label}
                          onChange={(event) => setEditForm((current) => ({ ...current, label: event.target.value }))}
                        />
                      </SettingsField>
                      <SettingsField label="Category">
                        <select
                          aria-label="MCP server category"
                          className="mc-next-settings-input"
                          value={editForm.category}
                          onChange={(event) =>
                            setEditForm((current) => ({
                              ...current,
                              category: event.target.value as McpServerRecord["category"],
                            }))
                          }
                        >
                          <option value="development">development</option>
                          <option value="browser">browser</option>
                          <option value="automation">automation</option>
                          <option value="research">research</option>
                          <option value="data">data</option>
                          <option value="creative">creative</option>
                          <option value="orchestration">orchestration</option>
                          <option value="other">other</option>
                        </select>
                      </SettingsField>
                      {selectedServer.transport === "stdio" ? (
                        <SettingsField label="Command" span={2}>
                          <input
                            aria-label="MCP server command"
                            className="mc-next-settings-input"
                            value={editForm.command}
                            onChange={(event) =>
                              setEditForm((current) => ({ ...current, command: event.target.value }))
                            }
                          />
                        </SettingsField>
                      ) : (
                        <SettingsField label="URL" span={2}>
                          <input
                            aria-label="MCP server URL"
                            className="mc-next-settings-input"
                            value={editForm.url}
                            onChange={(event) => setEditForm((current) => ({ ...current, url: event.target.value }))}
                          />
                        </SettingsField>
                      )}
                      <SettingsField label="Enabled" group>
                        <label className="mc-next-settings-toggle">
                          <input
                            aria-label="MCP server enabled"
                            type="checkbox"
                            checked={editForm.enabled}
                            disabled={!selectedServerRuntimeReady}
                            onChange={(event) =>
                              setEditForm((current) => ({ ...current, enabled: event.target.checked }))
                            }
                          />
                          <span>
                            {selectedServerRuntimeReady
                              ? "Server can be used by the operator."
                              : "Configured only; runtime actions are disabled."}
                          </span>
                        </label>
                      </SettingsField>
                    </SettingsFieldGrid>
                    <fieldset disabled={busy || gatewayOwned || mutation.locked}>
                      <McpPolicyFields
                        value={editForm}
                        onChange={setEditForm}
                        stdio={selectedServer.transport === "stdio"}
                        fieldClass="mc-next-settings-textarea"
                        className="mc-next-settings-stack"
                      />
                    </fieldset>
                    {!selectedServerRuntimeReady ? (
                      <SettingsNotice
                        notice={{
                          tone: "warning",
                          message: selectedRemotePreviewItem
                            ? `${selectedRemotePreviewItem.operatorNextAction} ${selectedRemotePreviewItem.blockers[0] ?? ""}`.trim()
                            : "This MCP server is configured for visibility only until its transport, URL, auth, and trust posture are runtime-supported.",
                        }}
                      />
                    ) : null}
                    <NativeButton
                      disabled={busy || gatewayOwned || requiresReview || mutation.locked}
                      onClick={() => void handleSave()}
                    >
                      <Save size={16} />
                      Save changes
                    </NativeButton>
                  </>
                ) : (
                  <NativeCard
                    title="Retained MCP edits"
                    subtitle="This server is unavailable. Your draft has not been discarded."
                  >
                    <dl>
                      <dt>Label</dt>
                      <dd>{editForm.label}</dd>
                      <dt>Command or URL</dt>
                      <dd>{editForm.command || editForm.url || "None"}</dd>
                      <dt>Category</dt>
                      <dd>{editForm.category}</dd>
                    </dl>
                  </NativeCard>
                )}
              </SettingsStack>
            </FocusedDetail>
          ) : panel === "previews" ? (
            <FocusedDetail title="MCP diagnostics" onClose={closePanel}>
              <McpPreviewPanels evidence={modeEvidence} />
            </FocusedDetail>
          ) : panel === "elicitation" ? (
            <FocusedDetail title="MCP operator prompt" onClose={closePanel}>
              {selectedElicitation ? (
                <McpElicitationEditor
                  key={selectedElicitation.elicitationId}
                  workspaceId={props.activeWorkspaceId}
                  request={selectedElicitation}
                  setNotice={setNotice}
                  onResolved={async () => {
                    await reload();
                    setPanel(null);
                  }}
                />
              ) : (
                <SettingsEmptyState label="This prompt is no longer pending or is unavailable. Its retained response has not been sent." />
              )}
            </FocusedDetail>
          ) : (
            <>
              <SettingsButtonRow>
                <NativeButton onClick={openCreate}>
                  <Plus size={16} />
                  Add server{createDraft.isDirty ? " · Unsaved" : ""}
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void reload()}>
                  Refresh
                </NativeButton>
                <NativeButton
                  variant="outline"
                  onClick={() => {
                    setPreviewRequested(true);
                    setPanel("previews");
                  }}
                >
                  MCP diagnostics
                </NativeButton>
              </SettingsButtonRow>
              <NativeCard
                id="mcp-servers"
                title="MCP servers"
                subtitle="Choose a server to inspect its connection, tools, and diagnostics."
                stats={[
                  {
                    label: "Servers",
                    value: data.issues.some((issue) => issue.label === "MCP servers")
                      ? "Unavailable"
                      : Array.isArray(data.servers)
                        ? String(data.servers.length)
                        : "Unavailable",
                  },
                  {
                    label: "Templates",
                    value: !templatesRequested
                      ? "Not loaded"
                      : data.issues.some((issue) => issue.label === "MCP templates")
                        ? "Unavailable"
                        : Array.isArray(data.templates)
                          ? String(data.templates.length)
                          : "Unavailable",
                  },
                  {
                    label: "Pending prompts",
                    value: data.issues.some((issue) => issue.label === "MCP elicitations")
                      ? "Unavailable"
                      : Array.isArray(data.pendingElicitations)
                        ? String(data.pendingElicitations.length)
                        : "Unavailable",
                  },
                ]}
              >
                <NativeSelectableList
                  items={(data.servers ?? []).map((item) => ({
                    id: item.serverId,
                    title: item.label,
                    meta: [
                      item.status,
                      item.trustTier,
                      hasSessionDraft("mcp:" + props.activeWorkspaceId + ":" + item.serverId + ":edit")
                        ? "Unsaved"
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    body: item.transport + " · " + (item.enabled ? "enabled" : "disabled"),
                  }))}
                  selectedId={panel === "detail" ? selectedServerId : undefined}
                  onSelect={selectServer}
                  emptyLabel="No MCP servers configured."
                  maxHeight="min(50vh,30rem)"
                />
              </NativeCard>
              <NativeCard
                id="mcp-inbox"
                title="MCP elicitation inbox"
                subtitle="Pending prompts need an explicit operator response."
              >
                <NativeSelectableList
                  items={(data.pendingElicitations ?? []).map((item) => ({
                    id: item.elicitationId,
                    title: item.prompt.text,
                    meta:
                      item.status +
                      (hasSessionDraft("mcp:" + props.activeWorkspaceId + ":" + item.elicitationId + ":response")
                        ? " · Unsaved"
                        : ""),
                    body: formatMcpElicitationMeta(item),
                  }))}
                  onSelect={(id) =>
                    leave.request(() => {
                      setSelectedElicitationId(id);
                      setPanel("elicitation");
                    })
                  }
                  emptyLabel="No pending MCP elicitations."
                />
              </NativeCard>
            </>
          )}
          <DetailInspector
            open={panel === "detail"}
            title={selectedServer?.label ?? "Server unavailable"}
            onClose={closePanel}
          >
            {reviewPanel}
            {selectedServer ? (
              <SettingsStack>
                <p>
                  {selectedServer.status} · {selectedServer.transport} · Trust:{" "}
                  {selectedServer.trustTier ?? "Unavailable"}
                </p>
                {selectedServer.lastError ? <p role="alert">{selectedServer.lastError}</p> : null}
                {!selectedServerRuntimeReady ? (
                  <SettingsNotice
                    notice={{
                      tone: "warning",
                      message: selectedRemotePreviewItem
                        ? `${selectedRemotePreviewItem.operatorNextAction} ${selectedRemotePreviewItem.blockers[0] ?? ""}`.trim()
                        : "This MCP server is configured for visibility only until its transport, URL, auth, and trust posture are runtime-supported.",
                    }}
                  />
                ) : null}
                <nav className="mc-next-settings-button-row mc-next-inspector-tabs" aria-label="Server detail views">
                  {(["connection", "tools", "diagnostics"] as const).map((tab) => (
                    <NativeButton
                      key={tab}
                      variant={detailTab === tab ? "default" : "outline"}
                      aria-pressed={detailTab === tab}
                      onClick={() => {
                        setDetailTab(tab);
                        if (tab === "diagnostics") setPreviewRequested(true);
                      }}
                    >
                      {tab === "connection" ? "Connection" : tab === "tools" ? "Tools" : "Diagnostics"}
                    </NativeButton>
                  ))}
                </nav>
                {detailTab === "connection" ? (
                  <>
                    <dl>
                      <dt>Enabled</dt>
                      <dd>{String(selectedServer.enabled)}</dd>
                      <dt>Command or URL</dt>
                      <dd>{selectedServer.command || selectedServer.url || "Unavailable"}</dd>
                      <dt>Category</dt>
                      <dd>{selectedServer.category}</dd>
                    </dl>
                    <fieldset disabled={busy} className="mc-next-settings-fieldset">
                      <SettingsButtonRow>
                        <NativeButton disabled={gatewayOwned} onClick={() => setPanel("edit")}>
                          Edit server{editDraft.isDirty ? " · Unsaved" : ""}
                        </NativeButton>
                        <NativeButton variant="secondary" onClick={() => setDetailTab("diagnostics")}>
                          Configuration report
                        </NativeButton>
                        <NativeButton
                          variant="secondary"
                          onClick={() =>
                            props.navigate({ area: "settings", section: "tools", theme: props.route.theme })
                          }
                        >
                          <CheckCircle2 size={16} />
                          Manage tool grants
                        </NativeButton>
                        <NativeButton
                          variant="destructive"
                          disabled={gatewayOwned || requiresReview}
                          onClick={() => {
                            if (!selectedServer.revision) {
                              void review.refresh();
                              return;
                            }
                            deletion.requestReview();
                          }}
                        >
                          <Trash2 size={16} />
                          Delete
                        </NativeButton>
                      </SettingsButtonRow>
                    </fieldset>
                    <McpConnectionControls
                      server={selectedServer}
                      scope={props.activeWorkspaceId}
                      onSettled={reload}
                      button={(label, click, disabled) => (
                        <NativeButton variant="secondary" onClick={click} disabled={disabled}>
                          {label}
                        </NativeButton>
                      )}
                    />
                    <McpOAuthControls
                      server={selectedServer}
                      scope={props.activeWorkspaceId}
                      onSettled={reload}
                      button={(label, click, disabled) => (
                        <NativeButton variant="secondary" onClick={click} disabled={disabled}>{label}</NativeButton>
                      )}
                    />
                  </>
                ) : detailTab === "tools" ? (
                  toolsError ? (
                    <SettingsNotice notice={{ tone: "warning", message: toolsError }} />
                  ) : tools === null ? (
                    <p role="status">Loading server tools…</p>
                  ) : (
                    <SettingsActionList
                      ariaLabel={`${selectedServer.label} tools`}
                      items={tools.map((item) => ({
                        label: item.toolName,
                        description: item.description || "Registered MCP tool",
                      }))}
                      emptyLabel="No tools reported for this server."
                    />
                  )
                ) : (
                  <>
                    <NativeMetricGrid
                      items={[
                        { label: "Transport", value: selectedServer.transport, meta: selectedServer.authType },
                        {
                          label: "Auth readiness",
                          value: humanizeEnumToken(
                            selectedRemotePreviewItem?.authReadiness ??
                              selectedServer.authState?.readiness ??
                              (selectedServer.authType === "none" ? "not_required" : "unknown"),
                          ),
                          meta: selectedServer.authState?.tokenExpiresAt
                            ? `Expires ${formatDateTime(selectedServer.authState.tokenExpiresAt)}`
                            : selectedServer.oauth?.tokenUrl
                              ? "OAuth metadata configured"
                              : "No OAuth token metadata",
                        },
                        {
                          label: "Status",
                          value: selectedServer.status,
                          meta: selectedServer.lastError || "No recent error",
                        },
                        {
                          label: "Invocation",
                          value: selectedRemotePreviewItem
                            ? (selectedRemotePreviewItem.invocationState?.replaceAll("_", " ") ?? "unknown")
                            : selectedServerRuntimeReady
                              ? "runtime invokable"
                              : "not callable",
                          meta: selectedRemotePreviewItem?.runtimePath?.replaceAll("_", " ") ?? "local stdio",
                        },
                      ]}
                    />
                    <dl>
                      <dt>Server ID</dt>
                      <dd>{selectedServer.serverId}</dd>
                      <dt>Updated</dt>
                      <dd>{formatDateTime(selectedServer.updatedAt)}</dd>
                      <dt>Verified</dt>
                      <dd>{formatDateTime(selectedServer.verifiedAt)}</dd>
                    </dl>
                    <McpConfigurationReport
                      server={selectedServer}
                      scope={props.activeWorkspaceId}
                      button={(label, click, disabled) => (
                        <NativeButton onClick={click} disabled={disabled}>
                          {label}
                        </NativeButton>
                      )}
                    />
                  </>
                )}
                {detailTab === "tools" ? (
                  <NativeButton variant="secondary" onClick={() => setToolsVersion((value) => value + 1)}>
                    Refresh tools
                  </NativeButton>
                ) : null}
              </SettingsStack>
            ) : (
              <SettingsEmptyState label="The selected server is unavailable. Refresh or select another server." />
            )}
          </DetailInspector>
        </SettingsStack>
      ) : null}
      {leave.dialog}
      <ConfirmModal
        className="mc-next-integration-confirmation"
        open={deletion.review !== null}
        danger
        pending={deletion.mutation.pending}
        title="Delete MCP server?"
        message={
          'Delete "' +
          (deletion.review?.label ?? "this MCP server") +
          '" for the whole installation? Its saved configuration, credentials, tool inventory and retained edits will be removed, and current connections will close.'
        }
        confirmLabel="Delete"
        onCancel={deletion.cancel}
        onConfirm={() => void deletion.confirm()}
      />
    </SettingsSectionShell>
  );
}
