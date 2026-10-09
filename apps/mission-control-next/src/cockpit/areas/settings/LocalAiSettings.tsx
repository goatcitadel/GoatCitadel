import { useState } from "react";
import { useLocalAiSettings } from "../../../features/native-routes/settings/use-local-ai-settings";
import { LocalAiRequestConfirmation } from "../../../features/native-routes/settings/LocalAiRequestConfirmation";
import {
  formatLocalAiBytes,
  formatLocalAiFit,
  localAiModelKey,
} from "../../../features/native-routes/settings/local-ai-model";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { LocalAiHardware, LocalAiJobs } from "./LocalAiEvidence";

/** Installation-scoped owner reads; explicit requests record approval intent, not successful model work. */
export function LocalAiSettings() {
  const { navigate } = useCockpitRoute();
  const control = useLocalAiSettings();
  const [inspection, setInspection] = useState<"hardware" | "jobs" | null>(null);
  const { readiness, topRecommendation: selected } = control;
  return (
    <section
      id="local-ai"
      aria-label="Local AI readiness"
      className="mt-4 space-y-4 rounded-lg border border-line bg-sunken p-4"
    >
      <header>
        <h3 className="font-display text-base font-semibold text-fg">Local AI readiness</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Inspect this installation's hardware and model fit. Detection and recommendations are advisory; they do not
          establish working inference.
        </p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={control.loading} onClick={() => void control.reload()}>
          Refresh readiness
        </Button>
        <Button size="sm" disabled={!readiness} onClick={() => setInspection("hardware")}>
          Hardware details
        </Button>
        <Button size="sm" disabled={!readiness} onClick={() => setInspection("jobs")}>
          Jobs and endpoints
        </Button>
      </div>
      {control.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading Local AI readiness…
        </p>
      ) : null}
      {control.error ? (
        <p role="alert" className="text-sm text-status-failed">
          {control.error}
        </p>
      ) : null}
      {control.data?.issues.map((issue) => (
        <p role="alert" key={issue.label} className="text-sm text-status-failed">
          {issue.message}
        </p>
      ))}
      {!control.loading && !readiness ? (
        <p className="text-sm text-fg-secondary">
          Local AI evidence is unavailable. Refresh before reviewing a request.
        </p>
      ) : null}
      {control.notice ? (
        <p
          role={control.notice.tone === "error" ? "alert" : "status"}
          className="break-words text-sm text-fg-secondary"
        >
          {control.notice.message}
        </p>
      ) : null}
      {(["download", "serve"] as const).map((kind) => {
        const state = control.stateFor(kind);
        return state?.message && state.message !== control.notice?.message ? (
          <div key={kind} className="space-y-2">
            <p role={state.phase === "uncertain" ? "alert" : "status"} className="text-sm text-fg-secondary">
              {state.message}
            </p>
            {state.phase === "uncertain" && state.transport ? (
              <Button size="sm" disabled={state.checking} onClick={() => void control.checkOutcome(kind)}>
                {state.checking ? "Checking outcome…" : "Check outcome"}
              </Button>
            ) : null}
          </div>
        ) : null;
      })}
      {readiness ? (
        <>
          <dl className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-fg-muted">Platform</dt>
              <dd className="text-fg">
                {readiness.hardware.os.platform} · {readiness.hardware.os.arch}
              </dd>
            </div>
            <div>
              <dt className="text-fg-muted">CPU cores</dt>
              <dd className="text-fg">{readiness.hardware.cpu.logicalCores}</dd>
            </div>
            <div>
              <dt className="text-fg-muted">Host memory</dt>
              <dd className="text-fg">{formatLocalAiBytes(readiness.hardware.memory.totalBytes)}</dd>
            </div>
          </dl>
          <p className="text-xs text-fg-muted">Observed {readiness.hardware.checkedAt}</p>
          {!control.hasRegisteredEndpoint ? (
            <p className="text-sm text-fg-secondary">
              No Local AI job endpoint is registered here.{" "}
              {control.hasDetectedRuntime
                ? "A detected runtime is not a successful Chat test."
                : "Use Get started to configure llama.cpp for Chat."}
            </p>
          ) : null}
          <label className="block text-sm text-fg-secondary">
            Model and backend
            <select
              className="mt-1 block min-h-10 w-full rounded-md border border-line bg-canvas px-3 text-fg"
              disabled={control.queueing}
              value={selected ? localAiModelKey(selected) : ""}
              onChange={(event) => control.setSelectedModelKey(event.target.value)}
            >
              <option value="" disabled>
                Select a model fit
              </option>
              {control.recommendations.slice(0, 80).map((item, index) => (
                <option key={`${localAiModelKey(item)}:${index}`} value={localAiModelKey(item)}>
                  {readiness.catalog.find((model) => model.modelId === item.modelId)?.label || item.modelId} ·{" "}
                  {formatLocalAiFit(item.backend)} · {formatLocalAiFit(item.fit)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-fg-muted">
            Showing {Math.min(80, control.recommendations.length)} of {control.recommendations.length} returned model
            fits.
          </p>
          {selected ? (
            <div className="space-y-3 rounded-md border border-line bg-raised p-3 text-sm text-fg-secondary">
              <p>
                <strong className="text-fg">Fit: {formatLocalAiFit(selected.fit)}</strong> · {selected.confidence}{" "}
                confidence
              </p>
              <p>
                Estimated memory: {formatLocalAiBytes(selected.estimatedMemoryBytes)} · Estimated disk:{" "}
                {formatLocalAiBytes(selected.estimatedDiskBytes)}
              </p>
              <h4 className="font-medium text-fg">Reasons</h4>
              <ul className="list-inside list-disc space-y-1">
                {selected.reasons.slice(0, 12).map((reason, index) => (
                  <li key={index}>{reason.slice(0, 1600)}</li>
                ))}
              </ul>
              <h4 className="font-medium text-fg">Limitations</h4>
              {selected.limitations.length ? (
                <ul className="list-inside list-disc space-y-1">
                  {selected.limitations.slice(0, 12).map((reason, index) => (
                    <li key={index}>{reason.slice(0, 1600)}</li>
                  ))}
                </ul>
              ) : (
                <p>No limitations were returned by the fit owner.</p>
              )}
              <details>
                <summary>Selected identity</summary>
                <code className="block break-all font-mono">
                  {selected.modelId} · {selected.backend}
                </code>
              </details>
            </div>
          ) : (
            <p className="text-sm text-fg-muted">
              No selected model fit is available. Choose a returned recommendation to review a request.
            </p>
          )}
          <details><summary>Advisory approval requests (no execution)</summary><p className="text-sm text-fg-secondary">
            The current Gateway records approval intent only. These requests do not download models, start servers, or
            configure a provider. Approval does not supply the missing execution step.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!selected || control.queueing} onClick={() => control.requestReview("download")}>
              Request download approval
            </Button>
            <Button disabled={!selected || control.queueing} onClick={() => control.requestReview("serve")}>
              Request serve approval
            </Button>
          </div>
          </details>
        </>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
        <a className="text-accent hover:underline" href="/settings/models?shell=cockpit#local-ai"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate("/settings/models?shell=cockpit#local-ai");
            requestAnimationFrame(() => document.getElementById("llamacpp-setup")?.scrollIntoView({ block: "start" }));
          }}>
          Set up llama.cpp for Chat
        </a>
        <ClassicOwnerLink className="text-accent hover:underline" href="/settings/local-ai?shell=classic"
          scope="installation-local-ai" label="Open detailed Local AI settings" />
      </div>
      <Sheet
        open={Boolean(inspection)}
        onOpenChange={(open) => {
          if (!open) setInspection(null);
        }}
        title={inspection === "hardware" ? "Local hardware" : "Jobs and endpoints"}
        sideOnDesktop
      >
        {readiness ? (
          inspection === "hardware" ? (
            <LocalAiHardware readiness={readiness} />
          ) : (
            <LocalAiJobs readiness={readiness} />
          )
        ) : (
          <p role="status" className="text-sm text-fg-secondary">
            Current evidence is unavailable while readiness is loading or failed.
          </p>
        )}
      </Sheet>
      <LocalAiRequestConfirmation control={control} />
    </section>
  );
}
