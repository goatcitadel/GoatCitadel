import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CapabilityCatalogEntry, SkillRuntimeState } from "@goatcitadel/contracts";
import {
  fetchSkills,
  updateSkillState,
  type SkillStateMutationOutcome,
} from "@goatcitadel/mission-control-shared/api/skills";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import type { CapabilityCatalogView } from "./capability-catalog";

type CatalogSkill = CapabilityCatalogView["skillsById"][string];
type Review = {
  identity: string;
  generation: number;
  state: SkillRuntimeState;
  revision: number;
  currentState: SkillRuntimeState;
};
type Attempt = {
  phase: "checking" | "submitted" | "recorded" | "uncertain";
  revision: number;
  message: string;
  approvalId?: string;
};
// Skill lifecycle is installation-wide. Retain presentation locks by its canonical
// owner ID across Library selection, workspace navigation, and component remounts.
const attempts = new Map<string, Attempt>();
const listeners = new Set<() => void>();
function publish(skillId: string, attempt?: Attempt) {
  if (attempt) attempts.set(skillId, attempt);
  else attempts.delete(skillId);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function validateReceipt(outcome: SkillStateMutationOutcome, skillId: string, review: Review) {
  if (outcome?.pendingApproval) {
    const approval = outcome.pendingApproval;
    if (
      approval.kind !== "skill.lifecycle" ||
      approval.action !== "skill_state_set" ||
      approval.subjectKind !== "skill" ||
      approval.subjectId !== skillId ||
      approval.skillIds?.length !== 1 ||
      approval.skillIds[0] !== skillId ||
      !approval.approvalId?.trim() ||
      !["pending", "approved", "edited", "rejected"].includes(approval.status) ||
      !/^[a-f0-9]{64}$/i.test(approval.requestSha256) ||
      !/^[a-f0-9]{64}$/i.test(approval.expectedStateSha256)
    ) {
      throw new Error("The approval receipt does not match the reviewed skill request.");
    }
    return approval;
  }
  if (
    !outcome ||
    outcome.pendingApproval !== null ||
    !outcome.noMutationRequired ||
    outcome.skillState?.skillId !== skillId ||
    outcome.skillState.state !== review.state ||
    outcome.skillState.revision !== review.revision
  ) {
    throw new Error("The response does not confirm the reviewed skill state.");
  }
  return undefined;
}

export function useCapabilitySkillState({
  item,
  skill,
  skillsKnown,
  workspaceId,
  onRefresh,
}: {
  item: CapabilityCatalogEntry;
  skill?: CatalogSkill;
  skillsKnown: boolean;
  workspaceId?: string;
  onRefresh: () => void;
}) {
  const skillId = item.skillId ?? "";
  const access = useProjectAccess(JSON.stringify(["skill-state", skillId]));
  const attemptKey = access.presentationScope;
  const identity = JSON.stringify([
    workspaceId,
    access.identity,
    item.capabilityId,
    item.kind,
    skillId,
    skillsKnown,
    skill?.skillId,
    skill?.revision,
    skill?.state,
  ]);
  const lifecycle = useRef({ identity, generation: 0, onRefresh });
  if (lifecycle.current.identity !== identity) lifecycle.current.generation += 1;
  lifecycle.current.identity = identity;
  lifecycle.current.onRefresh = onRefresh;
  const mounted = useRef(true);
  useEffect(() => {
    const current = lifecycle.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.generation += 1;
    };
  }, []);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<{ identity: string; message: string }>();
  const attempt = useSyncExternalStore(
    subscribe,
    () => attempts.get(attemptKey),
    () => undefined,
  );
  const visibleAttempt =
    attempt?.phase === "recorded" && skill && skill.revision > attempt.revision ? undefined : attempt;
  const pending = visibleAttempt?.phase === "checking" || visibleAttempt?.phase === "submitted";
  const ready = Boolean(
    skillsKnown &&
    item.kind === "skill" &&
    skillId &&
    skill?.skillId === skillId &&
    Number.isSafeInteger(skill.revision) &&
    skill.revision > 0 &&
    ["enabled", "sleep", "disabled"].includes(skill.state),
  );
  const target = review?.identity === identity && review.generation === lifecycle.current.generation ? review : null;
  const locked = !ready || Boolean(visibleAttempt && visibleAttempt.phase !== "recorded");

  function requestReview(state: SkillRuntimeState) {
    if (locked || !skill) return;
    setReview({
      identity,
      generation: lifecycle.current.generation,
      state,
      revision: skill.revision,
      currentState: skill.state,
    });
    setError(undefined);
  }

  async function confirm() {
    if (!target || locked || !skill) return;
    const existing = attempts.get(attemptKey);
    if (existing && existing.phase !== "recorded") return;
    const current = () =>
      access.current() && mounted.current &&
      lifecycle.current.identity === target.identity &&
      lifecycle.current.generation === target.generation;
    if (!current()) return;
    const base = { revision: target.revision };
    publish(attemptKey, { ...base, phase: "checking", message: "Checking the current skill…" });
    setError(undefined);
    let dispatched = false;
    let recorded = false;
    try {
      const candidates = (await fetchSkills()).items.filter((entry) => entry.skillId === skillId);
      if (!current()) return;
      const fresh = candidates.length === 1 ? candidates[0] : undefined;
      if (!fresh || fresh.revision !== target.revision || fresh.state !== target.currentState) {
        setReview(null);
        setError({
          identity,
          message:
            "This skill changed in Gateway. Refresh and review its current state before requesting another change.",
        });
        lifecycle.current.onRefresh();
        return;
      }
      dispatched = true;
      publish(attemptKey, { ...base, phase: "submitted", message: "Requesting skill approval…" });
      const outcome = await updateSkillState(skillId, { expectedRevision: target.revision, state: target.state });
      const approval = validateReceipt(outcome, skillId, target);
      recorded = true;
      publish(attemptKey, {
        ...base,
        phase: "recorded",
        approvalId: approval?.approvalId,
        message:
          approval?.status === "pending"
            ? `Approval requested. The reviewed skill remains ${humanizeToken(target.currentState)} until the decision and follow-on effect complete.`
            : approval
              ? "An existing approval request was returned. Inspect its decision and current skill state before another request."
              : `Gateway reports the skill is already ${humanizeToken(target.state)}; no change was requested.`,
      });
      if (current()) {
        setReview(null);
        lifecycle.current.onRefresh();
      }
    } catch (cause) {
      if (recorded) {
        if (current())
          setError({
            identity,
            message:
              "The request was recorded, but Library could not refresh. Refresh the current skill and approval record.",
          });
        return;
      }
      if (dispatched) {
        publish(attemptKey, {
          ...base,
          phase: "uncertain",
          message:
            "Request outcome is uncertain. Further requests are locked in this app session. Check Approvals and the skill record in the classic view.",
        });
      } else if (current()) {
        setError({ identity, message: `Could not check the current skill state. ${describeApiError(cause).summary}` });
      }
      if (current()) setReview(null);
    } finally {
      if (!dispatched) publish(attemptKey);
    }
  }

  return {
    ready,
    target,
    pending,
    locked,
    requestReview,
    confirm,
    cancel: () => setReview(null),
    notice: visibleAttempt?.phase === "recorded" ? visibleAttempt.message : undefined,
    approvalId: visibleAttempt?.approvalId,
    error:
      visibleAttempt?.phase === "uncertain"
        ? visibleAttempt.message
        : error?.identity === identity
          ? error.message
          : undefined,
  };
}

export function __resetCapabilitySkillAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
