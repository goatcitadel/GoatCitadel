import { useState } from "react";
import {
  GOOGLE_WORKSPACE_CAPABILITY_DEFINITIONS,
  getGoogleWorkspaceCapability,
  type GoogleWorkspaceCapability,
  type GoogleWorkspaceOAuthStatus,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { Button } from "../../../cockpit/ui/Button";
import { Dialog } from "../../../cockpit/ui/Dialog";
import { Field } from "../../../cockpit/ui/Field";
import { TechnicalDetails } from "../../../cockpit/ui/TechnicalDetails";
import { TimeText } from "../../../cockpit/ui/TimeText";
import { cockpitInputClass } from "../../../cockpit/ui/input-class";
import { useGoogleWorkspaceSignIn } from "./use-google-workspace-sign-in";

/**
 * Connect Google for one Gmail and Google Calendar connection: readiness per capability, a scope review
 * before Google's consent page opens, and Disconnect. Writes stay approval-gated tools either way.
 */
export function GoogleWorkspaceSignIn({
  connection,
  onChanged,
}: {
  connection: IntegrationConnection;
  /** Re-reads the saved connection after sign-in changed its capability switches or status. */
  onChanged: () => void;
}) {
  const signIn = useGoogleWorkspaceSignIn(connection.connectionId, onChanged);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const status = signIn.status.data;
  const busy = Boolean(signIn.busy);
  return (
    <section aria-label="Google sign-in" className="space-y-3 border-t border-line-subtle pt-4 text-sm">
      <h4 className="font-semibold">Google sign-in</h4>
      {signIn.status.isLoading ? <p className="text-fg-muted">Loading Google sign-in…</p> : null}
      {signIn.status.isError ? (
        <p className="text-status-failed">
          Google sign-in status unavailable: {describeApiError(signIn.status.error).summary}
        </p>
      ) : null}
      {status ? <SignInSummary status={status} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={!status || busy || !status.keychainAvailable || !status.clientIdConfigured}
          onClick={() => setReviewOpen(true)}
        >
          {status?.connected ? "Reconnect Google" : "Connect Google"}
        </Button>
        {status?.connected || status?.requiresReauth ? (
          <Button disabled={busy} onClick={() => setConfirmDisconnect(true)}>
            Disconnect Google
          </Button>
        ) : null}
        <Button size="sm" disabled={busy || signIn.status.isFetching} onClick={() => void signIn.status.refetch()}>
          Refresh sign-in status
        </Button>
      </div>
      {status && !status.clientIdConfigured ? (
        <p className="text-fg-muted">Save the OAuth client ID with Edit integration connection before connecting.</p>
      ) : null}
      {signIn.flow ? (
        <div className="space-y-2 rounded-md border border-line p-3">
          <p>
            Finish on Google&apos;s page. When Google sends you back, this page completes the connection. Keep this tab
            open.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={signIn.flow.authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent underline"
            >
              Open Google sign-in
            </a>
            <Button size="sm" onClick={signIn.cancel}>
              Cancel sign-in
            </Button>
          </div>
        </div>
      ) : null}
      {signIn.busy === "complete" ? <p className="text-fg-muted">Finishing Google sign-in…</p> : null}
      {signIn.outcome ? (
        <p
          role={signIn.outcome.tone === "error" ? "alert" : "status"}
          className={signIn.outcome.tone === "error" ? "text-status-waiting" : "text-fg-secondary"}
        >
          {signIn.outcome.message}
        </p>
      ) : null}
      {status ? <SignInDetails status={status} /> : null}
      {status ? (
        <CapabilityReview
          key={String(reviewOpen)}
          open={reviewOpen}
          status={status}
          pending={signIn.busy === "start"}
          onCancel={() => setReviewOpen(false)}
          onContinue={async (capabilities, clientSecret) => {
            if (await signIn.start(capabilities, clientSecret)) setReviewOpen(false);
          }}
        />
      ) : null}
      <ConfirmModal
        className="min-w-0 grid-cols-1 break-words"
        open={confirmDisconnect}
        title="Disconnect Google?"
        message="GoatCitadel asks Google to end its access for this account, then removes the stored sign-in from this computer. The Gmail and Calendar tools stop working until you connect again. The saved client secret stays."
        confirmLabel="Disconnect Google"
        cancelLabel="Keep Google connected"
        pending={signIn.busy === "disconnect"}
        confirmDisabled={busy}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => {
          setConfirmDisconnect(false);
          void signIn.disconnect();
        }}
      />
    </section>
  );
}

function SignInSummary({ status }: { status: GoogleWorkspaceOAuthStatus }) {
  const headline = status.connected
    ? `Signed in${status.accountLabel ? ` as ${status.accountLabel}` : ""}.`
    : status.requiresReauth
      ? "The Google sign-in needs to be renewed. Connect Google again."
      : "Not signed in to Google.";
  return (
    <div className="space-y-2">
      <p className="text-fg-secondary">{headline}</p>
      {!status.keychainAvailable ? (
        <p className="text-status-waiting">
          The OS keychain is unavailable, so GoatCitadel cannot keep a Google sign-in on this computer.
        </p>
      ) : null}
      {status.legacyAccessTokenConfigured ? (
        <p className="text-status-waiting">
          A pasted access token is still saved on this connection. The tools ignore it and use the Google sign-in only;
          remove it with Edit integration connection.
        </p>
      ) : null}
      <ul className="space-y-1">
        {status.capabilities.map((item) => {
          const definition = getGoogleWorkspaceCapability(item.capability);
          const state = !item.enabled
            ? "Off"
            : item.granted && status.connected
              ? "On, allowed by Google"
              : "On, not allowed by Google yet";
          return (
            <li key={item.capability} className="break-words">
              <span className="font-medium text-fg">{definition.label}</span> · {state}
              {definition.write ? " · Asks for approval every time" : ""}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SignInDetails({ status }: { status: GoogleWorkspaceOAuthStatus }) {
  return (
    <TechnicalDetails label="Google sign-in details">
      <dl className="grid min-w-0 gap-1 text-xs">
        <dt>Redirect address</dt>
        <dd className="break-all font-mono">{status.redirectUri}</dd>
        <dt>Client secret</dt>
        <dd>
          {status.clientSecretSource === "keychain"
            ? "OS keychain"
            : status.clientSecretSource === "env"
              ? "Environment variable"
              : "Not set"}
        </dd>
        <dt>Granted scopes</dt>
        <dd className="break-all font-mono">{status.grantedScopes.join(" ") || "None"}</dd>
        {status.accessTokenExpiresAt ? (
          <>
            <dt>Access token</dt>
            <dd>
              <TimeText prefix="expires" value={status.accessTokenExpiresAt} />. Renewed automatically before use.
            </dd>
          </>
        ) : null}
      </dl>
    </TechnicalDetails>
  );
}

function CapabilityReview({
  open,
  status,
  pending,
  onCancel,
  onContinue,
}: {
  open: boolean;
  status: GoogleWorkspaceOAuthStatus;
  pending: boolean;
  onCancel: () => void;
  onContinue: (capabilities: GoogleWorkspaceCapability[], clientSecret: string) => Promise<void>;
}) {
  const [selected, setSelected] = useState<GoogleWorkspaceCapability[]>(() => {
    const enabled = status.capabilities.filter((item) => item.enabled).map((item) => item.capability);
    return enabled.length ? enabled : ["gmail.read"];
  });
  const [clientSecret, setClientSecret] = useState("");
  const needsSecret = status.clientSecretSource === "none";
  const toggle = (capability: GoogleWorkspaceCapability, checked: boolean) =>
    setSelected((current) =>
      checked
        ? [...current.filter((item) => item !== capability), capability]
        : current.filter((item) => item !== capability),
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
      title="Review Google access"
      description="Choose what GoatCitadel may do with this Google account. Google shows the same list on its consent page, and you can still untick items there."
    >
      <div className="space-y-4 text-sm">
        <fieldset className="space-y-3" disabled={pending}>
          <legend className="font-medium">Access to request</legend>
          {GOOGLE_WORKSPACE_CAPABILITY_DEFINITIONS.map((definition) => (
            <label key={definition.capability} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 accent-accent"
                checked={selected.includes(definition.capability)}
                onChange={(event) => toggle(definition.capability, event.target.checked)}
              />
              <span className="min-w-0 space-y-1">
                <span className="block font-medium text-fg">{definition.label}</span>
                <span className="block text-fg-secondary">{definition.description}</span>
                <span className="block break-all font-mono text-xs text-fg-muted">{definition.scope}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <Field
          label={needsSecret ? "Client secret" : "Replace client secret (optional)"}
          required={needsSecret}
          help={
            needsSecret
              ? "From the same Desktop app client in Google Cloud. It is kept in the OS keychain, never in this connection."
              : "Leave empty to keep the saved secret."
          }
        >
          {(fieldProps) => (
            <input
              {...fieldProps}
              type="password"
              autoComplete="off"
              maxLength={512}
              value={clientSecret}
              disabled={pending}
              className={cockpitInputClass}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          )}
        </Field>
        <p className="text-fg-muted">
          Google returns you to <span className="break-all font-mono">{status.redirectUri}</span> on this computer.
          Connecting again replaces the current sign-in with exactly the access chosen here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            loading={pending}
            loadingLabel="Preparing…"
            disabled={!selected.length || (needsSecret && !clientSecret.trim())}
            onClick={() => void onContinue(selected, clientSecret)}
          >
            Continue to Google
          </Button>
          <Button disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
