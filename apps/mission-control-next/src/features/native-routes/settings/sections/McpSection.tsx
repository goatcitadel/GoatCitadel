// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Plug2, Plus, RefreshCw, RotateCcw, Save, Square, Trash2 } from "lucide-react";
import type {
  ConnectorDiagnosticReport,
  McpElicitationRequest,
  McpElicitationResponseAction,
  McpServerRecord,
} from "@goatcitadel/contracts";
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
  respondMcpElicitation,
  runMcpServerHealthCheck,
  startMcpOAuth,
  updateMcpServer,
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
  SettingsCodeBlock,
  SettingsEmptyState,
  SettingsField,
  SettingsFieldGrid,
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { NativeCard, NativeDisclosureCard, NativeSectionIndex } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import { useDraftTransitionGuard, useFormDirty } from "../../library/use-form-dirty";
import {
  createEmptyMcpRemotePreview,
  createEmptyMcpServerModeManifest,
  formatDateTime,
  formatJson,
  formatMcpElicitationMeta,
  formatMcpRemotePreviewItem,
  isRuntimeInvokableMcpServer,
  parseMcpElicitationDraft,
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

function areMcpDraftsEqual(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function McpSection(props: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [servers, templates, remotePreview, serverMode, pendingElicitations] = await Promise.all([
      nativeLoad("MCP servers", fetchMcpServers(), { items: [] }),
      nativeLoad("MCP templates", fetchMcpTemplates(), { items: [] }),
      nativeLoad("MCP remote preview", fetchMcpRemotePreview(), createEmptyMcpRemotePreview()),
      nativeLoad("MCP server mode", fetchMcpServerModeManifest(), createEmptyMcpServerModeManifest()),
      nativeLoad("MCP elicitations", fetchMcpElicitations({ status: "pending" }), { items: [] }),
    ]);
    return {
      issues: nativeLoadIssues([servers, templates, remotePreview, serverMode, pendingElicitations]),
      servers: servers.data.items,
      templates: templates.data.items,
      remotePreview: remotePreview.data,
      serverMode: serverMode.data,
      pendingElicitations: pendingElicitations.data.items,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingDeleteServer, setPendingDeleteServer] = useState<{ serverId: string; label: string } | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState("");
  const [elicitationDrafts, setElicitationDrafts] = useState<Record<string, string>>({});
  const [createForm, setCreateForm] = useState(createEmptyMcpCreateForm);
  const [editForm, setEditForm] = useState(() => createMcpEditForm(null));
  const [editFormBaseline, setEditFormBaseline] = useState(() => createMcpEditForm(null));
  const [tools, setTools] = useState<Array<{ toolName: string; description?: string }>>([]);
  const [healthReport, setHealthReport] = useState<ConnectorDiagnosticReport | null>(null);
  const selectedServer =
    data?.servers?.find((item) => item.serverId === selectedServerId) ?? data?.servers?.[0] ?? null;
  const selectedRemotePreviewItem = selectedServer
    ? data?.remotePreview.items?.find((item) => item.source === "server" && item.id === selectedServer.serverId)
    : undefined;
  const selectedServerRuntimeReady = selectedRemotePreviewItem
    ? selectedRemotePreviewItem.runtimeSupported
    : selectedServer
      ? isRuntimeInvokableMcpServer(selectedServer)
      : false;
  const editFormDirty = !areMcpDraftsEqual(editForm, editFormBaseline);
  const createFormDirty = !areMcpDraftsEqual(createForm, createEmptyMcpCreateForm());
  const elicitationDraftDirty = Object.values(elicitationDrafts).some((draft) => draft.trim() !== "{}");
  useFormDirty("settings:mcp", editFormDirty || createFormDirty || elicitationDraftDirty, { label: "MCP" });

  const resetMcpEditDraft = useCallback(() => {
    setEditForm(editFormBaseline);
    setHealthReport(null);
  }, [editFormBaseline]);
  const applyServerSelection = useCallback((serverId: string) => {
    setSelectedServerId(serverId);
    setHealthReport(null);
  }, []);
  const serverSelectionGuard = useDraftTransitionGuard(editFormDirty, applyServerSelection, resetMcpEditDraft);

  useEffect(() => {
    if (!data?.servers?.length) {
      setSelectedServerId("");
      return;
    }
    setSelectedServerId((current) =>
      current && data.servers.some((item) => item.serverId === current) ? current : data.servers[0]?.serverId || "",
    );
  }, [data?.servers]);

  useEffect(() => {
    if (!data?.pendingElicitations?.length) {
      setElicitationDrafts({});
      return;
    }
    setElicitationDrafts((current) => {
      const next: Record<string, string> = {};
      for (const item of data.pendingElicitations) {
        next[item.elicitationId] = current[item.elicitationId] ?? "{}";
      }
      return next;
    });
  }, [data?.pendingElicitations]);

  useEffect(() => {
    if (editFormDirty) {
      return;
    }
    if (!selectedServer) {
      const emptyEditForm = createMcpEditForm(null);
      setEditForm(emptyEditForm);
      setEditFormBaseline(emptyEditForm);
      setTools([]);
      return;
    }
    const nextEditForm = createMcpEditForm(selectedServer);
    setEditForm(nextEditForm);
    setEditFormBaseline(nextEditForm);
    void fetchMcpTools(selectedServer.serverId)
      .then((result) =>
        setTools(result.items.map((item) => ({ toolName: item.toolName, description: item.description }))),
      )
      .catch(() => setTools([]));
    // Preserve local edits across background health/connect reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedServer]);

  const handleCreate = async () => {
    if (!createForm.label.trim()) {
      setNotice({ tone: "warning", message: "Server label is required." });
      return;
    }
    try {
      const created = await createMcpServer({
        label: createForm.label.trim(),
        transport: createForm.transport as McpServerRecord["transport"],
        command: createForm.transport === "stdio" ? createForm.command.trim() || undefined : undefined,
        url: createForm.transport !== "stdio" ? createForm.url.trim() || undefined : undefined,
        authType: createForm.authType,
        oauth: createForm.oauth,
        enabled: isRuntimeInvokableMcpServer(createForm) ? createForm.enabled : false,
      });
      setNotice({ tone: "success", message: `MCP server ${created.label} created.` });
      setCreateForm(createEmptyMcpCreateForm());
      await reload();
      setSelectedServerId(created.serverId);
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleSave = async () => {
    if (!selectedServer) {
      return;
    }
    try {
      await updateMcpServer(selectedServer.serverId, {
        label: editForm.label.trim() || undefined,
        command: selectedServer.transport === "stdio" ? editForm.command.trim() || undefined : undefined,
        url: selectedServer.transport !== "stdio" ? editForm.url.trim() || undefined : undefined,
        enabled: selectedServerRuntimeReady ? editForm.enabled : false,
        category: editForm.category as McpServerRecord["category"],
      });
      setEditFormBaseline(editForm);
      setNotice({ tone: "success", message: "MCP server updated." });
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const runServerAction = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
      setNotice({ tone: "success", message: successMessage });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
    }
  };

  const handleDeleteServer = async () => {
    if (!pendingDeleteServer) {
      return;
    }
    setDeletePending(true);
    try {
      await deleteMcpServer(pendingDeleteServer.serverId);
      setNotice({ tone: "success", message: `MCP server ${pendingDeleteServer.label} deleted.` });
      setPendingDeleteServer(null);
      await reload();
    } catch (deleteError) {
      setNotice({ tone: "error", message: getErrorMessage(deleteError) });
    } finally {
      setDeletePending(false);
    }
  };

  const handleElicitationResponse = async (request: McpElicitationRequest, action: McpElicitationResponseAction) => {
    try {
      let content: Record<string, unknown> | undefined;
      if (action === "accept") {
        content = parseMcpElicitationDraft(elicitationDrafts[request.elicitationId] ?? "{}");
      }
      const updated = await respondMcpElicitation(request.elicitationId, {
        action,
        content,
        owner: { surface: "mcp" },
      });
      setNotice({
        tone: "success",
        message: `MCP elicitation ${updated.status}. Evidence ${
          updated.response?.evidence?.auditEventId ??
          updated.evidence?.statusHistory?.at(-1)?.auditEventId ??
          "recorded"
        }.`,
      });
      await reload();
    } catch (responseError) {
      setNotice({ tone: "error", message: getErrorMessage(responseError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <>
          <NativeSectionIndex
            items={[
              { id: "mcp-servers", label: "Servers" },
              { id: "mcp-create", label: "Create" },
              { id: "mcp-inbox", label: "Inbox" },
              { id: "mcp-detail", label: "Selected server" },
              { id: "mcp-previews", label: "Previews" },
            ]}
          />
          <SettingsGrid variant="detail-wide">
            <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
            <SettingsStack>
              <NativeCard
                id="mcp-servers"
                density="compact"
                className="mc-next-settings-panel"
                title="MCP servers"
                subtitle="Connected and disconnected MCP servers available to the operator."
                stats={[
                  { label: "Servers", value: String(data.servers?.length ?? 0) },
                  { label: "Templates", value: String(data.templates?.length ?? 0) },
                  { label: "Pending prompts", value: String(data.pendingElicitations?.length ?? 0) },
                ]}
              >
                <NativeSelectableList
                  items={(data.servers ?? []).map((item) => ({
                    id: item.serverId,
                    title: item.label,
                    meta: item.status,
                    body: `${item.transport} · ${item.enabled ? "enabled" : "disabled"}`,
                  }))}
                  selectedId={selectedServerId}
                  onSelect={(serverId) => {
                    if (serverId === selectedServerId) {
                      return;
                    }
                    serverSelectionGuard.requestTransition(serverId);
                  }}
                  emptyLabel="No MCP servers configured."
                  maxHeight="min(38vh, 22rem)"
                />
              </NativeCard>
              <NativeDisclosureCard
                id="mcp-create"
                title="Create MCP server"
                subtitle="Set up a local stdio MCP server or use a runtime-supported template."
                defaultOpen={(data.servers?.length ?? 0) === 0}
              >
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
                  <NativeButton variant="default" onClick={() => void handleCreate()}>
                    <Plus size={16} />
                    Create MCP server
                  </NativeButton>
                </SettingsButtonRow>
                {data.templates?.length ? (
                  <SettingsActionList
                    ariaLabel="MCP server templates"
                    items={data.templates.slice(0, 6).map((item) => ({
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
              </NativeDisclosureCard>
              <NativeDisclosureCard
                id="mcp-inbox"
                title="MCP elicitation inbox"
                subtitle="Pending operator prompts requested through the Gateway-owned MCP elicitation route."
                defaultOpen={Boolean(data.pendingElicitations?.length)}
              >
                <NativeMetricGrid
                  items={[
                    {
                      label: "Pending",
                      value: String(data.pendingElicitations?.length ?? 0),
                      meta: "operator responses",
                    },
                    {
                      label: "Boundary",
                      value: "Gateway",
                      meta: "policy and audit enforced",
                    },
                  ]}
                />
                {data.pendingElicitations?.length ? (
                  <div className="mc-next-settings-stack">
                    {data.pendingElicitations.map((item) => (
                      <div className="mc-next-settings-panel-body" key={item.elicitationId}>
                        <NativeMetricGrid
                          items={[
                            { label: "Status", value: item.status, meta: item.elicitationId },
                            { label: "Source", value: item.source.sourceType, meta: item.source.serverId ?? "gateway" },
                            {
                              label: "Prompt",
                              value: `${item.prompt.charLength}/${item.prompt.maxChars}`,
                              meta: item.prompt.truncated ? "truncated" : "bounded",
                            },
                            {
                              label: "Schema",
                              value: `${item.requestedSchema.byteLength}/${item.requestedSchema.maxBytes}`,
                              meta:
                                item.requestedSchema.redactedSecretCount > 0
                                  ? `${item.requestedSchema.redactedSecretCount} redacted`
                                  : "bounded",
                            },
                          ]}
                        />
                        <SettingsActionList
                          ariaLabel={`MCP elicitation ${item.elicitationId}`}
                          items={[
                            {
                              label: item.prompt.text,
                              description: formatMcpElicitationMeta(item),
                              meta: item.audit.auditEventIds.at(-1) ?? item.createdAt,
                            },
                          ]}
                        />
                        <SettingsCodeBlock label="Requested response schema">
                          {formatJson(item.requestedSchema.value)}
                        </SettingsCodeBlock>
                        <SettingsField label="Accept response JSON">
                          <textarea
                            className="mc-next-settings-textarea"
                            rows={4}
                            value={elicitationDrafts[item.elicitationId] ?? "{}"}
                            onChange={(event) =>
                              setElicitationDrafts((current) => ({
                                ...current,
                                [item.elicitationId]: event.target.value,
                              }))
                            }
                          />
                        </SettingsField>
                        <SettingsButtonRow>
                          <NativeButton
                            variant="default"
                            onClick={() => void handleElicitationResponse(item, "accept")}
                          >
                            <CheckCircle2 size={16} />
                            Accept
                          </NativeButton>
                          <NativeButton
                            variant="secondary"
                            onClick={() => void handleElicitationResponse(item, "decline")}
                          >
                            <Square size={16} />
                            Decline
                          </NativeButton>
                          <NativeButton
                            variant="secondary"
                            onClick={() => void handleElicitationResponse(item, "cancel")}
                          >
                            <RotateCcw size={16} />
                            Cancel
                          </NativeButton>
                        </SettingsButtonRow>
                      </div>
                    ))}
                  </div>
                ) : (
                  <SettingsEmptyState label="No pending MCP elicitations." />
                )}
              </NativeDisclosureCard>
              <NativeDisclosureCard
                id="mcp-previews"
                title="Server mode preview"
                subtitle="Operator-authenticated export posture for agents that may call GoatCitadel in the future."
              >
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
              </NativeDisclosureCard>
              <NativeDisclosureCard
                id="mcp-remote-preview"
                title="Remote MCP preview"
                subtitle="Read-only posture for http/sse MCP records, runtime support, auth, trust, and invocation state."
              >
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
                      meta: data.remotePreview.experimentalRemoteRecordsAllowed ? "experimental records" : "default",
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
              </NativeDisclosureCard>
            </SettingsStack>
            <NativeCard
              id="mcp-detail"
              density="compact"
              className="mc-next-settings-panel"
              title={selectedServer?.label ?? "Server detail"}
              subtitle="Edit, connect, diagnose, or delete the selected MCP server."
            >
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
                          onChange={(event) => setEditForm((current) => ({ ...current, command: event.target.value }))}
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
                  <NativeMetricGrid
                    items={[
                      { label: "Transport", value: selectedServer.transport, meta: selectedServer.authType },
                      {
                        label: "Auth readiness",
                        value: humanizeEnumToken(
                          selectedRemotePreviewItem?.authReadiness ??
                            selectedServer.authState?.readiness ??
                            "not_required",
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
                  <SettingsButtonRow>
                    <NativeButton variant="default" onClick={() => void handleSave()}>
                      <Save size={16} />
                      Save changes
                    </NativeButton>
                    <NativeButton
                      variant="secondary"
                      onClick={() =>
                        void runServerAction(async () => {
                          const flow = await startMcpOAuth(selectedServer.serverId);
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
                        void runServerAction(
                          async () => setHealthReport(await runMcpServerHealthCheck(selectedServer.serverId)),
                          "MCP health check complete.",
                        )
                      }
                      disabled={!selectedServerRuntimeReady}
                    >
                      <RefreshCw size={16} />
                      Health check
                    </NativeButton>
                    <NativeButton
                      variant="secondary"
                      onClick={() => props.navigate({ area: "settings", section: "tools", theme: props.route.theme })}
                    >
                      <CheckCircle2 size={16} />
                      Manage tool grants
                    </NativeButton>
                    <NativeButton
                      variant="destructive"
                      onClick={() =>
                        setPendingDeleteServer({ serverId: selectedServer.serverId, label: selectedServer.label })
                      }
                    >
                      <Trash2 size={16} />
                      Delete
                    </NativeButton>
                  </SettingsButtonRow>
                  <SettingsActionList
                    ariaLabel={`${selectedServer.label} tools`}
                    items={tools.map((item) => ({
                      label: item.toolName,
                      description: item.description || "Registered MCP tool",
                    }))}
                    emptyLabel="No tools reported for this server."
                  />
                  {healthReport ? (
                    <DiagnosticsPanel report={healthReport} ariaLabel={`${selectedServer.label} health checks`} />
                  ) : null}
                </>
              ) : (
                <SettingsEmptyState label="Select a server or create a new one." />
              )}
            </NativeCard>
          </SettingsGrid>
        </>
      ) : null}
      <ConfirmModal
        open={serverSelectionGuard.pendingTransition !== null}
        danger
        title="Discard MCP server changes?"
        message="The selected MCP server has unsaved edits. Discard them and open another server?"
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        onCancel={serverSelectionGuard.cancelDiscard}
        onConfirm={serverSelectionGuard.confirmDiscard}
      />
      <ConfirmModal
        open={pendingDeleteServer !== null}
        danger
        pending={deletePending}
        title="Delete MCP server?"
        message={`Delete "${pendingDeleteServer?.label ?? "this MCP server"}"? Its saved configuration will be permanently removed.`}
        confirmLabel="Delete"
        onCancel={() => setPendingDeleteServer(null)}
        onConfirm={() => void handleDeleteServer()}
      />
    </SettingsSectionShell>
  );
}

// The "all" API surface is exposed through its own explicit action, not the per-surface action row.
