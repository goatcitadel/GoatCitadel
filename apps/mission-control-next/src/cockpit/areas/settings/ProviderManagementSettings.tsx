import { useId, useState } from "react";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { useProviderModelCatalog } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useProviderProfileEditor } from "../../../features/native-routes/settings/sections/use-provider-profile-editor";
import { useProviderCredentials } from "../../../features/native-routes/settings/sections/use-provider-credentials";
import { useProviderOAuthFlow } from "../../../features/native-routes/settings/sections/use-provider-oauth-flow";
import { useProviderPlanActions } from "../../../features/native-routes/settings/sections/use-provider-plan-actions";
import type { ProviderSaveDraft } from "../../../features/native-routes/settings/sections/provider-save-contract";
import type { Notice } from "../../../features/native-routes/settings/SettingsShared";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ProviderProfileFields } from "./ProviderProfileFields";
import { ProviderList } from "./ProviderList";
import { ProviderConnectionSettings } from "./ProviderConnectionSettings";
import { credentialRemovalBlockedReason, ProviderSavedCredential } from "./ProviderSavedCredential";
import { ProviderProfileReview } from "./ProviderProfileReview";
import { ProviderChangeStatus } from "./ProviderChangeStatus";
import { ProviderOutcomeCheck } from "./ProviderOutcomeCheck";
import { ProviderDraftLeave } from "./ProviderDraftLeave";
import { ProviderOAuthSettings } from "./ProviderOAuthSettings";
import { useProviderCodexSetup } from "../../../features/native-routes/settings/sections/use-provider-codex-setup";

