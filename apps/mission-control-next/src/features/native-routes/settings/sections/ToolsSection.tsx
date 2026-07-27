// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Save } from "lucide-react";
import type { ToolApprovalMode } from "@goatcitadel/contracts";
import {
  createToolGrant,
  fetchSettings,
  fetchToolCatalog,
  fetchToolGrants,
  isApiRequestError,
  patchSettings,
  revokeToolGrant,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
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
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid, NativeSelectableList } from "../../primitives";
import {
  defaultToolGrantExpiry,
  describeToolApprovalMode,
  describeToolGrantAvailability,
  isToolGrantAvailable,
  matchesToolGrant,
  normalizeToolApprovalMode,
  TOOL_APPROVAL_MODE_OPTIONS,
} from "../../SettingsNativePage";

export function ToolsSection({ activeWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [tools, grants, settings] = await Promise.all([
      nativeLoad("Tool catalog", fetchToolCatalog(), { items: [] }),
      nativeLoad("Tool grants", fetchToolGrants({ limit: 400 }), { items: [] }),
      fetchSettings().catch(() => null),
    ]);
    return {
      issues: nativeLoadIssues([tools, grants]),
      tools: tools.data.items,
      grants: grants.data.items,
      settings,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingRevokeGrantId, setPendingRevokeGrantId] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedToolName, setSelectedToolName] = useState("");
  const [approvalModeDraft, setApprovalModeDraft] = useState<ToolApprovalMode>("approve_risky");
  const preserveApprovalModeDraftRef = useRef(false);
  const [grantForm, setGrantForm] = useState({
    toolPattern: "",
    decision: "allow",
    scope: "workspace",
    grantType: "persistent",
    scopeRef: activeWorkspaceId,
    expiresAt: defaultToolGrantExpiry(),
  });

  const filteredTools = useMemo(() => {
    const items = data?.tools ?? [];
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return items;
    }
    return items.filter((item) => {
      const haystack = `${item.toolName} ${item.category ?? ""} ${item.description ?? ""}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [data?.tools, search]);
  const selectedTool = filteredTools.find((item) => item.toolName === selectedToolName) ?? filteredTools[0] ?? null;

  useEffect(() => {
    if (!filteredTools.length) {
      setSelectedToolName("");
      return;
    }
    setSelectedToolName((current) =>
      current && filteredTools.some((item) => item.toolName === current) ? current : filteredTools[0]?.toolName || "",
    );
  }, [filteredTools]);
  const approvalBypassRestriction = !data?.settings
    ? "Settings could not be loaded, so routine prompt skipping stays unavailable."
    : data.settings.deploymentProfile === "remote_hardened"
      ? "Remote Hardened mode keeps routine prompt skipping unavailable."
      : null;

  useEffect(() => {
    if (data?.settings?.toolApprovalMode) {
      if (preserveApprovalModeDraftRef.current) {
        preserveApprovalModeDraftRef.current = false;
        return;
      }
      setApprovalModeDraft(normalizeToolApprovalMode(data.settings.toolApprovalMode));
    }
  }, [data?.settings?.revision, data?.settings?.toolApprovalMode]);

  useEffect(() => {
    if (!selectedTool) {
      return;
    }
    setGrantForm((current) => ({
      ...current,
      toolPattern: selectedTool.toolName,
      scopeRef: current.scope === "workspace" ? activeWorkspaceId : current.scopeRef,
    }));
  }, [activeWorkspaceId, selectedTool]);

  const handleCreateGrant = async () => {
    if (!grantForm.toolPattern.trim()) {
      setNotice({ tone: "warning", message: "Tool pattern is required." });
      return;
    }
    const grantScope = grantForm.scope as "global" | "session" | "workspace" | "agent" | "task";
    const scopeRef = grantScope === "global" ? undefined : grantForm.scopeRef.trim();
    if ((grantScope === "session" || grantScope === "agent" || grantScope === "task") && !scopeRef) {
      setNotice({ tone: "warning", message: `Add a ${grantScope} id before creating this tool grant.` });
      return;
    }
    try {
      const expiresAt = grantForm.grantType === "ttl" ? grantForm.expiresAt.trim() : undefined;
      await createToolGrant({
        toolPattern: grantForm.toolPattern.trim(),
        decision: grantForm.decision as "allow" | "deny",
        scope: grantScope,
        scopeRef,
        grantType: grantForm.grantType as "persistent" | "ttl" | "one_time",
        ...(expiresAt ? { expiresAt } : {}),
      });
      setNotice({ tone: "success", message: "Tool grant created." });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleRevokeGrant = async (grantId: string) => {
    setRevokePending(true);
    try {
      await revokeToolGrant(grantId);
      setNotice({ tone: "success", message: "Tool grant revoked." });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    } finally {
      setRevokePending(false);
    }
  };

  const handleSaveApprovalMode = async () => {
    if (approvalBypassRestriction && approvalModeDraft === "bypass") {
      setNotice({ tone: "warning", message: approvalBypassRestriction });
      return;
    }
    if (!data?.settings) {
      setNotice({ tone: "warning", message: "Reload settings before saving the tool approval mode." });
      return;
    }
    try {
      await patchSettings({
        expectedRevision: data.settings.revision,
        toolApprovalMode: approvalModeDraft,
      });
      setNotice({ tone: "success", message: "Tool approval mode saved." });
      await reload();
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        preserveApprovalModeDraftRef.current = true;
        await reload();
        setNotice({
          tone: "warning",
          message:
            "Tool settings changed elsewhere. Your approval-mode draft is preserved; review the current settings, then save again to retry.",
        });
        return;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  return (
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="three-column">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Global tool prompt mode"
            subtitle="Base prompt behavior for otherwise-allowed tools when no active permission profile overrides it."
            stats={[
              {
                label: "Current",
                value: data.settings?.toolApprovalMode
                  ? describeToolApprovalMode(data.settings.toolApprovalMode)
                  : "Unavailable",
              },
              { label: "Hard blocks", value: "Always enforced" },
            ]}
          >
            <SettingsField label="Tool approvals">
              <select
                className="mc-next-settings-input"
                value={approvalModeDraft}
                onChange={(event) => {
                  const nextMode = normalizeToolApprovalMode(event.target.value);
                  if (approvalBypassRestriction && nextMode === "bypass") {
                    return;
                  }
                  setApprovalModeDraft(nextMode);
                }}
              >
                {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
                  <option key={mode} value={mode} disabled={Boolean(approvalBypassRestriction && mode === "bypass")}>
                    {describeToolApprovalMode(mode)}
                    {approvalBypassRestriction && mode === "bypass" ? " (Unavailable)" : ""}
                  </option>
                ))}
              </select>
              {approvalBypassRestriction ? (
                <p className="mc-next-settings-field-note">
                  {approvalBypassRestriction} Hard blocks and explicit auth stay enforced.
                </p>
              ) : null}
            </SettingsField>
            <SettingsButtonRow>
              <NativeButton variant="default" onClick={() => void handleSaveApprovalMode()}>
                <Save size={16} />
                Save mode
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Tool catalog"
              subtitle="Review the full catalog instead of a tiny first-page slice."
              stats={[
                { label: "Tools", value: String(data.tools?.length ?? 0) },
                { label: "Grants", value: String(data.grants?.length ?? 0) },
              ]}
            >
              <SettingsField label="Search">
                <input
                  className="mc-next-settings-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search tool name, category, or description"
                />
              </SettingsField>
              <NativeSelectableList
                items={filteredTools.map((item) => ({
                  id: item.toolName,
                  title: item.toolName,
                  meta: item.category || "tool",
                  body: item.description || "Tool catalog entry",
                }))}
                selectedId={selectedToolName}
                onSelect={setSelectedToolName}
                emptyLabel="No tools match the current search."
                maxHeight="min(48vh, 28rem)"
              />
            </NativeCard>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Create tool grant"
              subtitle="Create a scoped policy grant for the selected tool."
            >
              <SettingsFieldGrid>
                <SettingsField label="Tool pattern">
                  <input
                    className="mc-next-settings-input"
                    value={grantForm.toolPattern}
                    onChange={(event) => setGrantForm((current) => ({ ...current, toolPattern: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Decision">
                  <select
                    className="mc-next-settings-input"
                    value={grantForm.decision}
                    onChange={(event) => setGrantForm((current) => ({ ...current, decision: event.target.value }))}
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                </SettingsField>
                <SettingsField label="Scope">
                  <select
                    className="mc-next-settings-input"
                    value={grantForm.scope}
                    onChange={(event) =>
                      setGrantForm((current) => ({
                        ...current,
                        scope: event.target.value,
                        scopeRef: event.target.value === "workspace" ? activeWorkspaceId : "",
                      }))
                    }
                  >
                    <option value="global">Global</option>
                    <option value="workspace">Workspace</option>
                    <option value="session">Session</option>
                    <option value="agent">Agent</option>
                    <option value="task">Task</option>
                  </select>
                </SettingsField>
                <SettingsField label="Scope ref">
                  <input
                    className="mc-next-settings-input"
                    value={grantForm.scopeRef}
                    onChange={(event) => setGrantForm((current) => ({ ...current, scopeRef: event.target.value }))}
                    disabled={grantForm.scope === "global"}
                  />
                </SettingsField>
                <SettingsField label="Grant type">
                  <select
                    className="mc-next-settings-input"
                    value={grantForm.grantType}
                    onChange={(event) =>
                      setGrantForm((current) => ({
                        ...current,
                        grantType: event.target.value,
                        expiresAt:
                          event.target.value === "ttl" && !current.expiresAt
                            ? defaultToolGrantExpiry()
                            : current.expiresAt,
                      }))
                    }
                  >
                    <option value="persistent">Persistent</option>
                    <option value="ttl">TTL</option>
                    <option value="one_time">One time</option>
                  </select>
                </SettingsField>
                {grantForm.grantType === "ttl" ? (
                  <SettingsField label="Expires at">
                    <input
                      className="mc-next-settings-input"
                      value={grantForm.expiresAt}
                      onChange={(event) => setGrantForm((current) => ({ ...current, expiresAt: event.target.value }))}
                      placeholder="2099-01-01T00:00:00.000Z"
                    />
                  </SettingsField>
                ) : null}
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <NativeButton variant="default" onClick={() => void handleCreateGrant()}>
                  <Plus size={16} />
                  Create grant
                </NativeButton>
              </SettingsButtonRow>
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title={selectedTool?.toolName ?? "Tool detail"}
            subtitle="Selected catalog entry and tool grants."
          >
            {selectedTool ? (
              <>
                <NativeMetricGrid
                  items={[
                    {
                      label: "Category",
                      value: selectedTool.category || "tool",
                      meta: `${selectedTool.pack} pack · ${selectedTool.riskLevel} risk`,
                    },
                    {
                      label: "Available grants",
                      value: String(
                        (data.grants ?? []).filter(
                          (item) => matchesToolGrant(item, selectedTool.toolName) && isToolGrantAvailable(item),
                        ).length,
                      ),
                      meta: "Active, unexpired matches",
                    },
                  ]}
                />
                <SettingsCodeBlock label="Tool description">
                  {selectedTool.description || "No tool description provided."}
                </SettingsCodeBlock>
              </>
            ) : (
              <SettingsEmptyState label="Choose a tool from the catalog to inspect it." />
            )}
            <SettingsActionList
              items={(data.grants ?? [])
                .filter((item) => (selectedTool ? matchesToolGrant(item, selectedTool.toolName) : true))
                .map((item) => ({
                  id: item.grantId,
                  label: item.toolPattern,
                  description: `${item.scope}${item.scopeRef ? `:${item.scopeRef}` : ""} · ${item.decision} · ${item.grantType}${
                    item.revokedBy ? ` · revoked by ${item.revokedBy}` : ""
                  }`,
                  meta: describeToolGrantAvailability(item),
                  onClick: item.revokedAt ? undefined : () => setPendingRevokeGrantId(item.grantId),
                  actionLabel: item.revokedAt ? "Revoked" : "Revoke",
                }))}
              emptyLabel={selectedTool ? "No tool grants match this catalog entry." : "No tool grants created yet."}
              maxHeight="min(42vh, 24rem)"
            />
          </NativeCard>
        </SettingsGrid>
      ) : null}
      <ConfirmModal
        open={pendingRevokeGrantId !== null}
        danger
        title="Revoke tool grant?"
        message="This tool grant will be revoked. This cannot be undone."
        confirmLabel="Revoke"
        pending={revokePending}
        onCancel={() => setPendingRevokeGrantId(null)}
        onConfirm={() => {
          if (pendingRevokeGrantId !== null) {
            void handleRevokeGrant(pendingRevokeGrantId);
          }
          setPendingRevokeGrantId(null);
        }}
      />
    </SettingsSectionShell>
  );
}
