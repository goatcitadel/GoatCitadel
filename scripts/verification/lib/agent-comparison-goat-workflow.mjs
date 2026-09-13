import { randomUUID } from "node:crypto";
import { readFile, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { COMPARISON_TASKS, sha256 } from "./agent-comparison.mjs";
import { executeGoatComparisonTurn } from "./agent-comparison-goat-api.mjs";
import { createGoatComparisonClient } from "./agent-comparison-goat-client.mjs";
import { readComparisonJson } from "./agent-comparison-session.mjs";
import { advanceComparisonWorkflow, readComparisonWorkflowInstructions } from "./agent-comparison-workflow.mjs";
import { EXECUTION_BINDING_FIELDS, PERMISSION_REVIEW_FILE } from "./agent-comparison-permissions.mjs";

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const id = (value) => {
  requireValue(
    typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value),
    "Missing native workflow identifier.",
  );
  return value;
};
const exact = (left, right) => sha256(left) === sha256(right);

/** Drive the product's public owners, leaving each review and approval to an
 * explicitly attached operator. The phase controller owns held-out input release. */
export async function executeGoatComparisonSkillWorkflow({
  baseUrl,
  token,
  workspace,
  profile,
  cellDirectory,
  retain,
  signal,
  onApprovalReady,
  onReview,
  fetchImpl = fetch,
  pollMs = 1000,
}) {
  requireValue(
    typeof onReview === "function" && typeof onApprovalReady === "function",
    "Native skill workflows require explicit review and approval consoles.",
  );
  const start = await readComparisonJson(path.join(cellDirectory, "evidence/session-start.json"));
  requireValue(
    start.product === "goatcitadel" &&
      start.taskId === "workflow_capture_reuse" &&
      path.resolve(workspace) === path.join(path.resolve(cellDirectory), "workspace"),
    "The native skill workflow does not match its cell.",
  );
  const binding = Object.fromEntries(EXECUTION_BINDING_FIELDS.map((key) => [key, start[key]]));
  const sourceKind = start.source === "controlled_fixture" ? "controlled_fixture" : "native_receipts";
  const task = COMPARISON_TASKS.find((entry) => entry.id === start.taskId);
  let sequence = 0,
    phase = "source";
  const records = [];
  const save = async (name, value) => {
    const file = `workflow-${String(++sequence).padStart(4, "0")}-${name}`;
    requireValue(
      sequence <= 500 && /^[a-z0-9-]{1,140}$/u.test(file),
      "The native workflow evidence inventory exceeds its bound.",
    );
    await retain(file, value);
    records.push({ phase, name, ...value });
  };
  const api = createGoatComparisonClient({ baseUrl, token, signal, retain: save, fetchImpl });
  const review = async (kind, material) => {
    signal?.throwIfAborted();
    const digest = sha256(material);
    await save(`${kind}-review-intent`, { kind, material, sha256: digest });
    const response = await onReview({ kind, material, sha256: digest });
    signal?.throwIfAborted();
    requireValue(response === digest, "The operator did not confirm this exact native review.");
    await save(`${kind}-review-decision`, { kind, sha256: digest, source: "operator_console", decision: "reviewed" });
  };
  const advance = async (action, details, instructions) => {
    const filename = `native-goat-workflow-${action}.json`;
    const bytes =
      JSON.stringify(
        { ...binding, source: sourceKind, records: records.filter((entry) => entry.phase === phase) },
        null,
        2,
      ) + "\n";
    requireValue(Buffer.byteLength(bytes) <= 4 * 1024 * 1024, "Native workflow phase evidence exceeds its bound.");
    const file = await open(path.join(cellDirectory, "evidence", filename), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    const permission = await readFile(path.join(cellDirectory, "evidence", PERMISSION_REVIEW_FILE));
    return advanceComparisonWorkflow({
      cellDirectory,
      action,
      instructions,
      executionFile: "workflow-execution.json",
      receipt: {
        ...binding,
        source: sourceKind,
        nativeReceipt: { path: filename, sha256: sha256(bytes) },
        permissionReview: { path: PERMISSION_REVIEW_FILE, sha256: sha256(permission) },
        ...details,
      },
    });
  };
  const send = (prompt, nativeScope) =>
    executeGoatComparisonTurn({
      baseUrl,
      token,
      workspace,
      profile,
      prompt,
      nativeScope,
      signal,
      retain: save,
      onApprovalReady,
      fetchImpl,
      pollMs,
    });
  const nativeTurn = (result) => {
    const turnId = id(result.result.turnId ?? result.result.trace?.turnId);
    const turn = result.thread.turns?.find((entry) => entry.turnId === turnId);
    requireValue(
      result.thread.sessionId === result.sessionId &&
        turn?.trace?.sessionId === result.sessionId &&
        turn.trace.turnId === turnId &&
        turn.trace.status === "completed",
      "The native workflow turn did not complete in its declared session.",
    );
    return turn;
  };
  const source = await send(task.phases[0].prompt);
  const sourceTurn = nativeTurn(source);
  const scope = { workspaceId: source.workspaceId, projectId: source.projectId };
  const sourceArtifact = await readComparisonWorkflowInstructions(path.join(workspace, "source-release.md"));
  const sourceArtifactSha256 = sha256(sourceArtifact);
  await advance("source", {
    phase: {
      id: "source_workflow",
      status: "completed",
      sessionId: source.sessionId,
      turnId: sourceTurn.turnId,
      sourceArtifactSha256,
    },
  });

  phase = "review";
  const initialProfile = await api(
    "source-profile",
    `/chat/sessions/${source.sessionId}/turns/${sourceTurn.turnId}/capability-profile?workspaceId=${scope.workspaceId}`,
  );
  requireValue(
    initialProfile.state === "available" && (initialProfile.profile?.selection.activatedSkills ?? []).length === 0,
    "The source workflow must begin without an activated skill.",
  );
  const prepared = await api("capture-prepare", `/chat/sessions/${source.sessionId}/skill-captures/prepare`, {
    sourceTurnId: sourceTurn.turnId,
    guidance: task.phases[1].prompt,
  });
  requireValue(
    prepared.sourceTurnId === sourceTurn.turnId && typeof prepared.prompt === "string",
    "Capture preparation changed the source turn.",
  );
  const captured = await send(prepared.prompt, { ...scope, sessionId: source.sessionId });
  const draft = nativeTurn(captured);
  const draftContent = draft.assistantMessage?.content;
  requireValue(typeof draftContent === "string" && draftContent.length > 0, "The native skill draft is unavailable.");
  await review("stage", {
    sessionId: source.sessionId,
    sourceTurnId: sourceTurn.turnId,
    draftTurnId: draft.turnId,
    content: draftContent,
  });
  const candidate = await api("candidate-stage", `/chat/sessions/${source.sessionId}/skill-captures/stage`, {
    draftTurnId: draft.turnId,
    reviewedContentSha256: sha256(draftContent),
  });
  const candidateId = id(candidate.candidateId),
    versionId = id(candidate.versionId),
    proposalId = id(candidate.proposalId);
  requireValue(candidate.activationPerformed === false, "Staging unexpectedly activated a skill.");
  const reviewRoute = `/capabilities/candidates/${candidateId}/versions/${versionId}/review?workspaceId=${scope.workspaceId}`;
  const artifactReview = await api("candidate-artifacts", reviewRoute);
  const instructions = artifactReview.artifacts?.find((entry) => entry.label === "Instructions");
  const provenance = artifactReview.artifacts?.find((entry) => entry.label === "Provenance");
  requireValue(
    artifactReview.candidateId === candidateId &&
      artifactReview.versionId === versionId &&
      artifactReview.revision === candidate.revision &&
      instructions &&
      provenance,
    "The native artifact review changed the candidate/version.",
  );
  const instructionsSha256 = sha256(instructions.content);
  requireValue(
    instructions.artifactRef.endsWith(`:sha256:${instructionsSha256}`),
    "The reviewed instructions do not match their native hash.",
  );
  const lineage = JSON.parse(provenance.content);
  requireValue(
    lineage.sourceSessionId === source.sessionId &&
      lineage.sourceTurnId === sourceTurn.turnId &&
      lineage.draftTurnId === draft.turnId &&
      lineage.workspaceId === scope.workspaceId &&
      lineage.versionId === versionId,
    "The captured native provenance changed scope.",
  );
  let plan = await api("activation-plan", "/change-plans", {
    ...scopeOrigin(),
    surface: "chat",
    request: { kind: "capability_candidate", proposalId, action: "activate", versionId },
  });
  const planId = id(plan.planId);
  const planReadRoute = `/change-plans/${planId}?${new URLSearchParams(scopeOrigin())}`;
  const assertPlan = (value) => {
    requireValue(
      value.planId === planId &&
        value.kind === "capability_candidate" &&
        value.origin?.workspaceId === scope.workspaceId &&
        value.target?.resourceId === candidateId &&
        value.request?.versionId === versionId &&
        value.request.proposalId === proposalId &&
        value.request.action === "activate",
      "The native activation plan changed scope or target.",
    );
  };
  assertPlan(plan);
  requireValue(
    plan.status === "awaiting_input" &&
      plan.requiredAction?.kind === "artifact_review" &&
      exact(
        [...plan.requiredAction.artifactRefs].sort(),
        artifactReview.artifacts.map((entry) => entry.artifactRef).sort(),
      ),
    "The activation owner did not request the exact native artifacts.",
  );
  await review("artifacts", { plan, artifactReview });
  requireValue(
    exact(await api("candidate-artifacts-recheck", reviewRoute), artifactReview),
    "The candidate changed after review.",
  );
  plan = await api("activation-review", `/change-plans/${planId}/responses`, {
    ...scopeOrigin(),
    expectedRevision: plan.revision,
    actionId: plan.requiredAction.actionId,
    actionNonce: plan.requiredAction.actionNonce,
    values: {},
  });
  assertPlan(plan);
  requireValue(
    plan.status === "awaiting_confirmation" && plan.requiredAction?.kind === "confirmation",
    "The activation owner did not request confirmation.",
  );
  await review("confirm", plan);
  const refreshed = await api("activation-plan-recheck", planReadRoute);
  requireValue(exact(refreshed, plan), "The activation plan changed after confirmation review.");
  plan = await api("activation-confirm", `/change-plans/${planId}/confirmations`, {
    ...scopeOrigin(),
    expectedRevision: plan.revision,
    actionNonce: plan.requiredAction.actionNonce,
  });
  assertPlan(plan);
  requireValue(
    plan.status === "awaiting_approval" && plan.requiredAction?.kind === "approval",
    "The activation owner did not retain a native approval.",
  );
  const approvalId = id(plan.requiredAction.approvalId);
  const approval = async () => {
    const current = await api("activation-plan-status", planReadRoute);
    assertPlan(current);
    const replay = await api("activation-approval-replay", `/approvals/${approvalId}/replay`);
    const item = replay.approval;
    requireValue(
      item?.approvalId === approvalId &&
        item.kind === "capability.lifecycle" &&
        item.payload?.capabilityLifecycle?.subjectId === candidateId &&
        item.payload.capabilityLifecycle.action === "candidate_promoted" &&
        item.payload.request?.mutation?.candidateId === candidateId &&
        item.payload.request.mutation.versionId === versionId &&
        current.approvalRefs.includes(approvalId),
      "The native skill approval does not belong to this exact plan/version.",
    );
    return { current, item, replay };
  };
  const supervision = new AbortController();
  const stopSignal = AbortSignal.any([supervision.signal, ...(signal ? [signal] : [])]);
  let console;
  try {
    console = await onApprovalReady({
      workspace,
      signal: stopSignal,
      onClosed: () => supervision.abort(),
      pending: async () => {
        const { item } = await approval();
        return {
          approvals:
            item.status === "pending"
              ? [
                  {
                    id: approvalId,
                    kind: item.kind,
                    summary: `Activate reviewed skill ${candidateId}/${versionId}`,
                    request: item,
                  },
                ]
              : [],
        };
      },
      resolve: async ({ approvalId: selected, decision }) => {
        stopSignal.throwIfAborted();
        requireValue(
          selected === approvalId && ["allow-once", "deny"].includes(decision),
          "Select this exact native skill approval.",
        );
        const { current, item } = await approval();
        requireValue(
          current.status === "awaiting_approval" && item.status === "pending",
          "The native skill approval is no longer pending.",
        );
        requireValue(
          exact(await api("candidate-artifacts-before-approval", reviewRoute), artifactReview),
          "The reviewed skill changed before approval.",
        );
        const mutation = {
          approvalId,
          decision: decision === "allow-once" ? "approve" : "reject",
          source: "operator_console",
          requestId: randomUUID(),
        };
        await save("activation-decision-intent", mutation);
        try {
          return await api("activation-decision-result", `/approvals/${approvalId}/resolve`, {
            decision: mutation.decision,
          });
        } catch (error) {
          await save("activation-decision-unconfirmed", { ...mutation, status: "unconfirmed" });
          throw error;
        }
      },
    });
    requireValue(typeof console?.stop === "function", "The native skill approval console needs a close handle.");
    for (let count = 0; ; count++) {
      stopSignal.throwIfAborted();
      requireValue(count < 120, "Native skill activation did not settle within its polling bound.");
      plan = await api("activation-plan-poll", planReadRoute);
      assertPlan(plan);
      if (plan.status === "awaiting_approval") {
        const observed = await approval();
        requireValue(
          !["rejected", "denied", "expired"].includes(observed.item.status),
          "The native skill activation approval was not granted.",
        );
        plan = observed.current;
        if (
          plan.status === "awaiting_approval" &&
          hasGoatComparisonSkillActivationEffect(observed.replay, { approvalId, candidateId, versionId })
        ) {
          requireValue(
            plan.requiredAction?.kind === "approval" && plan.requiredAction.approvalId === approvalId,
            "The native activation resume action changed its approval.",
          );
          plan = await api("activation-resume", `/change-plans/${planId}/responses`, {
            ...scopeOrigin(),
            expectedRevision: observed.current.revision,
            actionId: observed.current.requiredAction.actionId,
            actionNonce: observed.current.requiredAction.actionNonce,
            values: {},
          });
          assertPlan(plan);
        }
      }
      if (["completed", "applied"].includes(plan.status)) break;
      requireValue(
        !["failed", "cancelled", "manual_required", "rolled_back", "rollback_failed"].includes(plan.status),
        "The native skill activation did not complete.",
      );
      await delay(pollMs, undefined, { signal: stopSignal });
    }
  } finally {
    supervision.abort();
    await console?.stop();
  }
  const detail = await api("candidate-active", `/capabilities/candidates/${candidateId}`);
  requireValue(
    detail.activeVersion?.versionId === versionId &&
      detail.activeVersion.workspaceId === scope.workspaceId &&
      ["approved", "trusted"].includes(detail.activeVersion.lifecycleState) &&
      detail.activeVersion.instructionArtifact?.sha256 === instructionsSha256 &&
      !detail.activationBlocked,
    "The exact reviewed native skill is not active.",
  );
  const journey = await api(
    "activation-journey",
    `/journey/events?workspaceId=${scope.workspaceId}&includeGlobal=true&subjectKinds=capability_candidate&limit=100`,
  );
  const events = projectGoatComparisonSkillActivation(journey, { approvalId, candidateId, versionId });
  await advance(
    "review",
    {
      phase: {
        id: "capture_review",
        sessionId: source.sessionId,
        turnId: draft.turnId,
        sourceSessionId: source.sessionId,
        sourceTurnId: sourceTurn.turnId,
        sourceArtifactSha256,
        instructionsSha256,
        reviewedInstructionsSha256: instructionsSha256,
        reviewDecision: "approved",
        skillVersionId: versionId,
      },
      activationEvents: events.map((event) => ({
        nativeEventId: event.eventId,
        skillVersionId: versionId,
        instructionsSha256,
      })),
    },
    instructions.content,
  );

  phase = "reuse";
  const reused = await send(task.phases[2].prompt, scope);
  const reuseTurn = nativeTurn(reused);
  const envelope = await api(
    "reuse-profile",
    `/chat/sessions/${reused.sessionId}/turns/${reuseTurn.turnId}/capability-profile?workspaceId=${scope.workspaceId}`,
  );
  const loaded = projectGoatComparisonSkillReuse({
    envelope,
    candidateId,
    versionId,
    instructionsSha256,
    workspaceId: scope.workspaceId,
    sessionId: reused.sessionId,
    turnId: reuseTurn.turnId,
  });
  await advance("reuse", {
    phase: {
      id: "reuse",
      sessionId: reused.sessionId,
      turnId: reuseTurn.turnId,
      skillVersionId: versionId,
      loadedInstructionsSha256: loaded.artifactSha256,
      nativePromptSha256: loaded.nativePromptSha256,
    },
  });
  return {
    sessionId: reused.sessionId,
    sourceSessionId: source.sessionId,
    candidateId,
    versionId,
    taskOutcome: "unverified",
  };

  function scopeOrigin() {
    return { workspaceId: scope.workspaceId, sessionId: source.sessionId, turnId: draft.turnId };
  }
}

export function projectGoatComparisonSkillActivation(journey, { approvalId, candidateId, versionId }) {
  requireValue(
    Array.isArray(journey.items) && !journey.nextCursor,
    "The native skill activation history is incomplete.",
  );
  const events = journey.items.filter((event) => event.action === "candidate_promoted");
  const event = events[0];
  // The canonical producer attributes the approval to the operator. The
  // separate completed approval effect proves execution; Journey links it to
  // the exact candidate/version and records the observed result.
  requireValue(
    events.length === 1 &&
      typeof event.eventId === "string" &&
      event.eventId.length > 0 &&
      event.actorType === "operator" &&
      event.subjectKind === "capability_candidate" &&
      event.subjectId === candidateId &&
      event.approvalId === approvalId &&
      event.sourceKind === "capability_candidate_version" &&
      event.sourceId === versionId &&
      event.trustDisposition === "approved_capability_mutation" &&
      event.summary?.selectedVersionId === versionId &&
      event.summary.skillMutationObserved === true &&
      event.summary.callable === true &&
      event.summary.directPromotion === false &&
      event.evidence?.health === "complete" &&
      event.evidence.sourceLinked === true &&
      event.evidence.approvalLinked === true &&
      event.evidenceRefs?.some((ref) => ref.owner === "approval" && ref.refId === approvalId) &&
      event.evidenceRefs.some((ref) => ref.owner === "candidate" && ref.refId === candidateId),
    "Native history does not prove exactly one requested skill activation.",
  );
  return events;
}

export function hasGoatComparisonSkillActivationEffect(replay, { approvalId, candidateId, versionId }) {
  if (replay.approval?.approvalId !== approvalId || replay.approval.status !== "approved") return false;
  if (!Array.isArray(replay.effects)) return false;
  const effects = replay.effects.filter((effect) => effect.effectKind === "capability_lifecycle_apply");
  return (
    effects.length === 1 &&
    effects[0].approvalId === approvalId &&
    effects[0].status === "completed" &&
    effects[0].targetKind === "capability_candidate" &&
    effects[0].targetId === candidateId &&
    effects[0].idempotencyKey === `${approvalId}:capability_lifecycle_apply:capability_candidate:${candidateId}` &&
    effects[0].result?.action === "promote" &&
    effects[0].result.candidateId === candidateId &&
    effects[0].result.selectedVersionId === versionId &&
    exact(effects[0].result.changedVersionIds, [versionId])
  );
}

export function projectGoatComparisonSkillReuse({
  envelope,
  candidateId,
  versionId,
  instructionsSha256,
  workspaceId,
  sessionId,
  turnId,
}) {
  const profile = envelope.profile;
  requireValue(
    envelope.state === "available" &&
      profile?.identity?.workspaceId === workspaceId &&
      profile.identity.sessionId === sessionId &&
      profile.identity.turnId === turnId,
    "The native skill-load profile changed session/turn scope.",
  );
  const trusted = profile.selection.trustedSkills?.find(
    (entry) => entry.sourceRef === `candidate:${candidateId}:${versionId}`,
  );
  const activated = profile.selection.activatedSkills ?? [];
  const loaded = activated.find(
    (entry) => entry.skillId === trusted?.skillId && entry.capabilityId === trusted?.capabilityId,
  );
  const module = loaded?.modules?.find((entry) => entry.relativePath === "SKILL.md");
  requireValue(
    trusted &&
      loaded &&
      activated.length === 1 &&
      trusted.treeSha256 === loaded.treeSha256 &&
      module?.sha256 === instructionsSha256 &&
      /^[a-f0-9]{64}$/u.test(loaded.instructionSha256),
    "The new native session did not load exactly the reviewed skill version.",
  );
  // The native prompt hash includes module headings. The raw SKILL.md hash is
  // separately retained in modules and is the approved artifact identity.
  return { artifactSha256: module.sha256, nativePromptSha256: loaded.instructionSha256 };
}
