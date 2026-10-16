import { readApprovalFollowOn } from "./approval-follow-on";
import {
  useApprovalOperationAttempt,
  beginApprovalOperation,
  updateApprovalOperation,
  releaseApprovalOperationCheck,
  releaseRefusedApprovalOperation,
  canReviewApprovalOperation,
  classifyOperationFailure,
} from "./approval-operation-attempts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { canonicalJsonString, type ApprovalRequest } from "@goatcitadel/contracts";
import {
  fetchDurableRunTimeline,
  resumeDurableRun,
  fetchDevDiagnostics,
} from "@goatcitadel/mission-control-shared/api/client";
import { findTraceMetadata } from "@goatcitadel/mission-control-shared/content/approval-helpers";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useWorkspaceNameLookup } from "../../data/use-workspace-name";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TimeText } from "../../ui/TimeText";
import {
  presentActor,
  presentApprovalEffectKind,
  presentApprovalEffectStatus,
  presentApprovalEvent,
  presentPendingActionResolution,
} from "./inbox-vocabulary";

export function ApprovalAuditRecovery({
  approval,
  workspaceId,
  checking = false,
}: {
  approval: ApprovalRequest;
  workspaceId: string;
  checking?: boolean;
}) {
  const access = useProjectAccess(JSON.stringify([workspaceId, approval.approvalId]));
  return <AuditRecovery key={access.identity} approval={approval} workspaceId={workspaceId} checking={checking} />;
}
function AuditRecovery({
  approval,
  workspaceId,
  checking,
}: {
  approval: ApprovalRequest;
  workspaceId: string;
  checking: boolean;
}) {
  const access = useProjectAccess(JSON.stringify([workspaceId, approval.approvalId]));
  const [open, setOpen] = useState(false),
    [traceOpen, setTraceOpen] = useState(false);
  const [review, setReview] = useState<string>(),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const { activeCitadelId } = useUiPreferences();
  const workspaceName = useWorkspaceNameLookup(activeCitadelId)(workspaceId) ?? "This workspace";

  async function read() {
    const state = await readApprovalFollowOn(approval, workspaceId, access.current);
    const { run } = state;
    const timeline = run ? await fetchDurableRunTimeline(run.runId, 120) : undefined;
    return { ...state, timeline };
  }
  const audit = useQuery({
    queryKey: ["approvals", "audit-recovery", access.identity],
    queryFn: read,
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const traceMetadata =
    (approval.linkage?.correlationId || approval.linkage?.traceId ? approval.linkage : undefined) ??
    findTraceMetadata(audit.data?.replay.pendingAction?.request) ??
    findTraceMetadata(approval.payload) ??
    findTraceMetadata(approval.preview);
  const correlationId = traceMetadata?.correlationId;
  const trace = useQuery({
    queryKey: ["approvals", "audit-trace", access.identity, correlationId],
    queryFn: () => fetchDevDiagnostics({ correlationId, limit: 12 }),
    enabled: traceOpen && Boolean(correlationId),
    retry: false,
  });
  const run = audit.data?.run;
  const attemptKey = JSON.stringify([access.presentationScope, "resume", run?.runId]);
  const attempt = useApprovalOperationAttempt(attemptKey);
  const revision = JSON.stringify([run?.version, run?.updatedAt]);
  const canReview = canReviewApprovalOperation(attempt, revision);
  async function refresh() {
    const result = await audit.refetch();
    if (access.current() && !result.isError) setNotice("");
  }
  async function resume() {
    if (
      !review ||
      checking ||
      !canReview ||
      !access.current() ||
      audit.isError ||
      audit.isFetching ||
      !run ||
      canonicalJsonString(run) !== review
    )
      return;
    const token = beginApprovalOperation(attemptKey, revision);
    if (!token) return;
    setBusy(true);
    setNotice("");
    let sent = false;
    try {
      const fresh = await read();
      if (!access.current()) return;
      if (!fresh.run || fresh.run.status !== "paused" || canonicalJsonString(fresh.run) !== review)
        throw new Error("The checkpoint changed. Refresh and review the current run.");
      sent = true;
      updateApprovalOperation(attemptKey, token, "submitted", "Resume request submitted; outcome is not yet verified.");
      const receipt = await resumeDurableRun(fresh.run.runId, "operator");
      if (receipt.runId !== fresh.run.runId || receipt.workflowKey !== fresh.run.workflowKey)
        throw new Error("Resume receipt does not identify the original workflow.");
      updateApprovalOperation(
        attemptKey,
        token,
        "resolved",
        "Resume requested. Use Open run detail to check its outcome.",
      );
      if (!access.current()) return;
      setReview(undefined);

      await audit.refetch();
    } catch (cause) {
      // Gateway answered and recorded nothing: no replay lock, the same checkpoint may be reviewed again.
      const refused = sent && classifyOperationFailure(cause) === "refused";
      if (refused) releaseRefusedApprovalOperation(attemptKey, token);
      else if (sent)
        updateApprovalOperation(
          attemptKey,
          token,
          "uncertain",
          `Resume outcome is uncertain. Use Open run detail to check it before another request. ${describeApiError(cause).summary}`,
        );
      if (access.current()) {
        setNotice(
          `${refused ? "Resume was not accepted. " : sent ? "Resume outcome is uncertain. Use Open run detail to check it before another request. " : ""}${describeApiError(cause).summary}`,
        );
        setReview(undefined);
      }
    } finally {
      releaseApprovalOperationCheck(attemptKey, token);
      if (access.current()) setBusy(false);
    }
  }
  return (
    <section className="grid min-w-0 gap-3" aria-label="Approval audit and recovery">
      <Button className="justify-self-start" aria-expanded={open} onClick={() => setOpen(!open)}>
        Audit and recovery
      </Button>
      {open ? (
        <>
          <Button disabled={audit.isFetching || busy} onClick={() => void refresh()}>
            Refresh audit and recovery
          </Button>
          {audit.isPending ? <p role="status">Loading decision history and recovery…</p> : null}
          {audit.error ? (
            <p role="alert">
              {describeApiError(audit.error).summary} What is shown may be out of date; recovery is unavailable.
            </p>
          ) : null}
          {notice && !attempt ? <p role="status">{notice}</p> : null}
          {attempt ? <p role="status">{attempt.message}</p> : null}
          {audit.data ? (
            <>
              <h4 className="font-semibold">Decision history</h4>
              <ol className="grid gap-2">
                {audit.data.replay.events.map((event) => (
                  <li key={event.eventId}>
                    {presentApprovalEvent(event.eventType)} ·{" "}
                    {presentActor(event.actorId, event.eventType === "resolved" ? "decision" : "event")} ·{" "}
                    <TimeText value={event.timestamp} />
                  </li>
                ))}
              </ol>
              <p>Pending action: {presentPendingActionResolution(audit.data.replay.pendingAction?.resolutionStatus)}</p>
              {audit.data.replay.effects.map((effect) => (
                <p key={effect.effectId}>
                  Follow-on work: {presentApprovalEffectKind(effect.effectKind)} ·{" "}
                  {presentApprovalEffectStatus(effect.status).label}
                  {effect.lastError ? ` · ${effect.lastError}` : ""}
                </p>
              ))}
              {run ? (
                <>
                  <p>
                    Original linked work: {presentRunStatus(run.status).label}. {run.lastError}
                  </p>
                  <Button
                    disabled={
                      run.status !== "paused" ||
                      audit.isError ||
                      audit.isFetching ||
                      busy ||
                      checking ||
                      !canReview ||
                      Boolean(notice)
                    }
                    onClick={() => setReview(canonicalJsonString(run))}
                  >
                    Resume paused run
                  </Button>
                  <NativeOwnerLink href={`/work/runs/${encodeURIComponent(run.runId)}`} scope={access.identity}>
                    Open run detail
                  </NativeOwnerLink>
                </>
              ) : (
                <p>No run is linked to this approval for recovery.</p>
              )}
              {approval.linkage?.sessionId ? (
                <NativeOwnerLink
                  href={`/chat?sessionId=${encodeURIComponent(approval.linkage.sessionId)}`}
                  scope={access.identity}
                >
                  Open live conversation
                </NativeOwnerLink>
              ) : null}
              <TechnicalDetails label="Audit request, lifecycle and checkpoint diagnostics">
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(audit.data, null, 2)}
                </pre>
              </TechnicalDetails>
            </>
          ) : null}
          {traceMetadata ? (
            <TechnicalDetails label="Trace linkage">
              <p className="break-all">
                Trace: {traceMetadata.traceId ?? "Not recorded"} · Correlation: {correlationId ?? "Not recorded"}
              </p>
            </TechnicalDetails>
          ) : null}
          {correlationId ? (
            <>
              <Button
                disabled={trace.isFetching}
                onClick={() => {
                  setTraceOpen(true);
                  if (traceOpen) void trace.refetch();
                }}
              >
                {traceOpen ? "Refresh trace detail" : "Load trace detail"}
              </Button>
              {trace.error ? <p role="alert">{describeApiError(trace.error).summary}</p> : null}
              {trace.data ? (
                <TechnicalDetails label="Trace diagnostics">
                  {trace.data.items.map((item, index) => (
                    <p key={index}>
                      {item.timestamp} · {item.event}: {item.message}
                    </p>
                  ))}
                </TechnicalDetails>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
      <Dialog
        open={Boolean(review)}
        onOpenChange={(value) => {
          if (!value && !busy) setReview(undefined);
        }}
        title="Resume paused run"
        description="Ask the run to continue from where it paused. This request alone does not show the work completed."
      >
        <p>Workspace: {workspaceName}</p>
        <TechnicalDetails label="Run identifiers">
          <p className="break-all font-mono text-xs">
            Workspace {workspaceId} · Run {run?.runId}
          </p>
        </TechnicalDetails>
        <p>{run?.lastError}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={busy || checking || !canReview || audit.isFetching || audit.isError}
            onClick={() => void resume()}
          >
            Confirm resume
          </Button>
          <Button disabled={busy} onClick={() => setReview(undefined)}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
