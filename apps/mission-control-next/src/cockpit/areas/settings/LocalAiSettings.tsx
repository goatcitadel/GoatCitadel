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
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { LocalAiHardware, LocalAiJobs, LocalAiFitEvidence } from "./LocalAiEvidence";
import { TimeText } from "../../ui/TimeText";
import { presentHostOs } from "./settings-vocabulary";

/** Installation-scoped owner reads; explicit requests record approval intent, not successful model work. */
export function LocalAiSettings() {
  const { navigate } = useCockpitRoute();
  const control = useLocalAiSettings();
  const [inspection, setInspection] = useState<"hardware" | "jobs" | null>(null);
  const { readiness, topRecommendation: selected } = control;
  const [fitPageIndex, setFitPageIndex] = useState(0);
  const fitPage = Math.min(fitPageIndex, Math.max(0, Math.ceil(control.recommendations.length / 80) - 1));
  const fitStart = fitPage * 80;
  const fits = control.recommendations.slice(fitStart, fitStart + 80);
  const selectedOutsidePage = selected && !fits.some((item) => localAiModelKey(item) === localAiModelKey(selected));
  return (
    <section
      id="local-ai"
      aria-label="Local AI readiness"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4 first:border-t-0 first:pt-0"
    >
      <header>
        <h3 className="text-base font-semibold text-fg">Local AI readiness</h3>
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
        <p className="text-sm text-fg-secondary">Local AI status could not load. Refresh before reviewing a request.</p>
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
              <dd className="text-fg">{presentHostOs(readiness.hardware.os)}</dd>
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
          <p className="text-xs text-fg-muted">
            <TimeText prefix="Observed" value={readiness.hardware.checkedAt} />
          </p>
          {!control.hasRegisteredEndpoint ? (
            <p className="text-sm text-fg-secondary">
              Local AI is not set up yet.{" "}
              {control.hasDetectedRuntime ? (
                "A runtime was found, but Chat has not been tested with it."
              ) : (
                <>
                  Set up llama.cpp for Chat in{" "}
                  <a
                    className="text-accent hover:underline"
                    href="/settings/models?shell=cockpit#onboarding"
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                        return;
                      event.preventDefault();
                      navigate("/settings/models?shell=cockpit#onboarding");
                    }}
                  >
                    Get started
                  </a>
                  .
                </>
              )}
            </p>
          ) : null}
          <label className="block text-sm text-fg-secondary">
            Model and backend
            <select
              className="mt-1 block min-h-10 w-full rounded-md border border-line-control bg-canvas px-3 text-fg"
              disabled={control.queueing}
              value={selected ? localAiModelKey(selected) : ""}
              onChange={(event) => control.setSelectedModelKey(event.target.value)}
            >
              <option value="" disabled>
                Select a model fit
              </option>
              {selectedOutsidePage ? (
                <option key={`selected:${localAiModelKey(selected)}`} value={localAiModelKey(selected)}>
                  {readiness.catalog.find((model) => model.modelId === selected.modelId)?.label || selected.modelId}
                  {" · "}
                  {formatLocalAiFit(selected.backend)}
                  {" · Selected outside this page"}
                </option>
              ) : null}
              {fits.map((item, index) => (
                <option key={`${localAiModelKey(item)}:${index}`} value={localAiModelKey(item)}>
                  {readiness.catalog.find((model) => model.modelId === item.modelId)?.label || item.modelId} ·{" "}
                  {formatLocalAiFit(item.backend)} · {formatLocalAiFit(item.fit)}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-fg-muted">
            Showing {fits.length} of {control.recommendations.length} returned model fits.
            {fits.length ? ` Records ${fitStart + 1}–${fitStart + fits.length}.` : ""}
          </p>
          {control.recommendations.length > 80 ? (
            <nav aria-label="Model fit pages" className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={fitPage === 0 || control.queueing}
                onClick={() => setFitPageIndex(fitPage - 1)}
              >
                Previous model fits
              </Button>
              <Button
                size="sm"
                disabled={fitStart + fits.length >= control.recommendations.length || control.queueing}
                onClick={() => setFitPageIndex(fitPage + 1)}
              >
                Next model fits
              </Button>
            </nav>
          ) : null}
          {selected ? (
            <div className="space-y-3 border-t border-line-subtle pt-3 text-sm text-fg-secondary">
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
                <p>No limitations were reported.</p>
              )}
              <LocalAiFitEvidence
                recommendation={selected}
                catalog={readiness.catalog.find((model) => model.modelId === selected.modelId)}
              />
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
          <details>
            <summary>Advisory approval requests (no execution)</summary>
            <p className="text-sm text-fg-secondary">
              This GoatCitadel version records approval intent only. These requests do not download models, start
              servers, or configure a provider. Approval does not supply the missing execution step.
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
        <a
          className="text-accent hover:underline"
          href="/settings/models?shell=cockpit#local-ai"
          onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigate("/settings/models?shell=cockpit#local-ai");
            requestAnimationFrame(() => document.getElementById("llamacpp-setup")?.scrollIntoView({ block: "start" }));
          }}
        >
          Set up llama.cpp for Chat
        </a>
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
            Current status is unavailable while readiness is loading or failed.
          </p>
        )}
      </Sheet>
      <LocalAiRequestConfirmation control={control} />
    </section>
  );
}
