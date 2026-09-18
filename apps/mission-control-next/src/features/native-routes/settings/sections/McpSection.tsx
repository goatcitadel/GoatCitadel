import { McpElicitationEditor } from "./McpElicitationEditor";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Plug2, Plus, RefreshCw, Save, Square, Trash2 } from "lucide-react";
import type { ConnectorDiagnosticReport, McpServerRecord } from "@goatcitadel/contracts";
import {
  connectMcpServer,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  fetchMcpElicitations,
  fetchMcpRemotePreview,
  fetchMcpServerModeManifest,
  fetchMcpServers,
  fetchMcpTemplates,
  fetchMcpTools,
  runMcpServerHealthCheck,
  startMcpOAuth,
  updateMcpServer,
  isApiRequestError,
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
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { discardSessionDraft, hasSessionDraft, useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { useSessionViewState } from "../../../../hooks/use-session-view-state";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { DetailInspector } from "../../../../components/DetailInspector";
import { McpServerReview } from "./McpServerReview";
import { describeMcpServerError, useMcpServerReview } from "./useMcpServerReview";
import "./integration-confirmation.css";
import {
  createEmptyMcpRemotePreview,
  createEmptyMcpServerModeManifest,
  formatDateTime,
  formatMcpElicitationMeta,
  formatMcpRemotePreviewItem,
  isRuntimeInvokableMcpServer,
} from "../../SettingsNativePage";

function createEmptyMcpCreateForm() {
  return {
    label: "",
    transport: "stdio",
    command: "",
    url: "",
    authType: "none" as McpServerRecord["authType"],
    oauth: undefined as McpServerRecord["oauth"] | undefined,
    enabled: true,
  };
}

function createMcpEditForm(server: McpServerRecord | null) {
  return {
    label: server?.label ?? "",
    command: server?.command ?? "",
    url: server?.url ?? "",
    enabled: server?.enabled ?? true,
    category: server?.category ?? "development",
  };
}

export function McpSection(props: SettingsSectionProps) {
  const [panel, setPanel] = useState<"create" | "edit" | "detail" | "previews" | "elicitation" | null>(null);
  const [templatesRequested, setTemplatesRequested] = useState(false);
  const [previewRequested, setPreviewRequested] = useState(false);
  const [selectedServerId, setSelectedServerId] = useSessionViewState("mcp:" + props.activeWorkspaceId + ":server", "");
  const [selectedElicitationId, setSelectedElicitationId] = useSessionViewState(
    "mcp:" + props.activeWorkspaceId + ":elicitation",
    "",
  );
  const [detailTab, setDetailTab] = useState<"connection" | "tools" | "diagnostics">("connection");
  const selectionRef = useRef(selectedServerId);
  selectionRef.current = selectedServerId;
  const scopeRef = useRef({ workspaceId: props.activeWorkspaceId, serverId: selectedServerId });
  if (scopeRef.current.workspaceId !== props.activeWorkspaceId || scopeRef.current.serverId !== selectedServerId) scopeRef.current = { workspaceId: props.activeWorkspaceId, serverId: selectedServerId };
  const currentScope = scopeRef.current;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrentScope = () => mounted.current && scopeRef.current === currentScope;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const leave = useDraftLeave();
  const load = useCallback(async () => {
    const [servers, templates, remotePreview, serverMode, pendingElicitations] = await Promise.all([
      nativeLoad("MCP servers", fetchMcpServers(), { items: [] }),
      nativeLoad("MCP templates", templatesRequested ? fetchMcpTemplates() : Promise.resolve({ items: [] }), {
        items: [],
      }),
      nativeLoad(
        "MCP remote preview",
        previewRequested ? fetchMcpRemotePreview() : Promise.resolve(createEmptyMcpRemotePreview()),
        createEmptyMcpRemotePreview(),
      ),
      nativeLoad(
        "MCP server mode",
        previewRequested ? fetchMcpServerModeManifest() : Promise.resolve(createEmptyMcpServerModeManifest()),
        createEmptyMcpServerModeManifest(),
      ),
      nativeLoad("MCP elicitations", fetchMcpElicitations({ status: "pending" }), { items: [] }),
    ]);
    return {
      workspaceId: props.activeWorkspaceId,
      issues: nativeLoadIssues([servers, templates, remotePreview, serverMode, pendingElicitations]),
      servers: servers.data.items,
      templates: templates.data.items,
      remotePreview: remotePreview.data,
      serverMode: serverMode.data,
      pendingElicitations: pendingElicitations.data.items,
      remotePreviewAvailable: previewRequested && !remotePreview.issue && Boolean(remotePreview.data.summary),
      serverModeAvailable: previewRequested && !serverMode.issue && Boolean(serverMode.data.summary),
    };
  }, [templatesRequested, previewRequested, props.activeWorkspaceId]);
  const { loading, error, data, reload, updateData } = useAsyncLoad(load, [load]);
  const applyServer = useCallback((serverId: string, server: McpServerRecord | null) => {
    updateData(current => ({ ...current, servers: server
      ? current.servers.some(item => item.serverId === serverId) ? current.servers.map(item => item.serverId === serverId ? server : item) : [...current.servers, server]
      : current.servers.filter(item => item.serverId !== serverId) }));
  }, [updateData]);
  const review = useMcpServerReview(props.activeWorkspaceId, selectedServerId, applyServer);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingDeleteServer, setPendingDeleteServer] = useState<{ serverId: string; label: string; revision: string } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [tools, setTools] = useState<Array<{ toolName: string; description?: string }> | null>(null);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [toolsVersion, setToolsVersion] = useState(0);
  const [healthReport, setHealthReport] = useState<ConnectorDiagnosticReport | null>(null);
  const selectedServer = data?.servers?.find((item) => item.serverId === selectedServerId) ?? null;
  const gatewayOwned = selectedServerId === "goatcitadel-internal-approval-inbox" || selectedServerId === "goatcitadel-internal-durable-tasks";
  const selectedElicitation =
    data?.pendingElicitations?.find((item) => item.elicitationId === selectedElicitationId) ?? null;
  const selectedRemotePreviewItem = previewRequested
    ? data?.remotePreview.items?.find((item) => item.source === "server" && item.id === selectedServerId)
    : undefined;
  const selectedServerRuntimeReady =
    selectedRemotePreviewItem?.runtimeSupported ??
    (selectedServer ? isRuntimeInvokableMcpServer(selectedServer) : false);
  const createDraft = useSessionDraft(
    "mcp:" + props.activeWorkspaceId + ":new",
    createEmptyMcpCreateForm(),
    undefined,
    { label: "New MCP server", active: panel === "create", onSave: () => handleCreate() },
  );
  const editDraft = useSessionDraft(
    "mcp:" + props.activeWorkspaceId + ":" + selectedServerId + ":edit",
    createMcpEditForm(selectedServer),
    selectedServer?.revision,
    {
      label: selectedServer?.label ?? "MCP server",
      active: panel === "edit",
      available: Boolean(selectedServer),
      onSave: () => handleSave(),
    },
  );
  const createForm = createDraft.value,
    setCreateForm = createDraft.setValue;
  const editForm = editDraft.value,
    setEditForm = editDraft.setValue;
  const requiresReview = review.required || editDraft.hasRemoteChanges;
  const reviewPanel = requiresReview ? <McpServerReview server={selectedServer} loading={review.loading} error={review.error} missing={review.missing}
    onReload={() => void review.refresh()} onAccept={() => {
      if (review.isCurrent() && selectedServer?.revision && !review.loading && !review.error && !review.missing) {
        editDraft.rebaseToCurrent(); review.accept();
        setNotice({ tone: "info", message: "Current server reviewed. Save your draft or choose Delete again when ready." });
      }
    }} /> : null;
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
  const closePanel = () => leave.request(() => setPanel(null));
  useEffect(() => {
    setPanel(null);
    setHealthReport(null);
    setPendingDeleteServer(null);
    setNotice(null);
  }, [props.activeWorkspaceId]);
  useEffect(() => { busyRef.current = false; setBusy(false); setDeletePending(false); setPendingDeleteServer(null); }, [currentScope]);
  useEffect(() => {
    setHealthReport(null);
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
    if (!createForm.label.trim()) {
      setNotice({ tone: "warning", message: "Server label is required." });
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    const submitted = createForm;
    try {
      const created = await createMcpServer({
        label: submitted.label.trim(),
        transport: submitted.transport as McpServerRecord["transport"],
        command: submitted.transport === "stdio" ? submitted.command.trim() || undefined : undefined,
        url: submitted.transport !== "stdio" ? submitted.url.trim() || undefined : undefined,
        authType: submitted.authType,
        oauth: submitted.oauth,
        enabled: isRuntimeInvokableMcpServer(submitted) ? submitted.enabled : false,
      });
      if (!isCurrentScope()) return false;
      if (!created?.serverId || !created.revision) throw new Error("The saved MCP server could not be verified. Reload the server inventory before creating another.");
      const clean = createDraft.acceptSaved(createEmptyMcpCreateForm(), undefined, submitted);
      applyServer(created.serverId, created);
      setNotice({ tone: "success", message: "MCP server " + created.label + " created." });
      if (clean && panelRef.current === "create") {
        setSelectedServerId(created.serverId);
        setPanel("detail");
      }
      return clean;
    } catch (cause) {
      if (isCurrentScope()) setNotice({ tone: "error", message: describeMcpServerError(cause) });
      return false;
    } finally {
      if (isCurrentScope()) { busyRef.current = false; setBusy(false); }
    }
  };
  const handleSave = async (): Promise<boolean> => {
    if (!selectedServer || gatewayOwned || busyRef.current) return false;
    if (requiresReview || !/^[a-f0-9]{64}$/.test(String(editDraft.baseRevision ?? ""))) {
      setNotice({
        tone: "warning",
        message: "The server configuration changed. Review it before applying your retained draft.",
      });
      if (!requiresReview) await review.refresh();
      return false;
    }
    busyRef.current = true;
    setBusy(true);
    const submitted = editForm;
    try {
      const updated = await updateMcpServer(selectedServer.serverId, {
        expectedRevision: String(editDraft.baseRevision),
        label: submitted.label.trim() || undefined,
        command: selectedServer.transport === "stdio" ? submitted.command.trim() : undefined,
        url: selectedServer.transport !== "stdio" ? submitted.url.trim() || undefined : undefined,
        enabled: selectedServerRuntimeReady ? submitted.enabled : false,
        category: submitted.category as McpServerRecord["category"],
      });
      if (!isCurrentScope()) return false;
      if (updated?.serverId !== selectedServer.serverId || !updated.revision) throw new Error("The saved MCP server could not be verified. Review the current server before retrying.");
      const saved = createMcpEditForm(updated);
      const clean = editDraft.acceptSaved(saved, updated.revision, submitted);
      applyServer(updated.serverId, updated);
      setNotice({ tone: "success", message: "MCP server updated." });
      return clean;
    } catch (cause) {
      if (isCurrentScope()) {
        setNotice({ tone: "error", message: describeMcpServerError(cause) });
        if (!isApiRequestError(cause) || cause.status === undefined || cause.status === 404 || cause.status === 409 || cause.status >= 500) await review.refresh();
      }
      return false;
    } finally {
      if (isCurrentScope()) { busyRef.current = false; setBusy(false); }
    }
  };
  const runServerAction = async (action: () => Promise<unknown>, successMessage: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
      if (!isCurrentScope()) return;
      setNotice({ tone: "success", message: successMessage });
      await reload();
    } catch (cause) {
      if (isCurrentScope()) setNotice({ tone: "error", message: describeMcpServerError(cause) });
    } finally {
      if (isCurrentScope()) { busyRef.current = false; setBusy(false); }
    }
  };
  const handleDeleteServer = async () => {
    if (!pendingDeleteServer || deletePending || busyRef.current) return;
    busyRef.current = true;
    setDeletePending(true);
    const submitted = pendingDeleteServer;
    try {
      const deleted = await deleteMcpServer(submitted.serverId, submitted.revision);
      if (!isCurrentScope()) return;
      if (!deleted.deleted) throw new Error("The MCP deletion could not be verified. Review the current server before retrying.");
      discardSessionDraft("mcp:" + props.activeWorkspaceId + ":" + submitted.serverId + ":edit");
      applyServer(submitted.serverId, null);
      setNotice({ tone: "success", message: "MCP server " + submitted.label + " deleted." });
      setPendingDeleteServer(null);
      if (selectionRef.current === pendingDeleteServer.serverId) setPanel(null);
    } catch (cause) {
      if (isCurrentScope()) {
        setPendingDeleteServer(null);
        setNotice({ tone: "error", message: describeMcpServerError(cause) });
        if (!isApiRequestError(cause) || cause.status === undefined || cause.status === 404 || cause.status === 409 || cause.status >= 500) await review.refresh();
      }
    } finally {
      if (isCurrentScope()) { busyRef.current = false; setDeletePending(false); }
    }
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          {panel === "create" ? (
            <FocusedDetail title="Add MCP server" onClose={closePanel}>
              <SettingsStack>
                <SettingsFieldGrid>
                  <SettingsField label="Label">
                    <input
                      className="mc-next-settings-input"
                      value={createForm.label}
                      onChange={(event) => setCreateForm((current) => ({ ...current, label: event.target.value }))}
                    />
                  </SettingsField>
                  <SettingsField label="Transport">
                    <input className="mc-next-settings-input" value={createForm.transport} readOnly />
                  </SettingsField>
                  {createForm.transport === "stdio" ? (
                    <SettingsField label="Command" span={2}>
                      <input
                        className="mc-next-settings-input"
                        value={createForm.command}
                        onChange={(event) => setCreateForm((current) => ({ ...current, command: event.target.value }))}
                      />
                    </SettingsField>
                  ) : (
                    <SettingsField label="URL" span={2}>
                      <input
                        className="mc-next-settings-input"
                        value={createForm.url}
                        onChange={(event) => setCreateForm((current) => ({ ...current, url: event.target.value }))}
                      />
                    </SettingsField>
                  )}
                  <SettingsField label="Enabled" group>
                    <label className="mc-next-settings-toggle">
                      <input
                        type="checkbox"
                        checked={createForm.enabled}
                        disabled={!isRuntimeInvokableMcpServer(createForm)}
                        onChange={(event) =>
                          setCreateForm((current) => ({ ...current, enabled: event.target.checked }))
                        }
                      />
                      <span>
                        {isRuntimeInvokableMcpServer(createForm)
                          ? "Enable immediately after create"
                          : "Configured only until supported auth and URL are present"}
                      </span>
                    </label>
                  </SettingsField>
                </SettingsFieldGrid>
                <SettingsNotice
                  notice={{
                    tone: "info",
                    message:
                      "Runtime invocation supports local stdio, the built-in Approval Inbox, and governed remote http/sse servers with no auth, explicit token env-key policy, or connected OAuth token state.",
                  }}
                />
                <SettingsButtonRow>
                  <NativeButton variant="default" disabled={busy} onClick={() => void handleCreate()}>
                    <Plus size={16} />
                    Create MCP server
                  </NativeButton>
                </SettingsButtonRow>
                {data.templates?.length ? (
                  <SettingsActionList
                    ariaLabel="MCP server templates"
                    items={data.templates.map((item) => ({
                      label: item.label,
                      description: item.description,
                      meta: item.installed
                        ? "installed"
                        : isRuntimeInvokableMcpServer(item)
                          ? item.transport
                          : "configured only",
                      onClick: () =>
                        setCreateForm({
                          label: item.label,
                          transport: item.transport,
                          command: item.command ?? "",
                          url: item.url ?? "",
                          authType: item.authType,
                          oauth: item.oauth,
                          enabled: item.enabledByDefault,
                        }),
                      actionLabel: "Use",
                    }))}
                  />
                ) : null}
              </SettingsStack>
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
                    <NativeButton disabled={busy || gatewayOwned || requiresReview} onClick={() => void handleSave()}>
                      <Save size={16} />
                      Save changes
                    </NativeButton>
                  </>
                ) : (
                  <NativeCard title="Retained MCP edits" subtitle="This server is unavailable. Your draft has not been discarded.">
                    <dl><dt>Label</dt><dd>{editForm.label}</dd><dt>Command or URL</dt><dd>{editForm.command || editForm.url || "None"}</dd><dt>Category</dt><dd>{editForm.category}</dd></dl>
                  </NativeCard>
                )}
              </SettingsStack>
            </FocusedDetail>
          ) : panel === "previews" ? (
            <FocusedDetail title="MCP diagnostics" onClose={closePanel}>
              <SettingsStack>
                <NativeDisclosureCard id="mcp-previews" title="Server mode preview" defaultOpen>
                  {data.serverModeAvailable ? (
                    <>
                      <NativeMetricGrid
                        items={[
                          {
                            label: "Runtime",
                            value: data.serverMode.runtimeSupport?.replaceAll("_", " ") ?? "unknown",
                            meta: data.serverMode.status,
                          },
                          {
                            label: "Descriptors",
                            value: String(data.serverMode.summary?.exportedToolDescriptors ?? 0),
                            meta: `${data.serverMode.summary?.blockedDescriptors ?? 0} blocked`,
                          },
                          {
                            label: "Call preview",
                            value: data.serverMode.runtime?.callPreview?.supported ? "available" : "not available",
                            meta: data.serverMode.runtime?.callPreview?.readOnlyOnly ? "read-only only" : "not scoped",
                          },
                        ]}
                      />
                      <SettingsNotice
                        notice={{
                          tone: data.serverMode.runtime?.callPreview?.supported ? "success" : "info",
                          message: data.serverMode.runtime?.callPreview?.supported
                            ? "Read-only, closed-world descriptors can re-enter Gateway policy through the server-mode stdio proxy or HTTP call preview."
                            : "The MCP stdio proxy can expose the manifest, but tools/call remains unavailable until Gateway tool invocation services are present.",
                        }}
                      />
                      <SettingsActionList
                        ariaLabel="MCP server-mode capability descriptors"
                        items={(data.serverMode.tools ?? []).slice(0, 8).map((item) => ({
                          label: item.name,
                          meta: `${item.serverModeState.replaceAll("_", " ")} · ${item.capabilityKind}`,
                          description: `${item.title} · ${item.blockers[0] ?? item.governance[0] ?? "No blocker recorded."}`,
                        }))}
                        emptyLabel="No callable capability descriptors are exported."
                      />
                    </>
                  ) : (
                    <p>Server mode evidence is unavailable.</p>
                  )}
                </NativeDisclosureCard>
                <NativeDisclosureCard id="mcp-remote-preview" title="Remote MCP preview" defaultOpen>
                  {data.remotePreviewAvailable ? (
                    <>
                      <NativeMetricGrid
                        items={[
                          {
                            label: "Remote servers",
                            value: String(data.remotePreview.summary?.remoteServers ?? 0),
                            meta: "configured records",
                          },
                          {
                            label: "Remote templates",
                            value: String(data.remotePreview.summary?.remoteTemplates ?? 0),
                            meta: "catalog entries",
                          },
                          {
                            label: "Callable",
                            value: String(data.remotePreview.summary?.runtimeSupported ?? 0),
                            meta: data.remotePreview.runtimeSupport?.replaceAll("_", " ") ?? "unknown",
                          },
                          {
                            label: "Blocked",
                            value: String(data.remotePreview.summary?.blocked ?? 0),
                            meta: data.remotePreview.experimentalRemoteRecordsAllowed
                              ? "experimental records"
                              : "default",
                          },
                          {
                            label: "Not callable",
                            value: String(data.remotePreview.summary?.notCallable ?? 0),
                            meta: `${data.remotePreview.summary?.quarantined ?? 0} quarantined`,
                          },
                          {
                            label: "Needs auth",
                            value: String(data.remotePreview.summary?.needsAuth ?? 0),
                            meta: `${data.remotePreview.summary?.experimentalRecords ?? 0} experimental`,
                          },
                        ]}
                      />
                      <SettingsNotice
                        notice={{
                          tone: "info",
                          message:
                            "Remote http/sse MCP can invoke through the governed Gateway bridge when auth is supported and resolved. OAuth servers show needs-auth until Gateway has a connected token.",
                        }}
                      />
                      <SettingsActionList
                        ariaLabel="Remote MCP server preview"
                        items={(data.remotePreview.items ?? []).map((item) => ({
                          label: item.label,
                          meta: [
                            item.source,
                            item.transport,
                            item.invocationState.replaceAll("_", " "),
                            item.transportRuntimeSupported ? "transport supported" : "no runtime bridge",
                          ].join(" · "),
                          description: formatMcpRemotePreviewItem(item),
                          actionLabel: item.runtimeSupported ? "Runtime path" : "Preview only",
                        }))}
                        emptyLabel="No remote MCP records or templates are visible."
                      />
                    </>
                  ) : (
                    <p>Remote MCP evidence is unavailable.</p>
                  )}
                </NativeDisclosureCard>
              </SettingsStack>
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
                stats={[{label:"Servers",value:data.issues.some(issue=>issue.label === "MCP servers") ? "Unavailable" : (Array.isArray(data.servers) ? String(data.servers.length) : "Unavailable")},{label:"Templates",value:!templatesRequested ? "Not loaded" : data.issues.some(issue=>issue.label === "MCP templates") ? "Unavailable" : (Array.isArray(data.templates) ? String(data.templates.length) : "Unavailable")},{label:"Pending prompts",value:data.issues.some(issue=>issue.label === "MCP elicitations") ? "Unavailable" : (Array.isArray(data.pendingElicitations) ? String(data.pendingElicitations.length) : "Unavailable")}]}
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
                        <NativeButton
                          variant="secondary"
                          onClick={() =>
                            void runServerAction(async () => {
                              const flow = await startMcpOAuth(selectedServer.serverId);
                              if (!isCurrentScope()) return;
                              window.open(flow.authorizeUrl, "_blank", "noopener,noreferrer");
                            }, "MCP OAuth authorization opened.")
                          }
                          disabled={
                            selectedServer.authType !== "oauth2" ||
                            !selectedServer.oauth?.authorizationUrl ||
                            !selectedServer.oauth.tokenUrl
                          }
                        >
                          <KeyRound size={16} />
                          OAuth
                        </NativeButton>
                        <NativeButton
                          variant="secondary"
                          onClick={() =>
                            void runServerAction(
                              () => connectMcpServer(selectedServer.serverId),
                              "MCP server connect requested.",
                            )
                          }
                          disabled={!selectedServerRuntimeReady}
                        >
                          <Plug2 size={16} />
                          Connect
                        </NativeButton>
                        <NativeButton
                          variant="secondary"
                          onClick={() =>
                            void runServerAction(
                              () => disconnectMcpServer(selectedServer.serverId),
                              "MCP server disconnect requested.",
                            )
                          }
                        >
                          <Square size={16} />
                          Disconnect
                        </NativeButton>
                        <NativeButton
                          variant="secondary"
                          onClick={() =>
                            void runServerAction(async () => {
                              const id = selectedServer.serverId;
                              const report = await runMcpServerHealthCheck(id);
                              if (isCurrentScope() && selectionRef.current === id) {
                                setHealthReport(report);
                                setDetailTab("diagnostics");
                              }
                            }, "MCP health check complete.")
                          }
                          disabled={!selectedServerRuntimeReady}
                        >
                          <RefreshCw size={16} />
                          Health check
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
                            if (!selectedServer.revision) { void review.refresh(); return; }
                            setPendingDeleteServer({ serverId: selectedServer.serverId, label: selectedServer.label, revision: selectedServer.revision });
                          }}
                        >
                          <Trash2 size={16} />
                          Delete
                        </NativeButton>
                      </SettingsButtonRow>
                    </fieldset>
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
                    {healthReport ? (
                      <DiagnosticsPanel report={healthReport} ariaLabel={selectedServer.label + " health checks"} />
                    ) : (
                      <p>No health check has been requested in this view.</p>
                    )}
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
        open={pendingDeleteServer !== null}
        danger
        pending={deletePending}
        title="Delete MCP server?"
        message={
          'Delete "' +
          (pendingDeleteServer?.label ?? "this MCP server") +
          '"? Its saved configuration and retained edits will be permanently removed.'
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDeleteServer(null)}
        onConfirm={() => void handleDeleteServer()}
      />
    </SettingsSectionShell>
  );
}
