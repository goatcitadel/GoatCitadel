import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE,
  REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256,
  isModelUsageProvenNotDispatched,
  readDurableChatTurnExecutionPayloadAuthority,
  remoteWorkerArtifactManifestSha256,
  remoteWorkerChatInferenceMessages,
  remoteWorkerInferenceCanonicalSha256,
  type ChatStreamUsageRecord,
  type ChatStreamChunkDraft,
  type DurableRunRecord,
  type ModelUsageEventRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage, RemoteWorkerAssignmentAggregate } from "@goatcitadel/storage";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { RemoteWorkerArtifactStore } from "./remote-worker-artifact-store.js";
import { readCanonicalWorkerChatOutput, type RemoteWorkerChatSequenceContext } from "./remote-worker-chat-output-service.js";
import { readCanonicalDurableChatTerminalOutput } from "./chat-durable-run-service.js";
import { retainRemoteWorkerChatApprovalWait } from "./remote-worker-chat-approval-wait.js";
import { normalizeRemoteWorkerNativeContinuation, appendRemoteWorkerNativeChatContext, remoteWorkerNativeChatContextSha256,
  type RemoteWorkerNativeChatContext } from "@goatcitadel/contracts";
import {
  hashChatTurnRuntimeAuthorityValue,
  verifyCheckpointAnchoredChatTurnRuntimeAuthority,
} from "./chat-durable-runtime-authority.js";

type WriteFence = <T>(work: () => T | Promise<T>) => Promise<Awaited<T>>;

/** Internal owner port, never deserialized from Chat or worker request JSON. */
export interface RemoteWorkerChatExecution {
  readonly taskId: string;
  stream(input: { signal: AbortSignal; canonicalWriteFence: WriteFence }): AsyncGenerator<ChatStreamChunkDraft>;
  recordAssistantCommit(messageId: string, content: string): Promise<void>;
}

/** Resumes an existing assignment through the normal Chat completion writer.
 * This owner does not place new work or authorize tools/provider spending. */
export class RemoteWorkerChatExecutionService {
  private readonly artifacts: RemoteWorkerArtifactStore;

  constructor(
    private readonly storage: AsyncStorage,
    artifactRoot: string,
  ) {
    this.artifacts = new RemoteWorkerArtifactStore(artifactRoot);
  }

