import { useId } from "react";
import type { useProviderCredentials } from "../../../features/native-routes/settings/sections/use-provider-credentials";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

type Credentials = ReturnType<typeof useProviderCredentials>;

/** Why "Remove saved API credential" can't be used right now, or nothing when it can. */
export function credentialRemovalBlockedReason(input: {
  ready: boolean;
  providerId: string;
  hasProvider: boolean;
  locked: boolean;
  removalPending: boolean;
  secret: Credentials["secretState"];
}): string | undefined {
  if (!input.ready || !input.hasProvider) return "Select a saved provider first.";
  if (input.providerId === "openai-codex")
    return "ChatGPT OAuth signs in without a saved API credential. Manage it under ChatGPT OAuth.";
  if (input.locked) return "Finish the provider change in progress first.";
  if (input.removalPending) return "A credential removal is already in progress. Review it below.";
  if (input.secret.loading) return "Checking for a saved credential…";
  if (input.secret.error) return "The saved credential couldn't be checked. Refresh profiles.";
  if (!input.secret.data?.hasSecret) return "There is no saved API credential to remove.";
  return undefined;
}

/** Saved-credential status and removal for the selected provider, shown with its credential controls. */
export function ProviderSavedCredential({
  credentials,
  providerId,
  providerLabel,
  blockedReason,
  locked,
  revision,
}: {
  credentials: Credentials;
  providerId: string;
  providerLabel?: string;
  blockedReason?: string;
  locked: boolean;
  revision?: number;
}) {
  const reasonId = useId();
  const pending = credentials.pendingDeleteSecret;
  return (
    <div className="space-y-2">
      {credentials.secretState.data ? (
        <p className="text-xs text-fg-muted">
          Saved credential:{" "}
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          variant="danger"
          disabled={Boolean(blockedReason)}
          aria-describedby={blockedReason ? reasonId : undefined}
          onClick={() => providerLabel && credentials.setPendingDeleteSecret({ providerId, label: providerLabel })}
        >
          Remove saved API credential
        </Button>
        {blockedReason ? (
          <p id={reasonId} className="text-xs text-fg-muted">
            {blockedReason}
          </p>
        ) : null}
      </div>
      <Dialog
        open={Boolean(pending)}
        onOpenChange={(next) => {
          if (!next && !credentials.deleteSecretBusy) credentials.setPendingDeleteSecret(null);
        }}
        title="Remove saved API credential?"
        description={`Remove the stored API credential for ${pending?.label ?? "this provider"}. Requests using it may fail until a replacement is configured.`}
      >
        <p className="mb-3 text-sm text-fg-secondary">
          Reviewed settings version {pending?.revision}. GoatCitadel handles removal from each place the API key is
          saved.
        </p>
        {pending?.revision !== revision ? (
          <p role="alert" className="mb-3 text-sm text-status-waiting">
            Settings changed. Close and review removal again.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="danger"
            disabled={locked || pending?.revision !== revision}
            onClick={() => void credentials.handleDeleteSecret()}
          >
            Request credential removal
          </Button>
          <Button disabled={credentials.deleteSecretBusy} onClick={() => credentials.setPendingDeleteSecret(null)}>
            Keep credential
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
