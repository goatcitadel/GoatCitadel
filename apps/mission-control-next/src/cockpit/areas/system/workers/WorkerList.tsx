import type { useRemoteWorkerRegistry } from "@goatcitadel/mission-control-shared/hooks/useRemoteWorkerRegistry";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../../ui/Button";
import { EmptyState } from "../../../ui/EmptyState";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TimeText } from "../../../ui/TimeText";
import { workerStatus } from "./worker-copy";

/** Every worker that joined this workspace, by name and status. */
export function WorkerList({
  registry,
  onSelect,
}: {
  registry: ReturnType<typeof useRemoteWorkerRegistry>;
  onSelect: (workerId: string) => void;
}) {
  const items = registry.page?.items ?? [];
  if (registry.error)
    return (
      <EmptyState
        title="Worker records are unavailable"
        description={registry.error}
        action={<Button onClick={() => void registry.reload()}>Try again</Button>}
      />
    );
  if (registry.loading && !registry.page)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading workers…
      </p>
    );
  if (!items.length)
    return (
      <EmptyState
        title="No workers have joined yet"
        description="Workers appear here once they join this workspace from their host."
      />
    );
  return (
    <>
      <ul className="divide-y divide-line-subtle" aria-label="Workers">
        {items.map((item) => {
          const admission = item.admission.value;
          return (
            <li key={item.workerId}>
              <button
                type="button"
                onClick={() => onSelect(item.workerId)}
                className="flex w-full flex-wrap items-center justify-between gap-2 py-3 text-left hover:bg-sunken focus-visible:outline-2 focus-visible:outline-accent"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-fg">
                    {admission?.workerLabel ?? "Unnamed worker"}
                  </span>
                  <span className="block text-xs text-fg-muted">
                    {admission
                      ? plural(admission.capabilityClassCount, "capability", "capabilities")
                      : "Identity not reported"}{" "}
                    · <TimeText value={item.posture.observedAt} prefix="checked" />
                  </span>
                </span>
                <StatusBadge status={workerStatus(item.posture.value)} />
              </button>
            </li>
          );
        })}
      </ul>
      {registry.moreError ? (
        <p role="alert" className="text-sm text-status-failed">
          {registry.moreError}
        </p>
      ) : null}
      {registry.page?.nextCursor ? (
        <Button
          size="sm"
          loading={registry.loadingMore}
          loadingLabel="Loading workers…"
          onClick={() => void registry.loadMore()}
        >
          Load more workers
        </Button>
      ) : null}
    </>
  );
}