  async resolve(
    run: DurableRunRecord,
    prepared: PreparedAgentChatTurn,
  ): Promise<RemoteWorkerChatExecution | undefined> {
    const bound = await this.findAssignment(run, prepared);
    if (!bound) return undefined;
    const { scope, assignment, admitted } = bound;
    const manifest = assignment.assignment.manifest;
    const ref = {
      registryWorkspaceId: assignment.assignment.registryWorkspaceId,
      assignmentId: assignment.assignment.assignmentId,
    };
    let verified: Awaited<ReturnType<RemoteWorkerChatExecutionService["readCompleted"]>> | undefined;
    const readCurrent = async () => {
      const current = await this.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(scope);
      if (
        !current ||
        current.assignment.assignmentId !== ref.assignmentId ||
        current.assignment.registryWorkspaceId !== ref.registryWorkspaceId ||
        current.assignment.manifestSha256 !== assignment.assignment.manifestSha256
      )
        throw new Error("Worker Chat assignment ownership changed.");
      return current;
    };
    const storage = this.storage;
    const readCompleted = this.readCompleted.bind(this);
    let resumeInspected = false;
    let resume: Awaited<ReturnType<AsyncStorage["remoteWorkerAssignments"]["bindChatApprovalResumeDispatch"]>>;
    let parentRecovery: Awaited<ReturnType<AsyncStorage["remoteWorkerAssignments"]["bindChatParentRecoveryDispatch"]>>;
    return {
      taskId: manifest.taskId,
      async *stream({ signal, canonicalWriteFence }) {
        while (true) {
          signal.throwIfAborted();
          await canonicalWriteFence(() => undefined);
          const current = await readCurrent();
          if (current.generation && !current.settlement && !resumeInspected) {
            if (!run.leaseOwnerId) throw new Error("Worker Chat resume has no parent dispatch owner.");
            // The previous fence has ended: the repository acquires session and
            // worker roots before the parent row, preserving native lock order.
            resume = await storage.remoteWorkerAssignments.bindChatApprovalResumeDispatch({ ...ref,
              durableRunId: run.runId, leaseOwnerId: run.leaseOwnerId, attemptCount: run.attemptCount });
            if (!resume) parentRecovery = await storage.remoteWorkerAssignments.bindChatParentRecoveryDispatch({ ...ref,
              durableRunId: run.runId, leaseOwnerId: run.leaseOwnerId, attemptCount: run.attemptCount });
            resumeInspected = true;
          }
          if (current.settlement) {
            verified = await readCompleted(current, signal);
            await canonicalWriteFence(() => undefined);
            yield {
              type: "usage",
              sessionId: scope.sessionId,
              turnId: scope.turnId,
              usage: summarizeUsage(verified.usage),
              modelUsageEventIds: verified.usage.map((event) => event.eventId),
            };
            yield {
              type: "message_done",
              sessionId: scope.sessionId,
              turnId: scope.turnId,
              messageId: prepared.assistantMessageId,
              content: verified.text,
            };
            return;
          }
          if (
            Date.parse(manifest.deadlineAt) <= Date.now() ||
            current.control
          )
            throw new Error("Worker Chat assignment requires reconciliation before execution can continue.");
          const approval = await canonicalWriteFence(async () =>
            await retainRemoteWorkerChatApprovalWait(storage, await readCurrent(), {
              resumedApprovalId: resume?.material.approvalId,
            }));
          if (approval) {
            yield { type: "approval_required", sessionId: scope.sessionId, turnId: scope.turnId, approval };
            return;
          }
          const leaseHandoff = resume?.recovery?.material ?? resume?.material ?? parentRecovery?.material;
          const renewingWorkerLease = (resume?.binding || parentRecovery) && current.lease && leaseHandoff &&
            current.lease.leaseRevision === leaseHandoff.priorLeaseRevision &&
            current.lease.requestSha256 === leaseHandoff.priorLeaseRequestSha256;
          if (current.lease && Date.parse(current.lease.expiresAt) <= Date.now() && !renewingWorkerLease)
            throw new Error("Worker Chat assignment requires reconciliation before execution can continue.");
          await delay(250, undefined, { signal });
        }
      },
      async recordAssistantCommit(messageId, content) {
        const current = await readCurrent();
        if (
          !verified ||
          messageId !== prepared.assistantMessageId ||
          content !== verified.text ||
          current.settlement?.requestSha256 !== verified.settlement.requestSha256 ||
          current.generation?.assignmentGeneration !== verified.settlement.assignmentGeneration
        )
          throw new Error("Worker Chat assistant commit lost its verified settlement binding.");
        const message = await storage.chatMessages.get(messageId);
        const trace = await storage.chatTurnTraces.get(scope.turnId);
        if (
          !message ||
          message.sessionId !== scope.sessionId ||
          message.role !== "assistant" ||
          message.actorType !== "agent" ||
          message.content !== content ||
          trace.sessionId !== scope.sessionId ||
          trace.status !== "completed" ||
          trace.assistantMessageId !== messageId
        )
          throw new Error("Worker Chat materialization requires its canonical assistant message and completed trace.");
        const events = await storage.remoteWorkerAssignments.listEventsAfter(
          ref.registryWorkspaceId,
          ref.assignmentId,
          verified.settlement.assignmentGeneration,
          0,
          500,
        );
        // This first output profile is bounded text. A different workflow cannot
        // silently substitute a synthetic answer for its unmaterialized events.
        if (
          events.length !== verified.settlement.finalEventSequence ||
          events.at(-1)?.eventSha256 !== verified.settlement.finalEventSha256 ||
          events.some((event) => event.eventType !== "transcript_delta") ||
          events.map((event) => ("text" in event.payload ? event.payload.text : "")).join("") !== content
        )
          throw new Error("Worker Chat transcript does not match its verified output.");
        const targetSha256 = remoteWorkerInferenceCanonicalSha256({
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          messageId,
          content,
        });
        for (const event of events) {
          await storage.remoteWorkerAssignments.recordMaterialization({
            ...ref,
            sourceKind: "event",
            sourceGeneration: verified.settlement.assignmentGeneration,
            sourceSequence: event.sequence,
            sourceSha256: event.eventSha256,
            targetKind: "chat_transcript",
            targetId: messageId,
            targetSha256,
            targetOwnerSessionId: scope.sessionId,
            targetOwnerTurnId: scope.turnId,
            gatewayActorId: admitted.requestActor.actorId,
            idempotencyKey: `chat-output:${ref.assignmentId}:${verified.settlement.assignmentGeneration}:${event.sequence}`,
          });
        }
      },
    };
  }

