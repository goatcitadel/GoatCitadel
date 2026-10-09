import { useState } from "react";
import { useProviderModelCatalog, type ProviderModelCatalogOption } from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { Button } from "../../ui/Button";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { canReviewConnectionPlan, connectionPlanCompleted } from "./provider-connection-state";
import { useProviderConnectionEditor } from "./use-provider-connection-editor";

export function ProviderConnectionSettings() {
  const catalog = useProviderModelCatalog("system");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const id = selectedId ?? catalog.config?.activeProviderId ?? catalog.providers[0]?.providerId;
  const provider = catalog.providers.find((item) => item.providerId === id);
  const ready = Boolean(catalog.config && !catalog.loading && !catalog.error
    && Number.isSafeInteger(catalog.config.revision) && catalog.config.revision > 0);
  return <section aria-labelledby="provider-connection-title" className="mt-4 rounded-lg border border-line bg-sunken p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 id="provider-connection-title" className="font-display text-md font-semibold text-fg">Provider connection</h3>
        <p className="mt-1 text-sm text-fg-secondary">Review an endpoint or API credential change for this installation. The Gateway owns validation and application.</p></div>
      <Button size="sm" disabled={catalog.loading} onClick={() => void catalog.reload()}>Refresh connection</Button>
    </div>
    {catalog.loading ? <p role="status" className="mt-3 text-sm text-fg-muted">Loading current provider settings…</p> : null}
    {catalog.error ? <p role="alert" className="mt-3 text-sm text-status-failed">Current provider settings are unavailable. Refresh before editing.</p> : null}
    <label className="mt-3 block text-sm font-medium text-fg">Edit provider
      <select className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 text-fg" value={id ?? ""}
        disabled={!ready} onChange={(event) => setSelectedId(event.target.value)}>
        {!provider ? <option value={id ?? ""}>{id ? "Selected provider unavailable" : "No provider configured"}</option> : null}
        {catalog.providers.map((item) => <option key={item.providerId} value={item.providerId}>{item.label}</option>)}
      </select>
    </label>
    {provider && catalog.config ? <ProviderConnectionEditor key={provider.providerId} provider={provider}
      registeredEnvVar={catalog.config.providerConfigs?.find((item) => item.providerId === provider.providerId)?.apiKeyEnv}
      revision={catalog.config.revision} available={ready} reload={catalog.reload} /> : <p className="mt-3 text-sm text-fg-muted">Select a configured provider to edit its connection.</p>}
  </section>;
}

