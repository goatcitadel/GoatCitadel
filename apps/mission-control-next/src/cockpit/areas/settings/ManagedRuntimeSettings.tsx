import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useManagedRuntimeSettings } from "../../../features/native-routes/settings/use-managed-runtime-settings";
import { ManagedRuntimeReview } from "../../../features/native-routes/settings/ManagedRuntimeReview";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { Button } from "../../ui/Button";

const inputClass =
  "mt-1 min-h-10 w-full rounded-md border border-line bg-canvas px-2 text-sm text-fg disabled:opacity-60";
export function ManagedRuntimeSettings() {
  const { navigate } = useCockpitRoute();
  const scope = getGatewayApiBaseUrl();
  const settings = useQuery({
    queryKey: ["system", "managed-runtime-settings"],
    queryFn: fetchSettings,
    refetchOnWindowFocus: true,
  });
  const control = useManagedRuntimeSettings({
    settings: settings.data,
    available: !settings.isError && !settings.isFetching,
    reload: () => settings.refetch(),
  });
  const { draft, change } = control;
  const runtime = settings.data?.llamaCpp;
  return (
    <section
      id="managed-runtime"
      aria-labelledby="managed-runtime-title"
      className="mt-4 space-y-4 rounded-lg border border-line bg-sunken p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="managed-runtime-title" className="font-display text-base font-semibold text-fg">
            Managed local runtime
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            Review llama.cpp configuration for this Gateway installation.
          </p>
        </div>
        <Button size="sm" disabled={settings.isFetching || control.busy} onClick={() => void settings.refetch()}>
          Refresh runtime settings
        </Button>
      </div>
      {settings.isFetching ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading runtime configuration…
        </p>
      ) : null}
      {settings.isError ? (
        <p role="alert" className="text-sm text-status-failed">
          {describeApiError(settings.error).summary}
        </p>
      ) : null}
      {settings.data && !settings.isError && !settings.isFetching && !control.ready ? (
        <p role="alert" className="text-sm text-status-failed">
          The Gateway returned incomplete runtime settings. Refresh before editing.
        </p>
      ) : null}
      {control.ready ? (
        <>
          <p className="text-xs text-fg-muted">
            Mode: {control.managed ? "Managed" : "External"} · settings revision {settings.data?.revision} · Process:{" "}
            {humanizeToken(runtime?.status?.processState ?? "unknown")}
          </p>
          {control.managed ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm text-fg">
                  Runtime endpoint
                  <input
                    className={inputClass}
                    value={draft.value.baseUrl}
                    disabled={control.locked}
                    onChange={(event) => draft.setValue((current) => ({ ...current, baseUrl: event.target.value }))}
                  />
                </label>
                <label className="text-sm text-fg">
                  Model alias
                  <input
                    className={inputClass}
                    value={draft.value.alias}
                    disabled={control.locked}
                    onChange={(event) => draft.setValue((current) => ({ ...current, alias: event.target.value }))}
                  />
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={draft.value.enabled}
                    disabled={control.locked}
                    onChange={(event) => draft.setValue((current) => ({ ...current, enabled: event.target.checked }))}
                  />
                  Enable managed runtime
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={draft.value.autoStart}
                    disabled={control.locked}
                    onChange={(event) => draft.setValue((current) => ({ ...current, autoStart: event.target.checked }))}
                  />
                  Auto-start with the Gateway
                </label>
              </div>
              <p className="text-xs text-fg-secondary">
                These settings affect every workspace using the runtime. Saved configuration and process health are
                separate.
              </p>
              {draft.isDirty ? (
                <p role="status" className="text-xs text-status-waiting">
                  Unsaved runtime draft
                </p>
              ) : null}
              {draft.hasRemoteChanges ? (
                <div role="status" className="space-y-2 text-sm text-fg-secondary">
                  <p>
                    The saved configuration changed after this draft began. Current endpoint:{" "}
                    <span className="break-all">{control.current.baseUrl}</span>; alias: {control.current.alias};
                    enabled: {String(control.current.enabled)}; auto-start: {String(control.current.autoStart)}.
                  </p>
                  <Button size="sm" disabled={control.locked} onClick={draft.rebaseToCurrent}>
                    Review draft against current revision
                  </Button>
                </div>
              ) : null}
              {control.inputError ? (
                <p role="alert" className="text-sm text-status-failed">
                  {control.inputError}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={!control.canReview} onClick={() => void control.requestReview()}>
                  Review runtime changes
                </Button>
                <Button disabled={!draft.isDirty || control.locked} onClick={draft.discard}>
                  Discard runtime draft
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-fg-secondary">
              GoatCitadel observes this external server. Process and launch configuration stay with its owner; use
              guided setup to change the connection.
            </p>
          )}
          <details className="text-sm text-fg-secondary">
            <summary className="cursor-pointer text-fg">Saved launch paths</summary>
            <p className="mt-2">
              Read-only evidence. Change command and model paths through the validated llama.cpp setup flow.
            </p>
            <dl className="mt-2 grid gap-2">
              <div>
                <dt>Command</dt>
                <dd className="break-all">{runtime?.command || "Not reported"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd className="break-all">{runtime?.modelPath || "Not reported"}</dd>
              </div>
            </dl>
          </details>
        </>
      ) : null}
      {change.change ? (
        <div className="space-y-2 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
          <p role="status">
            {humanizeToken(change.change.receipt.status)} · {change.change.message}
          </p>
          {change.change.error ? <p role="alert">{change.change.error}</p> : null}
          <Button size="sm" onClick={() => void change.refresh()}>
            Refresh runtime change status
          </Button>
          {change.change.blocking && change.change.receipt.status === "awaiting_approval" && change.change.receipt.requiredAction?.kind === "approval" ? (
            <SettingsApprovalOwnerAction plan={change.change.plan} receipt={change.change.receipt}
              owner="managed-runtime" workspaceId="default" viewIdentity={draft.key} disabled={control.busy} />
          ) : null}
        </div>
      ) : null}
      {control.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {control.notice}
        </p>
      ) : null}
      {control.uncertain ? (
        <p role="alert" className="text-sm text-status-failed">
          {control.uncertain}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3 text-sm">
        <ClassicOwnerLink href="/settings/onboarding?view=llamacpp&shell=classic" scope={scope} label="Open validated llama.cpp setup" />
        <Button size="sm" onClick={() => navigate("/system/health")}>Check runtime health</Button>
        <ClassicOwnerLink href="/settings/runtime?shell=classic" scope={scope} label="Voice and runtime diagnostics" />
      </div>
      <ManagedRuntimeReview control={control} />
    </section>
  );
}