  /** Called inside the canonical Chat finalization transaction, after the run,
   * checkpoint, and trace have been written. Exact terminal replay is supported. */
  async recordDurableCommit(runId: string, prepared: PreparedAgentChatTurn): Promise<void> {
    const run = await this.storage.durableRuns.getRun(runId);
    const bound = await this.findAssignment(run, prepared);
    if (!bound) return;
    const { scope, assignment, admitted } = bound;
    const trace = await this.storage.chatTurnTraces.get(scope.turnId);
    const checkpoint = await this.storage.durableRuns.getLatestCheckpointByKind(runId, "run_completed");
    if (
      run.status !== "completed" ||
      trace.status !== "completed" ||
      trace.sessionId !== scope.sessionId ||
      trace.durable?.runId !== runId ||
      trace.durable.status !== "completed" ||
      !checkpoint
    )
      throw new Error("Worker result materialization requires a canonical completed Chat run and checkpoint.");
    const output = await readCanonicalDurableChatTerminalOutput(this.storage, prepared, trace);
    const authority = verifyCheckpointAnchoredChatTurnRuntimeAuthority(run.metadata, checkpoint.state);
    const material = authority.material;
    if (
      !output ||
      material.runId !== runId ||
      material.turnId !== scope.turnId ||
      material.transitionKind !== "terminal" ||
      material.durableStatus !== "completed" ||
      material.traceStatus !== "completed" ||
      material.terminalOutput?.assistantMessageId !== output.assistantMessageId ||
      material.terminalOutput.outputTextSha256 !== hashChatTurnRuntimeAuthorityValue(output.outputText) ||
      material.terminalOutput.outputSummarySha256 !== hashChatTurnRuntimeAuthorityValue(output.outputSummary) ||
      run.metadata?.outputText !== output.outputText ||
      run.metadata?.finalOutput !== output.outputText ||
      run.metadata?.outputSummary !== output.outputSummary ||
      run.metadata?.finalSummary !== output.outputSummary ||
      checkpoint.state.assistantMessageId !== output.assistantMessageId ||
      checkpoint.state.outputText !== output.outputText ||
      checkpoint.state.outputSummary !== output.outputSummary
    )
      throw new Error("Worker result materialization differs from canonical Chat terminal authority.");
    const verified = await this.readCompleted(assignment, new AbortController().signal);
    if (output.outputText !== verified.text)
      throw new Error("Worker result materialization differs from its verified settlement output.");
    await this.storage.remoteWorkerAssignments.recordMaterialization({
      registryWorkspaceId: assignment.assignment.registryWorkspaceId,
      assignmentId: assignment.assignment.assignmentId,
      sourceKind: "settlement",
      sourceGeneration: verified.settlement.assignmentGeneration,
      sourceSha256: verified.settlement.requestSha256,
      targetKind: "durable_run_result",
      targetId: runId,
      targetOwnerDurableRunId: runId,
      targetSha256: remoteWorkerInferenceCanonicalSha256({
        ...scope,
        ...output,
        status: "completed",
        runtimeAuthoritySha256: authority.materialSha256,
      }),
      gatewayActorId: admitted.requestActor.actorId,
      idempotencyKey: `chat-result:${assignment.assignment.assignmentId}:${verified.settlement.assignmentGeneration}`,
    });
  }

