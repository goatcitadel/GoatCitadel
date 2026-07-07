// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Code2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import type {
  FilesystemReadAccessMode,
  LocalOperatorOverrideRecord,
  LocalOperatorOverrideScope,
  PermissionSurface,
} from "@goatcitadel/contracts";
import {
  activatePermissionProfile,
  archivePermissionProfile,
  createLocalOperatorOverride,
  createPermissionProfile,
  fetchActiveLocalOperatorOverrides,
  fetchAutonomousActivationGrants,
  fetchEffectivePermissionProfile,
  fetchPermissionProfiles,
  fetchSettings,
  revokeAutonomousActivationGrant,
  revokeLocalOperatorOverride,
  updatePermissionProfile,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  type Notice,
  SettingsActionList,
  SettingsButtonRow,
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
import { NativeButton, NativeSelectableList } from "../../primitives";
import {
  createEmptyPermissionProfileDraft,
  createPermissionProfileDraftFromRecord,
  describePermissionProfile,
  describeToolApprovalMode,
  formatDateTime,
  labelForLocalOperatorOverrideScope,
  labelForPermissionProfile,
  normalizeToolApprovalMode,
  permissionProfileDraftToMutation,
  type PermissionProfileEditorDraft,
  resetLocalOperatorOverrideScopeRefForScope,
  resolveLocalOperatorOverrideScopeRef,
  togglePermissionProfileSurface,
  TOOL_APPROVAL_MODE_OPTIONS,
} from "../../SettingsNativePage";

const PERMISSION_SURFACE_OPTIONS = [
  "chat",
  "cowork",
  "code",
  "tools",
  "mcp",
] as const satisfies readonly PermissionSurface[];
const PERMISSION_PROFILE_DEFAULT_SURFACE_OPTIONS = [
  "chat",
  "cowork",
  "code",
  "tools",
  "mcp",
  "all",
] as const satisfies readonly PermissionSurface[];
const LOCAL_OPERATOR_OVERRIDE_SCOPE_OPTIONS = [
  "workspace",
  "session",
  "run",
  "operator",
] as const satisfies readonly LocalOperatorOverrideScope[];
const READ_ACCESS_MODE_OPTIONS = ["", "roots_only", "approval_required", "full_disk"] as const satisfies readonly (
  | FilesystemReadAccessMode
  | ""
)[];

interface EffectivePermissionSurfaceState {
  surface: (typeof PERMISSION_SURFACE_OPTIONS)[number];
  profileId?: string;
  profileLabel?: string;
  approvalMode?: string;
  localOperatorOverrideId?: string;
  localOperatorOverride?: LocalOperatorOverrideRecord;
}

export function PermissionsSection({ activeWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const effectiveLoadsPromise = Promise.all(
      PERMISSION_SURFACE_OPTIONS.map(async (surface) => ({
        surface,
        load: await nativeLoad(
          `Effective ${surface} permission profile`,
          fetchEffectivePermissionProfile({ workspaceId: activeWorkspaceId, surface }),
          {},
        ),
      })),
    );
    const [profiles, effectiveLoads, activeOverrides, autonomyGrants, settings] = await Promise.all([
      nativeLoad("Permission profiles", fetchPermissionProfiles({ workspaceId: activeWorkspaceId }), { items: [] }),
      effectiveLoadsPromise,
      nativeLoad("Active Local Operator Overrides", fetchActiveLocalOperatorOverrides(), { items: [] }),
      nativeLoad("Autonomous activation grants", fetchAutonomousActivationGrants(true), { items: [] }),
      fetchSettings().catch(() => null),
    ]);
    return {
      issues: nativeLoadIssues([profiles, ...effectiveLoads.map((item) => item.load), activeOverrides, autonomyGrants]),
      profiles: profiles.data.items,
      effective: effectiveLoads.map(({ surface, load }) => readEffectivePermissionSurfaceState(surface, load.data)),
      activeOverrides: activeOverrides.data.items,
      autonomyGrants: autonomyGrants.data.items,
      settings,
    };
  }, [activeWorkspaceId]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingRevokeGrantId, setPendingRevokeGrantId] = useState<string | null>(null);
  const [revokePending, setRevokePending] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("safe");
  const [profileDraft, setProfileDraft] = useState<PermissionProfileEditorDraft>(createEmptyPermissionProfileDraft);
  const [profileEditDraft, setProfileEditDraft] = useState<PermissionProfileEditorDraft>(
    createEmptyPermissionProfileDraft,
  );
  const [overrideDraft, setOverrideDraft] = useState({
    scope: "workspace" as LocalOperatorOverrideScope,
    scopeRef: activeWorkspaceId,
    reason: "",
    ttlSeconds: 600,
  });
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [recentLocalOverride, setRecentLocalOverride] = useState<LocalOperatorOverrideRecord | null>(null);
  const selectedProfile =
    data?.profiles?.find((profile) => profile.profileId === selectedProfileId) ?? data?.profiles?.[0];
  const effectiveOverride = data?.effective.find((item) => item.localOperatorOverride)?.localOperatorOverride;
  const activeOverrides = collectActiveLocalOperatorOverrides([
    effectiveOverride,
    ...(data?.activeOverrides ?? []),
    recentLocalOverride,
  ]);
  const primaryActiveOverride = activeOverrides[0];
  const chatEffectiveProfileLabel =
    data?.effective.find((item) => item.surface === "chat")?.profileLabel ?? "Unavailable";
  const settingsUnavailable = !data?.settings;
  const isRemoteHardened = data?.settings?.deploymentProfile === "remote_hardened";
  const promptSkippingProfileRestriction = settingsUnavailable
    ? "Settings could not be loaded, so profiles that skip normal prompts stay unavailable."
    : isRemoteHardened
      ? "Remote Hardened keeps profiles that skip normal prompts unavailable."
      : null;
  const localOperatorOverrideRestriction = settingsUnavailable
    ? "Settings could not be loaded, so Local Operator Override stays unavailable."
    : isRemoteHardened
      ? "Remote Hardened mode keeps Local Operator Override unavailable."
      : null;
  const selectedProfileBypassesPrompts = selectedProfile?.approvalMode === "bypass";
  const activationBlockedByRemoteHardened = Boolean(promptSkippingProfileRestriction && selectedProfileBypassesPrompts);
  const activeAutonomyGrants = (data?.autonomyGrants ?? []).filter((grant) => grant.status === "active");

  useEffect(() => {
    setOverrideDraft((current) =>
      current.scope === "workspace"
        ? {
            ...current,
            scopeRef: activeWorkspaceId,
          }
        : current,
    );
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!data?.profiles?.length) return;
    setSelectedProfileId((current) =>
      data.profiles.some((profile) => profile.profileId === current) ? current : data.profiles[0]!.profileId,
    );
  }, [data?.profiles]);

  useEffect(() => {
    if (effectiveOverride) {
      setRecentLocalOverride(effectiveOverride);
    }
  }, [effectiveOverride]);

  useEffect(() => {
    if (!selectedProfile || selectedProfile.builtin) {
      setProfileEditDraft(createEmptyPermissionProfileDraft());
      return;
    }
    setProfileEditDraft(createPermissionProfileDraftFromRecord(selectedProfile));
  }, [selectedProfile]);

  const handleActivateProfile = async (profileId: string, surface: PermissionSurface) => {
    const profile = data?.profiles?.find((item) => item.profileId === profileId);
    if (promptSkippingProfileRestriction && profile?.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    try {
      await activatePermissionProfile({ profileId, workspaceId: activeWorkspaceId, surface });
      setNotice({ tone: "success", message: `${labelForPermissionProfile(profileId, data?.profiles)} activated.` });
      await reload();
    } catch (activateError) {
      setNotice({ tone: "error", message: getErrorMessage(activateError) });
    }
  };

  const handleCreateProfile = async () => {
    if (!profileDraft.label.trim()) {
      setNotice({ tone: "warning", message: "Profile name is required." });
      return;
    }
    if (promptSkippingProfileRestriction && profileDraft.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    try {
      const created = await createPermissionProfile({
        scope: "workspace",
        scopeRef: activeWorkspaceId,
        ...permissionProfileDraftToMutation(profileDraft),
      });
      setSelectedProfileId(created.profileId);
      setProfileDraft(createEmptyPermissionProfileDraft());
      setNotice({ tone: "success", message: "Permission profile created." });
      await reload();
    } catch (createError) {
      setNotice({ tone: "error", message: getErrorMessage(createError) });
    }
  };

  const handleUpdateSelectedProfile = async () => {
    if (!selectedProfile || selectedProfile.builtin) {
      setNotice({ tone: "warning", message: "Select a custom permission profile to edit." });
      return;
    }
    if (!profileEditDraft.label.trim()) {
      setNotice({ tone: "warning", message: "Profile name is required." });
      return;
    }
    if (promptSkippingProfileRestriction && profileEditDraft.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    try {
      const updated = await updatePermissionProfile(selectedProfile.profileId, {
        ...permissionProfileDraftToMutation(profileEditDraft),
      });
      setSelectedProfileId(updated.profileId);
      setNotice({ tone: "success", message: "Permission profile updated." });
      await reload();
    } catch (updateError) {
      setNotice({ tone: "error", message: getErrorMessage(updateError) });
    }
  };

  const handleArchiveSelectedProfile = async () => {
    if (!selectedProfile || selectedProfile.builtin) {
      setNotice({ tone: "warning", message: "Select a custom permission profile to archive." });
      return;
    }
    if (!window.confirm(`Archive permission profile ${selectedProfile.label}?`)) {
      return;
    }
    try {
      await archivePermissionProfile(selectedProfile.profileId);
      setSelectedProfileId("safe");
      setNotice({ tone: "success", message: "Permission profile archived." });
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    }
  };

  const handleStartOverride = async () => {
    if (localOperatorOverrideRestriction) {
      setNotice({ tone: "warning", message: localOperatorOverrideRestriction });
      return;
    }
    if (!overrideDraft.reason.trim()) {
      setNotice({ tone: "warning", message: "Add a reason before starting Local Operator Override." });
      return;
    }
    const scopeRef = resolveLocalOperatorOverrideScopeRef(
      overrideDraft.scope,
      overrideDraft.scopeRef,
      activeWorkspaceId,
    );
    if (overrideDraft.scope !== "operator" && !scopeRef) {
      setNotice({ tone: "warning", message: "Add a target for this Local Operator Override scope." });
      return;
    }
    if (!overrideAcknowledged) {
      setNotice({
        tone: "warning",
        message:
          "Confirm that this grants broad local tool access, skips normal prompts, and keeps hard safety boundaries in force.",
      });
      return;
    }
    try {
      const override = await createLocalOperatorOverride({
        scope: overrideDraft.scope,
        scopeRef,
        reason: overrideDraft.reason.trim(),
        ttlSeconds: overrideDraft.ttlSeconds,
      });
      setRecentLocalOverride(override);
      setOverrideDraft((current) => ({
        ...current,
        reason: "",
        ttlSeconds: 600,
        scopeRef: current.scope === "workspace" ? activeWorkspaceId : current.scopeRef,
      }));
      setOverrideAcknowledged(false);
      setNotice({
        tone: "warning",
        message: `Local Operator Override ${override.overrideId} is active until ${formatDateTime(override.expiresAt)}.`,
      });
      await reload();
    } catch (overrideError) {
      setNotice({ tone: "error", message: getErrorMessage(overrideError) });
    }
  };

  const handleRevokeOverride = async (overrideId?: string) => {
    if (!overrideId) {
      setNotice({ tone: "warning", message: "No active Local Operator Override to end." });
      return;
    }
    try {
      const revoked = await revokeLocalOperatorOverride(overrideId);
      const revokedAt = revoked.revokedAt ? ` at ${formatDateTime(revoked.revokedAt)}` : "";
      const revokedBy = revoked.revokedBy ? ` by ${revoked.revokedBy}` : "";
      const revokedStatus = revoked.status ? ` (${revoked.status})` : "";
      setRecentLocalOverride((current) => (current?.overrideId === overrideId ? null : current));
      setNotice({
        tone: "success",
        message: `Local Operator Override ${revoked.overrideId} ended${revokedBy}${revokedAt}${revokedStatus}.`,
      });
      await reload();
    } catch (revokeError) {
      setNotice({ tone: "error", message: getErrorMessage(revokeError) });
    }
  };

  const runServerActionForPermissions = async (action: () => Promise<unknown>, successMessage: string) => {
    try {
      await action();
      setNotice({ tone: "success", message: successMessage });
      await reload();
    } catch (actionError) {
      setNotice({ tone: "error", message: getErrorMessage(actionError) });
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
            title="Permission profiles"
            subtitle="Profiles define normal defaults; hard denies, scoped grants, auth, path jails, and disabled capabilities still win."
            stats={[
              { label: "Profiles", value: String(data.profiles?.length ?? 0) },
              { label: "Chat effective", value: chatEffectiveProfileLabel },
            ]}
          >
            <NativeSelectableList
              items={(data.profiles ?? []).map((profile) => ({
                id: profile.profileId,
                title: profile.label,
                meta: profile.builtin ? "Built-in" : profile.scope,
                body: profile.description ?? describePermissionProfile(profile),
              }))}
              selectedId={selectedProfile?.profileId ?? ""}
              onSelect={setSelectedProfileId}
              emptyLabel="No permission profiles returned by the gateway."
              maxHeight="22rem"
            />
          </NativeCard>
          <SettingsStack>
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title={selectedProfile?.label ?? "Profile"}
              subtitle={selectedProfile ? describePermissionProfile(selectedProfile) : "Select a profile to activate."}
              stats={[
                {
                  label: "Approval mode",
                  value: selectedProfile ? describeToolApprovalMode(selectedProfile.approvalMode) : "-",
                },
                { label: "Tool patterns", value: String(selectedProfile?.toolPatterns?.length ?? 0) },
                { label: "Read access", value: describeReadAccessMode(selectedProfile?.readAccessMode ?? "") },
              ]}
            >
              {selectedProfile ? (
                <>
                  <SettingsActionList
                    items={selectedProfile.toolPatterns.map((pattern) => ({
                      label: pattern,
                      description: "Profile tool pattern",
                    }))}
                    emptyLabel="This profile does not add tool patterns."
                  />
                  <SettingsActionList
                    items={[
                      {
                        label: "Allow",
                        description: (selectedProfile.allow ?? []).length
                          ? (selectedProfile.allow ?? []).join(", ")
                          : "No extra allow patterns",
                      },
                      {
                        label: "Deny",
                        description: (selectedProfile.deny ?? []).length
                          ? (selectedProfile.deny ?? []).join(", ")
                          : "No profile deny patterns",
                      },
                      {
                        label: "Default surfaces",
                        description: selectedProfile.defaultForSurfaces?.length
                          ? selectedProfile.defaultForSurfaces.join(", ")
                          : "No automatic surface default",
                      },
                    ]}
                    emptyLabel="No profile policy details."
                  />
                  {activationBlockedByRemoteHardened ? (
                    <p className="mc-next-settings-field-note">{promptSkippingProfileRestriction}</p>
                  ) : null}
                  <SettingsButtonRow>
                    <NativeButton
                      variant="default"
                      disabled={activationBlockedByRemoteHardened}
                      onClick={() => void handleActivateProfile(selectedProfile.profileId, "all")}
                    >
                      <ShieldCheck size={16} />
                      Use for all surfaces
                    </NativeButton>
                    <NativeButton
                      variant="secondary"
                      disabled={activationBlockedByRemoteHardened}
                      onClick={() => void handleActivateProfile(selectedProfile.profileId, "code")}
                    >
                      <Code2 size={16} />
                      Use for Code
                    </NativeButton>
                  </SettingsButtonRow>
                  <SettingsButtonRow>
                    {PERMISSION_SURFACE_OPTIONS.filter((surface) => surface !== "code").map((surface) => (
                      <NativeButton
                        key={surface}
                        variant="secondary"
                        disabled={activationBlockedByRemoteHardened}
                        onClick={() => void handleActivateProfile(selectedProfile.profileId, surface)}
                      >
                        <ShieldCheck size={16} />
                        Use for {surface.toUpperCase()}
                      </NativeButton>
                    ))}
                  </SettingsButtonRow>
                </>
              ) : (
                <SettingsEmptyState label="Select a profile." />
              )}
            </NativeCard>
            {selectedProfile && !selectedProfile.builtin ? (
              <NativeCard
                density="compact"
                className="mc-next-settings-panel"
                title="Edit custom profile"
                subtitle="Update or archive the selected profile."
              >
                <PermissionProfileDraftFields
                  draft={profileEditDraft}
                  bypassUnavailableReason={promptSkippingProfileRestriction ?? undefined}
                  setDraft={setProfileEditDraft}
                />
                <SettingsButtonRow>
                  <NativeButton variant="default" onClick={() => void handleUpdateSelectedProfile()}>
                    <Save size={16} />
                    Save profile
                  </NativeButton>
                  <NativeButton variant="destructive" onClick={() => void handleArchiveSelectedProfile()}>
                    <Trash2 size={16} />
                    Archive profile
                  </NativeButton>
                </SettingsButtonRow>
              </NativeCard>
            ) : null}
            <NativeCard
              density="compact"
              className="mc-next-settings-panel"
              title="Custom profile"
              subtitle="Create a workspace-scoped profile for your own workflow."
            >
              <PermissionProfileDraftFields
                draft={profileDraft}
                bypassUnavailableReason={promptSkippingProfileRestriction ?? undefined}
                setDraft={setProfileDraft}
              />
              <SettingsButtonRow>
                <NativeButton variant="default" onClick={() => void handleCreateProfile()}>
                  <Plus size={16} />
                  Create profile
                </NativeButton>
              </SettingsButtonRow>
            </NativeCard>
          </SettingsStack>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Active defaults"
            subtitle="Effective profile and temporary local override state by surface."
          >
            <SettingsActionList
              items={(data.effective ?? []).map((item) => ({
                label: item.surface.toUpperCase(),
                description: `${item.profileLabel ?? item.profileId ?? "Safe"}${
                  item.approvalMode ? `, ${describeToolApprovalMode(normalizeToolApprovalMode(item.approvalMode))}` : ""
                }${
                  item.localOperatorOverrideId
                    ? `, override ${item.localOperatorOverrideId} until ${formatDateTime(item.localOperatorOverride?.expiresAt)}`
                    : ""
                }`,
              }))}
              emptyLabel="No effective profile state returned."
            />
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Local Operator Override"
            subtitle={
              isRemoteHardened
                ? "Remote Hardened mode keeps Local Operator Override unavailable."
                : settingsUnavailable
                  ? "Settings could not be loaded, so Local Operator Override stays unavailable."
                  : "A time-boxed local action that skips normal prompts and grants broad local tool access for the selected scope. Deny rules, auth, path jails, network blocks, disabled capabilities, and Code Mode policy and artifact checks remain enforced."
            }
            stats={[
              { label: "Status", value: activeOverrides.length ? `${activeOverrides.length} active` : "Inactive" },
              {
                label: "Next expiry",
                value: primaryActiveOverride ? formatDateTime(primaryActiveOverride.expiresAt) : "-",
              },
            ]}
          >
            {activeOverrides.length ? (
              <SettingsActionList
                items={activeOverrides.map((override) => ({
                  label: override.overrideId,
                  description: `${override.reason} · started by ${override.createdBy} · operator ${override.operatorId}`,
                  meta: `${override.scope}${override.scopeRef ? ` · ${override.scopeRef}` : ""} · expires ${formatDateTime(override.expiresAt)}`,
                  onClick: () => void handleRevokeOverride(override.overrideId),
                  actionLabel: "End",
                }))}
                emptyLabel="No active override evidence."
              />
            ) : null}
            <SettingsField label="Reason">
              <textarea
                className="mc-next-settings-input"
                value={overrideDraft.reason}
                onChange={(event) => setOverrideDraft((current) => ({ ...current, reason: event.target.value }))}
                rows={4}
                placeholder="Why this local run needs temporary fast-path execution"
              />
            </SettingsField>
            <SettingsField label="Scope">
              <select
                className="mc-next-settings-input"
                value={overrideDraft.scope}
                onChange={(event) =>
                  setOverrideDraft((current) => {
                    const scope = event.target.value as LocalOperatorOverrideScope;
                    return {
                      ...current,
                      scope,
                      scopeRef: resetLocalOperatorOverrideScopeRefForScope(scope, activeWorkspaceId),
                    };
                  })
                }
              >
                {LOCAL_OPERATOR_OVERRIDE_SCOPE_OPTIONS.map((scope) => (
                  <option key={scope} value={scope}>
                    {labelForLocalOperatorOverrideScope(scope)}
                  </option>
                ))}
              </select>
            </SettingsField>
            {overrideDraft.scope !== "operator" ? (
              <SettingsField label={overrideDraft.scope === "workspace" ? "Workspace" : "Target id"}>
                <input
                  className="mc-next-settings-input"
                  value={overrideDraft.scope === "workspace" ? activeWorkspaceId : (overrideDraft.scopeRef ?? "")}
                  onChange={(event) => setOverrideDraft((current) => ({ ...current, scopeRef: event.target.value }))}
                  disabled={overrideDraft.scope === "workspace"}
                  placeholder={overrideDraft.scope === "session" ? "session id" : "run id"}
                />
              </SettingsField>
            ) : null}
            <SettingsField label="Duration">
              <select
                className="mc-next-settings-input"
                value={overrideDraft.ttlSeconds}
                onChange={(event) =>
                  setOverrideDraft((current) => ({ ...current, ttlSeconds: Number(event.target.value) }))
                }
              >
                <option value={300}>5 minutes</option>
                <option value={600}>10 minutes</option>
                <option value={1800}>30 minutes</option>
                <option value={3600}>60 minutes</option>
              </select>
            </SettingsField>
            <label className="mc-next-settings-check">
              <input
                type="checkbox"
                checked={overrideAcknowledged}
                onChange={(event) => setOverrideAcknowledged(event.target.checked)}
                disabled={Boolean(localOperatorOverrideRestriction)}
              />
              <span>
                I understand this grants broad local tool access and skips normal prompts for the selected scope. Deny
                rules, auth, path, network, disabled-capability, Code Mode policy, and artifact checks still apply.
              </span>
            </label>
            <SettingsButtonRow>
              <NativeButton
                variant="destructive"
                disabled={Boolean(localOperatorOverrideRestriction) || !overrideAcknowledged}
                onClick={() => void handleStartOverride()}
              >
                <AlertTriangle size={16} />
                Start temporary override
              </NativeButton>
            </SettingsButtonRow>
          </NativeCard>
          <NativeCard
            density="compact"
            className="mc-next-settings-panel"
            title="Autonomous activation grants"
            subtitle="Expiring operator grants that may permit agentic activation after policy, auth, path, provenance, and health checks still pass."
            stats={[
              { label: "Active", value: String(activeAutonomyGrants.length) },
              { label: "Total", value: String(data.autonomyGrants?.length ?? 0) },
            ]}
          >
            <SettingsActionList
              items={(data.autonomyGrants ?? []).map((grant) => ({
                label: grant.grantId,
                description: `${grant.workspaceId} · ${grant.surfaces.join(", ")} · ${grant.activationKinds.join(", ")} · ${grant.reason}`,
                meta: `${grant.status} · max ${grant.maxRiskLevel} · ${grant.usedActivations}/${grant.maxActivations ?? "unlimited"} used · expires ${formatDateTime(grant.expiresAt)}`,
                onClick: grant.status === "active" ? () => setPendingRevokeGrantId(grant.grantId) : undefined,
                actionLabel: grant.status === "active" ? "Revoke" : undefined,
              }))}
              emptyLabel="No autonomous activation grants recorded."
            />
          </NativeCard>
        </SettingsGrid>
      ) : null}
      <ConfirmModal
        open={pendingRevokeGrantId !== null}
        danger
        title="Revoke autonomous activation grant?"
        message="This grant will no longer permit agentic activation. This cannot be undone."
        confirmLabel="Revoke"
        pending={revokePending}
        onCancel={() => setPendingRevokeGrantId(null)}
        onConfirm={() => {
          const grantId = pendingRevokeGrantId;
          setPendingRevokeGrantId(null);
          if (grantId === null) {
            return;
          }
          setRevokePending(true);
          void runServerActionForPermissions(async () => {
            await revokeAutonomousActivationGrant(grantId, {
              revokedBy: "operator",
              reason: "Revoked from Settings.",
            });
          }, "Autonomous activation grant revoked.").finally(() => setRevokePending(false));
        }}
      />
    </SettingsSectionShell>
  );
}

function PermissionProfileDraftFields({
  draft,
  bypassUnavailableReason,
  setDraft,
}: {
  draft: PermissionProfileEditorDraft;
  bypassUnavailableReason?: string;
  setDraft: Dispatch<SetStateAction<PermissionProfileEditorDraft>>;
}) {
  const bypassUnavailable = Boolean(bypassUnavailableReason);
  return (
    <SettingsFieldGrid>
      <SettingsField label="Name">
        <input
          className="mc-next-settings-input"
          value={draft.label}
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
          placeholder="Review mode, research mode, release captain"
        />
      </SettingsField>
      <SettingsField label="Approval behavior">
        <select
          className="mc-next-settings-input"
          value={draft.approvalMode}
          onChange={(event) => {
            const nextMode = normalizeToolApprovalMode(event.target.value);
            if (bypassUnavailable && nextMode === "bypass") {
              return;
            }
            setDraft((current) => ({
              ...current,
              approvalMode: nextMode,
            }));
          }}
        >
          {TOOL_APPROVAL_MODE_OPTIONS.map((mode) => (
            <option key={mode} value={mode} disabled={bypassUnavailable && mode === "bypass"}>
              {bypassUnavailable && mode === "bypass"
                ? `${describeToolApprovalMode(mode)} (unavailable)`
                : describeToolApprovalMode(mode)}
            </option>
          ))}
        </select>
        {bypassUnavailableReason ? <p className="mc-next-settings-field-note">{bypassUnavailableReason}</p> : null}
      </SettingsField>
      <SettingsField label="Description" span={2}>
        <textarea
          className="mc-next-settings-input"
          value={draft.description}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
          rows={3}
          placeholder="Why this profile exists and when to use it"
        />
      </SettingsField>
      <SettingsField label="Read access">
        <select
          className="mc-next-settings-input"
          value={draft.readAccessMode}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              readAccessMode: event.target.value as FilesystemReadAccessMode | "",
            }))
          }
        >
          {READ_ACCESS_MODE_OPTIONS.map((mode) => (
            <option key={mode || "default"} value={mode}>
              {describeReadAccessMode(mode)}
            </option>
          ))}
        </select>
      </SettingsField>
      <SettingsField label="Default surfaces">
        {PERMISSION_PROFILE_DEFAULT_SURFACE_OPTIONS.map((surface) => (
          <label key={surface} className="mc-next-settings-toggle">
            <input
              type="checkbox"
              checked={draft.defaultForSurfaces.includes(surface)}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  defaultForSurfaces: togglePermissionProfileSurface(
                    current.defaultForSurfaces,
                    surface,
                    event.target.checked,
                  ),
                }))
              }
            />
            <span>{surface.toUpperCase()}</span>
          </label>
        ))}
      </SettingsField>
      <SettingsField label="Tool patterns" span={2}>
        <textarea
          className="mc-next-settings-input"
          value={draft.toolPatterns}
          onChange={(event) => setDraft((current) => ({ ...current, toolPatterns: event.target.value }))}
          rows={5}
          placeholder={"session.status\nmemory.read"}
        />
      </SettingsField>
      <SettingsField label="Allow patterns">
        <textarea
          className="mc-next-settings-input"
          value={draft.allow}
          onChange={(event) => setDraft((current) => ({ ...current, allow: event.target.value }))}
          rows={4}
          placeholder="Optional allow patterns"
        />
      </SettingsField>
      <SettingsField label="Deny patterns">
        <textarea
          className="mc-next-settings-input"
          value={draft.deny}
          onChange={(event) => setDraft((current) => ({ ...current, deny: event.target.value }))}
          rows={4}
          placeholder="Optional deny patterns"
        />
      </SettingsField>
    </SettingsFieldGrid>
  );
}

