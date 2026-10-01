import { GatewayAuthEditor } from "../GatewayAuthEditor";
import { deviceGrantCanBeRevoked, useDeviceAccessRevocation } from "../use-device-access-revocation";
// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useMemo } from "react";
import {
  fetchDaemonStatus,
  fetchDeviceAccessGrants,
  fetchSettings,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  nativeLoad,
  nativeLoadIssues,
  SettingsActionList,
  SettingsButtonRow,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeMetricGrid } from "../../primitives";
import { deriveDesktopMobileContinuityItems } from "../helpers/provider-format";
import { formatDateTime } from "../helpers/input-format";

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
  const deviceRevocation = useDeviceAccessRevocation();
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

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {deviceRevocation.notice ? <SettingsNotice notice={deviceRevocation.notice} /> : null}
      {data ? (
        <SettingsStack>
          <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
          <p className="mc-next-settings-field-note">Workspace: {activeWorkspaceName}. Authentication is installation-wide.</p>
          <GatewayAuthEditor settings={data.settings} available={!loading && !error} reload={reload}
            onReviewApproval={approvalId => navigate({ area: "ops", section: "approvals", approvalId, theme: route.theme })} />
          <SettingsButtonRow><NativeButton variant="outline" onClick={() => void reload()}>Refresh devices</NativeButton></SettingsButtonRow>
          <SettingsStack>
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
                onClick: !deviceGrantCanBeRevoked(grant) || deviceRevocation.attemptFor(grant.grantId) ? undefined : () => deviceRevocation.review(grant),
                actionLabel: deviceRevocation.attemptFor(grant.grantId)?.message ?? (grant.revokedAt ? "Revoked" : "Revoke"),
              }))}
              emptyLabel="No device grants found."
            />
          </NativeCard>
        </SettingsStack>
      ) : null}
      <ConfirmModal
        open={deviceRevocation.reviewed !== null}
        danger
        title="Revoke device access?"
        message={`Revoke Gateway access for ${deviceRevocation.reviewed?.deviceLabel || "this device"}? Its companion sessions and session controls will also be revoked. This can disconnect the current device. A new approval is needed to regain access.`}
        confirmLabel="Revoke"
        pending={deviceRevocation.pending}
        onCancel={deviceRevocation.cancel}
        onConfirm={() => {
          void deviceRevocation.confirm().then((revoked) => { if (revoked) void reload(); });
        }}
      />
    </SettingsSectionShell>
  );
}
