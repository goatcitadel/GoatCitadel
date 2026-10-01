import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import type { LocalAiReadinessResponse } from "@goatcitadel/contracts";
import { formatLocalAiBytes, formatLocalAiFit } from "../../../features/native-routes/settings/local-ai-model";

const LIMIT = 40;
const text = (value: string) => value.slice(0, 1600);

export function LocalAiHardware({ readiness }: { readiness: LocalAiReadinessResponse }) {
  const hardware = readiness.hardware;
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      <p>Read-only host scan observed {hardware.checkedAt}. Detection does not prove successful inference.</p>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="font-medium text-fg">Operating system</dt>
          <dd>
            {hardware.os.platform} · {hardware.os.arch}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Processor</dt>
          <dd>
            {hardware.cpu.model || "Model unavailable"} · {hardware.cpu.logicalCores} logical cores
          </dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Memory</dt>
          <dd>
            {formatLocalAiBytes(hardware.memory.totalBytes)} total · {formatLocalAiBytes(hardware.memory.freeBytes)}{" "}
            free
          </dd>
        </div>
        <div>
          <dt className="font-medium text-fg">Model storage</dt>
          <dd>{formatLocalAiBytes(hardware.disk.freeBytes)} free</dd>
        </div>
      </dl>
      {hardware.disk.modelsRootPath ? (
        <p>
          Models path: <code className="break-all font-mono">{hardware.disk.modelsRootPath}</code>
        </p>
      ) : null}
      <h4 className="font-medium text-fg">GPU evidence</h4>
      {!hardware.gpu.length ? (
        <p>No GPU measurements were returned. This does not establish that the host has no GPU.</p>
      ) : (
        <ul className="space-y-2">
          {hardware.gpu.slice(0, LIMIT).map((gpu, index) => (
            <li key={`${gpu.name}:${index}`}>
              {gpu.name} · {formatLocalAiBytes(gpu.vramBytes)} VRAM · {gpu.source}
            </li>
          ))}
        </ul>
      )}
      <h4 className="font-medium text-fg">Runtime detection</h4>
      <p>
        Showing {Math.min(LIMIT, hardware.runtimes.length)} of {hardware.runtimes.length} returned runtimes.
      </p>
      <ul className="space-y-3">
        {hardware.runtimes.slice(0, LIMIT).map((runtime, index) => (
          <li key={`${runtime.backend}:${index}`} className="rounded-md border border-line p-3">
            <strong className="text-fg">{formatLocalAiFit(runtime.backend)}</strong> ·{" "}
            {runtime.detected ? "Detected" : "Not detected"} · {formatLocalAiFit(runtime.platformSupport)}
            {runtime.version ? <p>Version {text(runtime.version)}</p> : null}
            {runtime.notes?.slice(0, 8).map((note, noteIndex) => (
              <p key={noteIndex}>{text(note)}</p>
            ))}
            {runtime.command || runtime.baseUrl ? (
              <code className="mt-1 block break-all font-mono">{runtime.command || runtime.baseUrl}</code>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LocalAiJobs({ readiness }: { readiness: LocalAiReadinessResponse }) {
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      <p>
        These job and endpoint records are retained in Gateway process memory. They are not a durable execution history.
        Download and serve requests currently record approval intent only.
      </p>
      {(
        [
          ["Downloads", readiness.downloads],
          ["Serve jobs", readiness.serveJobs],
        ] as const
      ).map(([label, jobs]) => (
        <section key={label} aria-label={label} className="space-y-2">
          <h4 className="font-medium text-fg">{label}</h4>
          <p>
            Showing {Math.min(LIMIT, jobs.length)} of {jobs.length} retained records.
          </p>
          {!jobs.length ? (
            <p>No retained {label.toLowerCase()}.</p>
          ) : (
            <ul className="space-y-2">
              {jobs.slice(0, LIMIT).map((job) => (
                <li key={job.jobId} className="space-y-1 rounded-md border border-line p-3">
                  <p className="break-words font-medium text-fg">
                    {job.modelId} · {formatLocalAiFit(job.backend)}
                  </p>
                  <p>
                    Status: {formatLocalAiFit(job.status)}
                    {"health" in job ? ` · Health: ${job.health}` : ""}
                  </p>
                  {job.error ? (
                    <p role="alert" className="break-words text-status-failed">
                      {text(job.error)}
                    </p>
                  ) : null}
                  <code className="block break-all font-mono">{job.jobId}</code>
                  {job.approvalId ? (
                    <ClassicOwnerLink
                      href={`/ops/approvals?shell=classic&approvalId=${encodeURIComponent(job.approvalId)}`}
                      className="inline-block text-accent hover:underline"
                      scope={JSON.stringify([job.jobId, job.approvalId])}
                      label="Review required approval"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <section aria-label="Registered endpoints" className="space-y-2">
        <h4 className="font-medium text-fg">Registered endpoints</h4>
        <p>
          Showing {Math.min(LIMIT, readiness.endpoints.length)} of {readiness.endpoints.length} retained endpoints.
          Registration alone does not prove Chat works.
        </p>
        {!readiness.endpoints.length ? (
          <p>No Local AI job endpoint is registered here.</p>
        ) : (
          <ul className="space-y-2">
            {readiness.endpoints.slice(0, LIMIT).map((endpoint) => (
              <li key={endpoint.endpointId} className="rounded-md border border-line p-3">
                <strong className="text-fg">{endpoint.label}</strong>
                <p>
                  {endpoint.model} · {formatLocalAiFit(endpoint.backend)}
                </p>
                <p>Smoke test: {formatLocalAiFit(endpoint.smokeStatus)}</p>
                <code className="block break-all font-mono">{endpoint.baseUrl}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
