import { useState } from "react";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import type {
  LocalAiReadinessResponse,
  LocalAiFitRecommendation,
  LocalAiModelCatalogItem,
} from "@goatcitadel/contracts";
import { formatLocalAiBytes, formatLocalAiFit } from "../../../features/native-routes/settings/local-ai-model";

const LIMIT = 40;
const text = (value: string) => value.slice(0, 1600);
const pageFor = (index: number, length: number) => Math.min(index, Math.max(0, Math.ceil(length / LIMIT) - 1));

function EvidencePager({
  label,
  page,
  count,
  select,
}: {
  label: string;
  page: number;
  count: number;
  select: (page: number) => void;
}) {
  return count > LIMIT ? (
    <nav aria-label={`${label} pages`} className="flex flex-wrap gap-2">
      <Button size="sm" disabled={page === 0} onClick={() => select(page - 1)}>
        Previous {label}
      </Button>
      <Button size="sm" disabled={(page + 1) * LIMIT >= count} onClick={() => select(page + 1)}>
        Next {label}
      </Button>
    </nav>
  ) : null;
}
function EvidenceDetails({ label, values }: { label: string; values: Record<string, unknown> }) {
  return (
    <details>
      <summary>{label}</summary>
      <dl className="mt-2 space-y-2 break-words">
        {Object.entries(values)
          .filter(([, value]) => value !== undefined)
          .map(([label, value]) => (
            <div key={label}>
              <dt className="font-medium">{formatLocalAiFit(label)}</dt>
              <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
            </div>
          ))}
      </dl>
    </details>
  );
}
export function LocalAiFitEvidence({
  recommendation: fit,
  catalog,
}: {
  recommendation: LocalAiFitRecommendation;
  catalog?: LocalAiModelCatalogItem;
}) {
  return (
    <EvidenceDetails
      label="Full model fit details"
      values={{
        modelId: fit.modelId,
        backend: fit.backend,
        fit: fit.fit,
        confidence: fit.confidence,
        reasons: fit.reasons,
        limitations: fit.limitations,
        estimatedMemoryBytes: fit.estimatedMemoryBytes,
        estimatedDiskBytes: fit.estimatedDiskBytes,
        catalogLabel: catalog?.label,
        family: catalog?.family,
        parameterCountBillions: catalog?.parameterCountBillions,
        quantization: catalog?.quantization,
        downloadBytes: catalog?.downloadBytes,
        contextTokens: catalog?.contextTokens,
        preferredBackends: catalog?.preferredBackends,
        tags: catalog?.tags,
        source: catalog?.source,
      }}
    />
  );
}

