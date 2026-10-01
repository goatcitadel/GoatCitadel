import type { HookRecord, HookRunRecord } from "@goatcitadel/contracts";

export function HookRecordEvidence({ hook }: { hook: HookRecord }) {
  return (
    <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 text-sm">
      <dt>Workspace</dt>
      <dd className="break-all">{hook.workspaceId}</dd>
      <dt>Event</dt>
      <dd className="break-words">
        {hook.trigger} · {hook.phase}
      </dd>
      <dt>Mode</dt>
      <dd>
        {hook.mode} · {hook.enabled ? "Enabled" : "Disabled"}
      </dd>
      <dt>Payload</dt>
      <dd>{hook.dataScope ?? "metadata"}</dd>
      <dt>Failure policy</dt>
      <dd>{hook.failPolicy}</dd>
      <dt>Priority</dt>
      <dd>{hook.priority}</dd>
      <dt>Timeout</dt>
      <dd>{hook.timeoutMs} ms</dd>
      <dt>Custody</dt>
      <dd>
        {hook.action.type === "webhook"
          ? hook.action.webhook.secretRef
            ? "Keychain reference recorded"
            : "Legacy / needs rotation"
          : "Managed package"}
      </dd>
      <dt>Record</dt>
      <dd className="break-all">{hook.hookId}</dd>
      <dt>Updated</dt>
      <dd className="break-words">{hook.updatedAt}</dd>
    </dl>
  );
}
export function HookRunEvidence({ run }: { run: HookRunRecord }) {
  return (
    <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 text-sm">
      <dt>Outcome</dt>
      <dd>
        {run.status} · attempt {run.attemptCount}
      </dd>
      <dt>Workspace</dt>
      <dd className="break-all">{run.workspaceId}</dd>
      <dt>Event</dt>
      <dd className="break-words">
        {run.trigger} · {run.entityType}
      </dd>
      <dt>Entity</dt>
      <dd className="break-all">{run.entityId}</dd>
      <dt>Delivery</dt>
      <dd className="break-all">{run.runId}</dd>
      <dt>Hook</dt>
      <dd className="break-all">{run.hookId}</dd>
      <dt>Created</dt>
      <dd className="break-words">{run.createdAt}</dd>
      <dt>Updated</dt>
      <dd className="break-words">{run.updatedAt}</dd>
      {run.durableRunId ? (
        <>
          <dt>Durable run</dt>
          <dd className="break-all">{run.durableRunId}</dd>
        </>
      ) : null}
      {run.errorText ? (
        <>
          <dt>Error</dt>
          <dd>Delivery failure detail is redacted; inspect Gateway audit evidence.</dd>
        </>
      ) : null}
    </dl>
  );
}
