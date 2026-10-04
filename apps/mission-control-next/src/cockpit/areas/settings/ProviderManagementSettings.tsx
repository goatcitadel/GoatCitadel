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
import { ProviderProfileFields, providerFieldClass } from "./ProviderProfileFields";
import { ProviderProfileReview } from "./ProviderProfileReview";
import { ProviderChangeStatus } from "./ProviderChangeStatus";
import { ProviderDraftLeave } from "./ProviderDraftLeave";
import { ProviderOAuthSettings } from "./ProviderOAuthSettings";
import { useProviderCodexSetup } from "../../../features/native-routes/settings/sections/use-provider-codex-setup";

export function ProviderManagementSettings() {
  const providerLabelId = useId();
  const catalog = useProviderModelCatalog("system");
  const { activeWorkspaceId } = useUiPreferences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"selected" | "new">("selected");
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
  const begin = (nextMode: "selected" | "new") =>
    leave.request(() => {
      setMode(nextMode);
      setOpen(true);
      setReview(null);
    }, [profile.providerEditor.key]);
  return (
    <section aria-label="Provider profiles" className="mt-4 space-y-3 rounded-lg border border-line bg-raised p-4">
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Provider profiles</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Create and edit installation profiles. Connection and credential actions remain governed by the Gateway.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!ready || locked} onClick={() => begin("new")}>
          Add provider profile
        </Button>
        <Button size="sm" disabled={catalog.loading} onClick={() => void catalog.reload()}>
          Refresh profiles
        </Button>
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
      <label className="block text-sm text-fg-secondary">
        <span id={providerLabelId}>Manage provider</span>
        <select
          aria-labelledby={providerLabelId}
          className={providerFieldClass}
          value={id}
          disabled={!ready || locked}
          onChange={(event) => {
            const next = event.target.value;
            leave.request(() => {
              setSelectedId(next);
              setMode("selected");
            }, [profile.providerEditor.key]);
          }}
        >
          {!provider ? (
            <option value={id}>{id ? "Selected provider unavailable" : "No configured provider"}</option>
          ) : null}
          {catalog.providers.map((item) => (
            <option key={item.providerId} value={item.providerId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!ready || !provider || locked} onClick={() => begin("selected")}>
          Edit provider profile
        </Button>
        <Button
          variant="danger"
          disabled={
            !ready ||
            !provider ||
            locked ||
            id === "openai-codex" ||
            credentials.secretRemoval.hasPending ||
            !credentials.secretState.data?.hasSecret
          }
          onClick={() => provider && credentials.setPendingDeleteSecret({ providerId: id, label: provider.label })}
        >
          Remove saved API credential
        </Button>
      </div>
      {credentials.secretState.data ? (
        <p className="text-xs text-fg-muted">
          Credential owner:{" "}
          {credentials.secretState.data.hasSecret
            ? `Present (${credentials.secretState.data.source})`
            : "No stored API credential"}
          . Secret values are not returned.
        </p>
      ) : null}
      {credentials.secretState.error ? (
        <p role="alert" className="text-sm text-status-failed">
          Credential status unavailable: {credentials.secretState.error}
        </p>
      ) : null}
      {notice ? (
        <p role={notice.tone === "error" ? "alert" : "status"} className="text-sm text-fg-secondary">
          {notice.message}
        </p>
      ) : null}
      {profile.mutation.uncertain ? (
        <p role="alert" className="text-sm text-status-waiting">
          {profile.mutation.uncertain}
        </p>
      ) : null}
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
      <Dialog
        open={open && !review}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        title={mode === "new" ? "New provider profile" : "Edit provider profile"}
        description="Public configuration uses the existing Gateway settings owner. Credentials are supplied in a separate secure action."
      >
        <div className="space-y-3">
          <ProviderProfileFields
            {...profile}
            disabled={!ready || locked}
            existing={mode === "selected"}
            credentialStorage={profile.providerEditor.value.credentialStorage}
            onCredentialStorage={profile.setCredentialStorage}
          />
          {profile.providerEditor.hasRemoteChanges ? (
            <div className="space-y-2 text-sm text-status-waiting">
              <p>Saved settings changed. Review the refreshed owner before rebasing this retained draft.</p>
              <Button disabled={locked} onClick={profile.providerEditor.rebaseToCurrent}>
                Apply draft to current revision
              </Button>
            </div>
          ) : null}
          {profile.mutation.uncertain ? (
            <p role="alert" className="text-sm text-status-waiting">
              {profile.mutation.uncertain}
            </p>
          ) : null}
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
      <Dialog
        open={Boolean(credentials.pendingDeleteSecret)}
        onOpenChange={(next) => {
          if (!next && !credentials.deleteSecretBusy) credentials.setPendingDeleteSecret(null);
        }}
        title="Remove saved API credential?"
        description={`Remove the stored API credential for ${credentials.pendingDeleteSecret?.label ?? "this provider"}. Requests using it may fail until a replacement is configured.`}
      >
        <p className="mb-3 text-sm text-fg-secondary">
          Reviewed settings revision {credentials.pendingDeleteSecret?.revision}. The Gateway governs removal of all
          saved API key storage sources.
        </p>
        {credentials.pendingDeleteSecret?.revision !== config?.revision ? (
          <p role="alert" className="mb-3 text-sm text-status-waiting">
            Settings changed. Close and review removal again.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={locked || credentials.pendingDeleteSecret?.revision !== config?.revision}
            onClick={() => void credentials.handleDeleteSecret()}
          >
            Request credential removal
          </Button>
          <Button disabled={credentials.deleteSecretBusy} onClick={() => credentials.setPendingDeleteSecret(null)}>
            Keep credential
          </Button>
        </div>
      </Dialog>
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
