import { useState } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type { WebSearchCredentialStatus } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  clearWebSearchCredential,
  fetchWebSearchCredentials,
  saveWebSearchCredential,
} from "@goatcitadel/mission-control-shared/api/web-search-settings";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { StatusBadge } from "../../ui/StatusBadge";
import { presentChangeStatusLabel } from "./settings-vocabulary";

export const WEB_SEARCH_CREDENTIALS_QUERY_KEY = ["settings", "web-search-credentials"] as const;

/** What a saved key changes. A Brave or Parallel key alone does not make Chat use that provider. */
const KEY_USE: Record<WebSearchCredentialStatus["targetId"], string> = {
  "search.firecrawl": "Used for every Firecrawl search and page read.",
  "search.brave": "Used only when a search asks for official providers (backend: official). It is not the default.",
  "search.parallel": "Used only when a search asks for official providers (backend: official). It is not the default.",
};

function sourceBadge(status: WebSearchCredentialStatus) {
  if (status.activeSource === "keychain") return { tone: "done" as const, label: "Saved in OS keychain" };
  if (status.activeSource === "env") return { tone: "done" as const, label: `From ${status.envNames.join(" or ")}` };
  return { tone: "neutral" as const, label: "Not set" };
}

/** Firecrawl, Brave, and Parallel keys: stored in the OS keychain, with the environment as fallback. */
export function WebSearchKeys({ settings }: { settings: UseQueryResult<RuntimeSettingsResponse> }) {
  const credentials = useQuery({
    queryKey: WEB_SEARCH_CREDENTIALS_QUERY_KEY,
    queryFn: ({ signal }) => fetchWebSearchCredentials({ signal }),
  });
  return (
    <div className="mt-4 border-t border-line-subtle pt-4">
      <h4 className="text-sm font-semibold text-fg">API keys</h4>
      <p className="mt-1 text-sm text-fg-secondary">
        Keys are checked live, then stored in the OS keychain. A saved key takes priority over its environment variable.
        GoatCitadel never shows a saved key again.
      </p>
      {credentials.isPending ? <p className="mt-3 text-sm text-fg-muted">Loading keys…</p> : null}
      {credentials.isError ? (
        <Callout tone="error">Could not load key status. {describeApiError(credentials.error).summary}</Callout>
      ) : null}
      {credentials.data ? (
        <ul className="mt-3 grid max-w-3xl gap-3">
          {credentials.data.items.map((status) => (
            <WebSearchKeyRow key={status.targetId} status={status} settings={settings} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WebSearchKeyRow({
  status,
  settings,
}: {
  status: WebSearchCredentialStatus;
  settings: UseQueryResult<RuntimeSettingsResponse>;
}) {
  const queryClient = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "remove">();
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string }>();
  const revision = settings.data?.revision;

  async function run(action: "save" | "remove") {
    if (!revision) return;
    setBusy(action);
    setMessage(undefined);
    try {
      const response =
        action === "save"
          ? await saveWebSearchCredential(status.targetId, apiKey, revision)
          : await clearWebSearchCredential(status.targetId, revision);
      setApiKey("");
      const planStatus = response.changePlanReceipt?.status;
      setMessage(
        !planStatus || planStatus === "completed"
          ? {
              tone: "info",
              text:
                action === "save"
                  ? `${status.label} key checked and saved.`
                  : `${status.label} key removed from the keychain.`,
            }
          : {
              tone: "info",
              text: `The ${status.label} key change is ${presentChangeStatusLabel(planStatus).toLowerCase()}. Review it in Inbox before relying on it.`,
            },
      );
      queryClient.setQueryData(
        WEB_SEARCH_CREDENTIALS_QUERY_KEY,
        (previous: { items: WebSearchCredentialStatus[] } | undefined) =>
          previous
            ? { items: previous.items.map((item) => (item.targetId === status.targetId ? response.status : item)) }
            : previous,
      );
    } catch (error) {
      setMessage({ tone: "error", text: describeApiError(error).summary });
    } finally {
      setBusy(undefined);
      void queryClient.invalidateQueries({ queryKey: WEB_SEARCH_CREDENTIALS_QUERY_KEY });
    }
  }

  return (
    <li className="min-w-0 rounded-md border border-line-subtle bg-sunken p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-sm font-semibold text-fg">{status.label}</h5>
        <StatusBadge status={sourceBadge(status)} />
      </div>
      <p className="mt-1 text-xs text-fg-muted">{KEY_USE[status.targetId]}</p>
      {!status.endpointAllowlisted ? (
        <p className="mt-1 text-xs text-status-waiting">
          {status.endpointHost} is not in the outbound allowlist, so this key cannot be checked or used yet.
        </p>
      ) : null}
      {!status.keychainAvailable ? (
        <p className="mt-1 text-xs text-status-waiting">
          The OS keychain is unavailable. Set {status.envNames.join(" or ")} in the Gateway environment instead.
        </p>
      ) : null}
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (apiKey.trim()) void run("save");
        }}
      >
        <div className="min-w-0 flex-1 basis-60">
          <Field label={`${status.label} API key`}>
            {(props) => (
              <input
                {...props}
                type="password"
                autoComplete="off"
                spellCheck={false}
                className={cockpitInputClass}
                value={apiKey}
                placeholder={status.keychainConfigured ? "Enter a new key to replace the saved one" : "Paste a key"}
                disabled={Boolean(busy) || !status.keychainAvailable}
                onChange={(event) => setApiKey(event.target.value)}
              />
            )}
          </Field>
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={
            !apiKey.trim() || Boolean(busy) || !revision || !status.keychainAvailable || !status.endpointAllowlisted
          }
        >
          {busy === "save" ? "Checking…" : "Check and save"}
        </Button>
        {status.keychainConfigured ? (
          <Button disabled={Boolean(busy) || !revision} onClick={() => void run("remove")}>
            {busy === "remove" ? "Removing…" : "Remove key"}
          </Button>
        ) : null}
      </form>
      <a
        href={status.acquisitionUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-2 inline-block text-xs font-medium text-accent hover:underline"
      >
        Get a {status.label} API key
      </a>
      {message ? <Callout tone={message.tone}>{message.text}</Callout> : null}
    </li>
  );
}
