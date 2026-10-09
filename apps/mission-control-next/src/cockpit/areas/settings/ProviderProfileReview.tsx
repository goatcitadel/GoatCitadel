import type { ProviderSaveDraft } from "../../../features/native-routes/settings/sections/provider-save-contract";
import { Dialog } from "../../ui/Dialog";
import { Button } from "../../ui/Button";

export function ProviderProfileReview({
  draft,
  kind,
  revision,
  current,
  busy,
  onCancel,
  onConfirm,
}: {
  draft: ProviderSaveDraft | null;
  kind?: "profile" | "transport";
  revision?: number;
  current: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const transport = draft?.transport;
  return (
    <Dialog
      open={Boolean(draft)}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      title={kind === "transport" ? "Review provider transport" : "Review provider profile"}
      description={
        kind === "transport"
          ? "Apply only request transport through the dedicated Gateway configuration owner with the exact reviewed revision."
          : "Submit this public profile through the Gateway's governed Settings change plan. Saved transport stays unchanged."
      }
    >
      {draft ? (
        <div className="space-y-3 text-sm text-fg-secondary">
          <p>Reviewed settings revision {revision}</p>
          {draft.governedCreation ? (
            <p>
              Credential storage:{" "}
              {draft.credentialStorage === "env"
                ? `plaintext in this installation's environment file (${draft.provider.apiKeyEnv}). Anyone who can read that file can read the credential.`
                : "OS keychain. A keychain failure will not fall back to an environment file."}
            </p>
          ) : null}
          <dl className="space-y-2">
            {Object.entries({
              "Provider ID": draft.provider.providerId,
              Label: draft.provider.label,
              "Base URL": draft.provider.baseUrl,
              "API style": draft.provider.apiStyle,
              "Credential mode": draft.provider.authMode || "Provider default",
              "Profile default model": draft.provider.defaultModel || "Gateway default",
              "Credential environment reference": draft.provider.apiKeyEnv || "None",
              "Google project": draft.provider.googleProjectId,
              "Google project environment": draft.provider.googleProjectIdEnv,
              "Google location": draft.provider.googleLocation,
              "Google location environment": draft.provider.googleLocationEnv,
              "Google endpoint": draft.provider.googleEndpointId,
            })
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="font-medium text-fg">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
          </dl>
          <p>
            Requests and connection checks will use this endpoint with the configured credential. Saving the profile
            does not select it as the installation default.
          </p>
          {transport && (transport.tls.insecureSkipVerify || transport.proxyTls.insecureSkipVerify) ? (
            <p role="alert" className="rounded border border-status-waiting p-3 text-status-waiting">
              Certificate verification will be disabled for{" "}
              {transport.tls.insecureSkipVerify ? "provider requests" : ""}
              {transport.tls.insecureSkipVerify && transport.proxyTls.insecureSkipVerify ? " and " : ""}
              {transport.proxyTls.insecureSkipVerify ? "proxy requests" : ""} to {draft.provider.baseUrl}. An
              impersonated endpoint could receive prompts, responses and credentials. This applies to this provider
              across the installation.
            </p>
          ) : null}
          {transport ? (
            <details>
              <summary className="cursor-pointer">Reviewed transport configuration</summary>
              <dl className="mt-2 space-y-2">
                {Object.entries({
                  "Request headers": transport.headersJson || "None",
                  "Request auth mode": transport.auth.mode,
                  "Request token environment": transport.auth.tokenEnv,
                  "Request header": transport.auth.headerName,
                  "Request value environment": transport.auth.valueEnv,
                  "Request scheme": transport.auth.scheme,
                  "Query parameter": transport.auth.queryParam,
                  "Query prefix": transport.auth.prefix,
                  "Proxy URL": transport.proxyUrl,
                  "Proxy bypass hosts": transport.proxyBypassHostsText,
                  "Proxy auth mode": transport.proxyAuth.mode,
                  "Proxy header": transport.proxyAuth.headerName,
                  "Proxy token environment": transport.proxyAuth.tokenEnv,
                  "Proxy value environment": transport.proxyAuth.valueEnv,
                  "Proxy scheme": transport.proxyAuth.scheme,
                  "Request CA path": transport.tls.caCertPath,
                  "Request certificate path": transport.tls.clientCertPath,
                  "Request key path": transport.tls.clientKeyPath,
                  "Request server name": transport.tls.serverName,
                  "Proxy CA path": transport.proxyTls.caCertPath,
                  "Proxy certificate path": transport.proxyTls.clientCertPath,
                  "Proxy key path": transport.proxyTls.clientKeyPath,
                  "Proxy server name": transport.proxyTls.serverName,
                })
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt className="font-medium text-fg">{label}</dt>
                      <dd className="whitespace-pre-wrap break-words">{value}</dd>
                    </div>
                  ))}
              </dl>
              <p>
                Request certificate verification: {transport.tls.insecureSkipVerify ? "DISABLED (unsafe)" : "Enabled"}.
                Proxy certificate verification:{" "}
                {transport.proxyTls.insecureSkipVerify ? "DISABLED (unsafe)" : "Enabled"}.
              </p>
            </details>
          ) : null}
          {!current ? (
            <p role="alert" className="text-status-waiting">
              This review is stale. Close it and review the current draft and settings revision.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={
                transport && (transport.tls.insecureSkipVerify || transport.proxyTls.insecureSkipVerify)
                  ? "danger"
                  : "primary"
              }
              disabled={busy || !current}
              onClick={onConfirm}
            >
              {kind === "transport" ? "Apply reviewed transport" : "Apply reviewed provider profile"}
            </Button>
            <Button disabled={busy} onClick={onCancel}>
              Keep editing
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
