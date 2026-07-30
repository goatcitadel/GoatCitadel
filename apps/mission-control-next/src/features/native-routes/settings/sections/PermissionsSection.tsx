// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Code2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import type {
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
  SettingsGrid,
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard, NativeSectionIndex } from "../../NativeRoutePageLayout";
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
} from "../../SettingsNativePage";
import {
  describeReadAccessMode,
  EFFECTIVE_PERMISSION_CONTEXTS,
  formatPermissionContextLabel,
  formatPermissionContextList,
  hasLegacyOnlyPermissionContexts,
  isLegacyPermissionContext,
  isPrimaryPermissionContext,
  LEGACY_PERMISSION_CONTEXTS,
  PERMISSION_CONTEXT_PRESENTATION,
  PermissionProfileDraftFields,
  PRIMARY_PERMISSION_CONTEXTS,
} from "./PermissionProfileDraftFields";

const LOCAL_OPERATOR_OVERRIDE_SCOPE_OPTIONS = [
  "workspace",
  "session",
  "run",
  "operator",
] as const satisfies readonly LocalOperatorOverrideScope[];

interface EffectivePermissionSurfaceState {
  surface: (typeof EFFECTIVE_PERMISSION_CONTEXTS)[number];
  profileId?: string;
  profileLabel?: string;
  approvalMode?: string;
  localOperatorOverrideId?: string;
  localOperatorOverride?: LocalOperatorOverrideRecord;
}

