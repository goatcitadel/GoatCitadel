import { useEffect, useRef, useState } from "react";
import { useSessionViewState } from "../../hooks/use-session-view-state";
import { useStableHandler } from "./useStableHandler";
import { useSessionDraft } from "../native-routes/library/session-drafts";
import { useDraftLeave } from "../native-routes/library/DraftLeaveDialog";
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

// Deduplicate mutations across timeline virtualization and route unmounts. App memory only.
const captureOperations = new Set<string>();

export function WorkflowSkillCaptureControl({
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
  const [open, setOpen] = useState(false);
  const leave = useDraftLeave();
  const captureDraft = useSessionDraft(
    JSON.stringify(["workflow-capture", workspaceId, sessionId, turn.turnId]),
    { guidance: "", target: "" },
    undefined,
    { label: "Skill capture guidance", active: open },
  );
  const { guidance, target } = captureDraft.value;
  const setGuidance = (guidance: string) => captureDraft.setValue((current) => ({ ...current, guidance }));
  const setTarget = (target: string) => captureDraft.setValue((current) => ({ ...current, target }));
  const receiptKey = JSON.stringify(["workflow-capture-receipt", workspaceId, sessionId, turn.turnId]);
  const [choices, setChoices] = useState<CapabilityProposalRecord[]>([]);
  const [busy, setBusy] = useSessionViewState(receiptKey + ":busy", false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useSessionViewState<WorkflowSkillCaptureResult | null>(receiptKey + ":candidate", null);
  const [plan, setPlan] = useSessionViewState<ChangePlanRecord | null>(receiptKey + ":plan", null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sourceKey = JSON.stringify([workspaceId, sessionId, turn.turnId]);
  const acceptPrepared = useStableHandler((preparedFor: string, prompt: string) => {
    if (!mounted.current) return;
    if (preparedFor !== sourceKey)
      throw new Error("The conversation changed. Prepare the skill again from its source task.");
    if (!draftEmpty)
      throw new Error("Your draft changed while the skill was being prepared. Send or clear it before trying again.");
    onPrepare(prompt);
  });
  const openReview = useStableHandler((created: ChangePlanRecord) => {
    if (mounted.current && created.origin.sessionId === sessionId && created.origin.workspaceId === workspaceId) onReviewPlan?.(created);
  });
  const isCapture = turn.userMessage.content.startsWith(WORKFLOW_SKILL_CAPTURE_MARKER);
  if (
    turn.trace.status !== "completed" ||
    turn.trace.completion?.status !== "complete" ||
    !turn.assistantMessage?.content
  )
    return null;
  const run = async (operation: () => Promise<void>) => {
    if (captureOperations.has(receiptKey)) return;
    captureOperations.add(receiptKey);
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Skill capture failed.");
    } finally {
      captureOperations.delete(receiptKey);
      setBusy(false);
    }
  };
  return (
    <>
    {leave.dialog}
    <details
      className="mc-next-thread-details"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open && !isCapture && choices.length === 0) {
          void fetchCapabilityProposals(200)
            .then(({ items }) =>
              setChoices(items.filter((item) => item.candidateId && item.payload.workspaceId === workspaceId)),
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
            className="mc-next-thread-inline-button"
            disabled={busy || Boolean(result)}
            onClick={() =>
              void run(async () => {
                const bytes = new TextEncoder().encode(turn.assistantMessage!.content);
                const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
                  .map((value) => value.toString(16).padStart(2, "0"))
                  .join("");
                setResult(
                  await stageWorkflowSkillCapture(sessionId, { draftTurnId: turn.turnId, reviewedContentSha256: hash }),
                );
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
                  disabled={busy}
                  onChange={(event) => setGuidance(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="mc-next-thread-inline-button"
                disabled={busy || !draftEmpty || !guidance.trim()}
                onClick={() =>
                  void run(async () => {
                    const seed = JSON.parse(
                      turn.userMessage.content.split("\n", 1)[0]!.slice(WORKFLOW_SKILL_CAPTURE_MARKER.length),
                    ) as { sourceTurnId: string; targetCandidateId?: string };
                    const revision = seed.targetCandidateId
                      ? (await fetchCapabilityCandidate(seed.targetCandidateId)).revision
                      : undefined;
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
            <select value={target} disabled={busy} onChange={(event) => setTarget(event.target.value)}>
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
              disabled={busy}
              onChange={(event) => setGuidance(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="mc-next-thread-inline-button"
            disabled={busy || !draftEmpty}
            onClick={() =>
              void run(async () => {
                const revision = target ? (await fetchCapabilityCandidate(target)).revision : undefined;
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
      {error ? <p role="alert">{error}</p> : null}
      {result ? (
        <>
          <p role="status">Candidate saved. Structure and safety checks passed; behavioral validation has not run.</p>
          {!plan ? (
            <button
              type="button"
              className="mc-next-thread-inline-button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const created = await createChangePlan({
                      workspaceId,
                      sessionId,
                      turnId: turn.turnId,
                      surface: "chat",
                      request: {
                        kind: "capability_candidate",
                        proposalId: result.proposalId,
                        versionId: result.versionId,
                      },
                    });
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
        {onReviewPlan ? <button type="button" className="mc-next-thread-inline-button" disabled={busy} onClick={() => void run(async () => {
          const current = await fetchChangePlan(plan.planId, {workspaceId, sessionId, turnId:turn.turnId});
          setPlan(current);
          openReview(current);
        })}>Open activation review</button> : null}
      </> : null}
    </details>
    </>
  );
}
