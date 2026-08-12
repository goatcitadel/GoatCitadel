import { createHash } from "node:crypto";
import type {
  ApprovalRequest,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatToolRunRecord,
  DurableBackgroundTaskApprovalState,
  DurableBackgroundTaskBlocker,
  DurableBackgroundTaskItem,
  DurableBackgroundTaskLineageEntry,
  DurableBackgroundTaskOutputEvidence,
  DurableBackgroundTaskRailResponse,
  DurableBackgroundTaskSemanticLink,
  DurableBackgroundTaskSignalIntegrity,
  DurableChildStateChangedPayload,
  DurableChildWatcherRecord,
  DurableRunRecord,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import { isDurableRunTerminal, NotFoundError, redactStructuredSecrets } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";

const OUTPUT_PREVIEW_BYTES = 1_200;
const ERROR_PREVIEW_BYTES = 320;
const WATCHER_READ_LIMIT = 500;
const PARENT_SIGNAL_READ_LIMIT = 2_000;
const TOOL_READ_LIMIT = 200;
const DELEGATION_STEP_READ_LIMIT = 500;
const SEMANTIC_ID_BYTES = 200;

export interface DurableBackgroundTaskProjectionInput {
  parentRunId: string;
  workspaceId: string;
  sessionId: string;
  generatedAt?: string;
}

type BackgroundTaskProjectionStorage = Pick<
  Storage,
  | "approvals"
  | "chatDelegationRuns"
  | "chatDelegationSteps"
  | "chatMessages"
  | "chatSessionMeta"
  | "chatToolRuns"
  | "chatTurnTraces"
  | "durableChildWatchers"
  | "durableRunEvents"
  | "durableRuns"
>;

export async function projectDurableBackgroundTaskRail(
  storage: BackgroundTaskProjectionStorage,
  input: DurableBackgroundTaskProjectionInput,
): Promise<DurableBackgroundTaskRailResponse> {
  const parentRunId = input.parentRunId.trim();
  const workspaceId = input.workspaceId.trim();
  const sessionId = input.sessionId.trim();
  if (!parentRunId || !workspaceId || !sessionId) {
    throw new Error("parentRunId, workspaceId, and sessionId are required for the background-task rail");
  }

  const parent = await storage.durableRuns.getRun(parentRunId);
  await assertParentScope(storage, parent, workspaceId, sessionId);
  const watchers = await storage.durableChildWatchers.listByParent(parentRunId, WATCHER_READ_LIMIT);
  const parentEvents = await storage.durableRunEvents.listByRun(parentRunId, PARENT_SIGNAL_READ_LIMIT);
  const watchersComplete = watchers.length < WATCHER_READ_LIMIT;
  const parentSignalsComplete = parentEvents.length < PARENT_SIGNAL_READ_LIMIT;
  const unknowns: string[] = [];
  if (!watchersComplete) unknowns.push(`Watcher coverage reached the ${WATCHER_READ_LIMIT} item read boundary.`);
  if (!parentSignalsComplete) {
    unknowns.push(`Parent signal coverage reached the ${PARENT_SIGNAL_READ_LIMIT} event read boundary.`);
  }
  const delegationRuns = new Map<string, ChatDelegationRunRecord>();

  const tasks: DurableBackgroundTaskItem[] = [];
  for (const watcher of watchers) {
    const task = await projectTask(
      storage,
      watcher,
      parentEvents,
      parentSignalsComplete,
      workspaceId,
      sessionId,
      delegationRuns,
    );
    if (!task.scope.verified) {
      unknowns.push(`Scope could not be verified for child ${watcher.childRunId}.`);
    }
    if (task.canonicalStatus === "missing" || task.canonicalStatus === "unknown") {
      unknowns.push(`Canonical durable state is unavailable for child ${watcher.childRunId}.`);
    }
    if (task.signalIntegrity.posture === "degraded") {
      unknowns.push(`Watcher signals are degraded for child ${watcher.childRunId}; canonical run state is shown.`);
    }
    if (task.blockers.some((blocker) => blocker.kind === "signal_integrity")) {
      unknowns.push(
        `Canonical records conflict for child ${watcher.childRunId}; inspect the linked records before acting.`,
      );
    }
    if (!task.toolCoverage.complete) {
      unknowns.push(`Tool coverage reached the ${TOOL_READ_LIMIT} item read boundary for child ${watcher.childRunId}.`);
    }
    tasks.push(task);
  }

  const synthesisRun = selectSynthesisRun(delegationRuns, sessionId);
  const synthesisTasks = synthesisRun ? tasks.filter((task) => task.delegationRunId === synthesisRun.runId) : [];
  const lineage = synthesisTasks.flatMap(buildLineageEntry);
  const citedWatcherIds = new Set(lineage.map((entry) => entry.watcherId));
  const uncoveredChildRunIds = tasks
    .filter((task) => !citedWatcherIds.has(task.watcherId))
    .map((task) => task.childRunId);
  const missingTerminalChildRunIds = tasks
    .filter((task) => isTerminalBackgroundStatus(task.canonicalStatus) && task.output.availability !== "available")
    .map((task) => task.childRunId);
  const synthesisStepCoverage = await inspectSynthesisStepCoverage(storage, synthesisRun, synthesisTasks);
  const uncoveredStepIds = synthesisStepCoverage.uncoveredStepIds;
  if (!synthesisStepCoverage.complete) {
    unknowns.push(`Delegation-step coverage reached the ${DELEGATION_STEP_READ_LIMIT} item read boundary.`);
  }
  if (!synthesisStepCoverage.integrityValid) {
    unknowns.push("One or more delegation-step records have invalid identity or generation linkage.");
  }
  if (delegationRuns.size > 1) {
    unknowns.push(
      `Background work spans ${delegationRuns.size} delegation runs; synthesis lineage is bound only to ${synthesisRun?.runId ?? "none"}.`,
    );
  }
  if (uncoveredChildRunIds.length > 0) {
    unknowns.push(`${uncoveredChildRunIds.length} watched child run(s) are not cited by the selected synthesis.`);
  }
  if (uncoveredStepIds.length > 0) {
    unknowns.push(
      `${uncoveredStepIds.length} delegation step(s) have no verified watched child in the selected synthesis.`,
    );
  }
  const synthesisSummary = publicPreviewText(
    synthesisRun?.finalSummary ?? synthesisRun?.stitchedOutput,
    OUTPUT_PREVIEW_BYTES,
  );
  const parentTerminal = isDurableRunTerminal(parent.status);
  const synthesisComplete =
    watchersComplete &&
    synthesisStepCoverage.complete &&
    synthesisStepCoverage.integrityValid &&
    synthesisRun?.status === "completed" &&
    synthesisTasks.length > 0 &&
    synthesisTasks.every((task) => isTerminalBackgroundStatus(task.canonicalStatus)) &&
    synthesisTasks.every((task) =>
      task.blockers.every(
        (blocker) =>
          !["approval_required", "projection_incomplete", "scope_unverified", "signal_integrity"].includes(
            blocker.kind,
          ),
      ),
    ) &&
    uncoveredChildRunIds.length === 0 &&
    uncoveredStepIds.length === 0 &&
    missingTerminalChildRunIds.length === 0;
  const synthesisAvailability = synthesisSummary
    ? synthesisComplete
      ? "available"
      : "partial"
    : parentTerminal
      ? "missing"
      : "not_terminal";

  return {
    version: "durable.background_task_rail.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    scope: { workspaceId, sessionId, verified: true },
    parent: {
      runId: parent.runId,
      status: parent.status,
      version: parent.version,
      workerHealth: parent.workerHealth,
      recoveryState: parent.recoveryState,
      links: [semanticLink("durable_run", parent.runId, "Parent run"), semanticLink("chat_session", sessionId, "Chat")],
    },
    coverage: {
      watchers: { complete: watchersComplete, observedCount: watchers.length, limit: WATCHER_READ_LIMIT },
      parentSignals: {
        complete: parentSignalsComplete,
        observedCount: parentEvents.length,
        limit: PARENT_SIGNAL_READ_LIMIT,
      },
    },
    tasks,
    synthesis: {
      availability: synthesisAvailability,
      summary: synthesisSummary,
      delegationRunId: synthesisRun?.runId,
      lineage,
      missingTerminalChildRunIds,
      uncoveredChildRunIds,
      uncoveredStepIds,
    },
    unknowns: [...new Set(unknowns)],
  };
}

export function normalizeDurableBackgroundTaskSignals(
  events: readonly DurableRunTimelineEvent[],
  watcherId: string,
  observationComplete = true,
): DurableBackgroundTaskSignalIntegrity {
  const relevant = events.filter((event) => {
    if (event.eventType !== "child_state_changed") return false;
    return readString(event.payload, "watcherId") === watcherId;
  });
  if (relevant.length === 0) {
    return {
      observedCount: 0,
      acceptedCount: 0,
      duplicateCount: 0,
      outOfOrderCount: 0,
      conflictingSequenceCount: 0,
      observationComplete,
      posture: observationComplete ? "unobserved" : "degraded",
    };
  }

  const seenEventIds = new Set<string>();
  const acceptedBySequence = new Map<number, string>();
  let duplicateCount = 0;
  let outOfOrderCount = 0;
  let conflictingSequenceCount = 0;
  let previousSequence = 0;

  for (const event of relevant) {
    const childSequence = readPositiveInteger(event.payload, "childSequence");
    const childEventId = readString(event.payload, "childEventId") ?? event.eventId;
    if (!childSequence) {
      conflictingSequenceCount += 1;
      continue;
    }
    if (previousSequence > childSequence) outOfOrderCount += 1;
    previousSequence = childSequence;
    if (seenEventIds.has(childEventId)) {
      duplicateCount += 1;
      continue;
    }
    seenEventIds.add(childEventId);
    const existing = acceptedBySequence.get(childSequence);
    if (existing && existing !== childEventId) {
      conflictingSequenceCount += 1;
      continue;
    }
    acceptedBySequence.set(childSequence, childEventId);
  }

  const acceptedSequences = [...acceptedBySequence.keys()].sort((left, right) => left - right);
  const degraded = duplicateCount + outOfOrderCount + conflictingSequenceCount > 0;
  return {
    observedCount: relevant.length,
    acceptedCount: acceptedSequences.length,
    duplicateCount,
    outOfOrderCount,
    conflictingSequenceCount,
    highestAcceptedSequence: acceptedSequences.at(-1),
    observationComplete,
    posture: degraded || !observationComplete ? "degraded" : "clean",
  };
}

async function projectTask(
  storage: BackgroundTaskProjectionStorage,
  watcher: DurableChildWatcherRecord,
  parentEvents: DurableRunTimelineEvent[],
  parentSignalsComplete: boolean,
  workspaceId: string,
  parentSessionId: string,
  delegationRuns: Map<string, ChatDelegationRunRecord>,
): Promise<DurableBackgroundTaskItem> {
  const child = await readOptional(() => storage.durableRuns.getRun(watcher.childRunId));
  const metadata = watcher.metadata ?? {};
  const delegationRunIdResult = readSemanticId(metadata, "delegationRunId");
  const stepIdResult = readSemanticId(metadata, "stepId");
  const metadataSessionIdResult = readSemanticId(metadata, "childSessionId");
  const metadataTurnIdResult = readSemanticId(metadata, "childTurnId");
  const delegationRunId = delegationRunIdResult.value;
  const stepId = stepIdResult.value;
  const metadataSessionId = metadataSessionIdResult.value;
  const metadataTurnId = metadataTurnIdResult.value;
  const childPayloadSessionIdResult = child ? readSemanticId(child.payload, "sessionId") : { valid: true };
  const childPayloadTurnIdResult = child ? readSemanticId(child.payload, "turnId") : { valid: true };
  const childPayloadSessionId = childPayloadSessionIdResult.value;
  const childPayloadTurnId = childPayloadTurnIdResult.value;
  const metadataIdsValid = [
    delegationRunIdResult,
    stepIdResult,
    metadataSessionIdResult,
    metadataTurnIdResult,
    childPayloadSessionIdResult,
    childPayloadTurnIdResult,
  ].every((result) => result.valid);
  const childSessionId = metadataSessionId ?? childPayloadSessionId;
  const childTurnId = metadataTurnId ?? childPayloadTurnId;
  const childMeta = childSessionId ? await readOptional(() => storage.chatSessionMeta.get(childSessionId)) : undefined;
  const childWorkspaceId = childMeta?.workspaceId ?? (childMeta ? "default" : undefined);
  const linkageConsistent =
    metadataIdsValid &&
    Boolean(childSessionId) &&
    (!metadataSessionId || !childPayloadSessionId || metadataSessionId === childPayloadSessionId) &&
    (!metadataTurnId || !childPayloadTurnId || metadataTurnId === childPayloadTurnId);
  const scopeVerified = linkageConsistent && childWorkspaceId === workspaceId;

  const delegationRun = delegationRunId
    ? await readOptional(() => storage.chatDelegationRuns.get(delegationRunId))
    : undefined;
  const delegationMetadataComplete = watcher.source !== "chat_delegation" || Boolean(delegationRunId && stepId);
  const delegationScopeVerified =
    !delegationRunId || Boolean(delegationRun && delegationRun.sessionId === parentSessionId);
  const step = stepId ? await readOptional(() => storage.chatDelegationSteps.get(stepId)) : undefined;
  const stepLinkVerified =
    !stepId ||
    (step !== undefined &&
      Boolean(delegationRunId) &&
      step.runId === delegationRunId &&
      (!step.durableRunId || step.durableRunId === watcher.childRunId) &&
      (!step.childSessionId || step.childSessionId === childSessionId) &&
      (!step.childTurnId || step.childTurnId === childTurnId) &&
      (!child || !isDurableRunTerminal(child.status) || isTerminalDelegationStepStatus(step.status)));
  const lineageVerified =
    Boolean(child) && scopeVerified && delegationMetadataComplete && delegationScopeVerified && stepLinkVerified;
  const rawTools = lineageVerified && childTurnId ? await storage.chatToolRuns.listByTurn(childTurnId) : [];
  const toolRecordsValid = rawTools.every(
    (tool) =>
      tool.turnId === childTurnId &&
      tool.sessionId === childSessionId &&
      isSemanticId(tool.toolRunId) &&
      isPublicLabel(tool.toolName, 96) &&
      (!tool.approvalId || isSemanticId(tool.approvalId)),
  );
  const verified = lineageVerified && toolRecordsValid;
  if (verified && delegationRun) delegationRuns.set(delegationRun.runId, delegationRun);
  const tools = rawTools
    .filter(
      (tool) =>
        tool.turnId === childTurnId &&
        tool.sessionId === childSessionId &&
        isSemanticId(tool.toolRunId) &&
        isPublicLabel(tool.toolName, 96) &&
        (!tool.approvalId || isSemanticId(tool.approvalId)),
    )
    .slice(0, TOOL_READ_LIMIT)
    .map(projectTool);
  const toolCoverage = {
    complete: rawTools.length <= TOOL_READ_LIMIT,
    observedCount: Math.min(rawTools.length, TOOL_READ_LIMIT),
    limit: TOOL_READ_LIMIT,
  };
  const approvals = verified ? await projectApprovals(storage, tools, childSessionId) : [];
  const output = await projectOutput(storage, child, step, childSessionId, childTurnId, verified);
  const canonicalStatus = verified ? (child?.status ?? "missing") : child ? "unknown" : "missing";
  const signalIntegrity = normalizeDurableBackgroundTaskSignals(parentEvents, watcher.watcherId, parentSignalsComplete);
  const blockers = buildBlockers({ watcher, child, approvals, output, verified, signalIntegrity, toolCoverage });
  const attention = projectAttention(watcher, blockers);
  const terminal = child ? isDurableRunTerminal(child.status) : false;
  const label =
    publicPreviewText(verified ? (step?.label ?? step?.summary ?? step?.role) : undefined, 96) ??
    `Child ${shortId(watcher.childRunId)}`;
  const links: DurableBackgroundTaskSemanticLink[] = [
    semanticLink("durable_run", watcher.childRunId, "Child run"),
    ...(verified && childSessionId ? [semanticLink("chat_session", childSessionId, "Child chat")] : []),
    ...(verified && childTurnId ? [semanticLink("chat_turn", childTurnId, "Child turn")] : []),
    ...(verified && delegationRunId ? [semanticLink("delegation_run", delegationRunId, "Delegation run")] : []),
    ...(verified && stepId ? [semanticLink("delegation_step", stepId, "Delegation step")] : []),
  ];

  return {
    watcherId: watcher.watcherId,
    watcherRevision: computeDurableBackgroundWatcherRevision(watcher),
    watcherState: watcher.state,
    watcherUpdatedAt: watcher.updatedAt,
    childRunId: watcher.childRunId,
    delegationRunId: verified ? delegationRunId : undefined,
    delegationStepId: verified ? stepId : undefined,
    canonicalStatus,
    childVersion: verified ? child?.version : undefined,
    workerHealth: verified ? child?.workerHealth : undefined,
    recoveryState: verified ? child?.recoveryState : undefined,
    recoverySummary: publicPreviewText(verified ? child?.recoverySummary : undefined, ERROR_PREVIEW_BYTES),
    label,
    role: publicPreviewText(verified ? step?.role : undefined, 80),
    startedAt: verified ? (child?.startedAt ?? step?.startedAt) : undefined,
    finishedAt: verified ? (child?.finishedAt ?? step?.finishedAt) : undefined,
    scope: { workspaceId, sessionId: verified ? (childSessionId ?? parentSessionId) : parentSessionId, verified },
    tools: verified ? tools : [],
    toolCoverage,
    approvals,
    output,
    blockers,
    attention,
    signalIntegrity,
    controls: {
      detach: {
        enabled: watcher.state === "attached" && !terminal,
        reason:
          watcher.state !== "attached"
            ? `Watcher is ${watcher.state}.`
            : terminal && child
              ? `Child run is already ${child.status}.`
              : undefined,
      },
      reattach: {
        enabled: watcher.state === "detached",
        reason: watcher.state === "detached" ? undefined : `Watcher is ${watcher.state}.`,
      },
      cancel: {
        enabled: verified && Boolean(child) && !terminal && watcher.state !== "closed",
        reason: !verified
          ? "Child scope or lineage is not verified."
          : !child
            ? "Canonical child state is missing."
            : terminal
              ? `Child run is already ${child.status}.`
              : watcher.state === "closed"
                ? "Watcher is closed."
                : undefined,
      },
    },
    links,
  };
}

function projectTool(tool: ChatToolRunRecord): DurableBackgroundTaskItem["tools"][number] {
  return {
    toolRunId: tool.toolRunId,
    toolName: publicPreviewText(tool.toolName, 96) ?? "Tool",
    status: tool.status,
    approvalId: tool.approvalId,
    startedAt: tool.startedAt,
    finishedAt: tool.finishedAt,
    error: publicPreviewText(tool.error, ERROR_PREVIEW_BYTES),
    failureGuidance: publicPreviewText(tool.failureGuidance, ERROR_PREVIEW_BYTES),
    links: tool.approvalId ? [semanticLink("approval", tool.approvalId, "Approval")] : [],
  };
}

async function projectApprovals(
  storage: Pick<BackgroundTaskProjectionStorage, "approvals">,
  tools: DurableBackgroundTaskItem["tools"],
  childSessionId: string | undefined,
): Promise<DurableBackgroundTaskApprovalState[]> {
  const referenced = new Map(
    tools
      .filter((tool): tool is typeof tool & { approvalId: string } => Boolean(tool.approvalId))
      .map((tool) => [tool.approvalId, tool]),
  );
  return Promise.all(
    [...referenced].map(async ([approvalId, tool]) => {
      const approval = await readOptional(() => storage.approvals.get(approvalId));
      const linkage = approval?.linkage;
      const linkageVerified =
        childSessionId !== undefined &&
        linkage !== undefined &&
        linkage.sessionId === childSessionId &&
        (!linkage.toolName || linkage.toolName === tool.toolName);
      return approval && linkageVerified ? projectApproval(approval) : missingApproval(approvalId);
    }),
  );
}

function projectApproval(approval: ApprovalRequest): DurableBackgroundTaskApprovalState {
  return {
    approvalId: approval.approvalId,
    status: approval.status,
    riskLevel: approval.riskLevel,
    createdAt: approval.createdAt,
    expiresAt: approval.expiresAt,
    links: [semanticLink("approval", approval.approvalId, "Approval")],
  };
}

function missingApproval(approvalId: string): DurableBackgroundTaskApprovalState {
  return { approvalId, status: "missing", links: [semanticLink("approval", approvalId, "Missing approval")] };
}

async function projectOutput(
  storage: Pick<BackgroundTaskProjectionStorage, "chatMessages" | "chatTurnTraces">,
  child: DurableRunRecord | undefined,
  step: ChatDelegationStepRecord | undefined,
  childSessionId: string | undefined,
  childTurnId: string | undefined,
  verified: boolean,
): Promise<DurableBackgroundTaskOutputEvidence> {
  if (!verified) return { availability: child ? "unknown" : "missing" };
  if (!child || !isDurableRunTerminal(child.status)) return { availability: "not_terminal" };
  if (step?.output?.trim()) return outputEvidence("delegation_step", step.stepId, step.output);
  if (childSessionId && childTurnId) {
    const trace = await readOptional(() => storage.chatTurnTraces.get(childTurnId));
    if (!trace || trace.turnId !== childTurnId || trace.sessionId !== childSessionId) {
      return { availability: "unknown" };
    }
    const message = trace.assistantMessageId ? await storage.chatMessages.get(trace.assistantMessageId) : undefined;
    if (
      message?.content.trim() &&
      message.sessionId === childSessionId &&
      message.role === "assistant" &&
      isSemanticId(message.messageId)
    ) {
      return outputEvidence("assistant_message", message.messageId, message.content);
    }
  }
  return { availability: "missing" };
}

function outputEvidence(
  source: "delegation_step" | "assistant_message",
  sourceId: string,
  value: string,
): DurableBackgroundTaskOutputEvidence {
  const bytes = Buffer.from(value, "utf8");
  return {
    availability: "available",
    source,
    sourceId,
    summary: publicPreviewText(value, OUTPUT_PREVIEW_BYTES),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.byteLength,
  };
}

function buildBlockers(input: {
  watcher: DurableChildWatcherRecord;
  child?: DurableRunRecord;
  approvals: DurableBackgroundTaskApprovalState[];
  output: DurableBackgroundTaskOutputEvidence;
  verified: boolean;
  signalIntegrity: DurableBackgroundTaskSignalIntegrity;
  toolCoverage: DurableBackgroundTaskItem["toolCoverage"];
}): DurableBackgroundTaskBlocker[] {
  const blockers: DurableBackgroundTaskBlocker[] = [];
  if (!input.child) blockers.push({ kind: "missing_child", message: "Canonical child run is missing." });
  if (!input.verified)
    blockers.push({ kind: "scope_unverified", message: "Child workspace or lineage could not be verified." });
  if (input.verified && input.child?.status === "waiting")
    blockers.push({ kind: "waiting", message: "Child run is waiting." });
  if (input.verified && input.child?.status === "paused")
    blockers.push({ kind: "paused", message: "Child run is paused and requires operator attention." });
  if (input.verified && input.child?.status === "failed")
    blockers.push({ kind: "failed", message: "Child run failed." });
  if (input.verified && input.child?.status === "cancelled")
    blockers.push({ kind: "cancelled", message: "Child run was cancelled." });
  if (input.verified && input.child?.status === "dead_lettered") {
    blockers.push({ kind: "dead_lettered", message: "Child run exhausted recovery and is dead-lettered." });
  }
  const childTerminal = Boolean(input.verified && input.child && isDurableRunTerminal(input.child.status));
  for (const approval of input.approvals.filter((item) => item.status === "pending" || item.status === "missing")) {
    blockers.push({
      kind: childTerminal ? "signal_integrity" : "approval_required",
      message: childTerminal
        ? `Terminal child still references a ${approval.status} approval; inspect canonical records before acting.`
        : approval.status === "missing"
          ? "Referenced approval is missing."
          : "Operator approval is required.",
      link: semanticLink("approval", approval.approvalId, "Review approval"),
    });
  }
  if (
    input.verified &&
    input.child &&
    isDurableRunTerminal(input.child.status) &&
    input.output.availability !== "available"
  ) {
    blockers.push({
      kind: "missing_output",
      message:
        input.output.availability === "unknown"
          ? "Terminal child output linkage could not be verified."
          : "Terminal child has no concrete output to cite.",
    });
  }
  if (input.signalIntegrity.posture === "degraded") {
    blockers.push({
      kind: "signal_integrity",
      message: "Watcher signals were duplicate, conflicting, or out of order.",
    });
  }
  if (!input.toolCoverage.complete) {
    blockers.push({
      kind: "projection_incomplete",
      message: `Tool execution coverage reached the ${input.toolCoverage.limit} item display boundary.`,
    });
  }
  return blockers;
}

const OPERATOR_ATTENTION_BLOCKER_PRIORITY: readonly DurableBackgroundTaskBlocker["kind"][] = [
  "approval_required",
  "paused",
  "waiting",
  "failed",
  "dead_lettered",
  "missing_child",
  "scope_unverified",
  "signal_integrity",
  "projection_incomplete",
  "missing_output",
];

function projectAttention(
  watcher: DurableChildWatcherRecord,
  blockers: readonly DurableBackgroundTaskBlocker[],
): DurableBackgroundTaskItem["attention"] {
  const requiredReason = OPERATOR_ATTENTION_BLOCKER_PRIORITY.find((kind) =>
    blockers.some((blocker) => blocker.kind === kind),
  );
  if (watcher.state === "detached") {
    return {
      state: "background",
      reason: "operator_continued_in_background",
      updatedAt: watcher.detachedAt ?? watcher.updatedAt,
      required: requiredReason !== undefined,
      ...(requiredReason ? { requiredReason } : {}),
    };
  }
  if (watcher.state === "closed") {
    return {
      state: "stopped",
      reason: "watcher_closed",
      updatedAt: watcher.closedAt ?? watcher.updatedAt,
      required: requiredReason !== undefined,
      ...(requiredReason ? { requiredReason } : {}),
    };
  }
  return {
    state: "foreground",
    reason: "watcher_attached",
    updatedAt: watcher.reattachedAt ?? watcher.createdAt,
    required: requiredReason !== undefined,
    ...(requiredReason ? { requiredReason } : {}),
  };
}

function buildLineageEntry(task: DurableBackgroundTaskItem): DurableBackgroundTaskLineageEntry[] {
  if (
    !isTerminalBackgroundStatus(task.canonicalStatus) ||
    !task.scope.verified ||
    task.output.availability !== "available" ||
    !task.output.source ||
    !task.output.sourceId ||
    !task.output.sha256 ||
    task.output.byteCount === undefined
  ) {
    return [];
  }
  return [
    {
      watcherId: task.watcherId,
      childRunId: task.childRunId,
      source: task.output.source,
      sourceId: task.output.sourceId,
      sha256: task.output.sha256,
      byteCount: task.output.byteCount,
      links: task.links,
    },
  ];
}

async function inspectSynthesisStepCoverage(
  storage: Pick<BackgroundTaskProjectionStorage, "chatDelegationSteps">,
  synthesisRun: ChatDelegationRunRecord | undefined,
  synthesisTasks: DurableBackgroundTaskItem[],
): Promise<{ complete: boolean; integrityValid: boolean; uncoveredStepIds: string[] }> {
  if (!synthesisRun) return { complete: true, integrityValid: true, uncoveredStepIds: [] };
  const steps = await storage.chatDelegationSteps.listByRun(synthesisRun.runId);
  const observed = steps.slice(0, DELEGATION_STEP_READ_LIMIT);
  const integrityValid = observed.every(
    (step) =>
      isSemanticId(step.stepId) &&
      step.runId === synthesisRun.runId &&
      (synthesisRun.status !== "completed" || isTerminalDelegationStepStatus(step.status)),
  );
  const watchedStepIds = new Set(
    synthesisTasks.map((task) => task.delegationStepId).filter((id): id is string => Boolean(id)),
  );
  return {
    complete: steps.length <= DELEGATION_STEP_READ_LIMIT,
    integrityValid,
    uncoveredStepIds: observed
      .filter((step) => isSemanticId(step.stepId) && !watchedStepIds.has(step.stepId))
      .map((step) => step.stepId),
  };
}

export function computeDurableBackgroundWatcherRevision(watcher: DurableChildWatcherRecord): number {
  if (!Number.isSafeInteger(watcher.revision) || watcher.revision < 1) {
    throw new Error(`Durable child watcher ${watcher.watcherId} has an invalid persisted revision.`);
  }
  return watcher.revision;
}

function selectSynthesisRun(
  runs: ReadonlyMap<string, ChatDelegationRunRecord>,
  sessionId: string,
): ChatDelegationRunRecord | undefined {
  return [...runs.values()]
    .filter((run) => run.sessionId === sessionId)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId))[0];
}

