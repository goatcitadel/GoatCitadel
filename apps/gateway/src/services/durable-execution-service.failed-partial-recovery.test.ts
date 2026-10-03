import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord, DurableCheckpointRecord, DurableRunRecord } from "@goatcitadel/contracts";
vi.mock("@goatcitadel/storage", () => ({}));
vi.mock("sqlite", () => ({}));
import { executeGeneralChatPostCommit, parseDurableChatTurnPayload } from "./durable-execution-service.js";
import {
  buildChatTurnRuntimeAuthoritySeal,
  withChatTurnRuntimeAuthority,
  withChatTurnRuntimeAuthorityCheckpoint,
} from "./chat-durable-runtime-authority.js";
import {
  computeEffectiveChatTurnRequestMaterialSha256,
  computeFrozenChatTurnAdmissionMaterialSha256,
} from "./session-control-service.js";

function createFailedPartialFixture() {
  const now = "2026-10-03T17:30:27.806Z";
  const request = { content: "Perform a read-only repository audit." };
  const admissionMaterialSha256 = computeFrozenChatTurnAdmissionMaterialSha256(request);
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission-failed-partial",
    sessionIncarnationId: "incarnation-failed-partial",
    admissionMaterialSha256,
    workspaceId: "default",
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    effectiveRequestMaterialSha256: computeEffectiveChatTurnRequestMaterialSha256(admissionMaterialSha256, request),
    requestActor: { actorKind: "operator", actorId: "operator:test" },
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: "run-failed-partial" },
    sessionId: "session-failed-partial",
    turnId: "turn-failed-partial",
    userMessageId: "user-failed-partial",
    assistantMessageId: "assistant-failed-partial",
    branchKind: "new",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const authority = buildChatTurnRuntimeAuthoritySeal({
    runId: "run-failed-partial",
    turnId: payload.turnId,
    transitionKind: "terminal",
    durableStatus: "failed",
    traceStatus: "partial",
    transitionAt: now,
    postCommitGenerationId: "generation-failed-partial",
    postCommitEligibility: {
      version: 1,
      autonomyEnabledAtParentSettlement: true,
      evalIntegrityTurn: false,
      humanSession: true,
    },
    requiredFinalizers: ["general"],
  });
  const run = {
    runId: authority.material.runId,
    workflowKey: "chat.turn.execute",
    status: "failed",
    attemptCount: 0,
    maxAttempts: 3,
    payload,
    metadata: withChatTurnRuntimeAuthority({}, authority),
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as DurableRunRecord;
  const checkpoint: DurableCheckpointRecord = {
    checkpointId: "checkpoint-failed-partial",
    runId: run.runId,
    checkpointKind: "run_failed",
    state: withChatTurnRuntimeAuthorityCheckpoint({}, authority),
    createdAt: now,
  };
  const trace = {
    turnId: payload.turnId,
    sessionId: payload.sessionId,
    userMessageId: payload.userMessageId,
    assistantMessageId: payload.assistantMessageId,
    status: "partial",
    durable: { runId: run.runId, status: "failed" },
  } as ChatTurnTraceRecord;
  const messages = new Map<string, { messageId: string; sessionId: string; role: string; content: string }>([
    [
      payload.userMessageId,
      {
        messageId: payload.userMessageId,
        sessionId: payload.sessionId,
        role: "user",
        content: request.content,
      },
    ],
  ]);
  const host = {
    storage: {
      chatMessages: { get: vi.fn(async (id: string) => messages.get(id)), upsert: vi.fn() },
      chatTurnTraces: { get: vi.fn(async () => trace), patch: vi.fn() },
      chatToolRuns: { listByTurn: vi.fn(async () => []) },
      durableRuns: { getLatestCheckpointByKind: vi.fn(async () => checkpoint) },
    },
    hooksService: { enqueueAfterHooks: vi.fn(async () => undefined) },
    recordCapabilityGapFromTrace: vi.fn(),
    publishRealtime: vi.fn(),
  };
  const progress = {
    generationId: authority.material.postCommitGenerationId!,
    requestedAt: now,
    targetTraceStatus: "partial" as const,
    completedEffects: [],
    runEffect: vi.fn(async (_effect: string, callback: () => void | Promise<void>) => {
      await callback();
      return true;
    }),
    publishEffect: vi.fn(),
    enqueueDurableEffect: vi.fn(),
  };
  return { run, payload, checkpoint, trace, host, progress, messages };
}

