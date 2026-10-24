import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ApprovalRequest } from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { readApprovalFollowOn } from "./approval-follow-on";
import {
  ApprovalChangePlanOutcome,
  approvalChangePlanId,
  approvalChangePlanQueryKey,
} from "./ApprovalChangePlanOutcome";
import { approvalDecisionMessage, approvalResolutionLine } from "./approval-settlement";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { RecordedErrorDetails } from "../../ui/RecordedErrorDetails";
import { presentErrorText } from "../../lib/present-error";
import { presentApprovalEffectKind, presentApprovalEffectStatus, presentApprovalEvent } from "./inbox-vocabulary";

export function ApprovalSettlement({
  approval,
  workspaceId,
  onFollowOnChange,
  focusDecision = false,
}: {
  approval: ApprovalRequest;
  workspaceId: string;
  onFollowOnChange?: () => void;
  /** Move focus to the decision line, which replaces the parent's click notice (#496). */
  focusDecision?: boolean;
}) {
  const access = useProjectAccess(workspaceId);
  const queryClient = useQueryClient();
  const route = useCockpitRoute();
  const decisionParams = new URLSearchParams(route.search);
  decisionParams.set("approvalId", approval.approvalId);
  decisionParams.set("workspaceId", workspaceId);
  decisionParams.set("view", "history");
  decisionParams.delete("shell");
  decisionParams.delete("shellScope");
  const decisionHref = `/inbox?${decisionParams}${route.hash}`;
  const query = useQuery({
    queryKey: ["approval-settlement", workspaceId, approval.approvalId, access.identity],
    queryFn: () => readApprovalFollowOn(approval, workspaceId, access.current),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const data = query.state.data;
      return data?.replay.effects.some((effect) => effect.status === "pending" || effect.status === "running") ||
        [data?.run, data?.wait].some(
          (run) => run && !["completed", "failed", "cancelled", "dead_lettered"].includes(run.status),
        )
        ? 2000
        : false;
    },
  });
  const state = query.data;
  const onFollowOnChangeRef = useRef(onFollowOnChange);
  onFollowOnChangeRef.current = onFollowOnChange;
  const followOnKey = state
    ? JSON.stringify([
        workspaceId,
        approval.approvalId,
        access.identity,
        state.replay.approval.status,
        state.replay.effects.map((effect) => [effect.effectId, effect.status]),
        [state.run?.runId, state.run?.status],
        [state.wait?.runId, state.wait?.status],
      ])
    : undefined;
  useEffect(() => {
    // Slow approval effects can settle long after the decision callback. Let
    // Chat re-read its canonical thread/queue when this polling owner sees a
    // changed outcome, without refreshing on every identical poll/render.
    if (followOnKey) onFollowOnChangeRef.current?.();
  }, [followOnKey]);
  const run = state?.run;
  const settled = state?.replay.approval ?? approval;
  const resolution = approvalResolutionLine(settled);
  const planId = approvalChangePlanId(approval);
  const decisionRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focusDecision) decisionRef.current?.focus();
  }, [focusDecision]);
  return (
    <section aria-label="Decision and follow-on work" className="space-y-2 border-t border-line-subtle pt-3">
      <p role="status" ref={decisionRef} tabIndex={focusDecision ? -1 : undefined}>
        {approvalDecisionMessage(settled, state?.replay.effects)}
      </p>
      {resolution ? <p className="text-fg-secondary">{resolution}</p> : null}
      {state ? (
        <details>
          <summary>Decision history</summary>
          <ol className="space-y-2 pt-2">
            {state.replay.events.map((event) => (
              <li key={event.eventId}>
                {presentApprovalEvent(event.eventType)} · <TimeText value={event.timestamp} />
              </li>
            ))}
          </ol>
          {state.replay.effects.map((effect) => (
            <p key={effect.effectId}>
              Follow-on effect: {presentApprovalEffectKind(effect.effectKind)} ·{" "}
              {presentApprovalEffectStatus(effect.status).label}
            </p>
          ))}
        </details>
      ) : null}
      {state?.replay.approval.followUp?.reason ? (
        <TechnicalDetails>
          <p>Wake reason: {state.replay.approval.followUp.reason}</p>
        </TechnicalDetails>
      ) : null}
      {query.isError ? (
        <p role="alert">
          Decision recorded; follow-on work couldn&apos;t be refreshed. {describeApiError(query.error).summary} What is
          shown may be out of date.
        </p>
      ) : null}
      {/* Background polling stays quiet; only the outcome lines above and below are live regions. */}
      {query.isFetching ? <p className="text-fg-muted">Checking follow-on work…</p> : null}
      {state?.wait ? (
        <p>
          Approval wait: {presentRunStatus(state.wait.status).label}. This tracks the approval itself, not the original
          work.
        </p>
      ) : null}
      {planId ? (
        <ApprovalChangePlanOutcome approval={approval} planId={planId} workspaceId={workspaceId} />
      ) : run ? (
        <>
          <p role={run.status === "failed" || run.status === "dead_lettered" ? "alert" : "status"}>
            Original linked work: {run.status === "running" ? "Resumed" : presentRunStatus(run.status).label}.{" "}
            {run.lastError ? presentErrorText(run.lastError).summary : null}
          </p>
          <RecordedErrorDetails error={run.lastError} />
        </>
      ) : state ? (
        <p>No original run was found. A recorded decision does not show the work ran.</p>
      ) : (
        <p>Original linked work outcome is not yet verified.</p>
      )}
      <Button
        size="sm"
        disabled={query.isFetching}
        onClick={() => {
          void query.refetch();
          if (planId)
            void queryClient.invalidateQueries({ queryKey: approvalChangePlanQueryKey(approval, workspaceId) });
        }}
      >
        Refresh follow-on work
      </Button>
      <div className="pt-3">
        <NativeOwnerLink href={decisionHref} scope={JSON.stringify([access.identity, approval.approvalId])}>
          Inspect decision and execution record
        </NativeOwnerLink>
      </div>
    </section>
  );
}