export function LocalAiHardware({ readiness }: { readiness: LocalAiReadinessResponse }) {
  const hardware = readiness.hardware;
  const [gpuPageIndex, setGpuPage] = useState(0),
    [runtimePageIndex, setRuntimePage] = useState(0);
  const gpuPage = pageFor(gpuPageIndex, hardware.gpu.length),
    runtimePage = pageFor(runtimePageIndex, hardware.runtimes.length);
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
      <EvidenceDetails
        label="Hardware measurements"
        values={{
          checkedAt: hardware.checkedAt,
          platform: hardware.os.platform,
          arch: hardware.os.arch,
          release: hardware.os.release,
          cpuModel: hardware.cpu.model,
          logicalCores: hardware.cpu.logicalCores,
          totalMemoryBytes: hardware.memory.totalBytes,
          freeMemoryBytes: hardware.memory.freeBytes,
          modelsRootPath: hardware.disk.modelsRootPath,
          freeDiskBytes: hardware.disk.freeBytes,
        }}
      />
      <h4 className="font-medium text-fg">GPU details</h4>
      {!hardware.gpu.length ? (
        <p>No GPU measurements were returned. This does not establish that the host has no GPU.</p>
      ) : (
        <ul className="space-y-2">
          {hardware.gpu.slice(gpuPage * LIMIT, (gpuPage + 1) * LIMIT).map((gpu, index) => (
            <li key={`${gpu.name}:${gpuPage * LIMIT + index}`}>
              {gpu.name} · {formatLocalAiBytes(gpu.vramBytes)} VRAM · {gpu.source}
              <EvidenceDetails
                label="GPU measurements"
                values={{
                  name: gpu.name,
                  vendor: gpu.vendor,
                  vramBytes: gpu.vramBytes,
                  driverVersion: gpu.driverVersion,
                  source: gpu.source,
                }}
              />
            </li>
          ))}
        </ul>
      )}
      <p>
        GPU records {hardware.gpu.length ? gpuPage * LIMIT + 1 : 0}–
        {Math.min((gpuPage + 1) * LIMIT, hardware.gpu.length)} of {hardware.gpu.length}.
      </p>
      <EvidencePager label="GPU details" page={gpuPage} count={hardware.gpu.length} select={setGpuPage} />
      <h4 className="font-medium text-fg">Runtime detection</h4>
      <p>
        {"Showing "}
        {Math.min(LIMIT, Math.max(0, hardware.runtimes.length - runtimePage * LIMIT))}
        {" of "}
        {hardware.runtimes.length}
        {" returned runtimes."}
        {hardware.runtimes.length
          ? ` Records ${runtimePage * LIMIT + 1}–${Math.min((runtimePage + 1) * LIMIT, hardware.runtimes.length)}.`
          : ""}
      </p>
      <ul className="space-y-3">
        {hardware.runtimes.slice(runtimePage * LIMIT, (runtimePage + 1) * LIMIT).map((runtime, index) => (
          <li key={`${runtime.backend}:${runtimePage * LIMIT + index}`} className="rounded-md border border-line p-3">
            <strong className="text-fg">{formatLocalAiFit(runtime.backend)}</strong> ·{" "}
            {runtime.detected ? "Detected" : "Not detected"} · {formatLocalAiFit(runtime.platformSupport)}
            {runtime.version ? <p>Version {text(runtime.version)}</p> : null}
            {runtime.notes?.slice(0, 8).map((note, noteIndex) => (
              <p key={noteIndex}>{text(note)}</p>
            ))}
            <EvidenceDetails
              label="Runtime measurements"
              values={{
                backend: runtime.backend,
                detected: runtime.detected,
                version: runtime.version,
                command: runtime.command,
                baseUrl: runtime.baseUrl,
                platformSupport: runtime.platformSupport,
                notes: runtime.notes,
              }}
            />
            {runtime.command || runtime.baseUrl ? (
              <code className="mt-1 block break-all font-mono">{runtime.command || runtime.baseUrl}</code>
            ) : null}
          </li>
        ))}
      </ul>
      <EvidencePager
        label="Runtime detection"
        page={runtimePage}
        count={hardware.runtimes.length}
        select={setRuntimePage}
      />
    </div>
  );
}

