import { useState } from "react";
import { useSessionViewState } from "../../../hooks/use-session-view-state";
import { useStableHandler } from "../../threaded-surface/useStableHandler";
import { useSessionDraft } from "./session-drafts";
import { useDraftLeave } from "./DraftLeaveDialog";
import {
  WORKFLOW_SKILL_CAPTURE_MARKER,
  type ChangePlanRecord,
  type ChatThreadTurnRecord,
  type CapabilityProposalRecord,
  type WorkflowSkillCaptureResult,
} from "@goatcitadel/contracts";
import {
  createChangePlan,
  fetchChangePlan,
  fetchCapabilityCandidate,
  fetchCapabilityProposals,
  prepareWorkflowSkillCapture,
  stageWorkflowSkillCapture,
} from "@goatcitadel/mission-control-shared/api/client";

import { useLibraryOperation } from "../../../cockpit/areas/library/use-library-operation";

export function WorkflowSkillCaptureControl(props: WorkflowCaptureProps) {
  const access = useLibraryOperation(JSON.stringify(["workflow-capture", props.workspaceId, props.sessionId, props.turn.turnId]));
  return <CaptureControl key={access.identity} {...props} />;
}

type WorkflowCaptureProps = { turn: ChatThreadTurnRecord; sessionId: string; workspaceId: string; draftEmpty: boolean; onPrepare: (prompt: string) => void; onReviewPlan?: (plan: ChangePlanRecord) => void };
function CaptureControl({
  turn,
  sessionId,
  workspaceId,
  draftEmpty,
  onPrepare,
  onReviewPlan,
}: {
  turn: ChatThreadTurnRecord;
  sessionId: string;
  workspaceId: string;
  draftEmpty: boolean;
  onPrepare: (prompt: string) => void;
  onReviewPlan?: (plan: ChangePlanRecord) => void;
}) {
  const operation = useLibraryOperation(JSON.stringify(["workflow-capture", workspaceId, sessionId, turn.turnId]));
  // The Chat transcript is virtualized and can recreate this row while the operator
  // works; keep the disclosure in the same presentation-scoped state as its receipts.
  const [open, setOpen] = useSessionViewState(
    JSON.stringify(["workflow-capture-open", operation.presentationScope]),
    false,
  );
  const leave = useDraftLeave();
  const captureDraft = useSessionDraft(
    JSON.stringify(["workflow-capture-draft", operation.presentationScope]),
    { guidance: "", target: "" },
    undefined,
    { label: "Skill capture guidance", active: open },
  );
  const { guidance, target } = captureDraft.value;
  const setGuidance = (guidance: string) => captureDraft.setValue((current) => ({ ...current, guidance }));
  const setTarget = (target: string) => captureDraft.setValue((current) => ({ ...current, target }));
  const receiptKey = JSON.stringify(["workflow-capture-receipt", operation.presentationScope]);
  const [choices, setChoices] = useState<CapabilityProposalRecord[]>([]);
  const [busy, setBusy] = useSessionViewState(receiptKey + ":busy", false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useSessionViewState<WorkflowSkillCaptureResult | null>(receiptKey + ":candidate", null);
  const [plan, setPlan] = useSessionViewState<ChangePlanRecord | null>(receiptKey + ":plan", null);
  const sourceKey = JSON.stringify([workspaceId, sessionId, turn.turnId]);
  const acceptPrepared = useStableHandler((preparedFor: string, prompt: string) => {
    if (!operation.current()) return;
    if (preparedFor !== sourceKey)
      throw new Error("The conversation changed. Prepare the skill again from its source task.");
    if (!draftEmpty)
      throw new Error("Your draft changed while the skill was being prepared. Send or clear it before trying again.");
    onPrepare(prompt);
  });
  const openReview = useStableHandler((created: ChangePlanRecord) => {
    if (operation.current() && created.origin.sessionId === sessionId && created.origin.workspaceId === workspaceId) onReviewPlan?.(created);
  });
  const isCapture = turn.userMessage.content.startsWith(WORKFLOW_SKILL_CAPTURE_MARKER);
  if (
    turn.trace.status !== "completed" ||
    turn.trace.completion?.status !== "complete" ||
    !turn.assistantMessage?.content
  )
    return null;
  const run = async (task: () => Promise<void>) => {
    if (busy || operation.locked || !operation.current()) return;
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (failure) {
      if (operation.current()) setError(failure instanceof Error ? failure.message : "Skill capture failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    {leave.dialog}
    <details
      className="rounded-md border border-line-subtle p-3 text-sm text-fg-secondary [&_label]:grid [&_label]:gap-2 [&_label]:my-3 [&_textarea]:min-h-20 [&_textarea]:rounded-md [&_textarea]:border [&_textarea]:border-line [&_textarea]:bg-canvas [&_textarea]:p-2 [&_select]:min-h-11 [&_select]:bg-canvas"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open && !isCapture && choices.length === 0) {
          void fetchCapabilityProposals(200)
            .then(({ items }) =>
              operation.current() && setChoices(items.filter((item) => item.candidateId && item.payload.workspaceId === workspaceId)),
            )
            .catch(() => setError("Existing skills could not be loaded. You can still create a new skill."));
        }
      }}
    >
      <summary onClick={(event) => {
        event.preventDefault();
        if (open) leave.request(() => setOpen(false), [captureDraft.key]);
        else setOpen(true);
      }}>{isCapture ? "Review skill draft" : "Save as skill"}{captureDraft.isDirty ? " · Unsaved" : ""}</summary>
      {isCapture ? (
        <>
          <p>
            Review the generated instructions above. Saving creates an inactive candidate; activation requires a
            separate review and approval.
          </p>
          <button
            type="button"
            className="my-2 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-accent disabled:opacity-50"
            disabled={busy || operation.locked || Boolean(result)}
            onClick={() =>
              void run(async () => {
                const bytes = new TextEncoder().encode(turn.assistantMessage!.content);
                const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
                  .map((value) => value.toString(16).padStart(2, "0"))
                  .join("");
                await operation.run("stage:" + hash, async () => hash, () => stageWorkflowSkillCapture(sessionId, { draftTurnId: turn.turnId, reviewedContentSha256: hash }), receipt => {
                  if (!receipt.candidateId || !receipt.versionId || !receipt.proposalId || receipt.activationPerformed !== false || receipt.evaluation !== "structure_and_safety_passed" || receipt.behavioralValidation !== "not_run") throw new Error("The capture receipt does not confirm an inactive reviewed candidate.");
                  setResult(receipt);
                });
              })
            }
          >
            {busy ? "Saving…" : "Save reviewed candidate"}
          </button>
          {!result ? (
            <>
              <label>
                Refine these instructions
                <textarea
                  value={guidance}
                  maxLength={2000}
                  disabled={busy || operation.locked}
                  onChange={(event) => setGuidance(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="my-2 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-accent disabled:opacity-50"
                disabled={busy || !draftEmpty || !guidance.trim()}
                onClick={() =>
                  void run(async () => {
                    const seed = JSON.parse(
                      turn.userMessage.content.split("\n", 1)[0]!.slice(WORKFLOW_SKILL_CAPTURE_MARKER.length),
                    ) as { sourceTurnId: string; targetCandidateId?: string };
                    const revision = seed.targetCandidateId
                      ? (await fetchCapabilityCandidate(seed.targetCandidateId)).revision
                      : undefined;
                    if (!operation.current()) return;
                    const prepared = await prepareWorkflowSkillCapture(sessionId, {
                      sourceTurnId: seed.sourceTurnId,
                      guidance,
                      ...(seed.targetCandidateId
                        ? { targetCandidateId: seed.targetCandidateId, expectedRevision: revision }
                        : {}),
                    });
                    acceptPrepared(sourceKey, prepared.prompt);
                  })
                }
              >
                Prepare revised draft
              </button>
            </>
          ) : null}
        </>
      ) : (
        <>
          <p>
            Turn this completed task into reusable instructions. Review and send the prepared request in Chat to
            generate the draft.
          </p>
          <label>
            Save destination
            <select value={target} disabled={busy || operation.locked} onChange={(event) => setTarget(event.target.value)}>
              <option value="">Create a new skill</option>
              {Array.from(new Map(choices.map((item) => [item.candidateId!, item])).values()).map((item) => (
                <option key={item.candidateId} value={item.candidateId}>
                  Revise: {item.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            What should the skill preserve? (optional)
            <textarea
              value={guidance}
              maxLength={2000}
              disabled={busy || operation.locked}
              onChange={(event) => setGuidance(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="my-2 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-accent disabled:opacity-50"
            disabled={busy || !draftEmpty}
            onClick={() =>
              void run(async () => {
                const revision = target ? (await fetchCapabilityCandidate(target)).revision : undefined;
                if (!operation.current()) return;
                    const prepared = await prepareWorkflowSkillCapture(sessionId, {
                  sourceTurnId: turn.turnId,
                  guidance,
                  ...(target ? { targetCandidateId: target, expectedRevision: revision } : {}),
                });
                acceptPrepared(sourceKey, prepared.prompt);
              })
            }
          >
            {busy ? "Preparing…" : "Prepare skill draft"}
          </button>
          {!draftEmpty ? <p>Send or clear the current draft before preparing a skill.</p> : null}
        </>
      )}
      {operation.locked ? <p role="status">{operation.attempt?.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <>
          <p role="status">Candidate saved. Structure and safety checks passed; behavioral validation has not run.</p>
          {!plan ? (
            <button
              type="button"
              className="my-2 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-accent disabled:opacity-50"
              disabled={busy || operation.locked}
              onClick={() =>
                void run(async () => {
                  const created = await operation.run("activation:" + result.versionId, async () => result, () => createChangePlan({
                      workspaceId,
                      sessionId,
                      turnId: turn.turnId,
                      surface: "chat",
                      request: {
                        kind: "capability_candidate",
                        proposalId: result.proposalId,
                        versionId: result.versionId,
                      },
                    }), receipt => { if (receipt.origin.workspaceId !== workspaceId || receipt.origin.sessionId !== sessionId) throw new Error("The activation plan belongs to another source."); setPlan(receipt); });
                  if (!created || !operation.current()) return;
                  setPlan(created);
                  openReview(created);
                })
              }
            >
              Review activation
            </button>
          ) : null}
        </>
      ) : null}
      {plan ? <>
        <p role="status">The activation review is attached to this turn.</p>
        {onReviewPlan ? <button type="button" className="my-2 inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm text-accent disabled:opacity-50" disabled={busy || operation.locked} onClick={() => void run(async () => {
          const current = await fetchChangePlan(plan.planId, {workspaceId, sessionId, turnId:turn.turnId});
          if (!operation.current()) return;
          setPlan(current);
          openReview(current);
        })}>Open activation review</button> : null}
      </> : null}
    </details>
    </>
  );
}
