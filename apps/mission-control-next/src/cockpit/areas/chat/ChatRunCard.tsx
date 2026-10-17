import { ChevronRight } from "lucide-react";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { presentDelegationRunStatus } from "./chat-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";
import { useAutoOpenDisclosure } from "./use-auto-open-disclosure";

export function ChatRunCard({
  props,
  turnId,
  durableRunId,
  onInspect,
}: {
  props: MissionThreadedActiveSessionSurfaceProps;
  turnId?: string;
  durableRunId?: string;
  onInspect?: () => void;
}) {
  const run =
    props.delegationRun?.attachedTurnId && props.delegationRun.attachedTurnId !== turnId ? null : props.delegationRun;
  // CH-10/CH-39: opens while work is running; a pending decision has its own card. Never closes itself.
  const disclosure = useAutoOpenDisclosure(Boolean(props.hasActiveStream || (run && run.status !== "completed")));
  if (!run && !durableRunId) return null;
  const completed = run?.steps.filter((step) => step.status === "completed").length ?? 0;
  const status = run ? presentDelegationRunStatus(run.status) : null;
  return (
    <details
      {...disclosure}
      aria-label="Conversation run"
      className="group mt-3 rounded-lg border border-line bg-raised p-3 text-sm"
    >
      {/* The summary is the heading; the kind of run rides in the badge instead of an eyebrow. */}
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-fg-muted group-open:rotate-90" />
          <h3 className="min-w-0 truncate font-semibold text-fg">{run?.label ?? "Background run"}</h3>
        </span>
        {status ? (
          <StatusBadge status={{ ...status, label: `Supervised work · ${status.label}` }} />
        ) : (
          <span className="text-xs text-fg-muted">Recorded for this response</span>
        )}
      </summary>
      {run?.objective ? <p className="mt-2 line-clamp-2 text-fg-secondary">{run.objective}</p> : null}
      {run?.steps.length ? (
        <p className="mt-2 text-xs text-fg-muted">
          {completed} of {run.steps.length} steps done · Latest:{" "}
          {run.steps.at(-1)?.label ?? humanizeToken(run.steps.at(-1)?.role ?? "step")}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        {onInspect ? (
          <button
            type="button"
            onClick={onInspect}
            className="inline-flex min-h-8 items-center font-medium text-accent hover:underline max-sm:min-h-11"
          >
            Inspect run
          </button>
        ) : null}
        {durableRunId ? (
          <NativeOwnerLink
            scope={[props.selectedSessionId, turnId, durableRunId]}
            href={`/work/runs/${encodeURIComponent(durableRunId)}`}
            className="inline-flex min-h-8 items-center font-medium text-accent hover:underline max-sm:min-h-11"
          >
            Open run in Work
          </NativeOwnerLink>
        ) : null}
      </div>
    </details>
  );
}