export function PermissionsSection({ activeWorkspaceId }: SettingsSectionProps) {
  const load = useCallback(async () => {
    const effectiveLoadsPromise = Promise.all(
      EFFECTIVE_PERMISSION_CONTEXTS.map(async (surface) => ({
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
  const [pendingArchiveProfile, setPendingArchiveProfile] = useState<{ profileId: string; label: string } | null>(null);
  const [archiveProfilePending, setArchiveProfilePending] = useState(false);
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
  const primaryEffectiveContexts = (data?.effective ?? []).filter((item) => isPrimaryPermissionContext(item.surface));
  const legacyEffectiveContexts = (data?.effective ?? []).filter((item) => isLegacyPermissionContext(item.surface));

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
    if (!pendingArchiveProfile) {
      return;
    }
    setArchiveProfilePending(true);
    try {
      await archivePermissionProfile(pendingArchiveProfile.profileId);
      setSelectedProfileId("safe");
      setNotice({ tone: "success", message: "Permission profile archived." });
      setPendingArchiveProfile(null);
      await reload();
    } catch (archiveError) {
      setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    } finally {
      setArchiveProfilePending(false);
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
        <>
          <NativeSectionIndex
            items={[
              { id: "permissions-profiles", label: "Profiles" },
              { id: "permissions-effective", label: "Core grants" },
              { id: "permissions-override", label: "Local override" },
              { id: "permissions-autonomy", label: "Autonomous grants" },
            ]}
          />
          <SettingsGrid variant="three-column">
            <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
            <NativeCard
              id="permissions-profiles"
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
                subtitle={
                  selectedProfile ? describePermissionProfile(selectedProfile) : "Select a profile to activate."
                }
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
                      ariaLabel={`${selectedProfile.label} tool patterns`}
                      items={selectedProfile.toolPatterns.map((pattern) => ({
                        label: pattern,
                        description: "Profile tool pattern",
                      }))}
                      emptyLabel="This profile does not add tool patterns."
                    />
                    <SettingsActionList
                      ariaLabel={`${selectedProfile.label} policy details`}
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
                          label: "Default policy contexts",
                          description: selectedProfile.defaultForSurfaces?.length
                            ? formatPermissionContextList(selectedProfile.defaultForSurfaces)
                            : "No automatic policy-context default",
                        },
                      ]}
                      emptyLabel="No profile policy details."
                    />
                    {activationBlockedByRemoteHardened ? (
                      <p className="mc-next-settings-field-note">{promptSkippingProfileRestriction}</p>
                    ) : null}
                    {hasLegacyOnlyPermissionContexts(selectedProfile.defaultForSurfaces) ? (
                      <p className="mc-next-settings-field-note" role="status">
                        Compatibility warning: this profile defaults only to legacy policy keys and does not govern
                        current Chat. Add Chat or All policy contexts if intended; GoatCitadel has not broadened it
                        automatically.
                      </p>
                    ) : null}
                    <SettingsButtonRow>
                      <NativeButton
                        variant="default"
                        disabled={activationBlockedByRemoteHardened}
                        onClick={() => void handleActivateProfile(selectedProfile.profileId, "chat")}
                      >
                        <ShieldCheck size={16} />
                        Use for Chat
                      </NativeButton>
                      <NativeButton
                        variant="secondary"
                        disabled={activationBlockedByRemoteHardened}
                        onClick={() => void handleActivateProfile(selectedProfile.profileId, "all")}
                      >
                        <ShieldCheck size={16} />
                        Use across all policy contexts
                      </NativeButton>
                    </SettingsButtonRow>
                    <SettingsButtonRow>
                      {PRIMARY_PERMISSION_CONTEXTS.filter((surface) => surface !== "chat").map((surface) => (
                        <NativeButton
                          key={surface}
                          variant="secondary"
                          disabled={activationBlockedByRemoteHardened}
                          onClick={() => void handleActivateProfile(selectedProfile.profileId, surface)}
                        >
                          <ShieldCheck size={16} />
                          Use for {formatPermissionContextLabel(surface)}
                        </NativeButton>
                      ))}
                    </SettingsButtonRow>
                    <details className="mc-next-disclosure">
                      <summary>Legacy compatibility contexts</summary>
                      <p className="mc-next-settings-field-note">
                        Cowork and Code are retained policy keys for stored activations and older API clients. They are
                        not separate Mission Control surfaces and do not govern current Chat.
                      </p>
                      <SettingsButtonRow>
                        {LEGACY_PERMISSION_CONTEXTS.map((surface) => (
                          <NativeButton
                            key={surface}
                            variant="secondary"
                            disabled={activationBlockedByRemoteHardened}
                            onClick={() => void handleActivateProfile(selectedProfile.profileId, surface)}
                          >
                            {surface === "code" ? <Code2 size={16} /> : <ShieldCheck size={16} />}
                            Use for {formatPermissionContextLabel(surface)}
                          </NativeButton>
                        ))}
                      </SettingsButtonRow>
                    </details>
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
                    <NativeButton
                      variant="destructive"
                      onClick={() =>
                        selectedProfile && !selectedProfile.builtin
                          ? setPendingArchiveProfile({
                              profileId: selectedProfile.profileId,
                              label: selectedProfile.label,
                            })
                          : setNotice({ tone: "warning", message: "Select a custom permission profile to archive." })
                      }
                    >
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
              id="permissions-effective"
              density="compact"
              className="mc-next-settings-panel"
              title="Effective policy contexts"
              subtitle="Chat includes conversation, agentic work, and Chat-launched Code Mode. Direct tools and MCP remain separate policy contexts."
            >
              <SettingsActionList
                ariaLabel="Effective primary policy contexts"
                items={primaryEffectiveContexts.map((item) => ({
                  id: item.surface,
                  label: formatPermissionContextLabel(item.surface),
                  description: `${item.profileLabel ?? item.profileId ?? "Safe"}${
                    item.approvalMode
                      ? `, ${describeToolApprovalMode(normalizeToolApprovalMode(item.approvalMode))}`
                      : ""
                  }${
                    item.localOperatorOverrideId
                      ? `, override ${item.localOperatorOverrideId} until ${formatDateTime(item.localOperatorOverride?.expiresAt)}`
                      : ""
                  } · ${PERMISSION_CONTEXT_PRESENTATION[item.surface].description}`,
                }))}
                emptyLabel="No effective primary policy context returned."
              />
              <details className="mc-next-disclosure">
                <summary>Legacy compatibility contexts</summary>
                <p className="mc-next-settings-field-note">
                  These retained Cowork and Code policy keys keep stored activations and older API clients inspectable.
                  They are not separate Mission Control surfaces and do not govern current Chat.
                </p>
                <SettingsActionList
                  ariaLabel="Legacy compatibility policy contexts"
                  items={legacyEffectiveContexts.map((item) => ({
                    id: item.surface,
                    label: formatPermissionContextLabel(item.surface),
                    description: `${item.profileLabel ?? item.profileId ?? "Safe"}${
                      item.approvalMode
                        ? `, ${describeToolApprovalMode(normalizeToolApprovalMode(item.approvalMode))}`
                        : ""
                    }${
                      item.localOperatorOverrideId
                        ? `, override ${item.localOperatorOverrideId} until ${formatDateTime(item.localOperatorOverride?.expiresAt)}`
                        : ""
                    } · ${PERMISSION_CONTEXT_PRESENTATION[item.surface].description}`,
                  }))}
                  emptyLabel="No legacy compatibility context returned."
                />
              </details>
            </NativeCard>
            <NativeCard
              id="permissions-override"
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
                  ariaLabel="Active local operator overrides"
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
            <NativeDisclosureCard
              id="permissions-autonomy"
              title="Autonomous activation grants"
              subtitle="Expiring operator grants that may permit agentic activation after policy, auth, path, provenance, and health checks still pass."
              defaultOpen={Boolean(
                data.autonomyGrants?.some((grant) => ["active", "pending", "degraded"].includes(grant.status)),
              )}
            >
              <p className="mc-next-settings-field-note">
                {activeAutonomyGrants.length} active of {data.autonomyGrants?.length ?? 0} recorded grants.
              </p>
              <SettingsActionList
                ariaLabel="Autonomous activation grants"
                items={(data.autonomyGrants ?? []).map((grant) => ({
                  label: grant.grantId,
                  description: `${grant.workspaceId} · ${formatPermissionContextList(grant.surfaces)} · ${grant.activationKinds.join(", ")} · ${grant.reason}`,
                  meta: `${grant.status} · max ${grant.maxRiskLevel} · ${grant.usedActivations}/${grant.maxActivations ?? "unlimited"} used · expires ${formatDateTime(grant.expiresAt)}${
                    hasLegacyOnlyPermissionContexts(grant.surfaces)
                      ? " · Compatibility warning: this legacy-only grant does not govern current Chat; reissue it for Chat or All policy contexts if intended."
                      : ""
                  }`,
                  onClick: grant.status === "active" ? () => setPendingRevokeGrantId(grant.grantId) : undefined,
                  actionLabel: grant.status === "active" ? "Revoke" : undefined,
                }))}
                emptyLabel="No autonomous activation grants recorded."
              />
            </NativeDisclosureCard>
          </SettingsGrid>
        </>
      ) : null}
      <ConfirmModal
        open={pendingArchiveProfile !== null}
        danger
        pending={archiveProfilePending}
        title="Archive permission profile?"
        message={`Archive ${pendingArchiveProfile?.label ?? "this permission profile"}? It will no longer be available for activation.`}
        confirmLabel="Archive profile"
        onCancel={() => setPendingArchiveProfile(null)}
        onConfirm={() => void handleArchiveSelectedProfile()}
      />
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
