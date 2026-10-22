import { useId, useState, type ReactNode } from "react";
import {
  useProviderModelCatalog,
  type ProviderModelCatalogOption,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { Button } from "../../ui/Button";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { urlFieldError, useBlurValidation } from "./field-validation";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { RiskBadge } from "../../ui/RiskBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { canReviewConnectionPlan, connectionPlanCompleted } from "./provider-connection-state";
import { useProviderConnectionEditor } from "./use-provider-connection-editor";
import {
  AWS_SIGV4_CREDENTIAL_HELP,
  AWS_SIGV4_CREDENTIAL_LABEL,
  AWS_SIGV4_SECURE_INPUT_NOTE,
  isBedrockCredentialMode,
  presentChangeStatusLabel,
  PROVIDER_AUTH_MODE_LABELS,
} from "./settings-vocabulary";

/**
 * The Connection and Credential parts of the one provider editor. The provider page owns the selection and
 * passes it in, so this panel never offers a second provider picker.
 */
export function ProviderConnectionSettings({
  providerId,
  credentialActions,
}: {
  providerId?: string;
  /** Saved-credential status and removal, shown with the credential controls. */
  credentialActions?: ReactNode;
}) {
  const titleId = useId();
  const catalog = useProviderModelCatalog("system");
  const id = providerId ?? catalog.config?.activeProviderId ?? catalog.providers[0]?.providerId;
  const provider = catalog.providers.find((item) => item.providerId === id);
  const ready = Boolean(
    catalog.config &&
    !catalog.loading &&
    !catalog.error &&
    Number.isSafeInteger(catalog.config.revision) &&
    catalog.config.revision > 0,
  );
  return (
    <section aria-labelledby={titleId} className="border-t border-line-subtle pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 id={titleId} className="text-base font-semibold text-fg">
            Provider connection
          </h4>
          <p className="mt-1 text-sm text-fg-secondary">
            The endpoint and API credential this provider uses. GoatCitadel checks and applies each change.
          </p>
        </div>
        <Button size="sm" disabled={catalog.loading} onClick={() => void catalog.reload()}>
          Refresh connection
        </Button>
      </div>
      {catalog.loading ? (
        <p role="status" className="mt-3 text-sm text-fg-muted">
          Loading current provider settings…
        </p>
      ) : null}
      {catalog.error ? (
        <p role="alert" className="mt-3 text-sm text-status-failed">
          Current provider settings are unavailable. Refresh before editing.
        </p>
      ) : null}
      {provider && catalog.config ? (
        <ProviderConnectionEditor
          key={provider.providerId}
          provider={provider}
          registeredEnvVar={
            catalog.config.providerConfigs?.find((item) => item.providerId === provider.providerId)?.apiKeyEnv
          }
          revision={catalog.config.revision}
          available={ready}
          reload={catalog.reload}
          credentialActions={credentialActions}
        />
      ) : (
        <p className="mt-3 text-sm text-fg-muted">
          {id ? "This provider is no longer saved. Refresh the connection." : "Select a saved provider first."}
        </p>
      )}
    </section>
  );
}

function ProviderConnectionEditor({
  provider,
  registeredEnvVar,
  revision,
  available,
  reload,
  credentialActions,
}: {
  provider: ProviderModelCatalogOption;
  registeredEnvVar?: string;
  revision: number;
  available: boolean;
  reload: () => Promise<unknown>;
  credentialActions?: ReactNode;
}) {
  const editor = useProviderConnectionEditor(provider, revision, reload, available);
  const draftReasonId = useId();
  const envReasonId = useId();
  const endpointCheck = useBlurValidation((value) => urlFieldError(value, { required: true }));
  const route = useCockpitRoute();
  const [credentialStorage, setCredentialStorage] = useState<"keychain" | "env">("keychain");
  const { draft, attempt, blocked } = editor;
  const credentialEditable =
    !provider.authMode || provider.authMode === "api-key" || isBedrockCredentialMode(provider.authMode);
  const sigV4 = provider.authMode === "aws-sigv4";
  const disabled = !available || blocked || editor.refreshing;
  const plan = attempt?.plan;
  const inspectionParams = new URLSearchParams(route.search);
  for (const key of ["shell", "shellScope", "item", "approvalId", "view", "planId"]) inspectionParams.delete(key);
  inspectionParams.set("workspaceId", plan?.origin.workspaceId ?? inspectionParams.get("workspaceId") ?? "default");
  inspectionParams.set("providerId", provider.providerId);
  inspectionParams.set("resourceId", provider.providerId);
  if (plan) {
    inspectionParams.set("item", `change_plan:${plan.planId}`);
    inspectionParams.set("planId", plan.planId);
    if (plan.origin.sessionId) inspectionParams.set("sessionId", plan.origin.sessionId);
    if (plan.origin.turnId) inspectionParams.set("turnId", plan.origin.turnId);
  }
  const inspectionHref = `${plan ? "/inbox" : "/system/activity"}?${inspectionParams}${route.hash}`;
  const pendingCredential =
    blocked && attempt?.request.credentialAction === "replace_api_key" ? attempt.request : undefined;
  const shownStorage = pendingCredential?.credentialStorage ?? credentialStorage;
  const shownEnvVar = pendingCredential?.credentialEnvVar ?? registeredEnvVar?.trim() ?? "";
  const dialogRequest = editor.dialog?.request;
  const storageNote =
    dialogRequest?.kind === "provider_connection" && dialogRequest.credentialAction === "replace_api_key"
      ? dialogRequest.credentialStorage === "env"
        ? `Credential storage: plaintext in this installation's environment file, variable ${dialogRequest.credentialEnvVar}. Anyone who can read that file can read the credential.`
        : "Credential storage: OS keychain. A keychain failure will not switch storage automatically."
      : dialogRequest?.kind === "provider_connection" && dialogRequest.profile?.baseUrl
        ? `New endpoint: ${dialogRequest.profile.baseUrl}. Provider requests, including the live connection check, will use this address with the configured credential.`
        : undefined;
  const reviewNote =
    sigV4 && dialogRequest?.kind === "provider_connection" && dialogRequest.credentialAction === "replace_api_key"
      ? `${AWS_SIGV4_SECURE_INPUT_NOTE} ${storageNote ?? ""}`.trim()
      : storageNote;
  return (
    <div className="mt-4 space-y-3">
      <p className="text-xs text-fg-muted">
        Settings version {revision} · Credential: {provider.hasApiKey ? "Configured" : "Not reported as configured"}.
        Saved values are never displayed.
      </p>
      <Field
        label="Provider endpoint"
        required
        help="Use the provider API base URL. Credentials belong in the secure credential step."
        error={endpointCheck.error}
      >
        {(fieldProps) => (
          <input
            {...fieldProps}
            aria-label="Provider endpoint"
            type="url"
            autoComplete="off"
            spellCheck={false}
            value={draft.value}
            disabled={disabled}
            maxLength={2048}
            onBlur={(event) => endpointCheck.onBlur(event.target.value)}
            onChange={(event) => {
              draft.setValue(event.target.value);
              endpointCheck.onChange(event.target.value);
            }}
            className={cockpitInputClass}
          />
        )}
      </Field>
      {draft.isDirty ? (
        <p role="status" className="text-xs text-status-waiting">
          Unsaved endpoint draft
        </p>
      ) : null}
      {draft.hasRemoteChanges ? (
        <div role="status" className="space-y-2 text-sm text-status-waiting">
          <p>The provider changed. Your draft started from an older version. Review the current endpoint first.</p>
          <p className="break-all">
            Current endpoint: {provider.sanitizedEndpointIdentity ?? "Unavailable. Refresh this provider."}
          </p>
          <Button size="sm" disabled={disabled} onClick={draft.rebaseToCurrent}>
            Apply draft to latest version
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={disabled || !draft.isDirty || draft.hasRemoteChanges || Boolean(endpointCheck.error)}
          onClick={editor.prepareEndpoint}
        >
          Review endpoint change
        </Button>
        <Button size="sm" disabled={disabled || !draft.isDirty} onClick={draft.discard}>
          Discard endpoint draft
        </Button>
      </div>
      {credentialEditable ? (
        <fieldset
          className="space-y-2 border-t border-line-subtle pt-3"
          disabled={disabled || draft.isDirty || draft.hasRemoteChanges}
        >
          <legend className="pt-3 text-sm font-medium text-fg">
            {sigV4 ? AWS_SIGV4_CREDENTIAL_LABEL : "API credential"}
          </legend>
          {sigV4 ? <p className="text-xs text-fg-muted">{AWS_SIGV4_CREDENTIAL_HELP}</p> : null}
          <Field label="Credential storage">
            {(fieldProps) => (
              <select
                {...fieldProps}
                className={cockpitInputClass}
                value={shownStorage}
                onChange={(event) => setCredentialStorage(event.target.value as "keychain" | "env")}
              >
                <option value="keychain">OS keychain (default)</option>
                <option value="env">Installation environment file (plaintext)</option>
              </select>
            )}
          </Field>
          {shownStorage === "env" ? (
            <>
              <p className="text-sm text-status-waiting">
                This explicitly saves the credential as plaintext in the installation's environment file. Anyone who can
                read that file can read the credential.
              </p>
              <Field
                label="Environment variable name"
                help="GoatCitadel manages this registered variable and checks reserved names and shared ownership before saving."
              >
                {(fieldProps) => (
                  <input
                    {...fieldProps}
                    value={shownEnvVar}
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    className={cockpitInputClass}
                  />
                )}
              </Field>
              {!shownEnvVar ? (
                <p id={envReasonId} className="text-sm text-status-waiting">
                  No environment variable is registered. Set API key environment variable with Edit provider profile
                  first.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-fg-muted">A keychain failure will not switch storage automatically.</p>
          )}
          {draft.isDirty ? (
            <p id={draftReasonId} className="text-xs text-fg-muted">
              Finish or discard the endpoint draft before replacing its credential.
            </p>
          ) : null}
          <Button
            size="sm"
            disabled={disabled || draft.isDirty || draft.hasRemoteChanges || (shownStorage === "env" && !shownEnvVar)}
            aria-describedby={
              draft.isDirty ? draftReasonId : shownStorage === "env" && !shownEnvVar ? envReasonId : undefined
            }
            onClick={() => editor.prepareCredential(credentialStorage, shownEnvVar)}
          >
            {sigV4 ? `Replace ${AWS_SIGV4_CREDENTIAL_LABEL}` : "Replace API credential"}
          </Button>
        </fieldset>
      ) : null}
      {!credentialEditable ? (
        <p className="text-sm text-fg-muted">
          This provider uses{" "}
          {(provider.authMode ? PROVIDER_AUTH_MODE_LABELS[provider.authMode] : undefined) ?? "managed authentication"}.
          Use its existing authentication setup below.
        </p>
      ) : null}
      {credentialActions}
      {attempt ? (
        <div className="space-y-2 border-t border-line-subtle pt-3 text-sm text-fg-secondary">
          <p role={attempt.uncertain ? "alert" : "status"}>{attempt.message}</p>
          {attempt.uncertain && attempt.transport ? (
            <Button
              size="sm"
              disabled={!available || attempt.busy || editor.refreshing}
              onClick={() => void editor.checkOutcome()}
            >
              Check outcome
            </Button>
          ) : null}
          {plan ? (
            <>
              <p className="font-medium text-fg">
                {plan.title} · {presentChangeStatusLabel(plan.status)}
              </p>
              <p className="break-words">{plan.summary}</p>
              <p className="break-words">Impact: {plan.impact}</p>
              {plan.result?.summary && plan.result.summary !== plan.summary ? (
                <p className="break-words">Result: {plan.result.summary}</p>
              ) : null}
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <RiskBadge risk={plan.risk} />
                <span>Plan version {plan.revision}</span>
              </p>
              {connectionPlanCompleted(plan) && attempt.verified && !attempt.uncertain ? (
                <p className="text-status-done">Change complete. The saved provider settings match it.</p>
              ) : null}
              {connectionPlanCompleted(plan) && !attempt.verified ? (
                <p role="status">The change reports complete, but the saved provider settings do not show it yet.</p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={attempt.busy || editor.refreshing} onClick={() => void editor.refresh()}>
                  Refresh connection change
                </Button>
                {canReviewConnectionPlan(plan) && !attempt.uncertain ? (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!available || attempt.busy || editor.refreshing}
                    onClick={() => editor.setDialog(plan)}
                  >
                    Review current step
                  </Button>
                ) : null}
                {plan.requiredAction?.kind === "approval" ? (
                  <SettingsApprovalOwnerAction
                    plan={plan}
                    owner="provider-management"
                    workspaceId="default"
                    viewIdentity={[provider.providerId, revision, plan.planId, plan.revision]}
                    disabled={!available || attempt.busy || editor.refreshing}
                  />
                ) : null}
              </div>
              <TechnicalDetails label="Change record">
                <p className="break-all font-mono text-xs">
                  Plan {plan.planId} · installation workspace {plan.origin.workspaceId}
                </p>
                <p className="break-all font-mono text-xs">
                  {plan.evidenceRefs.length ? plan.evidenceRefs.join(", ") : "Nothing recorded yet"}
                </p>
              </TechnicalDetails>
            </>
          ) : null}
        </div>
      ) : null}
      {editor.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {editor.error}
        </p>
      ) : null}
      {attempt?.uncertain || (plan && !canReviewConnectionPlan(plan) && !connectionPlanCompleted(plan)) ? (
        <NativeOwnerLink
          href={inspectionHref}
          scope={JSON.stringify([provider.providerId, revision, attempt?.planKey, plan?.planId, plan?.revision])}
          className="inline-block text-sm font-medium text-accent hover:underline"
        >
          {plan ? "Open connection change in Inbox" : "Open recent activity in System"}
        </NativeOwnerLink>
      ) : null}
      <ChatChangePlanActionDialog
        plan={editor.dialog}
        contextNote={reviewNote}
        pending={Boolean(attempt?.busy)}
        onClose={() => editor.setDialog(null)}
        onConfirm={(reviewed) => editor.act(reviewed)}
        onSubmitSecureInput={(reviewed, values) => editor.act(reviewed, values.credential ?? values.apiKey ?? "")}
        onSubmitPublicForm={() => undefined}
        onContinueOAuth={() => undefined}
        onOpenApproval={() => undefined}
        onReviewArtifacts={() => undefined}
        onOpenNativePathPicker={() => undefined}
      />
    </div>
  );
}