  private async findAssignment(run: DurableRunRecord, prepared: PreparedAgentChatTurn) {
    const scope = {
      executionWorkspaceId: prepared.workspaceId,
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      durableRunId: run.runId,
    };
    const assignment = await this.storage.remoteWorkerAssignments.findTaskBoundChatAssignment(scope);
    if (!assignment) return undefined;
    const admitted = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: run.runId,
      payload: run.payload,
    });
    if (
      !admitted ||
      admitted.workspaceId !== scope.executionWorkspaceId ||
      admitted.sessionId !== scope.sessionId ||
      admitted.turnId !== scope.turnId ||
      !prepared.capabilityProfile
    )
      throw new Error("Worker Chat completion has no matching canonical admission.");
    const manifest = assignment.assignment.manifest;
    if (
      manifest.durableRunId !== run.runId ||
      manifest.capabilityProfileSha256 !== prepared.capabilityProfile.hashes.profileHash ||
      manifest.contextSnapshotSha256 !== run.metadata?.remoteWorkerChatContextSha256
    )
      throw new Error("Worker Chat completion differs from its admitted context or capability profile.");
    return { scope, assignment, admitted };
  }

  private async readCompleted(current: RemoteWorkerAssignmentAggregate, signal: AbortSignal) {
    const { assignment, generation, settlement } = current;
    if (
      !settlement ||
      settlement.outcome !== "completed" ||
      !generation ||
      generation.assignmentGeneration !== settlement.assignmentGeneration
    )
      throw new Error("Worker Chat assignment did not complete successfully.");
    const ref = {
      registryWorkspaceId: assignment.registryWorkspaceId,
      assignmentId: assignment.assignmentId,
      assignmentGeneration: settlement.assignmentGeneration,
    };
    const manifest = await this.storage.remoteWorkerArtifacts.getVerifiedManifest(
      ref.registryWorkspaceId,
      ref.assignmentId,
      ref.assignmentGeneration,
    );
    if (
      !manifest ||
      manifest.requiredVerifierProfileSha256 !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE_SHA256 ||
      remoteWorkerArtifactManifestSha256(manifest) !== settlement.outputManifestSha256 ||
      manifest.identity.assignmentManifestSha256 !== assignment.manifestSha256 ||
      manifest.identity.executionWorkspaceId !== assignment.manifest.executionWorkspaceId ||
      manifest.identity.workerId !== generation.workerId ||
      manifest.identity.workerGeneration !== generation.workerGeneration ||
      manifest.pathJailSha256 !== assignment.manifest.pathJailSha256 ||
      manifest.entries.length !== 1 ||
      manifest.entries[0]!.logicalPath !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE.logicalPath ||
      manifest.entries[0]!.mimeType !== REMOTE_WORKER_CHAT_OUTPUT_PROFILE.mimeType ||
      manifest.totalBytes > REMOTE_WORKER_CHAT_OUTPUT_PROFILE.maxBytes
    )
      throw new Error("Worker Chat completion lacks its verified output manifest.");
    const profile = await this.storage.chatTurnCapabilityProfiles.findByRun(assignment.manifest.durableRunId);
    const context = await this.storage.remoteWorkerChatContexts.findForRun(assignment.manifest.durableRunId);
    if (!profile || profile.hashes.profileHash !== assignment.manifest.capabilityProfileSha256 ||
      (context && (context.contextSha256 !== assignment.manifest.contextSnapshotSha256 ||
        context.capabilityProfileId !== profile.profileId)))
      throw new Error("Worker Chat completion lost its admitted context or capability profile.");
    // Older text-only assignments did not retain a complete history snapshot.
    // Iterative tool workflows always require that immutable context.
    const nativeResume = await this.storage.remoteWorkerAssignments.findChatApprovalResume(ref);
    let nativeContext: RemoteWorkerNativeChatContext | undefined;
    if (nativeResume?.material.schemaVersion === "goatcitadel.remote-worker-native-runtime-resume.v1") {
      const approval = await this.storage.approvals.get(nativeResume.material.approvalId);
      const continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
        assignmentGeneration: ref.assignmentGeneration, resumeSha256: nativeResume.materialSha256,
        approvalId: approval.approvalId, approvalSha256: nativeResume.material.approvalSha256,
        nativeRuntimeBindingSha256: nativeResume.material.nativeRuntimeBindingSha256, decision: approval.status });
      const retained = await this.storage.remoteWorkerRuntimeResults.readChatContextForParent({ ...ref,
        durableRunId: assignment.manifest.durableRunId, continuation });
      signal.throwIfAborted();
      if (!retained || !context) throw new Error("Native Chat completion lacks its retained continuation context.");
      nativeContext = retained;
    }
    const sequence: RemoteWorkerChatSequenceContext | undefined = context ? {
      profile, baseMessages: nativeContext ? appendRemoteWorkerNativeChatContext(remoteWorkerChatInferenceMessages(context), nativeContext)
        : remoteWorkerChatInferenceMessages(context), contextSha256: context.contextSha256,
      ...(nativeContext ? { continuationSha256: remoteWorkerNativeChatContextSha256(nativeContext), nativeContext } : {}),
      taskId: assignment.manifest.taskId, workerId: generation.workerId,
      workerGeneration: generation.workerGeneration, toolStorage: this.storage,
    } : undefined;
    const { record, text, steps, toolIntentIds } = await readCanonicalWorkerChatOutput(
      this.storage.remoteWorkerInference,
      ref,
      sequence,
    );
    if (
      record.workerId !== generation.workerId ||
      record.workerGeneration !== generation.workerGeneration ||
      record.durableRunId !== assignment.manifest.durableRunId ||
      record.sessionId !== assignment.manifest.sessionId ||
      record.turnId !== assignment.manifest.turnId ||
      record.executionWorkspaceId !== assignment.manifest.executionWorkspaceId ||
      record.capabilityProfileSha256 !== assignment.manifest.capabilityProfileSha256 ||
      record.routedContextSha256 !== assignment.manifest.contextSnapshotSha256
    )
      throw new Error("Worker Chat inference belongs to another execution.");
    const bytes = await this.artifacts.readBlob({
      executionWorkspaceId: assignment.manifest.executionWorkspaceId,
      blobSha256: manifest.entries[0]!.blobSha256,
      signal,
    });
    if (
      bytes.byteLength !== manifest.totalBytes ||
      !Buffer.from(bytes).equals(Buffer.from(text, "utf8")) ||
      createHash("sha256").update(bytes).digest("hex") !== settlement.resultSha256
    )
      throw new Error("Worker Chat artifact differs from its settled response.");
    const usage = await readRemoteWorkerChatUsage(this.storage, ref, { record, steps, toolIntentIds }, Boolean(nativeContext));
    return { text, usage, settlement };
  }
}