export function LocalAiJobs({ readiness }: { readiness: LocalAiReadinessResponse }) {
  const { search, hash } = useCockpitRoute();
  const [pageIndexes, setPages] = useState({ downloads: 0, serveJobs: 0, endpoints: 0 });
  const endpointPage = pageFor(pageIndexes.endpoints, readiness.endpoints.length);
  function approvalHref(approvalId: string) {
    const parameters = new URLSearchParams(search);
    parameters.set("approvalId", approvalId);
    parameters.delete("view");
    parameters.delete("shell");
    parameters.delete("shellScope");
    return `/inbox?${parameters}${hash}`;
  }
  return (
    <div className="space-y-4 text-sm text-fg-secondary">
      <p>
        These job and endpoint records live in GoatCitadel memory and are lost when GoatCitadel restarts. They are not a
        run history. Download and serve requests currently record approval intent only.
      </p>
      {(
        [
          ["Downloads", readiness.downloads, "downloads"],
          ["Serve jobs", readiness.serveJobs, "serveJobs"],
        ] as const
      ).map(([label, jobs, pageKey]) => {
        const page = pageFor(pageIndexes[pageKey], jobs.length);
        return (
          <section key={label} aria-label={label} className="space-y-2">
            <h4 className="font-medium text-fg">{label}</h4>
            <p>
              Showing {Math.min(LIMIT, Math.max(0, jobs.length - page * LIMIT))} of {jobs.length} retained records.
              {jobs.length ? ` Records ${page * LIMIT + 1}–${Math.min((page + 1) * LIMIT, jobs.length)}.` : ""}
            </p>
            {!jobs.length ? (
              <p>No retained {label.toLowerCase()}.</p>
            ) : (
              <ul className="space-y-2">
                {jobs.slice(page * LIMIT, (page + 1) * LIMIT).map((job) => (
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
                    <EvidenceDetails
                      label="Job records"
                      values={{
                        jobId: job.jobId,
                        modelId: job.modelId,
                        backend: job.backend,
                        status: job.status,
                        approvalId: job.approvalId,
                        error: job.error,
                        createdAt: job.createdAt,
                        updatedAt: job.updatedAt,
                        ...("progressPercent" in job
                          ? {
                              progressPercent: job.progressPercent,
                              artifactPath: job.artifactPath,
                              artifactHash: job.artifactHash,
                            }
                          : {}),
                        ...("health" in job ? { health: job.health } : {}),
                        ...("endpointUrl" in job ? { endpointUrl: job.endpointUrl } : {}),
                        ...("processId" in job ? { processId: job.processId } : {}),
                      }}
                    />
                    {job.approvalId ? (
                      <NativeOwnerLink
                        href={approvalHref(job.approvalId)}
                        className="inline-block text-accent hover:underline"
                        scope={JSON.stringify([job.jobId, job.approvalId])}
                      >
                        Review required approval
                      </NativeOwnerLink>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <EvidencePager
              label={label}
              page={page}
              count={jobs.length}
              select={(next) => setPages((current) => ({ ...current, [pageKey]: next }))}
            />
          </section>
        );
      })}
      <section aria-label="Registered endpoints" className="space-y-2">
        <h4 className="font-medium text-fg">Registered endpoints</h4>
        <p>
          {"Showing "}
          {Math.min(LIMIT, Math.max(0, readiness.endpoints.length - endpointPage * LIMIT))}
          {" of "}
          {readiness.endpoints.length}
          {" retained endpoints."}
          {readiness.endpoints.length
            ? ` Records ${endpointPage * LIMIT + 1}–${Math.min((endpointPage + 1) * LIMIT, readiness.endpoints.length)}.`
            : ""}
          {"Registration alone does not prove Chat works."}
        </p>
        {!readiness.endpoints.length ? (
          <p>No Local AI job endpoint is registered here.</p>
        ) : (
          <ul className="space-y-2">
            {readiness.endpoints.slice(endpointPage * LIMIT, (endpointPage + 1) * LIMIT).map((endpoint) => (
              <li key={endpoint.endpointId} className="rounded-md border border-line p-3">
                <strong className="text-fg">{endpoint.label}</strong>
                <p>
                  {endpoint.model} · {formatLocalAiFit(endpoint.backend)}
                </p>
                <p>Smoke test: {formatLocalAiFit(endpoint.smokeStatus)}</p>
                <code className="block break-all font-mono">{endpoint.baseUrl}</code>
                <EvidenceDetails
                  label="Endpoint records"
                  values={{
                    endpointId: endpoint.endpointId,
                    providerId: endpoint.providerId,
                    label: endpoint.label,
                    backend: endpoint.backend,
                    baseUrl: endpoint.baseUrl,
                    model: endpoint.model,
                    smokeStatus: endpoint.smokeStatus,
                    evidenceRef: endpoint.evidenceRef,
                    createdAt: endpoint.createdAt,
                    updatedAt: endpoint.updatedAt,
                  }}
                />
              </li>
            ))}
          </ul>
        )}
        <EvidencePager
          label="Registered endpoints"
          page={endpointPage}
          count={readiness.endpoints.length}
          select={(next) => setPages((current) => ({ ...current, endpoints: next }))}
        />
      </section>
    </div>
  );
}
