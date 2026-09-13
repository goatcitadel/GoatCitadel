import { SettingsChangeStatus, useSettingsChange } from "../use-settings-change";
import { useSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { FocusedDetail } from "../../shared/FocusedDetail";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import {
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchSettings,
  isApiRequestError,
  patchGatewayAuthSettings,
  resolveGatewayInstallToken,
  revokeDeviceAccessGrant,
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
  SettingsField,
  SettingsFieldGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { deriveDesktopMobileContinuityItems, formatDateTime } from "../../SettingsNativePage";

export function AccessSection({ activeWorkspaceName, route, navigate }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const [settings, grants, daemon] = await Promise.all([
      fetchSettings(),
      nativeLoad("Device grants", fetchDeviceAccessGrants("all"), { items: [] }),
      nativeLoad("Daemon status", fetchDaemonStatus(), null),
    ]);
    return {
      settings,
      issues: nativeLoadIssues([grants, daemon]),
      grants: grants.data.items,
      daemon: daemon.data,
    };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingRevokeGrantId, setPendingRevokeGrantId] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const tokenGeneration = useRef(0);
  const leave = useDraftLeave();
  const canonical = { mode: data?.settings.auth?.mode ?? "none", allowLoopbackBypass: data?.settings.auth?.allowLoopbackBypass ?? false, token: "", basicUsername: "", basicPassword: "" };
  const editor = useSessionDraft("access:system:auth", canonical, data?.settings.revision, { label: "Gateway access", active: editing, available: Boolean(data?.settings), onSave: () => handleSave() });
  const accessChange = useSettingsChange({ key: editor.key, operation: "gateway_auth_configuration", matches: (settings, submitted: typeof editor.value) => settings.auth?.mode === submitted.mode && settings.auth?.allowLoopbackBypass === submitted.allowLoopbackBypass && (submitted.mode !== "token" || settings.auth.tokenConfigured) && (submitted.mode !== "basic" || settings.auth.basicConfigured), savedValue: (submitted) => ({ ...submitted, token: "", basicUsername: "", basicPassword: "" }), acceptSaved: editor.acceptSaved, reload });
  const form = editor.value;
  const setForm = editor.setValue;
  const closeEditor = () => leave.request(() => { setEditing(false); tokenGeneration.current += 1; setInstallToken(""); }, [editor.key]);
  const [installToken, setInstallToken] = useState<string>("");
  const continuityItems = useMemo(
    () =>
      data
        ? deriveDesktopMobileContinuityItems({
            settings: data.settings,
            grants: data.grants ?? [],
            daemon: data.daemon,
          })
        : [],
    [data],
  );

  useEffect(() => {
    if (!installToken) return;
    const timeout = globalThis.setTimeout(() => setInstallToken(""), 30_000);
    return () => globalThis.clearTimeout(timeout);
  }, [installToken]);
  useEffect(() => () => { tokenGeneration.current += 1; }, []);

  const handleSave = async (): Promise<boolean> => {
    if (accessChange.isPending()) { await accessChange.refresh(); return false; }
    if (savingRef.current) return false;
    if (editor.hasRemoteChanges) { setNotice({ tone: "warning", message: "Review the current access mode before applying your draft." }); return false; }
    if (!data) {
      setNotice({ tone: "warning", message: "Reload settings before saving access changes." });
      return false;
    }
    const submitted = form;
    savingRef.current = true; setSaving(true);
    try {
      const updated = await patchGatewayAuthSettings({
        expectedRevision: Number(editor.baseRevision ?? data.settings.revision),
        mode: form.mode as "none" | "token" | "basic",
        allowLoopbackBypass: form.allowLoopbackBypass,
        token: form.token.trim() || undefined,
        basicUsername: form.basicUsername.trim() || undefined,
        basicPassword: form.basicPassword.trim() || undefined,
      });
      const clean = accessChange.receive({ ...data.settings, auth: updated, revision: updated.revision, changePlanReceipt: updated.changePlanReceipt }, submitted, Number(editor.baseRevision ?? data.settings.revision));
      if (clean) setNotice({ tone: "success", message: "Access posture updated." });
      await reload();
      return clean;
    } catch (saveError) {
      if (isApiRequestError(saveError) && saveError.status === 409) {
        await reload();
        setNotice({
          tone: "warning",
          message:
            "Access settings changed elsewhere. Your draft is preserved; review the current settings, then save again to retry.",
        });
        return false;
      }
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };

  const handleGenerateInstallToken = async () => {
    const generation = ++tokenGeneration.current;
    try {
      const result = await resolveGatewayInstallToken({
        generateWhenMissing: true,
        persistToEnv: false,
      });
      if (tokenGeneration.current !== generation) return;
      setInstallToken(result.token ?? "");
      setNotice({ tone: "success", message: `Install token resolved from ${result.source}.` });
    } catch (tokenError) {
      setNotice({ tone: "error", message: getErrorMessage(tokenError) });
    }
  };

  const handleRevokeGrant = async (grantId: string) => {
    setRevokePending(true);
    try {
      await revokeDeviceAccessGrant(grantId);
      setNotice({ tone: "success", message: "Device access revoked." });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    } finally {
      setRevokePending(false);
    }
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      <SettingsChangeStatus change={accessChange.change} onRefresh={accessChange.refresh} navigate={navigate} route={route} />
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <p className="mc-next-settings-field-note">Gateway access: {data.settings.auth?.mode ?? "Unavailable"} · Workspace: {activeWorkspaceName}</p>
                        {data.settings.auth?.plan?.warnings?.length ? (
                <SettingsActionList
                  ariaLabel="Gateway access warnings"
                  items={(data.settings.auth?.plan?.warnings ?? []).map((warning) => ({
                    label: "Auth warning",
                    description: warning,
                    tone: "warning",
                  }))}
                />
              ) : null}

          {data.settings.auth?.allowLoopbackBypass ? <p role="status">Loopback bypass is enabled. Local requests may access the Gateway without full authentication.</p> : null}
          <SettingsButtonRow><NativeButton onClick={() => setEditing(true)}>Configure access{editor.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="outline" onClick={() => void reload()}>Refresh devices</NativeButton></SettingsButtonRow>
          <SettingsStack>
            {editing ? <FocusedDetail title="Configure Gateway access" onClose={closeEditor}><NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Gateway access"
              subtitle="Change auth mode, loopback behavior, and optional credentials."
              stats={[
                { label: "Current mode", value: data.settings.auth?.mode ?? "unknown" },
                { label: "Workspace", value: activeWorkspaceName },
              ]}
            >
              {data.settings.auth?.plan?.warnings?.length ? (
                <SettingsActionList
                  ariaLabel="Gateway access warnings"
                  items={(data.settings.auth?.plan?.warnings ?? []).map((warning) => ({
                    label: "Auth warning",
                    description: warning,
                    tone: "warning",
                  }))}
                />
              ) : null}
              {editor.hasRemoteChanges ? <div role="status"><p>Current saved mode: {data.settings.auth?.mode ?? "Unavailable"}; loopback bypass: {data.settings.auth?.allowLoopbackBypass ? "enabled" : "disabled"}. Your draft is preserved.</p><NativeButton variant="outline" onClick={editor.rebaseToCurrent}>Apply draft to current access</NativeButton></div> : null}
              <SettingsFieldGrid>
                <SettingsField label="Auth mode">
                  <select
                    className="mc-next-settings-input"
                    value={form.mode}
                    onChange={(event) => setForm((current) => ({ ...current, mode: event.target.value as typeof current.mode }))}
                  >
                    <option value="none">None</option>
                    <option value="token">Token</option>
                    <option value="basic">Basic</option>
                  </select>
                </SettingsField>
                <SettingsField label="Loopback bypass" group>
                  <label className="mc-next-settings-toggle">
                    <input
                      type="checkbox"
                      checked={form.allowLoopbackBypass}
                      onChange={(event) =>
                        setForm((current) => ({ ...current, allowLoopbackBypass: event.target.checked }))
                      }
                    />
                    <span>Allow local loopback sessions without full auth.</span>
                  </label>
                  <SettingsNotice
                    notice={{
                      tone: "warning",
                      message:
                        "Leave this off unless this is trusted single-machine development and every local process may reach the gateway without normal auth.",
                    }}
                  />
                </SettingsField>
                <SettingsField label="Token">
                  <input
                    className="mc-next-settings-input"
                    type="password"
                    value={form.token}
                    placeholder="New token (only when rotating)"
                    onChange={(event) => setForm((current) => ({ ...current, token: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Basic username">
                  <input
                    className="mc-next-settings-input"
                    value={form.basicUsername}
                    placeholder="Optional"
                    onChange={(event) => setForm((current) => ({ ...current, basicUsername: event.target.value }))}
                  />
                </SettingsField>
                <SettingsField label="Basic password">
                  <input
                    className="mc-next-settings-input"
                    type="password"
                    value={form.basicPassword}
                    placeholder="Optional"
                    onChange={(event) => setForm((current) => ({ ...current, basicPassword: event.target.value }))}
                  />
                </SettingsField>
              </SettingsFieldGrid>
              <SettingsButtonRow>
                <NativeButton variant="default" disabled={saving || accessChange.hasPending || editor.hasRemoteChanges} onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save access settings
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void handleGenerateInstallToken()}>
                  <RefreshCw size={16} />
                  Generate install token
                </NativeButton>
              </SettingsButtonRow>
              {installToken ? (
                <div><SettingsCodeBlock label="Install token preview">{installToken}</SettingsCodeBlock><NativeButton variant="ghost" onClick={() => { tokenGeneration.current += 1; setInstallToken(""); }}>Hide token</NativeButton><p className="mc-next-settings-field-note">Preview clears after 30 seconds or when this editor closes.</p></div>
              ) : null}
            </NativeCard></FocusedDetail> : null}
            <NativeDisclosureCard id="access-transport" title="Transport and credential posture"><NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Current posture"
              subtitle="Readable auth state instead of a recycled general page."
            >
              <NativeMetricGrid
                items={[
                  {
                    label: "Loopback bypass",
                    value: data.settings.auth?.allowLoopbackBypass ? "Enabled" : "Disabled",
                    meta:
                      data.settings.auth?.tokenConfigured || data.settings.auth?.basicConfigured
                        ? "Protected mode configured"
                        : "No persisted credentials",
                  },
                  {
                    label: "Token auth",
                    value: data.settings.auth?.tokenConfigured ? "Configured" : "Missing",
                    meta: "Operator token presence",
                  },
                  {
                    label: "Basic auth",
                    value: data.settings.auth?.basicConfigured ? "Configured" : "Missing",
                    meta: "Username/password presence",
                  },
                ]}
              />
            </NativeCard></NativeDisclosureCard>
            <NativeDisclosureCard id="access-continuity" title="Desktop/mobile continuity"><NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Desktop/mobile continuity"
              subtitle="Trusted devices, desktop runtime state, and companion handoff boundaries."
              stats={[
                { label: "Desktop", value: data.daemon?.state ?? "unknown" },
                {
                  label: "Active devices",
                  value: String((data.grants ?? []).filter((grant) => !grant.revokedAt).length),
                },
              ]}
            >
              <SettingsActionList
                ariaLabel="Desktop and mobile continuity checks"
                items={continuityItems.map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.description,
                  meta: item.meta,
                  actionLabel: item.actionLabel,
                }))}
                maxHeight="min(36vh, 22rem)"
              />
            </NativeCard></NativeDisclosureCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Approved devices"
            subtitle="View and revoke device grants that can access the gateway."
            stats={[{ label: "Grants", value: String(data.grants?.length ?? 0) }]}
          >
            <SettingsActionList
              ariaLabel="Approved device grants"
              items={(data.grants ?? []).map((grant) => ({
                id: grant.grantId,
                label: grant.deviceLabel || grant.grantId,
                description: `${grant.deviceType || "device"} · ${grant.revokedAt ? "revoked" : "active"} · ${formatDateTime(grant.createdAt)}`,
                meta:
                  (typeof grant.metadata.origin === "string" ? grant.metadata.origin : undefined) ||
                  grant.platform ||
                  "Unknown origin",
                onClick: grant.revokedAt ? undefined : () => setPendingRevokeGrantId(grant.grantId),
                actionLabel: grant.revokedAt ? "Revoked" : "Revoke",
              }))}
              emptyLabel="No device grants found."
            />
          </NativeCard>
        </SettingsStack>
      ) : null}
      {leave.dialog}
      <ConfirmModal
        open={pendingRevokeGrantId !== null}
        danger
        title="Revoke device access?"
        message="This device will lose gateway access. This cannot be undone."
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
