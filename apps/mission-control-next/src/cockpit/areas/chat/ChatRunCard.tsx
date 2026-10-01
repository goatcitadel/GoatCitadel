import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";

export function ChatRunCard({ props, turnId, durableRunId, onInspect }: {
  props: MissionThreadedActiveSessionSurfaceProps;
  turnId?: string;
  durableRunId?: string;
  onInspect?: () => void;
}) {
  const run = props.delegationRun?.attachedTurnId && props.delegationRun.attachedTurnId !== turnId ? null : props.delegationRun;
  if (!run && !durableRunId) return null;
  const completed = run?.steps.filter((step) => step.status === "completed").length ?? 0;
  return <section aria-label="Conversation run" className="mt-3 rounded-lg border border-line bg-raised p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-accent">{run ? "Supervised work" : "Durable run"}</p>
        <h3 className="truncate font-display font-semibold text-fg">{run?.label ?? "Run evidence"}</h3>
      </div>
      {run ? <StatusBadge status={{ label: run.status === "partial" ? "Partially complete" : humanizeToken(run.status),
        tone: run.status === "running" ? "running" : run.status === "completed" ? "done" : run.status === "failed" ? "failed" : "waiting" }} /> : <span className="text-xs text-fg-muted">Recorded for this turn</span>}
    </div>
    {run?.objective ? <p className="mt-2 line-clamp-2 text-fg-secondary">{run.objective}</p> : null}
    {run?.steps.length ? <p className="mt-2 text-xs text-fg-muted">{completed} of {run.steps.length} steps done · Latest: {run.steps.at(-1)?.label ?? humanizeToken(run.steps.at(-1)?.role ?? "step")}</p> : null}
    <div className="mt-3 flex flex-wrap gap-3">
      {onInspect ? <button type="button" onClick={onInspect} className="font-medium text-accent hover:underline">Inspect run</button> : null}
      {durableRunId ? <NativeOwnerLink scope={[props.selectedSessionId, turnId, durableRunId]} href={`/work/runs/${encodeURIComponent(durableRunId)}`} className="font-medium text-accent hover:underline">Open durable evidence</NativeOwnerLink> : null}
    </div>
  </section>;
}