export function ProviderManagementSettings() {
  const addReasonId = useId();
  const editReasonId = useId();
  const catalog = useProviderModelCatalog("system");
  const { activeWorkspaceId } = useUiPreferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"selected" | "new">("selected");
  const [transportOpen, setTransportOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [review, setReview] = useState<{ draft: ProviderSaveDraft; revision: number } | null>(null);
  const leave = useDraftLeave();
  const id = selectedId ?? catalog.config?.activeProviderId ?? catalog.providers[0]?.providerId ?? "";
  const provider = catalog.providers.find((item) => item.providerId === id) ?? null;
  const config = catalog.config;
  const ready = Boolean(
    config && !catalog.loading && !catalog.error && Number.isSafeInteger(config.revision) && config.revision > 0,
  );
  const profile = useProviderProfileEditor({
    ...catalog,
    governedCreation: true,
    selectedProviderId: id,
    selectedProvider: provider,
    selectedProviderConfig: config?.providerConfigs?.find((item) => item.providerId === id),
    editorMode: mode,
    detailView: open ? "editor" : "trust",
    setNotice,
    onSaved: (savedId) => {
      setOpen(false);
      setSelectedId(savedId);
      setMode("selected");
    },
    onSubmitted: () => setOpen(false),
  });
  const credentials = useProviderCredentials({
    ...catalog,
    selectedProviderId: id,
    detailView: "trust",
    credentialEditorOpen: false,
    currentEditor: profile.currentEditor,
    setNotice,
  });
  const oauth = useProviderOAuthFlow({
    activeWorkspaceId: activeWorkspaceId ?? "default",
    hasCodexOAuthProvider: catalog.providers.some((item) => item.providerId === "openai-codex"),
    setNotice,
  });
  const plan = oauth.codexOAuthPlanDialog,
    setPlan = oauth.setCodexOAuthPlanDialog;
  const setup = useProviderCodexSetup({
    ...catalog,
    setNotice,
    viewIdentity: activeWorkspaceId,
    onSaved: () => setSelectedId("openai-codex"),
  });
  const actions = useProviderPlanActions({
    plan,
    setPlan,
    setNotice,
    viewIdentity: { activeWorkspaceId, id, open },
    onAcknowledged: (next) => {
      if (next.request.kind === "provider_connection" && next.request.providerId === "openai-codex")
        oauth.setCodexOAuthPlan(next);
    },
    onSettled: async () => {
      await Promise.all([
        profile.providerChange.refresh(),
        credentials.secretRemoval.refresh(),
        setup.refresh(),
        catalog.reload(),
        oauth.refreshCodexOAuthStatus(),
      ]);
    },
  });
  const locked = profile.mutation.pending || Boolean(profile.mutation.uncertain) || profile.providerChange.hasPending;
  const currentReview = Boolean(
    review &&
    ready &&
    !profile.providerEditor.hasRemoteChanges &&
    review.revision === profile.providerEditor.baseRevision &&
    !profile.saveOperationError &&
    JSON.stringify(review.draft) === JSON.stringify(profile.providerEditor.value),
  );
  const close = () =>
    leave.request(() => {
      setOpen(false);
      setReview(null);
    }, [profile.providerEditor.key]);
  const begin = (nextMode: "selected" | "new", withTransport = false) =>
    leave.request(() => {
      setMode(nextMode);
      setTransportOpen(withTransport);
      setOpen(true);
      setReview(null);
    }, [profile.providerEditor.key]);
  const unavailableReason = catalog.loading
    ? "Loading saved providers…"
    : "Saved provider settings couldn't load. Refresh profiles, then try again.";
  const busyReason = "Finish the provider change in progress first.";
  const addReason = !ready ? unavailableReason : locked ? busyReason : undefined;
  const editReason = !ready
    ? unavailableReason
    : !provider
      ? "Select a saved provider first."
      : locked
        ? busyReason
        : undefined;
  const removalReason = credentialRemovalBlockedReason({
    ready,
    providerId: id,
    hasProvider: Boolean(provider),
    locked,
    removalPending: credentials.secretRemoval.hasPending,
    secret: credentials.secretState,
  });
  return (
    <section
      aria-label="Provider profiles"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <header>
        <h3 className="text-md font-semibold text-fg">Provider profiles</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Pick a provider, then edit its profile, transport, connection, and credential in one place. The Gateway checks
          and applies each change.
        </p>
      </header>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          size="sm"
          disabled={Boolean(addReason)}
          aria-describedby={addReason ? addReasonId : undefined}
          onClick={() => begin("new")}
        >
          Add provider profile
        </Button>
        <Button size="sm" disabled={catalog.loading} onClick={() => void catalog.reload()}>
          Refresh profiles
        </Button>
        {addReason ? (
          <p id={addReasonId} className="text-xs text-fg-muted">
            {addReason}
          </p>
        ) : null}
      </div>
      {catalog.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading saved provider profiles…
        </p>
      ) : null}
      {catalog.error ? (
        <p role="alert" className="text-sm text-status-failed">
          Provider profiles unavailable: {catalog.error}
        </p>
      ) : null}
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className="text-sm text-fg-secondary">
          {notice.message}
        </p>
      ) : null}
      <ProviderOutcomeCheck mutation={profile.mutation} reload={catalog.reload} />
      <ProviderChangeStatus
        change={profile.providerChange.change}
        onRefresh={profile.providerChange.refresh}
        onReview={setPlan}
      />
      <ProviderChangeStatus
        change={credentials.secretRemoval.change}
        onRefresh={credentials.secretRemoval.refresh}
        onReview={setPlan}
      />
      <ProviderList
        providers={catalog.providers}
        selectedId={id}
        activeProviderId={config?.activeProviderId}
        disabled={!ready || locked}
        disabledReason={!ready ? unavailableReason : busyReason}
        onSelect={(next) =>
          leave.request(() => {
            setSelectedId(next);
            setMode("selected");
          }, [profile.providerEditor.key])
        }
      />
      {provider ? (
        <div aria-label={`${provider.label} settings`} role="group" className="space-y-4">
          <div className="space-y-2">
            <h4 className="text-base font-semibold text-fg">Profile and transport</h4>
            <p className="text-sm text-fg-secondary">
              The provider's label, API style, credential mode, and advanced request transport.
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Button
                disabled={Boolean(editReason)}
                aria-describedby={editReason ? editReasonId : undefined}
                onClick={() => begin("selected")}
              >
                Edit provider profile
              </Button>
              <Button
                disabled={Boolean(editReason)}
                aria-describedby={editReason ? editReasonId : undefined}
                onClick={() => begin("selected", true)}
              >
                Edit request transport
              </Button>
              {editReason ? (
                <p id={editReasonId} className="text-xs text-fg-muted">
                  {editReason}
                </p>
              ) : null}
            </div>
          </div>
          <ProviderConnectionSettings
            providerId={id}
            credentialActions={
              <ProviderSavedCredential
                credentials={credentials}
                providerId={id}
                providerLabel={provider.label}
                blockedReason={removalReason}
                locked={locked}
                revision={config?.revision}
              />
            }
          />
        </div>
      ) : null}
      <Dialog
        open={open && !review}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={mode === "new" ? "New provider profile" : "Edit provider profile"}
        description="Save the profile here. Credentials are added separately through the secure credential action."
      >
        <div className="space-y-3">
          <ProviderProfileFields
            {...profile}
            disabled={!ready || locked}
            existing={mode === "selected"}
            transportOpen={transportOpen}
            credentialStorage={profile.providerEditor.value.credentialStorage}
            onCredentialStorage={profile.setCredentialStorage}
          />
          {profile.providerEditor.hasRemoteChanges ? (
            <div className="space-y-2 text-sm text-status-waiting">
              <p>
                Saved settings changed. Your draft started from an older version and is kept. Review the saved settings
                first.
              </p>
              <Button disabled={locked} onClick={profile.providerEditor.rebaseToCurrent}>
                Apply draft to latest version
              </Button>
            </div>
          ) : null}
          <ProviderOutcomeCheck mutation={profile.mutation} reload={catalog.reload} />
          {profile.saveOperationError ? (
            <p role="alert" className="text-sm text-status-waiting">
              {profile.saveOperationError}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={
                !ready ||
                locked ||
                !profile.providerEditor.isDirty ||
                // Applying an edit that sends the saved profile again can conflict and lock provider changes.
                !profile.sendsChanges ||
                profile.providerEditor.hasRemoteChanges ||
                Boolean(profile.providerRequestValidation.error) ||
                Boolean(profile.saveOperationError)
              }
              onClick={() =>
                setReview({
                  draft: profile.providerEditor.value,
                  revision: Number(profile.providerEditor.baseRevision),
                })
              }
            >
              Review provider profile
            </Button>
            <Button onClick={close}>Close profile editor</Button>
          </div>
        </div>
      </Dialog>
      <ProviderProfileReview
        draft={review?.draft ?? null}
        kind={profile.saveOperationKind}
        revision={review?.revision}
        current={currentReview}
        busy={locked}
        onCancel={() => setReview(null)}
        onConfirm={() => {
          if (currentReview) {
            setReview(null);
            void profile.handleSaveProvider();
          }
        }}
      />
      <ProviderOAuthSettings
        oauth={oauth}
        setup={setup}
        configured={catalog.providers.some((item) => item.providerId === "openai-codex")}
        onReview={setPlan}
      />
      <ProviderDraftLeave {...leave.dialogProps} />
      <ChatChangePlanActionDialog
        plan={plan}
        pending={actions.mutation.pending || Boolean(actions.mutation.uncertain)}
        onClose={() => setPlan(null)}
        onConfirm={actions.confirm}
        onSubmitSecureInput={actions.secure}
        onContinueOAuth={(reviewed) => oauth.handleStartCodexOAuth(true, reviewed)}
        renderApprovalAction={(reviewed, pending) => (
          <SettingsApprovalOwnerAction
            plan={reviewed}
            owner="provider-management"
            workspaceId={activeWorkspaceId ?? "default"}
            disabled={pending}
            viewIdentity={[id, open, mode]}
          />
        )}
        onSubmitPublicForm={() => undefined}
        onReviewArtifacts={() => undefined}
        onOpenNativePathPicker={() => undefined}
      />
    </section>
  );
}
