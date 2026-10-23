import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {
  fetchReviewReadiness,
  refreshRuntimeReleaseTrust,
} from "@goatcitadel/mission-control-shared/api/review-readiness";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { releaseReadinessSummary } from "./release-readiness-model";

const QUERY_KEY = ["system", "review-readiness"] as const;

/** Whether this build is release-ready and which review checks are current. Read only once it is opened. */
export function ReleaseReadinessSection() {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const readiness = useQuery({ queryKey: QUERY_KEY, queryFn: fetchReviewReadiness, enabled: open });
  const recheck = useMutation({
    mutationFn: refreshRuntimeReleaseTrust,
    onSuccess: (next) => client.setQueryData(QUERY_KEY, next),
  });
  const data = readiness.isError ? undefined : readiness.data;
  const view = data ? releaseReadinessSummary(data) : undefined;
  const release = data?.runtimeIdentity.release;
  return (
    <section aria-label="Release and review readiness" className="border-t border-line-subtle pt-4">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-base font-semibold text-fg">Release and review readiness</summary>
        <div className="mt-3 space-y-3 text-sm text-fg-secondary">
          {readiness.isLoading ? <p>Checking release readiness…</p> : null}
          {readiness.isError ? (
            <p className="text-status-failed">
              Release readiness is unavailable: {describeApiError(readiness.error).summary}
            </p>
          ) : null}
          {view && data && release ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p>{view.sentence}</p>
                <StatusBadge status={view.status} />
              </div>
              <p className="text-xs text-fg-muted">
                <TimeText value={data.generatedAt} prefix="Checked" />
              </p>
              {view.blockers.length ? (
                <>
                  <h3 className="text-sm font-semibold text-fg">What blocks a release</h3>
                  <ul className="divide-y divide-line-subtle">
                    {view.blockers.map((item) => (
                      <li key={item.key} className="py-2">
                        <span className="font-medium text-fg">{item.title}</span>
                        <p className="mt-0.5">{item.detail}</p>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {view.checks.length ? (
                <>
                  <h3 className="text-sm font-semibold text-fg">Review checks</h3>
                  <ul className="divide-y divide-line-subtle">
                    {view.checks.map((item) => (
                      <li key={item.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span>{item.title}</span>
                        <StatusBadge status={item.status} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <TechnicalDetails label="Build and check details">
                <p className="break-all font-mono text-xs">
                  {data.branch} · {data.sha} · {data.runtimeIdentity.identitySource}
                </p>
                <p className="mt-1 break-all font-mono text-xs">
                  {release.reasonCodes.join(", ") || "No reason codes"}
                </p>
                <ul className="mt-1 space-y-1 font-mono text-xs">
                  {data.lanes.map((lane) => (
                    <li key={lane.lane} className="break-all">
                      {lane.lane} · {lane.rerunHint}
                    </li>
                  ))}
                  {data.linkedTasks.map((task) => (
                    <li key={task.taskId} className="break-all">
                      {task.taskId} · {task.title}
                    </li>
                  ))}
                  {(data.releaseProof?.artifacts ?? []).map((artifact) => (
                    <li key={`${artifact.name}:${artifact.sha256}`} className="break-all">
                      {artifact.name} · {artifact.platformArch} · {artifact.signatureStatus} · {artifact.sha256}
                    </li>
                  ))}
                </ul>
              </TechnicalDetails>
              {recheck.isError ? (
                <p className="text-status-failed">Could not check again: {describeApiError(recheck.error).summary}</p>
              ) : null}
              <Button size="sm" loading={recheck.isPending} loadingLabel="Checking…" onClick={() => recheck.mutate()}>
                Check again
              </Button>
            </>
          ) : null}
        </div>
      </details>
    </section>
  );
}
