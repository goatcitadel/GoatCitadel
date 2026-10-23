import type { RemoteWorkerAssignmentProjection } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { Button } from "../../../ui/Button";
import { Sheet } from "../../../ui/Sheet";
import { StatusBadge } from "../../../ui/StatusBadge";
import { TechnicalDetails } from "../../../ui/TechnicalDetails";
import { AssignmentRuntimeSections } from "./AssignmentRuntimeSections";
import { useAssignmentEvents } from "./use-assignment-events";
import { assignmentStatus, settlementStatus } from "./worker-copy";

function humanEvent(eventType: string): string {
  const words = eventType.replace(/[_.]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
}

/** One assignment: its events, then what the worker reported for it. A bookmark never falls back to another one. */
export function AssignmentInspector({
  workspaceId,
  assignments,
  assignmentId,
  refreshKey,
  onClose,
}: {
  workspaceId: string;
  assignments: readonly RemoteWorkerAssignmentProjection[];
  assignmentId: string;
  refreshKey?: string;
  onClose: () => void;
}) {
  const assignment = assignments.find((item) => item.assignmentId === assignmentId);
  const generation = assignment?.identity.value?.assignmentGeneration;
  const events = useAssignmentEvents(workspaceId, assignment ? { assignmentId, generation, refreshKey } : undefined);
  const settlement = assignment?.settlement.value;
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : onClose())} title="Assignment details" sideOnDesktop>
      {!assignment ? (
        <p className="text-sm text-fg-secondary">
          This assignment is not in the loaded records. Close this panel and load more assignments to find it; no other
          assignment is selected.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={assignmentStatus(assignment.phase.value)} />
            {settlement ? (
              <span className="text-sm text-fg-secondary">
                Finished: {settlementStatus(settlement.outcome).label}
                {settlement.origin === "gateway_recovery" ? " (recovered by the server)" : ""}
              </span>
            ) : null}
          </div>
          <section>
            <h3 className="text-sm font-semibold text-fg">Events</h3>
            {generation === undefined ? (
              <p className="text-sm text-fg-muted">
                Events are unavailable because this assignment's version was not reported.
              </p>
            ) : events.error ? (
              <p className="text-sm text-status-failed">{events.error}</p>
            ) : !events.page ? (
              <p className="text-sm text-fg-muted">Loading events…</p>
            ) : events.page.items.length === 0 ? (
              <p className="text-sm text-fg-muted">No events for this version of the assignment.</p>
            ) : (
              <>
                <ul className="divide-y divide-line-subtle text-sm text-fg-secondary">
                  {events.page.items.map((event) => (
                    <li key={event.eventId} className="py-1.5">
                      {humanEvent(event.eventType)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-fg-muted">
                  Not shown: {plural(events.page.omitted.transcriptDeltas, "transcript update")},{" "}
                  {plural(events.page.omitted.terminalOutputs, "terminal output")},{" "}
                  {plural(events.page.omitted.diagnostics, "diagnostic")}.
                </p>
              </>
            )}
            {events.moreError ? <p className="text-sm text-status-failed">{events.moreError}</p> : null}
            <Button
              className="mt-2"
              size="sm"
              disabled={!events.page || events.loadingNewer}
              loading={events.loadingNewer}
              loadingLabel="Loading events…"
              onClick={() => void events.loadNewer()}
            >
              Load newer events
            </Button>
          </section>
          <AssignmentRuntimeSections workspaceId={workspaceId} assignment={assignment} refreshKey={refreshKey} />
          <TechnicalDetails label="Assignment record">
            <pre className="max-h-64 overflow-auto font-mono text-xs">{JSON.stringify(assignment, null, 2)}</pre>
          </TechnicalDetails>
        </div>
      )}
    </Sheet>
  );
}
