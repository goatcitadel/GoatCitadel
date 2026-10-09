import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  cancelChangePlan, confirmChangePlan, fetchChangePlan, respondToChangePlan, submitChangePlanChannelSecrets,
} from "@goatcitadel/mission-control-shared/api/chat";
import { API_BASE } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  assertChannelPlanReviewBinding, channelPlanReturnHref, readChannelPlanReviewHandoff,
} from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import { ChatChangePlanActionDialog, type ChangePlanPublicValues } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { Button } from "@goatcitadel/mission-control-shared/components/ui/button";
import { isTerminalChangePlanStatus } from "./change-plan-controller-helpers";

type Props = {
  workspaceId: string;
  routeSearch: string;
  onReturnToChannels?: (href: string) => void;
  onOpenApprovals: (approvalId?: string) => void;
};
/** Workspace settings review has its own state; it is never attributed to a selected conversation. */
export function WorkspaceChannelPlanReview({ workspaceId, routeSearch, onReturnToChannels, onOpenApprovals }: Props) {
  const handoff = useMemo(() => readChannelPlanReviewHandoff(routeSearch), [routeSearch]);
  const key = handoff ? `${API_BASE}:${workspaceId}:${handoff.workspaceId}:${handoff.planId}:${handoff.reviewedRevision}:${handoff.draftId}` : "";
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const [snapshot, setSnapshot] = useState<{ key: string; plan: ChangePlanRecord | null; error: string | null; loading: boolean }>({ key: "", plan: null, error: null, loading: false });
  const [openKey, setOpenKey] = useState("");
  const [pendingKey, setPendingKey] = useState("");
  const current = snapshot.key === key ? snapshot : { key, plan: null, error: null, loading: Boolean(key) };
  const plan = current.plan;
  const open = openKey === key;
  const pending = pendingKey === key;
  const malformed = !handoff && new URLSearchParams(routeSearch).has("channelPlan");

  async function refresh() {
    if (!handoff || handoff.workspaceId !== workspaceId) return;
    const requestGeneration = ++generation.current;
    setSnapshot((value) => ({ key, plan: value.key === key ? value.plan : null, error: null, loading: true }));
    try {
      const fresh = await fetchChangePlan(handoff.planId, { workspaceId });
      assertChannelPlanReviewBinding(fresh, handoff);
      if (currentKey.current !== key || requestGeneration !== generation.current) return;
      const changed = fresh.revision !== handoff.reviewedRevision;
      setSnapshot({ key, plan: fresh, loading: false, error: changed ? "This setup plan changed since Channels opened it. Review the current revision before continuing." : null });
      if (!changed && !isTerminalChangePlanStatus(fresh.status)) setOpenKey(key);
    } catch (error) {
      if (currentKey.current === key && requestGeneration === generation.current) {
        setSnapshot({ key, plan: null, loading: false, error: error instanceof Error ? error.message : "The exact channel setup plan is unavailable." });
      }
    }
  }
  useEffect(() => {
    setOpenKey("");
    setPendingKey("");
    void refresh();
    return () => { generation.current += 1; };
    // Identity deliberately includes the workspace, Gateway and exact navigation revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function act(reviewed: ChangePlanRecord, operation: (fresh: ChangePlanRecord) => Promise<ChangePlanRecord>) {
    if (!handoff || pending || currentKey.current !== key || reviewed.planId !== plan?.planId || handoff.workspaceId !== workspaceId) return;
    setPendingKey(key);
    setSnapshot((value) => value.key === key ? { ...value, error: null } : value);
    try {
      const fresh = await fetchChangePlan(reviewed.planId, { workspaceId });
      assertChannelPlanReviewBinding(fresh, handoff);
      if (currentKey.current !== key) return;
      if (!isExactReviewedChannelAction(reviewed, fresh)) {
        setSnapshot({ key, plan: fresh, loading: false, error: "The plan or requested action changed. Review this current revision again." });
        setOpenKey("");
        return;
      }
      const updated = await operation(fresh);
      assertChannelPlanReviewBinding(updated, handoff);
      if (currentKey.current !== key) return;
      setSnapshot({ key, plan: updated, loading: false, error: null });
      if (isTerminalChangePlanStatus(updated.status)) setOpenKey("");
    } catch (error) {
      if (currentKey.current === key) setSnapshot((value) => value.key === key ? { ...value, error: error instanceof Error ? error.message : "Unable to continue this setup plan." } : value);
    } finally {
      if (currentKey.current === key) setPendingKey("");
    }
  }
  const confirm = (reviewed: ChangePlanRecord) => act(reviewed, (fresh) => {
    if (fresh.requiredAction?.kind !== "confirmation") throw new Error("Review the current confirmation action.");
    return confirmChangePlan(fresh.planId, { workspaceId }, { expectedRevision: fresh.revision, actionNonce: fresh.requiredAction.actionNonce });
  });
  const submitForm = (reviewed: ChangePlanRecord, values: ChangePlanPublicValues) => act(reviewed, (fresh) => {
    if (fresh.requiredAction?.kind !== "public_form") throw new Error("Review the current setup form.");
    return respondToChangePlan(fresh.planId, { workspaceId }, { expectedRevision: fresh.revision, actionId: fresh.requiredAction.actionId, actionNonce: fresh.requiredAction.actionNonce, values });
  });
  const submitSecret = (reviewed: ChangePlanRecord, values: Readonly<Record<string, string>>) => act(reviewed, (fresh) => {
    if (fresh.requiredAction?.kind !== "secure_input") throw new Error("Review the current credential action.");
    return submitChangePlanChannelSecrets(fresh.planId, { workspaceId }, { expectedRevision: fresh.revision, actionId: fresh.requiredAction.actionId, actionNonce: fresh.requiredAction.actionNonce, values });
  });
  const continueApproval = (reviewed: ChangePlanRecord) => act(reviewed, (fresh) => {
    if (fresh.requiredAction?.kind !== "approval" || !fresh.requiredAction.approvalId) throw new Error("Review the current required approval.");
    // The Gateway re-reads the exact canonical approval before any application.
    return respondToChangePlan(fresh.planId, { workspaceId }, { expectedRevision: fresh.revision, actionId: fresh.requiredAction.actionId, actionNonce: fresh.requiredAction.actionNonce, values: {} });
  });
  const cancel = (reviewed: ChangePlanRecord) => act(reviewed, (fresh) => {
    if (!fresh.requiredAction) throw new Error("This plan has no current cancellation action.");
    return cancelChangePlan(fresh.planId, { workspaceId }, { expectedRevision: fresh.revision, actionNonce: fresh.requiredAction.actionNonce });
  });
  const unsupported = async () => {
    setSnapshot((value) => value.key === key ? { ...value, error: "Continue this owner-specific setup action from Channels." } : value);
  };
  if (!handoff && !malformed) return null;
  if (!handoff || handoff.workspaceId !== workspaceId) {
    return <section className="panel" role="alert"><p>This channel setup review belongs to another workspace or has an invalid link. Open it again from Channels in the intended workspace.</p></section>;
  }
  return <section className="panel workspace-channel-plan-review" aria-label="Channel setup Change Plan review">
    <p><strong>Channel setup review</strong> · Workspace {workspaceId}</p>
    {current.loading ? <p role="status">Loading the exact setup plan…</p> : null}
    {current.error ? <p role="alert">{current.error}</p> : null}
    {plan ? <>
      <p>{plan.title} · Revision {plan.revision} · {plan.status.replaceAll("_", " ")}</p>
      <p>{plan.result?.summary ?? plan.summary}</p>
      <div className="flex flex-wrap gap-2">
        {plan.requiredAction && !isTerminalChangePlanStatus(plan.status) ? <Button disabled={pending || current.loading} onClick={() => { setOpenKey(key); setSnapshot((value) => ({ ...value, error: null })); }}>Review current revision</Button> : null}
        <Button variant="outline" disabled={pending || current.loading} onClick={() => void refresh()}>Refresh status</Button>
        <Button variant="outline" disabled={pending || !onReturnToChannels} onClick={() => onReturnToChannels?.(channelPlanReturnHref(plan))}>Return to Channels</Button>
        {plan.requiredAction && !isTerminalChangePlanStatus(plan.status) ? <Button variant="outline" disabled={pending} onClick={() => void cancel(plan)}>Cancel setup plan and discard its draft</Button> : null}
      </div>
      <ChatChangePlanActionDialog plan={open && !isTerminalChangePlanStatus(plan.status) ? plan : null}
        pending={pending} error={current.error} contextNote="This workspace setup plan was opened from Channels. It is reviewed independently of the selected conversation."
        onClose={() => setOpenKey("")} onConfirm={confirm} onSubmitPublicForm={submitForm} onSubmitSecureInput={submitSecret}
        onContinueOAuth={unsupported} onOpenApproval={(reviewed) => {
          if (reviewed.requiredAction?.kind === "approval") onOpenApprovals(reviewed.requiredAction.approvalId ?? reviewed.approvalRefs.at(-1));
        }} renderApprovalAction={(reviewed, isPending) => <div className="flex flex-wrap gap-2">
          <Button disabled={isPending} onClick={() => {
            if (reviewed.requiredAction?.kind === "approval") onOpenApprovals(reviewed.requiredAction.approvalId);
          }}>Open required approval</Button>
          <Button variant="outline" disabled={isPending} onClick={() => void continueApproval(reviewed)}>Continue after approval</Button>
        </div>} onReviewArtifacts={unsupported} onOpenNativePathPicker={unsupported} />
    </> : <Button variant="outline" disabled={current.loading} onClick={() => void refresh()}>Retry exact plan lookup</Button>}
  </section>;
}
export function isExactReviewedChannelAction(reviewed: ChangePlanRecord, fresh: ChangePlanRecord): boolean {
  return reviewed.planId === fresh.planId && reviewed.revision === fresh.revision &&
    reviewed.intentHash === fresh.intentHash && reviewed.actionSnapshotHash === fresh.actionSnapshotHash &&
    reviewed.target.ownerId === fresh.target.ownerId && reviewed.target.resourceId === fresh.target.resourceId &&
    reviewed.target.expectedRevision === fresh.target.expectedRevision && reviewed.target.expectedHash === fresh.target.expectedHash &&
    reviewed.requiredAction?.kind === fresh.requiredAction?.kind &&
    reviewed.requiredAction?.actionId === fresh.requiredAction?.actionId && reviewed.requiredAction?.actionNonce === fresh.requiredAction?.actionNonce;
}