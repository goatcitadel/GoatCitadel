import { useId } from "react";
import { useCitadelCouncil } from "../../../features/native-routes/library/use-citadel-council";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { CitadelAccessReview } from "./CitadelAccessReview";

export function CitadelCouncilSettings({ citadelId }: { citadelId: string }) {
  const c = useCitadelCouncil(citadelId),
    selectId = useId(),
    review = c.review;
  const notice = (
    <>
      {c.access.error ? (
        <p role="alert" className="break-words text-sm text-status-waiting">
          {c.access.error}
        </p>
      ) : null}
      {c.notice ? (
        <p role="status" className="text-sm text-fg-secondary">
          {c.notice}
        </p>
      ) : null}
    </>
  );
  return (
    <section
      id="citadel-council"
      aria-label="Citadel Council"
      className="mt-4 space-y-4 border-t border-line-subtle pt-4"
    >
      <header>
        <h3 className="font-display text-md font-semibold text-fg">Council</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Seat existing agents by reference. Membership does not indicate a running agent or copy its profile. Per-seat
          grant ceilings remain governed by policy.
        </p>
        <p className="break-all text-xs text-fg-muted">Citadel: {citadelId}</p>
      </header>
      {notice}
      {c.council.error ? (
        <p role="alert" className="text-sm text-status-waiting">
          {c.council.error}
        </p>
      ) : null}
      {c.council.loading || c.access.loading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading Council and active agent profiles…
        </p>
      ) : null}
      {c.access.reviewRequired ? (
        <CitadelAccessReview snapshot={c.access.snapshot} onAccept={c.access.acceptReview} />
      ) : null}
      {c.access.snapshot?.structure.record?.lifecycleStatus === "archived" ? (
        <p role="status" className="text-sm text-status-waiting">
          Restore this Citadel before changing access rules.
        </p>
      ) : null}
      <details className="rounded-md border border-line-subtle bg-sunken p-3">
        <summary className="cursor-pointer text-sm font-medium text-fg">Manage Council seats</summary>
        <div className="mt-3 space-y-3">
          <label htmlFor={selectId} className="block text-sm text-fg-secondary">
            Council agent
            <select
              id={selectId}
              aria-label="Council agent"
              value={c.selectedAgentId}
              className="mt-1 block w-full rounded-md border border-line bg-canvas px-3 py-2 text-fg"
              onChange={(e) => c.setSelectedAgentId(e.target.value)}
            >
              <option value="">Select agent</option>
              {c.council.agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
              {c.council.items
                .filter((seat) => !c.council.agents.some((agent) => agent.agentId === seat.agentId))
                .map((seat) => (
                  <option key={seat.agentId} value={seat.agentId}>
                    {seat.agentId} · Profile unavailable
                  </option>
                ))}
            </select>
          </label>
          <p className="text-xs text-fg-muted">
            The catalog lists up to 300 active profiles. Saved seats with unavailable profiles remain inspectable and
            removable.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={
                !c.access.ready ||
                c.council.loading ||
                Boolean(c.council.error) ||
                !c.selectedAgentId ||
                c.seatedAgentIds.has(c.selectedAgentId)
              }
              onClick={() => c.request("assign")}
            >
              Review Council seat
            </Button>
            <Button
              variant="danger"
              disabled={!c.access.ready || !c.seatedAgentIds.has(c.selectedAgentId)}
              onClick={() => c.request("remove")}
            >
              Review seat removal
            </Button>
            <Button disabled={c.access.busy || c.council.loading} onClick={() => void c.reloadAgents()}>
              Refresh agents
            </Button>
            <Button disabled={c.access.busy || c.access.loading} onClick={() => void c.access.reload()}>
              Refresh rules
            </Button>
          </div>
        </div>
      </details>
      <ul aria-label="Seated agents" className="max-h-96 space-y-2 overflow-y-auto">
        {c.council.items.map((seat) => {
          const profile = c.council.agents.find((agent) => agent.agentId === seat.agentId);
          return (
            <li key={seat.assignmentId} className="rounded-md border border-line-subtle bg-sunken p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="break-words font-medium text-fg">{profile?.name ?? seat.agentId}</h4>
                  <p className="break-words text-sm text-fg-secondary">{profile?.roleId ?? "Profile unavailable"}</p>
                </div>
                <Button size="sm" onClick={() => c.setSelectedSeatId(seat.assignmentId)}>
                  Inspect {profile?.name ?? seat.agentId}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {!c.council.items.length && !c.access.loading ? (
        <p className="text-sm text-fg-muted">
          No agents seated yet. Choose an existing active profile to add a reference.
        </p>
      ) : null}
      <Dialog
        open={Boolean(c.selectedSeat)}
        title={c.selectedProfile?.name ?? "Council seat"}
        description={c.selectedProfile?.roleId ?? "Profile unavailable"}
        onOpenChange={(open) => {
          if (!open) c.setSelectedSeatId(null);
        }}
      >
        <div className="space-y-3 text-sm text-fg-secondary">
          {notice}
          <p>
            {c.selectedProfile?.summary ?? "Existing agent reference. Membership does not indicate a running agent."}
          </p>
          <dl className="space-y-2 break-all">
            <dt>Agent</dt>
            <dd className="font-mono text-xs">{c.selectedSeat?.agentId}</dd>
            <dt>Seat</dt>
            <dd className="font-mono text-xs">{c.selectedSeat?.assignmentId}</dd>
            <dt>Created</dt>
            <dd>{c.selectedSeat?.createdAt}</dd>
          </dl>
          <Button
            variant="danger"
            disabled={!c.access.ready}
            onClick={() => {
              if (c.selectedSeat) {
                c.request("remove", c.selectedSeat.agentId);
              }
            }}
          >
            Review seat removal
          </Button>
          <ClassicOwnerLink href="/library/agents?shell=classic" scope={citadelId} label="Open agent catalog" />
        </div>
      </Dialog>
      <Dialog
        open={Boolean(review)}
        title={review?.kind === "assign" ? "Seat this agent?" : "Remove Council seat?"}
        description={
          review?.kind === "assign"
            ? "Reference this existing profile in the Council. No agent is started."
            : "Remove this seat reference. The agent profile remains available."
        }
        onOpenChange={(open) => {
          if (!open && !c.access.busy) c.cancel();
        }}
      >
        <dl className="space-y-2 break-words text-sm text-fg-secondary">
          <dt>Profile</dt>
          <dd>{review?.profile?.name ?? "Unavailable"}</dd>
          <dt>Agent</dt>
          <dd className="break-all font-mono text-xs">{review?.agentId}</dd>
          <dt>Citadel</dt>
          <dd>{citadelId}</dd>
          <dt>Reviewed access revision</dt>
          <dd className="break-all font-mono text-xs">{review?.before.revision}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant={review?.kind === "remove" ? "danger" : "primary"}
            disabled={c.access.locked}
            onClick={() => void c.confirm()}
          >
            {review?.kind === "assign" ? "Confirm Council seat" : "Remove seat"}
          </Button>
          <Button disabled={c.access.busy} onClick={c.cancel}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
