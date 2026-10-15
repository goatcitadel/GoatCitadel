import type { HookRecord, HookRunRecord } from "@goatcitadel/contracts";
import { formatDuration } from "@goatcitadel/mission-control-shared/content/format";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import {
  HOOK_DATA_SCOPE_LABELS,
  HOOK_FAIL_POLICY_LABELS,
  HOOK_MODE_LABELS,
  HOOK_PHASE_LABELS,
  presentHookDeliveryStatus,
  presentHookTrigger,
} from "./settings-vocabulary";

export function HookRecordEvidence({ hook, workspaceLabel }: { hook: HookRecord; workspaceLabel: string }) {
  const dataScope = hook.dataScope ?? "metadata";
  return (
    <>
      <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 text-sm">
        <dt>Workspace</dt>
        <dd className="break-words">{workspaceLabel}</dd>
        <dt>Event</dt>
        <dd className="break-words">
          {presentHookTrigger(hook.trigger)} · {HOOK_PHASE_LABELS[hook.phase] ?? "Unknown phase"}
        </dd>
        <dt>Mode</dt>
        <dd>
          {HOOK_MODE_LABELS[hook.mode] ?? "Unknown mode"} · {hook.enabled ? "Enabled" : "Disabled"}
        </dd>
        <dt>Payload</dt>
        <dd>{HOOK_DATA_SCOPE_LABELS[dataScope] ?? "Unknown payload scope"}</dd>
        <dt>Failure policy</dt>
        <dd>{HOOK_FAIL_POLICY_LABELS[hook.failPolicy] ?? "Unknown failure policy"}</dd>
        <dt>Priority</dt>
        <dd>{hook.priority}</dd>
        <dt>Timeout</dt>
        <dd>{formatDuration(hook.timeoutMs)}</dd>
        <dt>Custody</dt>
        <dd>
          {hook.action.type === "webhook"
            ? hook.action.webhook.secretRef
              ? "Keychain reference recorded"
              : "Legacy / needs rotation"
            : "Managed package"}
        </dd>
        <dt>Updated</dt>
        <dd className="break-words">
          <TimeText value={hook.updatedAt} />
        </dd>
      </dl>
      <TechnicalDetails label="Hook record details">
        <dl className="cockpit-definition-grid grid gap-x-3 gap-y-1 font-mono text-xs">
          <dt>Hook</dt>
          <dd className="break-all">{hook.hookId}</dd>
          <dt>Workspace</dt>
          <dd className="break-all">{hook.workspaceId}</dd>
          <dt>Trigger</dt>
          <dd className="break-all">
            {hook.trigger} · {hook.phase} · {hook.mode}
          </dd>
        </dl>
      </TechnicalDetails>
    </>
  );
}

export function HookRunEvidence({ run, workspaceLabel }: { run: HookRunRecord; workspaceLabel: string }) {
  return (
    <>
      <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2 text-sm">
        <dt>Outcome</dt>
        <dd>
          {presentHookDeliveryStatus(run.status).label} · attempt {run.attemptCount}
        </dd>
        <dt>Workspace</dt>
        <dd className="break-words">{workspaceLabel}</dd>
        <dt>Event</dt>
        <dd className="break-words">{presentHookTrigger(run.trigger)}</dd>
        <dt>Created</dt>
        <dd className="break-words">
          <TimeText value={run.createdAt} />
        </dd>
        <dt>Updated</dt>
        <dd className="break-words">
          <TimeText value={run.updatedAt} />
        </dd>
        {run.errorText ? (
          <>
            <dt>Error</dt>
            <dd>Delivery failure detail is redacted; inspect Gateway audit evidence.</dd>
          </>
        ) : null}
      </dl>
      <TechnicalDetails label="Delivery details">
        <dl className="cockpit-definition-grid grid gap-x-3 gap-y-1 font-mono text-xs">
          <dt>Delivery</dt>
          <dd className="break-all">{run.runId}</dd>
          <dt>Hook</dt>
          <dd className="break-all">{run.hookId}</dd>
          <dt>Workspace</dt>
          <dd className="break-all">{run.workspaceId}</dd>
          <dt>Status</dt>
          <dd className="break-all">{run.status}</dd>
          <dt>Trigger</dt>
          <dd className="break-all">{run.trigger}</dd>
          <dt>Entity</dt>
          <dd className="break-all">
            {run.entityType} · {run.entityId}
          </dd>
          {run.durableRunId ? (
            <>
              <dt>Durable run</dt>
              <dd className="break-all">{run.durableRunId}</dd>
            </>
          ) : null}
        </dl>
      </TechnicalDetails>
    </>
  );
}