function describeReadAccessMode(mode: FilesystemReadAccessMode | "") {
  switch (mode) {
    case "roots_only":
      return "Workspace roots only";
    case "approval_required":
      return "Ask before broader reads";
    case "full_disk":
      return "Full local disk reads";
    default:
      return "Global default";
  }
}

function readEffectivePermissionSurfaceState(
  surface: EffectivePermissionSurfaceState["surface"],
  context: Record<string, unknown>,
): EffectivePermissionSurfaceState {
  const profile = isRecord(context.permissionProfile) ? context.permissionProfile : undefined;
  const override = readLocalOperatorOverride(context.localOperatorOverride);
  return {
    surface,
    profileId: readString(context.permissionProfileId) ?? readString(profile?.profileId),
    profileLabel: readString(context.permissionProfileLabel) ?? readString(profile?.label),
    approvalMode: readString(context.permissionProfileApprovalMode) ?? readString(profile?.approvalMode),
    localOperatorOverrideId: readString(context.localOperatorOverrideId) ?? override?.overrideId,
    localOperatorOverride: override,
  };
}

function readLocalOperatorOverride(value: unknown): LocalOperatorOverrideRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const overrideId = readString(record.overrideId);
  const operatorId = readString(record.operatorId);
  const reason = readString(record.reason);
  const createdAt = readString(record.createdAt);
  const expiresAt = readString(record.expiresAt);
  if (!overrideId || !operatorId || !reason || !createdAt || !expiresAt) {
    return undefined;
  }
  return {
    overrideId,
    operatorId,
    scope: (readString(record.scope) as LocalOperatorOverrideRecord["scope"] | undefined) ?? "workspace",
    scopeRef: readString(record.scopeRef),
    reason,
    status: (readString(record.status) as LocalOperatorOverrideRecord["status"] | undefined) ?? "active",
    createdBy: readString(record.createdBy) ?? operatorId,
    createdAt,
    expiresAt,
    revokedAt: readString(record.revokedAt),
    revokedBy: readString(record.revokedBy),
  };
}

function isActiveLocalOperatorOverride(
  override: LocalOperatorOverrideRecord | null | undefined,
): override is LocalOperatorOverrideRecord {
  if (!override || override.status !== "active" || override.revokedAt) {
    return false;
  }
  const expiresAtMs = Date.parse(override.expiresAt);
  return Number.isFinite(expiresAtMs) ? expiresAtMs > Date.now() : true;
}

function collectActiveLocalOperatorOverrides(
  overrides: Array<LocalOperatorOverrideRecord | null | undefined>,
): LocalOperatorOverrideRecord[] {
  const seen = new Set<string>();
  return overrides
    .filter(isActiveLocalOperatorOverride)
    .filter((override) => {
      if (seen.has(override.overrideId)) {
        return false;
      }
      seen.add(override.overrideId);
      return true;
    })
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
