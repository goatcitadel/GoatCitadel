// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import {
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchSettings,
  patchSettings,
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
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { deriveDesktopMobileContinuityItems, formatDateTime } from "../../SettingsNativePage";

export function AccessSection({ activeWorkspaceName }: SettingsSectionProps) {
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
  const [form, setForm] = useState({
    mode: "none",
    allowLoopbackBypass: false,
    token: "",
    basicUsername: "",
    basicPassword: "",
  });
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
    if (!data) {
      return;
    }
    setForm({
      mode: data.settings.auth?.mode ?? "none",
      allowLoopbackBypass: data.settings.auth?.allowLoopbackBypass ?? false,
      token: "",
      basicUsername: "",
      basicPassword: "",
    });
  }, [data]);

  const handleSave = async () => {
    try {
      await patchSettings({
        auth: {
          mode: form.mode as "none" | "token" | "basic",
          allowLoopbackBypass: form.allowLoopbackBypass,
          token: form.token.trim() || undefined,
          basicUsername: form.basicUsername.trim() || undefined,
          basicPassword: form.basicPassword.trim() || undefined,
        },
      });
      setNotice({ tone: "success", message: "Access posture updated." });
      setForm((current) => ({
        ...current,
        token: "",
        basicUsername: "",
        basicPassword: "",
      }));
      await reload();
    } catch (saveError) {
      setNotice({ tone: "error", message: getErrorMessage(saveError) });
    }
  };

  const handleGenerateInstallToken = async () => {
    try {
      const result = await resolveGatewayInstallToken({
        generateWhenMissing: true,
        persistToEnv: false,
      });
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
    <SettingsSectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
      {data ? (
        <SettingsGrid variant="detail-wide">
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <SettingsStack>
            <NativeCard
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
                  items={(data.settings.auth?.plan?.warnings ?? []).map((warning) => ({
                    label: "Auth warning",
                    description: warning,
                    tone: "warning",
                  }))}
                />
              ) : null}
              <SettingsFieldGrid>
                <SettingsField label="Auth mode">
                  <select
                    className="mc-next-settings-input"
                    value={form.mode}
                    onChange={(event) => setForm((current) => ({ ...current, mode: event.target.value }))}
                  >
                    <option value="none">None</option>
                    <option value="token">Token</option>
                    <option value="basic">Basic</option>
                  </select>
                </SettingsField>
                <SettingsField label="Loopback bypass">
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
                    placeholder="Only enter a new token when rotating credentials"
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
                <NativeButton variant="default" onClick={() => void handleSave()}>
                  <Save size={16} />
                  Save access settings
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => void handleGenerateInstallToken()}>
                  <RefreshCw size={16} />
                  Generate install token
                </NativeButton>
              </SettingsButtonRow>
              {installToken ? (
                <SettingsCodeBlock label="Install token preview">{installToken}</SettingsCodeBlock>
              ) : null}
            </NativeCard>
            <NativeCard
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
            </NativeCard>
            <NativeCard
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
                items={continuityItems.map((item) => ({
                  id: item.id,
                  label: item.label,
                  description: item.description,
                  meta: item.meta,
                  actionLabel: item.actionLabel,
                }))}
                maxHeight="min(36vh, 22rem)"
              />
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Approved devices"
            subtitle="View and revoke device grants that can access the gateway."
            stats={[{ label: "Grants", value: String(data.grants?.length ?? 0) }]}
          >
            <SettingsActionList
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
        </SettingsGrid>
      ) : null}
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
