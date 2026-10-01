import { readEffectivePermissionSurfaceState } from "../effective-permission-contexts";
import { useAutonomousGrantRevocation } from "../use-autonomous-grant-revocation";
import { autonomousGrantReviewDescription, grantCanBeRevoked, readAutonomousGrants } from "../autonomous-grant-binding";
import { useCallback, useState, type SetStateAction } from "react";
import { AlertTriangle, Code2, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import type {
  LocalOperatorOverrideRecord,
  LocalOperatorOverrideScope,
  PermissionSurface,
} from "@goatcitadel/contracts";
import {
  fetchActiveLocalOperatorOverrides,
  fetchEffectivePermissionProfile,
  fetchPermissionProfiles,
  fetchSettings,
} from "@goatcitadel/mission-control-shared/api/client";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import {
  nativeLoad,
  nativeLoadIssues,
  SettingsActionList,
  SettingsButtonRow,
  SettingsEmptyState,
  SettingsField,
  SettingsLoadWarnings,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { useSessionDraft, hasSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { usePermissionSelectionReview } from "./usePermissionSelectionReview";
import { usePermissionProfileActivation } from "../use-permission-profile-activation";
import { usePermissionManagement } from "../use-permission-management";
import { PermissionManagementReview } from "../PermissionManagementReview";
import type { PermissionManagementOperation } from "../permission-management-binding";
import { PermissionSelectionReviewDetails } from "./PermissionSelectionReviewDetails";
import {
  createEmptyPermissionProfileDraft,
  createPermissionProfileDraftFromRecord,
  describePermissionProfile,
  describeToolApprovalMode,
  labelForLocalOperatorOverrideScope,
  normalizeToolApprovalMode,
  permissionProfileDraftToMutation,
  resetLocalOperatorOverrideScopeRefForScope,
  resolveLocalOperatorOverrideScopeRef,
} from "../helpers/permission-helpers";
import { formatDateTime } from "../helpers/input-format";
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
      nativeLoad("Autonomous activation grants", readAutonomousGrants(), []),
      fetchSettings().catch(() => null),
    ]);
    return {
      issues: nativeLoadIssues([profiles, ...effectiveLoads.map((item) => item.load), activeOverrides, autonomyGrants]),
      profiles: profiles.data.items,
      effective: effectiveLoads.map(({ surface, load }) => readEffectivePermissionSurfaceState(surface, load.data)),
      activeOverrides: activeOverrides.data.items,
      autonomyGrants: autonomyGrants.data,
      settings,
    };
  }, [activeWorkspaceId]);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);
  const grantRevocation = useAutonomousGrantRevocation({ scope: activeWorkspaceId, reload });
  const [grantLimit, setGrantLimit] = useState(30);
  const [selectedProfileId, setSelectedProfileId] = useState("safe");
  const [view, setView] = useState<"profile" | "edit" | "new" | "override" | "effective" | null>(null);
  const leave = useDraftLeave();
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const selectedProfile =
    data?.profiles?.find((profile) => profile.profileId === selectedProfileId);
  const effectiveOverride = data?.effective.find((item) => item.localOperatorOverride)?.localOperatorOverride;
  const activeOverrides = collectActiveLocalOperatorOverrides([
    effectiveOverride,
    ...(data?.activeOverrides ?? []),
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
  const createEditor = useSessionDraft(`permission-profile:${activeWorkspaceId}:new`, createEmptyPermissionProfileDraft(), undefined, { label: "New permission profile", active: view === "new" });
  const editBaseline = selectedProfile ? createPermissionProfileDraftFromRecord(selectedProfile) : createEmptyPermissionProfileDraft();
  const editEditor = useSessionDraft(`permission-profile:${activeWorkspaceId}:${selectedProfileId}`, editBaseline, selectedProfile?.revision, { label: selectedProfile?.label ?? "Permission profile", active: view === "edit", available: Boolean(selectedProfile) });
  const emptyOverride = { scope: "workspace" as LocalOperatorOverrideScope, scopeRef: activeWorkspaceId, reason: "", ttlSeconds: 600 };
  const overrideEditor = useSessionDraft(`permission-override:${activeWorkspaceId}:new`, emptyOverride, undefined, { label: "Temporary override", active: view === "override" });
  const profileDraft = createEditor.value;
  const setProfileDraft = (value: SetStateAction<typeof profileDraft>) => { management.invalidate(); createEditor.setValue(value); };
  const profileEditDraft = editEditor.value;
  const activation = usePermissionProfileActivation({
    key: JSON.stringify([activeWorkspaceId, selectedProfileId, view]),
    workspaceId: activeWorkspaceId, profile: selectedProfile,
    available: !loading && !error && Boolean(data?.settings),
    deploymentProfile: data?.settings?.deploymentProfile, reload,
  });
  const activationSaving = activation.locked;
  const activationSelection = { review: activation.review, pending: activation.reviewing, error: activation.error, clear: activation.clear };
  const defaultSelection = usePermissionSelectionReview(JSON.stringify([activeWorkspaceId, view, selectedProfileId,
    editEditor.baseRevision, view === "new" ? profileDraft : profileEditDraft]));
  const createNeedsDefaultReview = profileDraft.defaultForSurfaces.length > 0;
  const editNeedsDefaultReview = JSON.stringify([...profileEditDraft.defaultForSurfaces].sort())
    !== JSON.stringify([...(selectedProfile?.defaultForSurfaces ?? [])].sort());
  const setProfileEditDraft = (value: SetStateAction<typeof profileEditDraft>) => { management.invalidate(); editEditor.setValue(value); };
  const overrideDraft = overrideEditor.value;
  const setOverrideDraft = (update: SetStateAction<typeof overrideDraft>) => { management.invalidate(); overrideEditor.setValue(update); setOverrideAcknowledged(false); };
  const management = usePermissionManagement({ workspaceId: activeWorkspaceId,
    identity: JSON.stringify([view, selectedProfileId, profileDraft, profileEditDraft, editEditor.baseRevision, overrideDraft, overrideAcknowledged]), reload });
  const activeManagementOperation: PermissionManagementOperation = view === "override"
    ? { kind: "override-create", input: { ...overrideDraft, reason: overrideDraft.reason.trim(), scopeRef: resolveLocalOperatorOverrideScopeRef(overrideDraft.scope, overrideDraft.scopeRef, activeWorkspaceId) } }
    : view === "new" || !selectedProfile ? { kind: "create", fields: permissionProfileDraftToMutation(profileDraft) }
      : { kind: "update", profile: selectedProfile, fields: permissionProfileDraftToMutation(profileEditDraft) };
  const managementAttempt = management.attemptFor(activeManagementOperation);
  const saving = management.checking || Boolean(managementAttempt);
  const hasProfileConflict = managementAttempt?.phase === "rejected" || Boolean(selectedProfile && editEditor.baseRevision !== selectedProfile.revision);
  const draftKeys = [createEditor.key, editEditor.key, overrideEditor.key];
  const openView = (next: typeof view) => leave.request(() => { management.invalidate(); setView(next); setOverrideAcknowledged(false); }, draftKeys);
  const profileSelectionGuard = { requestTransition: (profileId: string) => leave.request(() => { management.invalidate(); setSelectedProfileId(profileId); setView("profile"); setOverrideAcknowledged(false); }, draftKeys) };

  const handleActivateProfile = async (profileId: string, surface: PermissionSurface) => {
    if (profileId === selectedProfile?.profileId) await activation.request(surface);
  };

  const handleApplyReviewedActivation = async () => {
    await activation.confirm();
  };

  const handleReviewDefaults = async () => {
    if (view === "new") {
      await defaultSelection.request({ operation: "defaults", scope: "workspace", scopeRef: activeWorkspaceId,
        defaultForSurfaces: profileDraft.defaultForSurfaces });
    } else if (view === "edit" && selectedProfile && !editEditor.hasRemoteChanges && !hasProfileConflict) {
      await defaultSelection.request({ operation: "defaults", profileId: selectedProfile.profileId,
        defaultForSurfaces: profileEditDraft.defaultForSurfaces });
    }
  };

  const handleCreateProfile = async (): Promise<boolean> => {
    if (saving || (createNeedsDefaultReview && !defaultSelection.review)) return false;
    const submitted = profileDraft;
    await management.request({ kind: "create", fields: permissionProfileDraftToMutation(submitted) }, (receipt) => {
      if ("profileId" in receipt) createEditor.acceptSaved(createEmptyPermissionProfileDraft(), undefined, submitted);
    });
    return false;
  };
  const handleUpdateSelectedProfile = async (): Promise<boolean> => {
    if (saving || !selectedProfile || editEditor.hasRemoteChanges || hasProfileConflict
      || (editNeedsDefaultReview && !defaultSelection.review)) return false;
    const submitted = profileEditDraft;
    await management.request({ kind: "update", profile: selectedProfile, fields: permissionProfileDraftToMutation(submitted) }, (receipt) => {
      if ("profileId" in receipt) editEditor.acceptSaved(createPermissionProfileDraftFromRecord(receipt), receipt.revision, submitted);
    });
    return false;
  };
  const handleArchiveSelectedProfile = async () => {
    if (saving || !selectedProfile || editEditor.hasRemoteChanges || hasProfileConflict) return;
    const submitted = profileEditDraft;
    await management.request({ kind: "archive", profile: selectedProfile }, () => editEditor.acceptSaved(createEmptyPermissionProfileDraft(), undefined, submitted));
  };
  const handleStartOverride = async (): Promise<boolean> => {
    if (saving || !overrideAcknowledged || localOperatorOverrideRestriction || activeManagementOperation.kind !== "override-create") return false;
    const submitted = overrideDraft;
    await management.request(activeManagementOperation, () => overrideEditor.acceptSaved(emptyOverride, undefined, submitted));
    return false;
  };
  const handleRevokeOverride = async (overrideId?: string) => {
    const override = activeOverrides.find((item) => item.overrideId === overrideId);
    if (!override || saving) return;
    await management.request({ kind: "override-revoke", override });
  };

  return (
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {grantRevocation.message ? <p role="status">{grantRevocation.message}</p> : null}
      {management.message ? <p role="status">{management.message}</p> : null}
      {managementAttempt ? <p role={managementAttempt.phase === "uncertain" ? "alert" : "status"}>{managementAttempt.message}</p> : null}
      {activation.notice ? <p role={activation.uncertain ? "alert" : "status"}>{activation.notice}</p> : null}
      {data ? (
        <>

          <SettingsStack>
            <SettingsLoadWarnings issues={data.issues} onRetry={reload} />
            <p className="mc-next-settings-field-note">Chat effective profile: {chatEffectiveProfileLabel} · Workspace: {activeWorkspaceId}</p>
            <SettingsButtonRow><NativeButton onClick={() => openView("new")}>New profile{createEditor.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="outline" onClick={() => openView("effective")}>Effective policy contexts</NativeButton><NativeButton variant="outline" onClick={() => openView("override")}>Temporary override{overrideEditor.isDirty ? " · Unsaved" : ""}</NativeButton><NativeButton variant="outline" onClick={() => void reload()}>Refresh</NativeButton></SettingsButtonRow>
            {activeOverrides.length ? <div role="status"><strong>{activeOverrides.length} active Local Operator Override{activeOverrides.length === 1 ? "" : "s"}</strong>{activeOverrides.map((override) => <p key={override.overrideId}>{override.scope} {override.scopeRef} · expires {formatDateTime(override.expiresAt)} <NativeButton variant="outline" onClick={() => void handleRevokeOverride(override.overrideId)}>End {override.overrideId}</NativeButton></p>)}</div> : null}
            {activeAutonomyGrants.length ? <p role="status">{activeAutonomyGrants.length} active autonomous activation grant{activeAutonomyGrants.length === 1 ? "" : "s"}. <a href="#permissions-autonomy">Inspect grants</a></p> : null}
            <div hidden={view === "edit" || view === "new"}><NativeCard
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
                  meta: `${profile.builtin ? "Built-in" : profile.scope}${hasSessionDraft(`permission-profile:${activeWorkspaceId}:${profile.profileId}`) ? " · Unsaved" : ""}`,
                  body: profile.description ?? describePermissionProfile(profile),
                }))}
                selectedId={selectedProfile?.profileId ?? ""}
                onSelect={(profileId) => {
                  if (profileId !== selectedProfileId || view !== "profile") {
                    profileSelectionGuard.requestTransition(profileId);
                  }
                }}
                emptyLabel="No permission profiles returned by the gateway."
                maxHeight=""
              />
            </NativeCard></div>
            <SettingsStack>
              <DetailInspector open={view === "profile"} title={selectedProfile?.label ?? "Profile unavailable"} onClose={() => openView(null)}><NativeCard
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
                {selectedProfile && !selectedProfile.builtin ? <SettingsButtonRow><NativeButton onClick={() => openView("edit")}>Edit profile{editEditor.isDirty ? " · Unsaved" : ""}</NativeButton></SettingsButtonRow> : null}
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
                    {activationSelection.error ? <p role="alert">{activationSelection.error}</p> : null}
                    {activationSelection.pending ? <p role="status">Reviewing the current permission selection...</p> : null}
                    {activationSelection.review ? <>
                      <PermissionSelectionReviewDetails review={activationSelection.review} />
                      <SettingsButtonRow>
                        <NativeButton disabled={activationSaving} onClick={() => void handleApplyReviewedActivation()}>Apply reviewed selection</NativeButton>
                        <NativeButton variant="outline" disabled={activationSaving} onClick={activationSelection.clear}>Cancel selection</NativeButton>
                      </SettingsButtonRow>
                    </> : null}
                    <SettingsButtonRow>
                      <NativeButton
                        variant="default"
                        disabled={activationBlockedByRemoteHardened || activationSaving || activationSelection.pending}
                        onClick={() => void handleActivateProfile(selectedProfile.profileId, "chat")}
                      >
                        <ShieldCheck size={16} />
                        Use for Chat
                      </NativeButton>
                      <NativeButton
                        variant="secondary"
                        disabled={activationBlockedByRemoteHardened || activationSaving || activationSelection.pending}
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
                          disabled={activationBlockedByRemoteHardened || activationSaving || activationSelection.pending}
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
                            disabled={activationBlockedByRemoteHardened || activationSaving || activationSelection.pending}
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
              </NativeCard></DetailInspector>
              {selectedProfile && !selectedProfile.builtin && view === "edit" ? (
                <FocusedDetail title="Edit permission profile" onClose={() => openView(null)}><NativeCard
                  density="compact"
                  className="mc-next-settings-panel"
                  title="Edit custom profile"
                  subtitle="Update or archive the selected profile."
                >
                  {editEditor.hasRemoteChanges || hasProfileConflict ? (
                    <div role="status">
                      <p>The saved profile changed. Your draft is preserved.</p>
                      <details>
                        <summary>Current profile rules</summary>
                        <SettingsActionList
                          ariaLabel="Current saved profile"
                          items={[
                            { label: "Name", description: editBaseline.label },
                            { label: "Description", description: editBaseline.description || "No description" },
                            { label: "Approval behavior", description: describeToolApprovalMode(editBaseline.approvalMode) },
                            { label: "Tool patterns", description: editBaseline.toolPatterns || "No tool patterns" },
                            { label: "Allow patterns", description: editBaseline.allow || "No extra allow patterns" },
                            { label: "Deny patterns", description: editBaseline.deny || "No profile deny patterns" },
                            { label: "Read access", description: describeReadAccessMode(editBaseline.readAccessMode) },
                            { label: "Default policy contexts", description: editBaseline.defaultForSurfaces.length
                              ? formatPermissionContextList(editBaseline.defaultForSurfaces) : "No automatic policy-context default" },
                          ]}
                          emptyLabel="Current profile unavailable."
                        />
                      </details>
                      <SettingsButtonRow>
                        <NativeButton variant="outline" disabled={!selectedProfile?.revision || managementAttempt?.phase === "rejected"} onClick={() => { management.invalidate(); editEditor.rebaseToCurrent(); }}>Apply draft to current profile</NativeButton>
                        <NativeButton variant="outline" onClick={() => void reload()}>Reload latest profile</NativeButton>
                      </SettingsButtonRow>
                    </div>
                  ) : null}
                  <PermissionProfileDraftFields
                    accessibleNamePrefix="Edit profile"
                    draft={profileEditDraft}
                    bypassUnavailableReason={promptSkippingProfileRestriction ?? undefined}
                    setDraft={setProfileEditDraft}
                  />
                  {editNeedsDefaultReview ? <>
                    <NativeButton variant="outline" disabled={saving || defaultSelection.pending || editEditor.hasRemoteChanges || hasProfileConflict} onClick={() => void handleReviewDefaults()}>Review default selection</NativeButton>
                    {defaultSelection.error ? <p role="alert">{defaultSelection.error}</p> : null}
                    {defaultSelection.review ? <PermissionSelectionReviewDetails review={defaultSelection.review} /> : null}
                  </> : null}
                  <SettingsButtonRow>
                    <NativeButton variant="default" disabled={saving || editEditor.hasRemoteChanges || hasProfileConflict || typeof editEditor.baseRevision !== "string" || (editNeedsDefaultReview && !defaultSelection.review)} onClick={() => void handleUpdateSelectedProfile()}>
                      <Save size={16} />
                      Save profile
                    </NativeButton>
                    <NativeButton
                      variant="destructive"
                      disabled={saving || editEditor.hasRemoteChanges || hasProfileConflict}
                      onClick={() => void handleArchiveSelectedProfile()}
                    >
                      <Trash2 size={16} />
                      Archive profile
                    </NativeButton>
                  </SettingsButtonRow>
                  <PermissionManagementReview control={management} retainedAttempt={managementAttempt} />
                </NativeCard></FocusedDetail>
              ) : null}
              {view === "new" ? <FocusedDetail title="New permission profile" onClose={() => openView(null)}><NativeCard
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
                {createNeedsDefaultReview ? <>
                  <NativeButton variant="outline" disabled={saving || defaultSelection.pending} onClick={() => void handleReviewDefaults()}>Review default selection</NativeButton>
                  {defaultSelection.error ? <p role="alert">{defaultSelection.error}</p> : null}
                  {defaultSelection.review ? <PermissionSelectionReviewDetails review={defaultSelection.review} /> : null}
                </> : null}
                <SettingsButtonRow>
                  <NativeButton variant="default" disabled={saving || (createNeedsDefaultReview && !defaultSelection.review)} onClick={() => void handleCreateProfile()}>
                    <Plus size={16} />
                    Create profile
                  </NativeButton>
                </SettingsButtonRow>
                <PermissionManagementReview control={management} retainedAttempt={managementAttempt} />
              </NativeCard></FocusedDetail> : null}
            </SettingsStack>
            <DetailInspector open={view === "effective"} title="Effective policy contexts" onClose={() => openView(null)}><NativeCard
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
                  description: `${item.profileLabel ?? item.profileId ?? "Unavailable"}${
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
                    description: `${item.profileLabel ?? item.profileId ?? "Unavailable"}${
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
            </NativeCard></DetailInspector>
            <DetailInspector open={view === "override"} title="Temporary Local Operator Override" onClose={() => openView(null)}><NativeCard
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
                  onChange={(event) => { management.invalidate(); setOverrideAcknowledged(event.target.checked); }}
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
                  disabled={saving || Boolean(localOperatorOverrideRestriction) || !overrideAcknowledged}
                  onClick={() => void handleStartOverride()}
                >
                  <AlertTriangle size={16} />
                  Start temporary override
                </NativeButton>
              </SettingsButtonRow>
              <PermissionManagementReview control={management} retainedAttempt={managementAttempt} />
            </NativeCard></DetailInspector>
            <NativeDisclosureCard
              id="permissions-autonomy"
              title="Autonomous activation grants"
              subtitle="Expiring operator grants that may permit agentic activation after policy, auth, path, provenance, and health checks still pass."
            >
              <p className="mc-next-settings-field-note">
                {activeAutonomyGrants.length} active of {data.autonomyGrants?.length ?? 0} recorded grants.
              </p>
              <SettingsActionList
                ariaLabel="Autonomous activation grants"
                items={(data.autonomyGrants ?? []).slice(0, grantLimit).map((grant) => ({
                  label: grant.grantId,
                  description: `${grant.workspaceId} · ${formatPermissionContextList(grant.surfaces)} · ${grant.activationKinds.join(", ")} · ${grant.reason}`,
                  meta: `${grant.status} · max ${grant.maxRiskLevel} · ${grant.usedActivations}/${grant.maxActivations ?? "unlimited"} used · expires ${formatDateTime(grant.expiresAt)}${
                    hasLegacyOnlyPermissionContexts(grant.surfaces)
                      ? " · Compatibility warning: this legacy-only grant does not govern current Chat; reissue it for Chat or All policy contexts if intended."
                      : ""
                  }${grantRevocation.attemptFor(grant.grantId) ? ` · ${grantRevocation.attemptFor(grant.grantId)!.message}` : ""}`,
                  onClick: grantCanBeRevoked(grant) && !grantRevocation.busy(grant.grantId) && !loading
                    ? () => void grantRevocation.request(grant) : undefined,
                  actionLabel: grantCanBeRevoked(grant) ? "Review revoke" : undefined,
                }))}
                emptyLabel="No autonomous activation grants recorded."
              />
              {(data.autonomyGrants?.length ?? 0) > grantLimit ? <NativeButton onClick={() => setGrantLimit(value => value + 30)}>Show more autonomous grants</NativeButton> : null}
            </NativeDisclosureCard>
          </SettingsStack>
        </>
      ) : null}
      {leave.dialog}
      <ConfirmModal
        open={Boolean(grantRevocation.review)}
        danger
        title="Revoke autonomous activation grant?"
        message={grantRevocation.review ? autonomousGrantReviewDescription(grantRevocation.review) : ""}
        confirmLabel="Revoke"
        pending={grantRevocation.pending}
        confirmDisabled={Boolean(grantRevocation.review && grantRevocation.busy(grantRevocation.review.grantId))}
        onCancel={grantRevocation.cancel}
        onConfirm={() => void grantRevocation.confirm()}
      />
    </SettingsSectionShell>
  );
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
