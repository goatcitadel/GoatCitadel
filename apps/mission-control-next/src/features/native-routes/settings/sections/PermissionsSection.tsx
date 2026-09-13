// Extracted verbatim from `../../SettingsNativePage.tsx` as part of the
// per-section settings decomposition.
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
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
  SettingsLoadWarnings,
  SettingsNotice,
  type SettingsSectionProps,
  SettingsSectionShell,
  SettingsStack,
  useAsyncLoad,
} from "../SettingsShared";
import { NativeCard, NativeDisclosureCard } from "../../NativeRoutePageLayout";
import { NativeButton, NativeSelectableList } from "../../primitives";
import { useSessionDraft, hasSessionDraft, discardSessionDraft } from "../../library/session-drafts";
import { useDraftLeave } from "../../library/DraftLeaveDialog";
import { DetailInspector } from "../../../../components/DetailInspector";
import { FocusedDetail } from "../../shared/FocusedDetail";
import { usePermissionSelectionReview } from "./usePermissionSelectionReview";
import { PermissionSelectionReviewDetails } from "./PermissionSelectionReviewDetails";
import {
  createEmptyPermissionProfileDraft,
  createPermissionProfileDraftFromRecord,
  describePermissionProfile,
  describeToolApprovalMode,
  formatDateTime,
  labelForLocalOperatorOverrideScope,
  normalizeToolApprovalMode,
  permissionProfileDraftToMutation,
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
  const [pendingArchiveProfile, setPendingArchiveProfile] = useState<{ profileId: string; label: string; expectedRevision: string } | null>(null);
  const [archiveProfilePending, setArchiveProfilePending] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("safe");
  const [view, setView] = useState<"profile" | "edit" | "new" | "override" | "effective" | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [activationSaving, setActivationSaving] = useState(false);
  const activationSavingRef = useRef(false);
  const [profileConflict, setProfileConflict] = useState<{ key: string; revision: string } | null>(null);
  const leave = useDraftLeave();
  const [overrideAcknowledged, setOverrideAcknowledged] = useState(false);
  const [recentLocalOverride, setRecentLocalOverride] = useState<LocalOperatorOverrideRecord | null>(null);
  const selectedProfile =
    data?.profiles?.find((profile) => profile.profileId === selectedProfileId);
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
  const createEditor = useSessionDraft(`permission-profile:${activeWorkspaceId}:new`, createEmptyPermissionProfileDraft(), undefined, { label: "New permission profile", active: view === "new", onSave: () => handleCreateProfile() });
  const editBaseline = selectedProfile ? createPermissionProfileDraftFromRecord(selectedProfile) : createEmptyPermissionProfileDraft();
  const editEditor = useSessionDraft(`permission-profile:${activeWorkspaceId}:${selectedProfileId}`, editBaseline, selectedProfile?.revision, { label: selectedProfile?.label ?? "Permission profile", active: view === "edit", available: Boolean(selectedProfile), onSave: () => handleUpdateSelectedProfile() });
  const emptyOverride = { scope: "workspace" as LocalOperatorOverrideScope, scopeRef: activeWorkspaceId, reason: "", ttlSeconds: 600 };
  const overrideEditor = useSessionDraft(`permission-override:${activeWorkspaceId}:new`, emptyOverride, undefined, { label: "Temporary override", active: view === "override", onSave: () => handleStartOverride() });
  const profileDraft = createEditor.value;
  const setProfileDraft = createEditor.setValue;
  const profileEditDraft = editEditor.value;
  const hasProfileConflict = profileConflict?.key === editEditor.key;
  const activationSelection = usePermissionSelectionReview(JSON.stringify([activeWorkspaceId, selectedProfileId, selectedProfile?.revision, view]));
  const defaultSelection = usePermissionSelectionReview(JSON.stringify([activeWorkspaceId, view, selectedProfileId,
    editEditor.baseRevision, view === "new" ? profileDraft : profileEditDraft]));
  const createNeedsDefaultReview = profileDraft.defaultForSurfaces.length > 0;
  const editNeedsDefaultReview = JSON.stringify([...profileEditDraft.defaultForSurfaces].sort())
    !== JSON.stringify([...(selectedProfile?.defaultForSurfaces ?? [])].sort());
  const setProfileEditDraft = editEditor.setValue;
  const overrideDraft = overrideEditor.value;
  const setOverrideDraft = (update: SetStateAction<typeof overrideDraft>) => { overrideEditor.setValue(update); setOverrideAcknowledged(false); };
  const draftKeys = [createEditor.key, editEditor.key, overrideEditor.key];
  const openView = (next: typeof view) => leave.request(() => { setView(next); setOverrideAcknowledged(false); }, draftKeys);
  const profileSelectionGuard = { requestTransition: (profileId: string) => leave.request(() => { setSelectedProfileId(profileId); setView("profile"); setOverrideAcknowledged(false); }, draftKeys) };
  useEffect(() => { if (effectiveOverride) setRecentLocalOverride(effectiveOverride); }, [effectiveOverride]);

  const handleActivateProfile = async (profileId: string, surface: PermissionSurface) => {
    if (activationSavingRef.current) return;
    const profile = data?.profiles?.find((item) => item.profileId === profileId);
    if (promptSkippingProfileRestriction && profile?.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return;
    }
    await activationSelection.request({ operation: "activate", profileId, workspaceId: activeWorkspaceId, surface });
  };

  const handleApplyReviewedActivation = async () => {
    const review = activationSelection.review;
    if (activationSavingRef.current || !review?.profile || review.input.operation !== "activate" || !activationSelection.isCurrent()) return;
    if (promptSkippingProfileRestriction && review.profile.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction }); return;
    }
    activationSavingRef.current = true; setActivationSaving(true);
    try {
      await activatePermissionProfile({ profileId: review.input.profileId, workspaceId: review.input.workspaceId,
        sessionId: review.input.sessionId, surface: review.input.surface,
        expectedProfileRevision: review.profile.revision, expectedSelectionRevision: review.revision });
      if (!activationSelection.isCurrent()) return;
      activationSelection.clear();
      setNotice({ tone: "success", message: `${review.profile.label} activated.` });
      await reload();
    } catch (activateError) {
      if (!activationSelection.isCurrent()) return;
      activationSelection.clear();
      if (isPermissionProfileConflict(activateError)) {
        setNotice({ tone: "warning", message: "Permission selections changed. Review the current selection before applying it again." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(activateError) });
    } finally { activationSavingRef.current = false; setActivationSaving(false); }
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
    if (savingRef.current) return false;
    if (createNeedsDefaultReview && !defaultSelection.review) {
      setNotice({ tone: "warning", message: "Review the default selection before creating this profile." }); return false;
    }
    const submitted = profileDraft;
    if (!profileDraft.label.trim()) {
      setNotice({ tone: "warning", message: "Profile name is required." });
      return false;
    }
    if (promptSkippingProfileRestriction && profileDraft.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return false;
    }
    savingRef.current = true; setSaving(true);
    try {
      const created = await createPermissionProfile({
        scope: "workspace",
        scopeRef: activeWorkspaceId,
        ...permissionProfileDraftToMutation(profileDraft),
        expectedSelectionRevision: createNeedsDefaultReview ? defaultSelection.review?.revision : undefined,
      });
      setSelectedProfileId(created.profileId);
      const clean = createEditor.acceptSaved(createEmptyPermissionProfileDraft(), undefined, submitted);
      setNotice({ tone: "success", message: "Permission profile created." });
      await reload();
      return clean;
    } catch (createError) {
      if (isPermissionProfileConflict(createError)) {
        defaultSelection.clear();
        setNotice({ tone: "warning", message: "Permission selections changed. Your draft is preserved; review the default selection again." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(createError) });
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };

  const handleUpdateSelectedProfile = async (): Promise<boolean> => {
    if (savingRef.current || editEditor.hasRemoteChanges || hasProfileConflict) return false;
    if (editNeedsDefaultReview && !defaultSelection.review) {
      setNotice({ tone: "warning", message: "Review the default selection before saving this profile." }); return false;
    }
    const submitted = profileEditDraft;
    const expectedRevision = editEditor.baseRevision;
    if (typeof expectedRevision !== "string") {
      setNotice({ tone: "warning", message: "Reload this permission profile before editing it." });
      return false;
    }
    if (!selectedProfile || selectedProfile.builtin) {
      setNotice({ tone: "warning", message: "Select a custom permission profile to edit." });
      return false;
    }
    if (!profileEditDraft.label.trim()) {
      setNotice({ tone: "warning", message: "Profile name is required." });
      return false;
    }
    if (promptSkippingProfileRestriction && profileEditDraft.approvalMode === "bypass") {
      setNotice({ tone: "warning", message: promptSkippingProfileRestriction });
      return false;
    }
    savingRef.current = true; setSaving(true);
    try {
      const updated = await updatePermissionProfile(selectedProfile.profileId, {
        ...permissionProfileDraftToMutation(profileEditDraft),
        expectedRevision,
        expectedSelectionRevision: editNeedsDefaultReview ? defaultSelection.review?.revision : undefined,
      });
      const nextDraft = createPermissionProfileDraftFromRecord(updated);
      setSelectedProfileId(updated.profileId);
      const clean = editEditor.acceptSaved(nextDraft, updated.revision, submitted);
      setNotice({ tone: "success", message: "Permission profile updated." });
      await reload();
      return clean;
    } catch (updateError) {
      if (isPermissionSelectionConflict(updateError)) {
        defaultSelection.clear();
        setNotice({ tone: "warning", message: "Permission selections changed. Your draft is preserved; review the default selection again." });
        await reload();
      } else if (isPermissionProfileConflict(updateError)) {
        setProfileConflict({ key: editEditor.key, revision: expectedRevision });
        setNotice({ tone: "warning", message: "This permission profile changed. Your draft is preserved; review the latest profile before saving." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(updateError) });
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  };

  const handleArchiveSelectedProfile = async () => {
    if (!pendingArchiveProfile) {
      return;
    }
    setArchiveProfilePending(true);
    try {
      await archivePermissionProfile(pendingArchiveProfile.profileId, { expectedRevision: pendingArchiveProfile.expectedRevision });
      discardSessionDraft(`permission-profile:${activeWorkspaceId}:${pendingArchiveProfile.profileId}`);
      setSelectedProfileId("safe"); setView(null);
      setNotice({ tone: "success", message: "Permission profile archived." });
      setPendingArchiveProfile(null);
      await reload();
    } catch (archiveError) {
      if (isPermissionProfileConflict(archiveError)) {
        setPendingArchiveProfile(null);
        setNotice({ tone: "warning", message: "This permission profile changed. Review it again before archiving; your draft is preserved." });
        await reload();
      } else setNotice({ tone: "error", message: getErrorMessage(archiveError) });
    } finally {
      setArchiveProfilePending(false);
    }
  };

  const handleStartOverride = async (): Promise<boolean> => {
    if (savingRef.current) return false;
    const submitted = overrideDraft;
    if (localOperatorOverrideRestriction) {
      setNotice({ tone: "warning", message: localOperatorOverrideRestriction });
      return false;
    }
    if (!overrideDraft.reason.trim()) {
      setNotice({ tone: "warning", message: "Add a reason before starting Local Operator Override." });
      return false;
    }
    const scopeRef = resolveLocalOperatorOverrideScopeRef(
      overrideDraft.scope,
      overrideDraft.scopeRef,
      activeWorkspaceId,
    );
    if (overrideDraft.scope !== "operator" && !scopeRef) {
      setNotice({ tone: "warning", message: "Add a target for this Local Operator Override scope." });
      return false;
    }
    if (!overrideAcknowledged) {
      setNotice({
        tone: "warning",
        message:
          "Confirm that this grants broad local tool access, skips normal prompts, and keeps hard safety boundaries in force.",
      });
      return false;
    }
    savingRef.current = true; setSaving(true);
    try {
      const override = await createLocalOperatorOverride({
        scope: overrideDraft.scope,
        scopeRef,
        reason: overrideDraft.reason.trim(),
        ttlSeconds: overrideDraft.ttlSeconds,
      });
      setRecentLocalOverride(override);
      const clean = overrideEditor.acceptSaved(emptyOverride, undefined, submitted);
      setOverrideAcknowledged(false);
      setNotice({
        tone: "warning",
        message: `Local Operator Override ${override.overrideId} is active until ${formatDateTime(override.expiresAt)}.`,
      });
      await reload();
      return clean;
    } catch (overrideError) {
      setNotice({ tone: "error", message: getErrorMessage(overrideError) });
      return false;
    } finally { savingRef.current = false; setSaving(false); }
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
    <SettingsSectionShell loading={loading && !data} error={error} onRetry={reload}>
      {notice ? <SettingsNotice notice={notice} /> : null}
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
                        <NativeButton variant="outline" disabled={!selectedProfile?.revision || selectedProfile.revision === profileConflict?.revision} onClick={() => { editEditor.rebaseToCurrent(); setProfileConflict(null); }}>Apply draft to current profile</NativeButton>
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
                      onClick={() =>
                        selectedProfile && !selectedProfile.builtin
                          ? setPendingArchiveProfile({
                              profileId: selectedProfile.profileId,
                              label: selectedProfile.label,
                              expectedRevision: selectedProfile.revision,
                            })
                          : setNotice({ tone: "warning", message: "Select a custom permission profile to archive." })
                      }
                    >
                      <Trash2 size={16} />
                      Archive profile
                    </NativeButton>
                  </SettingsButtonRow>
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
                  disabled={saving || Boolean(localOperatorOverrideRestriction) || !overrideAcknowledged}
                  onClick={() => void handleStartOverride()}
                >
                  <AlertTriangle size={16} />
                  Start temporary override
                </NativeButton>
              </SettingsButtonRow>
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
          </SettingsStack>
        </>
      ) : null}
      {leave.dialog}
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

function isPermissionProfileConflict(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "status" in error && error.status === 409);
}

function isPermissionSelectionConflict(error: unknown): boolean {
  if (!isPermissionProfileConflict(error) || !isRecord(error)) return false;
  const body = isRecord(error.body) ? error.body : undefined;
  return isRecord(body?.details) && body.details.reason === "PERMISSION_SELECTION_REVISION_CONFLICT";
}