describe("failed partial Chat post-commit recovery", () => {
  it("settles a checkpoint-confirmed failure without inventing an answer or scheduling transcript effects", async () => {
    const fixture = createFailedPartialFixture();
    const originalTrace = structuredClone(fixture.trace);
    expect(parseDurableChatTurnPayload(fixture.run)).toBeDefined();
    await expect(
      executeGeneralChatPostCommit(fixture.host as never, fixture.run, fixture.progress),
    ).resolves.toMatchObject({
      status: "partial",
      capabilityGap: "not_applicable",
      commitments: "not_applicable",
      backgroundReview: "not_applicable",
      memoryMaintenance: "not_applicable",
      realtime: "not_applicable",
      agentEnd: "reconciled",
    });
    expect(fixture.progress.runEffect).toHaveBeenCalledTimes(9);
    expect(fixture.progress.enqueueDurableEffect).not.toHaveBeenCalled();
    expect(fixture.host.recordCapabilityGapFromTrace).not.toHaveBeenCalled();
    expect(fixture.host.publishRealtime).not.toHaveBeenCalled();
    expect(fixture.host.storage.chatMessages.upsert).not.toHaveBeenCalled();
    expect(fixture.host.storage.chatTurnTraces.patch).not.toHaveBeenCalled();
    expect(fixture.trace).toEqual(originalTrace);
    expect(fixture.messages.size).toBe(1);
  });

  it.each([
    "running",
    "completed",
    "cancelled",
    "completed_trace",
    "unbound_trace",
    "missing_assistant_link",
    "missing_checkpoint",
    "wrong_checkpoint_run",
    "wrong_checkpoint_kind",
    "unanchored_authority",
    "stale_metadata_output",
    "stale_checkpoint_output",
    "unlinked_assistant_output",
    "wrong_assistant_link",
  ])("rejects %s evidence before post-commit effects", async (scenario) => {
    const fixture = createFailedPartialFixture();
    expect(parseDurableChatTurnPayload(fixture.run)).toBeDefined();
    if (scenario === "running" || scenario === "completed" || scenario === "cancelled") fixture.run.status = scenario;
    if (scenario === "completed_trace") fixture.trace.status = "completed";
    if (scenario === "unbound_trace") fixture.trace.durable = undefined;
    if (scenario === "missing_assistant_link") fixture.trace.assistantMessageId = undefined;
    if (scenario === "missing_checkpoint")
      fixture.host.storage.durableRuns.getLatestCheckpointByKind.mockResolvedValue(undefined as never);
    if (scenario === "wrong_checkpoint_run") fixture.checkpoint.runId = "other-run";
    if (scenario === "wrong_checkpoint_kind") fixture.checkpoint.checkpointKind = "run_completed";
    if (scenario === "unanchored_authority") fixture.checkpoint.state.chatTurnRuntimeAuthority = undefined;
    if (scenario === "stale_metadata_output") fixture.run.metadata!.outputText = "Unverified answer";
    if (scenario === "stale_checkpoint_output")
      fixture.checkpoint.state.assistantMessageId = fixture.payload.assistantMessageId;
    if (scenario === "unlinked_assistant_output") {
      fixture.trace.assistantMessageId = undefined;
      fixture.messages.set(fixture.payload.assistantMessageId, {
        messageId: fixture.payload.assistantMessageId,
        sessionId: fixture.payload.sessionId,
        role: "assistant",
        content: "An unlinked answer",
      });
    }
    if (scenario === "wrong_assistant_link") fixture.trace.assistantMessageId = "other-assistant";
    await expect(executeGeneralChatPostCommit(fixture.host as never, fixture.run, fixture.progress)).rejects.toThrow(
      /assistant output/,
    );
    expect(fixture.progress.runEffect).not.toHaveBeenCalled();
    expect(fixture.progress.enqueueDurableEffect).not.toHaveBeenCalled();
    expect(fixture.host.hooksService.enqueueAfterHooks).not.toHaveBeenCalled();
    expect(fixture.host.storage.chatMessages.upsert).not.toHaveBeenCalled();
    expect(fixture.host.storage.chatTurnTraces.patch).not.toHaveBeenCalled();
  });
});