function ProviderConnectionEditor({ provider, registeredEnvVar, revision, available, reload }: {
  provider: ProviderModelCatalogOption; registeredEnvVar?: string; revision: number; available: boolean; reload: () => Promise<unknown>;
}) {
  const editor = useProviderConnectionEditor(provider, revision, reload, available);
  const [credentialStorage, setCredentialStorage] = useState<"keychain" | "env">("keychain");
  const { draft, attempt, blocked } = editor;
  const credentialEditable = !provider.authMode || provider.authMode === "api-key";
  const disabled = !available || blocked || editor.refreshing;
  const plan = attempt?.plan;
  const pendingCredential = blocked && attempt?.request.credentialAction === "replace_api_key" ? attempt.request : undefined;
  const shownStorage = pendingCredential?.credentialStorage ?? credentialStorage;
  const shownEnvVar = pendingCredential?.credentialEnvVar ?? registeredEnvVar?.trim() ?? "";
  const dialogRequest = editor.dialog?.request;
  const reviewNote = dialogRequest?.kind === "provider_connection" && dialogRequest.credentialAction === "replace_api_key"
    ? dialogRequest.credentialStorage === "env"
      ? `Credential storage: plaintext in this installation's environment file, variable ${dialogRequest.credentialEnvVar}. Anyone who can read that file can read the credential.`
      : "Credential storage: OS keychain. A keychain failure will not switch storage automatically."
    : dialogRequest?.kind === "provider_connection" && dialogRequest.profile?.baseUrl
      ? `New endpoint: ${dialogRequest.profile.baseUrl}. Provider requests, including the live connection check, will use this address with the configured credential.`
      : undefined;
  return <div className="mt-4 space-y-3">
    <p className="text-xs text-fg-muted">Settings revision {revision} · Credential: {provider.hasApiKey ? "Configured" : "Not reported as configured"}. Saved values are never displayed.</p>
    <label className="block text-sm font-medium text-fg">Provider endpoint
      <input type="url" autoComplete="off" spellCheck={false} value={draft.value} disabled={disabled} maxLength={2048}
        onChange={(event) => draft.setValue(event.target.value)}
        className="mt-1 block min-h-11 w-full min-w-0 rounded-md border border-line bg-canvas px-3 text-fg" />
    </label>
    <p className="text-xs text-fg-muted">Use the provider API base URL. Credentials belong in the secure credential step.</p>
    {draft.isDirty ? <p role="status" className="text-xs text-status-waiting">Unsaved endpoint draft</p> : null}
    {draft.hasRemoteChanges ? <div role="status" className="space-y-2 text-sm text-status-waiting">
      <p>The provider changed after this draft began. Review the current endpoint before rebasing.</p>
      <p className="break-all">Current endpoint: {provider.sanitizedEndpointIdentity ?? "Inspect the current provider owner"}</p>
      <Button size="sm" disabled={disabled} onClick={draft.rebaseToCurrent}>Review draft against current revision</Button>
    </div> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={disabled || !draft.isDirty || draft.hasRemoteChanges} onClick={editor.prepareEndpoint}>Review endpoint change</Button>
      <Button size="sm" disabled={disabled || !draft.isDirty} onClick={draft.discard}>Discard endpoint draft</Button>
    </div>
    {credentialEditable ? <fieldset className="space-y-2 border-t border-line-subtle pt-3" disabled={disabled || draft.isDirty || draft.hasRemoteChanges}>
      <legend className="pt-3 text-sm font-medium text-fg">API credential</legend>
      <label className="block text-sm text-fg">Credential storage
        <select className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-2 text-fg" value={shownStorage}
          onChange={(event) => setCredentialStorage(event.target.value as "keychain" | "env")}>
          <option value="keychain">OS keychain (default)</option>
          <option value="env">Installation environment file (plaintext)</option>
        </select>
      </label>
      {shownStorage === "env" ? <>
        <p className="text-sm text-status-waiting">This explicitly saves the credential as plaintext in the installation's environment file. Anyone who can read that file can read the credential.</p>
        <label className="block text-sm text-fg">Environment variable name
          <input value={shownEnvVar} readOnly autoComplete="off" spellCheck={false}
            className="mt-1 block min-h-11 w-full rounded-md border border-line bg-canvas px-3 text-fg" />
        </label>
        <p className="text-xs text-fg-muted">The Gateway owns this registered variable and checks reserved names and shared ownership before saving.</p>
        {!shownEnvVar ? <p className="text-sm text-status-waiting">No environment variable is registered. Configure the provider profile in the classic Settings view first.</p> : null}
      </> : <p className="text-xs text-fg-muted">A keychain failure will not switch storage automatically.</p>}
      <Button size="sm" disabled={disabled || draft.isDirty || draft.hasRemoteChanges || (shownStorage === "env" && !shownEnvVar)}
        onClick={() => editor.prepareCredential(credentialStorage, shownEnvVar)}>Replace API credential</Button>
    </fieldset> : null}
    {!credentialEditable ? <p className="text-sm text-fg-muted">This provider uses {humanizeToken(provider.authMode ?? "managed authentication")}. Use its existing authentication setup below or in the classic Settings view.</p> : null}
    {draft.isDirty ? <p className="text-xs text-fg-muted">Finish or discard the endpoint draft before replacing its credential.</p> : null}
    {attempt ? <div className="space-y-2 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
      <p role={attempt.uncertain ? "alert" : "status"}>{attempt.message}</p>
      {attempt.uncertain && attempt.transport ? <Button size="sm" disabled={!available || attempt.busy || editor.refreshing}
        onClick={() => void editor.checkOutcome()}>Check outcome</Button> : null}
      {plan ? <>
        <p className="font-medium text-fg">{plan.title} · {humanizeToken(plan.status)}</p>
        <p className="break-words">{plan.summary}</p><p className="break-words">Impact: {plan.impact}</p>
        {plan.result?.summary && plan.result.summary !== plan.summary ? <p className="break-words">Owner result: {plan.result.summary}</p> : null}
        <p className="text-xs">Risk: {humanizeToken(plan.risk)} · Plan revision {plan.revision}</p>
        {connectionPlanCompleted(plan) && attempt.verified && !attempt.uncertain ? <p className="text-status-done">The Gateway reports this change complete. Current provider evidence confirms the saved change.</p> : null}
        {connectionPlanCompleted(plan) && !attempt.verified ? <p role="status">The plan reports completion; current provider evidence is not yet confirmed.</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={attempt.busy || editor.refreshing} onClick={() => void editor.refresh()}>Refresh connection change</Button>
          {canReviewConnectionPlan(plan) && !attempt.uncertain ? <Button size="sm" variant="primary" disabled={!available || attempt.busy || editor.refreshing} onClick={() => editor.setDialog(plan)}>Review current step</Button> : null}
          {plan.requiredAction?.kind === "approval" ? <ClassicOwnerLink href="/ops/approvals?shell=classic" scope={JSON.stringify([provider.providerId, plan.planId])} className="text-accent hover:underline" label="Review required approval" /> : null}
        </div>
        <details><summary className="cursor-pointer text-fg-muted">Change evidence</summary>
          <p className="mt-2 break-all">Plan {plan.planId} · installation workspace {plan.origin.workspaceId}</p>
          <p className="break-all">{plan.evidenceRefs.length ? plan.evidenceRefs.join(", ") : "No evidence recorded yet"}</p>
        </details>
      </> : null}
    </div> : null}
    {editor.error ? <p role="alert" className="text-sm text-status-failed">{editor.error}</p> : null}
    {attempt?.uncertain || (plan && !canReviewConnectionPlan(plan) && !connectionPlanCompleted(plan))
      ? <ClassicOwnerLink href="/settings/providers?shell=classic" scope={JSON.stringify([provider.providerId, plan?.planId])} className="inline-block text-sm font-medium text-accent hover:underline" label="Inspect provider activity in the classic view" /> : null}
    <ChatChangePlanActionDialog plan={editor.dialog} contextNote={reviewNote} pending={Boolean(attempt?.busy)} onClose={() => editor.setDialog(null)}
      onConfirm={(reviewed) => editor.act(reviewed)}
      onSubmitSecureInput={(reviewed, values) => editor.act(reviewed, values.credential ?? values.apiKey ?? "")}
      onSubmitPublicForm={() => undefined} onContinueOAuth={() => undefined} onOpenApproval={() => undefined}
      onReviewArtifacts={() => undefined} onOpenNativePathPicker={() => undefined} />
  </div>;
}