/** Read-model totals only; prices and usage remain canonical accounting inputs. */
function summarizeUsage(events: ModelUsageEventRecord[]): ChatStreamUsageRecord {
  const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd") =>
    events.every((event) => typeof event[key] === "number")
      ? events.reduce((total, event) => total + event[key]!, 0)
      : undefined;
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    costUsd: sum("costUsd"),
  };
}

/** Parent accounting across the current model sequence and retained assignment attempts. */
export async function readRemoteWorkerChatUsage(
  storage: Pick<AsyncStorage, "modelUsageEvents" | "remoteWorkerBudgets">,
  ref: { registryWorkspaceId: string; assignmentId: string; assignmentGeneration: number },
  { record, steps, toolIntentIds }: Pick<Awaited<ReturnType<typeof readCanonicalWorkerChatOutput>>, "record" | "steps" | "toolIntentIds">,
  includeAssignmentHistory: boolean,
): Promise<ModelUsageEventRecord[]> {
  const usage: ModelUsageEventRecord[] = [];
  for (const step of steps) {
    const reservation = await storage.remoteWorkerBudgets.getReservationForOperation(
      step.record.operationId, step.record.dispatchGeneration,
    );
    if (!reservation) throw new Error("Worker Chat completion lost its spending reservation.");
    for (const id of step.usageEventIds) {
      const event = await storage.modelUsageEvents.findByEventId(id);
      if (!event || event.operationId !== step.record.operationId || event.dispatchGeneration !== step.record.dispatchGeneration)
        throw new Error("Worker Chat completion lost its canonical usage event.");
      usage.push(event);
    }
    usage.push(...(await storage.remoteWorkerBudgets.listRelatedAttempts(reservation)));
  }
  for (const intentId of toolIntentIds) {
    const key = { ...ref, intentId };
    await storage.remoteWorkerBudgets.reconcileToolAttempts(key);
    usage.push(...(await storage.remoteWorkerBudgets.listToolAttempts(key)));
  }
  if (includeAssignmentHistory) {
    // Native continuation changes model request identities, not the assignment's
    // spending scope. Retain earlier attempts, including unresolved dispatches.
    const seen = new Set(usage.map((event) => event.eventId));
    const assignmentUsage = await storage.modelUsageEvents.listRemoteWorkerAssignment(
      ref.registryWorkspaceId, ref.assignmentId, ref.assignmentGeneration,
    );
    for (const event of assignmentUsage) {
      if (!seen.has(event.eventId)) { usage.push(event); seen.add(event.eventId); }
    }
  }
  if (
    new Set(usage.map((event) => event.eventId)).size !== usage.length ||
    usage.some(
      (event) =>
        event.workspaceId !== record.executionWorkspaceId ||
        event.sessionId !== record.sessionId ||
        event.turnId !== record.turnId ||
        event.durableRunId !== record.durableRunId ||
        event.taskId !== record.taskId ||
        event.workerId !== record.workerId ||
        (!isModelUsageProvenNotDispatched(event) &&
          (event.transportStatus !== "accepted" ||
            !event.finishedAt ||
            event.terminalOutcome === "in_flight" ||
            event.costUsd === undefined)),
    )
  )
    throw new Error("Worker Chat completion has unresolved or mismatched model usage.");
  return usage;
}