async function assertParentScope(
  storage: Pick<BackgroundTaskProjectionStorage, "chatSessionMeta">,
  parent: DurableRunRecord,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const payloadSessionId = readString(parent.payload, "sessionId");
  const meta = await storage.chatSessionMeta.get(sessionId);
  const storedWorkspaceId = meta?.workspaceId ?? (meta ? "default" : undefined);
  if (
    parent.workflowKey !== "chat.turn.execute" ||
    payloadSessionId !== sessionId ||
    storedWorkspaceId !== workspaceId
  ) {
    throw new NotFoundError({ entity: "Durable background-task rail", id: parent.runId });
  }
}

function semanticLink(
  kind: DurableBackgroundTaskSemanticLink["kind"],
  id: string,
  label: string,
): DurableBackgroundTaskSemanticLink {
  return { kind, id, label };
}

function isTerminalBackgroundStatus(status: DurableBackgroundTaskItem["canonicalStatus"]): boolean {
  return status !== "missing" && status !== "unknown" && isDurableRunTerminal(status);
}

function isTerminalDelegationStepStatus(status: ChatDelegationStepRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "skipped" || status === "cancelled";
}

async function readOptional<T>(read: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NotFoundError || (error instanceof Error && /not found/i.test(error.message)))
      return undefined;
    throw error;
  }
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function readPositiveInteger(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Partial<DurableChildStateChangedPayload> & Record<string, unknown>)[key];
  return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : undefined;
}

function boundedText(value: string | undefined | null, maxBytes: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const bytes = Buffer.from(trimmed, "utf8");
  if (bytes.byteLength <= maxBytes) return trimmed;
  return `${bytes
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "")
    .trimEnd()}…`;
}

function publicPreviewText(value: string | undefined | null, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedText(redactStructuredSecrets(value).value, maxBytes);
}

function readSemanticId(value: unknown, key: string): { value?: string; valid: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !(key in value)) return { valid: true };
  const candidate = (value as Record<string, unknown>)[key];
  if (typeof candidate !== "string") return { valid: false };
  const trimmed = candidate.trim();
  if (!trimmed) return { valid: false };
  if (Buffer.byteLength(trimmed, "utf8") > SEMANTIC_ID_BYTES || containsAsciiControlCharacter(trimmed)) {
    return { valid: false };
  }
  return { value: trimmed, valid: true };
}

function isSemanticId(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= SEMANTIC_ID_BYTES &&
    !containsAsciiControlCharacter(value)
  );
}

function isPublicLabel(value: string, maxBytes: number): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !containsAsciiControlCharacter(value)
  );
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
