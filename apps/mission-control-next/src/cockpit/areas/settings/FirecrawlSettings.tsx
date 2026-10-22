import { useEffect, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { FirecrawlConnectionCheck } from "@goatcitadel/contracts";
import { fetchSettings, patchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { RuntimeSettingsResponse } from "@goatcitadel/mission-control-shared/api/types";
import { checkFirecrawlConnection } from "@goatcitadel/mission-control-shared/api/web-search-settings";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Field } from "../../ui/Field";
import { cockpitInputClass } from "../../ui/input-class";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { presentChangeStatusLabel } from "./settings-vocabulary";
import { useGovernedRuntimeSetting } from "./use-governed-runtime-setting";
import {
  GovernedSettingChangeStatus,
  GovernedSettingDraftState,
  GovernedSettingLoadState,
} from "./GovernedSettingParts";
import {
  decodeFirecrawlDraft,
  encodeFirecrawlDraft,
  firecrawlUrlProblem,
  hostOf,
  HOSTED_FIRECRAWL_BASE_URL,
  isBaseUrlAllowlisted,
  LOCAL_FIRECRAWL_BASE_URL,
  matchesFirecrawlPlan,
  readFirecrawlDraft,
  WEB_SEARCH_ANCHOR,
  type FirecrawlDraft,
} from "./web-search-state";

const CHECK_PRESENTATION: Record<
  FirecrawlConnectionCheck["status"],
  { tone: "done" | "waiting" | "failed"; label: string }
> = {
  ok: { tone: "done", label: "Connected" },
  reachable: { tone: "waiting", label: "Reachable" },
  unauthorized: { tone: "failed", label: "Key rejected" },
  unreachable: { tone: "failed", label: "Unreachable" },
  blocked: { tone: "failed", label: "Not allowlisted" },
};

function summarize(draft: FirecrawlDraft): string {
  if (!draft.enabled) return "Off";
  return `On · ${hostOf(draft.baseUrl) ?? draft.baseUrl} · default ${draft.defaultReadBackend}`;
}

/** Firecrawl backend for web search and page reads. The key itself is managed under API keys below. */
export function FirecrawlSettings({ settings }: { settings: UseQueryResult<RuntimeSettingsResponse> }) {
  const governed = useGovernedRuntimeSetting<string>({
    settings,
    draftKey: "web:system:firecrawl",
    draftLabel: "Firecrawl",
    recovery: { path: "/settings/connections", anchor: WEB_SEARCH_ANCHOR },
    read: readFirecrawlDraft,
    fallback: encodeFirecrawlDraft({
      enabled: false,
      baseUrl: LOCAL_FIRECRAWL_BASE_URL,
      defaultReadBackend: "native",
      fallbackToNative: true,
      timeoutMs: 20_000,
    }),
    patch: (value) => ({ web: { firecrawl: decodeFirecrawlDraft(value) } }),
    operation: "web_firecrawl_configuration",
    matchesPlan: matchesFirecrawlPlan,
    copy: {
      staleDraft:
        "Settings changed. Your draft started from an older version. Review the current Firecrawl setup, then apply your draft again.",
      changedElsewhere: "Settings changed elsewhere. Your draft is preserved for review.",
      saved: "Firecrawl settings saved.",
    },
  });
  const { ready, draft } = governed;
  const value = decodeFirecrawlDraft(draft.value);
  const saved = settings.data?.web?.firecrawl;
  const allowlist = settings.data?.networkAllowlist ?? [];
  const draftHost = hostOf(value.baseUrl);
  const urlProblem = firecrawlUrlProblem(value.baseUrl);
  const needsAllowlist = value.enabled && !urlProblem && !isBaseUrlAllowlisted(value.baseUrl, allowlist);
  const hosted = value.baseUrl.replace(/\/+$/u, "") === HOSTED_FIRECRAWL_BASE_URL;
  const [allowlistBusy, setAllowlistBusy] = useState(false);
  const [allowlistMessage, setAllowlistMessage] = useState<{ tone: "info" | "error"; text: string }>();
  const [rebaseAfterRevision, setRebaseAfterRevision] = useState<number>();
  const [check, setCheck] = useState<FirecrawlConnectionCheck>();
  const [checkError, setCheckError] = useState<string>();
  const [checking, setChecking] = useState(false);

  // The allowlist save bumps the settings revision; carry the Firecrawl draft onto it.
  const revision = settings.data?.revision;
  useEffect(() => {
    if (rebaseAfterRevision === undefined || revision === undefined || revision <= rebaseAfterRevision) return;
    setRebaseAfterRevision(undefined);
    draft.rebaseToCurrent();
  }, [draft, rebaseAfterRevision, revision]);

  const edit = (patch: Partial<FirecrawlDraft>) => {
    governed.clearNotice();
    draft.setValue(encodeFirecrawlDraft({ ...value, ...patch }));
  };

  async function addHostToAllowlist() {
    if (!draftHost) return;
    setAllowlistBusy(true);
    setAllowlistMessage(undefined);
    try {
      const latest = await fetchSettings();
      const response = await patchSettings({
        expectedRevision: latest.revision,
        networkAllowlist: [...latest.networkAllowlist, draftHost],
      });
      const status = response.changePlanReceipt?.status;
      setRebaseAfterRevision(latest.revision);
      setAllowlistMessage(
        !status || status === "completed"
          ? { tone: "info", text: `${draftHost} is now in the outbound allowlist.` }
          : {
              tone: "info",
              text:
                status === "awaiting_approval"
                  ? `Adding ${draftHost} needs approval. Approve the allowlist change in Inbox, then save Firecrawl.`
                  : `The allowlist change is ${presentChangeStatusLabel(status).toLowerCase()}. Finish it, then save Firecrawl.`,
            },
      );
      await settings.refetch();
    } catch (error) {
      setAllowlistMessage({
        tone: "error",
        text: `Could not change the allowlist. ${describeApiError(error).summary}`,
      });
    } finally {
      setAllowlistBusy(false);
    }
  }

  async function runCheck() {
    setChecking(true);
    setCheckError(undefined);
    try {
      setCheck(await checkFirecrawlConnection());
    } catch (error) {
      setCheck(undefined);
      setCheckError(describeApiError(error).summary);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="mt-4 border-t border-line-subtle pt-4">
      <h4 className="text-sm font-semibold text-fg">Firecrawl</h4>
      <p className="mt-1 text-sm text-fg-secondary">
        A search and page-reading service. Use the hosted API with a key from firecrawl.dev, or your own server.
      </p>
      <GovernedSettingLoadState
        governed={governed}
        loading="Loading Firecrawl settings…"
        incomplete="GoatCitadel did not report Firecrawl settings. Update GoatCitadel before changing them."
      />
      {ready ? (
        <div className="mt-3 max-w-xl space-y-3">
          {saved?.enabled && saved.baseUrlAllowlisted === false ? (
            <Callout tone="warning" announce={false}>
              The saved Firecrawl URL is not in the outbound allowlist, so tools skip Firecrawl and use native search.
            </Callout>
          ) : null}
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={value.enabled}
              disabled={governed.locked}
              onChange={(event) => edit({ enabled: event.target.checked })}
            />
            Use Firecrawl
          </label>
          <fieldset className="space-y-2" disabled={governed.locked}>
            <legend className="text-sm font-medium text-fg-secondary">Server</legend>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="radio"
                name="firecrawl-server"
                checked={hosted}
                onChange={() => edit({ baseUrl: HOSTED_FIRECRAWL_BASE_URL })}
              />
              Hosted Firecrawl (api.firecrawl.dev, needs an API key)
            </label>
            <label className="flex items-center gap-2 text-sm text-fg">
              <input
                type="radio"
                name="firecrawl-server"
                checked={!hosted}
                onChange={() => edit({ baseUrl: hosted ? LOCAL_FIRECRAWL_BASE_URL : value.baseUrl })}
              />
              Self-hosted server
            </label>
          </fieldset>
          {!hosted ? (
            <Field
              label="Self-hosted base URL"
              help="http://127.0.0.1:3002 is the standard local port."
              error={urlProblem}
            >
              {(props) => (
                <input
                  {...props}
                  className={cockpitInputClass}
                  value={value.baseUrl}
                  disabled={governed.locked}
                  onChange={(event) => edit({ baseUrl: event.target.value.trim() })}
                />
              )}
            </Field>
          ) : null}
          <Field
            label="Default for web search and page reads"
            help="Native uses the built-in browser and the search engines below."
          >
            {(props) => (
              <select
                {...props}
                className={cockpitInputClass}
                value={value.defaultReadBackend}
                disabled={governed.locked}
                onChange={(event) =>
                  edit({ defaultReadBackend: event.target.value as FirecrawlDraft["defaultReadBackend"] })
                }
              >
                <option value="firecrawl">Firecrawl</option>
                <option value="native">Native browser</option>
              </select>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={value.fallbackToNative}
              disabled={governed.locked}
              onChange={(event) => edit({ fallbackToNative: event.target.checked })}
            />
            Fall back to native search when Firecrawl fails or is not allowlisted
          </label>
          <Field label="Timeout (seconds)" help="Between 1 and 120 seconds.">
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                max={120}
                className={`${cockpitInputClass} max-w-32`}
                value={Math.round(value.timeoutMs / 1_000)}
                disabled={governed.locked}
                onChange={(event) =>
                  edit({ timeoutMs: Math.min(120, Math.max(1, Number(event.target.value) || 1)) * 1_000 })
                }
              />
            )}
          </Field>
          {needsAllowlist ? (
            <Callout tone="warning" announce={false}>
              <p>
                {draftHost} is not in the outbound allowlist. Tools cannot reach it, and GoatCitadel will not save
                Firecrawl as on until the host is allowed.
              </p>
              <Button
                size="sm"
                className="mt-2"
                disabled={allowlistBusy || governed.locked}
                onClick={() => void addHostToAllowlist()}
              >
                {allowlistBusy ? "Adding…" : `Add ${draftHost} to the outbound allowlist`}
              </Button>
            </Callout>
          ) : null}
          {allowlistMessage ? <Callout tone={allowlistMessage.tone}>{allowlistMessage.text}</Callout> : null}
          <GovernedSettingDraftState
            governed={governed}
            unsaved={`Unsaved draft: ${summarize(value)}`}
            currentLabel={summarize(decodeFirecrawlDraft(governed.current))}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!governed.canSave || Boolean(urlProblem) || needsAllowlist}
              onClick={() => void governed.save()}
            >
              {governed.busy ? "Saving…" : "Save Firecrawl"}
            </Button>
            <Button disabled={checking || draft.isDirty} onClick={() => void runCheck()}>
              {checking ? "Testing…" : "Test connection"}
            </Button>
          </div>
          {draft.isDirty ? (
            <p className="text-xs text-fg-muted">Save first: the test uses the saved settings.</p>
          ) : null}
          {check ? (
            <Callout tone={check.status === "ok" || check.status === "reachable" ? "info" : "warning"}>
              <StatusBadge status={CHECK_PRESENTATION[check.status]} />
              <p className="text-fg-secondary">{check.message}</p>
              {check.status === "unreachable" && saved?.enabled && saved.defaultReadBackend === "firecrawl" ? (
                <p className="text-fg-secondary">
                  Every search and page read still tries this address first. Switch to hosted Firecrawl, or set the
                  default to Native browser, to skip the wait.
                </p>
              ) : null}
              <p className="text-xs text-fg-muted">
                Key:{" "}
                {check.keySource === "none"
                  ? "none"
                  : check.keySource === "keychain"
                    ? "OS keychain"
                    : "environment variable"}
                {check.remainingCredits !== undefined
                  ? ` · ${check.remainingCredits.toLocaleString()} credits left`
                  : ""}
              </p>
            </Callout>
          ) : null}
          {checkError ? <Callout tone="error">Could not run the test. {checkError}</Callout> : null}
          <TechnicalDetails>
            <p className="break-all font-mono text-xs">
              web.firecrawl · {saved?.baseUrl} · key env {saved?.apiKeyEnv ?? "FIRECRAWL_API_KEY"} · Settings version{" "}
              {settings.data?.revision}
            </p>
          </TechnicalDetails>
        </div>
      ) : null}
      <GovernedSettingChangeStatus
        governed={governed}
        owner="firecrawl"
        recoveryLabel="Inspect Firecrawl setting activity"
      />
    </div>
  );
}
