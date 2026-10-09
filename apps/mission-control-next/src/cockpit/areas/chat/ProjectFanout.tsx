import type { ChatProjectRecord } from "@goatcitadel/contracts";
import {
  useProjectFanout,
  defaultExpiryValue,
  formatGrantStatus,
} from "../../../features/native-routes/projects/use-project-fanout";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { Dialog } from "../../ui/Dialog";
import { Field } from "../../ui/Field";
import { RiskBadge } from "../../ui/RiskBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";

export function ProjectFanout({
  project,
  workspaceId,
  citadelId,
}: {
  project: ChatProjectRecord;
  workspaceId: string;
  citadelId?: string;
}) {
  const owner = useProjectFanout(project, workspaceId, citadelId);
  return (
    <section aria-label="Automatic fan-out" className="grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-line p-4">
      <h2 className="font-display text-lg">Automatic fan-out</h2>
      <p className="text-sm text-fg-secondary">
        Allow automatic child work for this project until a finite expiry. Every launch reserves child slots and cost
        before dispatch. Deny-wins, approvals, tools, hosts, and paths remain governed by the Gateway.
      </p>
      {owner.error ? <Callout tone="error">{owner.error}</Callout> : null}
      {owner.message ? <Callout>{owner.message}</Callout> : null}
      {owner.loading ? <p role="status">Reading project grants…</p> : null}
      {project.lifecycleStatus !== "active" ? (
        <Callout tone="warning">Archived projects cannot authorize automatic fan-out.</Callout>
      ) : null}
      <Button disabled={owner.busy || owner.loading} onClick={() => void owner.load()}>
        Refresh grants
      </Button>
      {owner.grants.map((grant) => (
        <article key={grant.grantId} className="grid min-w-0 grid-cols-1 gap-2 border-t border-line pt-3">
          <h3>{grant.status === "active" ? "Active project grant" : `Grant ${grant.status}`}</h3>
          <p className="text-sm">{formatGrantStatus(grant)}</p>
          <p className="break-words text-sm">{grant.reason}</p>
          <p className="break-words text-sm">Recorded caller: {grant.grantor}</p>
          <TechnicalDetails>
            <p className="break-all">Grant {grant.grantId}</p>
          </TechnicalDetails>
          {grant.status === "active" ? (
            <Button variant="danger" disabled={owner.busy} onClick={() => void owner.revoke(grant)}>
              Revoke now
            </Button>
          ) : null}
        </article>
      ))}
      {owner.canCreate ? (
        <div className="grid min-w-0 grid-cols-1 gap-3">
          <Field label="Grant lifetime preset">
            {(props) => (
              <select
                {...props}
                className="w-full min-w-0 max-w-full rounded-md border border-line bg-raised p-2"
                value=""
                onChange={(event) => {
                  if (event.target.value)
                    owner.setDraft((current) => ({
                      ...current,
                      expiresAt: defaultExpiryValue(Number(event.target.value)),
                    }));
                }}
              >
                <option value="">Choose a lifetime</option>
                <option value="1">1 hour</option>
                <option value="24">1 day</option>
                <option value="168">7 days</option>
                <option disabled value="indefinite">
                  Until revoked — unavailable: Gateway requires expiry
                </option>
              </select>
            )}
          </Field>
          {(
            [
              { key: "expiresAt", label: "Automatic fan-out grant expiry", type: "datetime-local" },
              { key: "maxActivations", label: "Automatic fan-out child activation limit", type: "number" },
              { key: "budgetUsd", label: "Automatic fan-out budget ceiling", type: "number" },
              { key: "reason", label: "Automatic fan-out grant reason", type: "text" },
            ] as const
          ).map((field) => (
            <Field key={field.key} label={field.label}>
              {(props) => (
                <input
                  {...props}
                  className="w-full min-w-0 max-w-full rounded-md border border-line bg-raised p-2"
                  type={field.type}
                  value={owner.draft[field.key]}
                  disabled={owner.busy}
                  onChange={(event) => owner.setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                />
              )}
            </Field>
          ))}
          <p className="text-sm text-fg-muted">
            New grants default to one hour, three child activations and a $0.75 ceiling. Until revoked is unavailable
            because the Gateway requires finite expiry.
          </p>
          <Button disabled={owner.busy || owner.loading} onClick={owner.createGrant}>
            Review automatic fan-out
          </Button>
        </div>
      ) : owner.activeGrant ? (
        <p className="text-sm">Revoke the active grant before issuing a replacement.</p>
      ) : null}
      <Dialog
        open={Boolean(owner.review)}
        onOpenChange={(open) => {
          if (!open) owner.cancel();
        }}
        title="Review automatic fan-out"
        description="Confirm the exact project, expiry, and limits before granting temporary authority."
      >
        <div className="grid min-w-0 grid-cols-1 gap-3">
          <p className="break-words">
            {project.name} · Workspace {workspaceId}
          </p>
          <p>
            {owner.review?.input.maxActivations} child activations · ${owner.review?.input.budgetUsd} ceiling
          </p>
          <p className="break-all">Expires {owner.review?.input.expiresAt}</p>
          <p className="break-words">{owner.review?.input.reason}</p>
          <p className="text-sm">
            Chat only, automatic child work only. This permits child dispatch within the limits above. Gateway policy
            and approvals still apply; the Gateway records the authenticated caller.
          </p>
          <RiskBadge risk="caution" />
          <p className="break-all text-sm">Workspace path: {project.workspacePath}</p>
          <TechnicalDetails label="Exact grant scope">
            <p className="break-all">
              Project {project.projectId} · Revision {project.revision} · Workspace {workspaceId}
            </p>
            <p>Capability and tool: agent.fanout · Activation: subagent_fanout</p>
          </TechnicalDetails>
          <div className="flex flex-wrap gap-2">
            <Button onClick={owner.cancel}>Cancel</Button>
            <Button variant="primary" disabled={owner.busy} onClick={() => void owner.confirm()}>
              Confirm automatic fan-out
            </Button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
