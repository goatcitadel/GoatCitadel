import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import { REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION, serializeRemoteWorkerRuntimeOutputArtifact,
  readDurableChatTurnExecutionPayloadAuthority } from "@goatcitadel/contracts";
import { seedProtectedFenceHarness } from "../../../../packages/storage/src/remote-worker-protected-fence-fixture.js";
import { verifyRetainedNativeChatResult } from "../../../../packages/storage/src/remote-worker-native-chat-result-fixture.js";
import { buildWorkerInferenceSubmission } from "../../../remote-worker/src/worker-inference-execution.js";
import { publishWorkerChatArtifact } from "../../../remote-worker/src/worker-artifact-publication.js";
import { projectRemoteWorkerNativeChatWorkload } from "./remote-worker-native-chat-workload.js";
import { RemoteWorkerInferenceRuntime } from "./remote-worker-inference-runtime.js";
import { RemoteWorkerArtifactRuntime } from "./remote-worker-artifact-runtime.js";
import { RemoteWorkerChatExecutionService } from "./remote-worker-chat-execution-service.js";
import { LlmService } from "./llm-service.js";
import { ModelUsageAccountingService } from "@goatcitadel/gateway-core";
import { SecretStoreService } from "./secret-store-service.js";
import { finalizeDurableChatRun } from "./chat-durable-run-service.js";
import { DURABLE_RETRY_POLICY_DEFAULT } from "./durable-retry-policy.js";

it("retains native failure facts through governed inference, verified artifact, settlement and canonical Chat completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "goat-native-chat-acceptance-"));
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes("goat-native-chat-acceptance-")) throw new Error("Unexpected fixture root.");
  const storageOptions = { dbPath: join(root, "gateway.sqlite"), transcriptsDir: join(root, "transcripts"), auditDir: join(root, "audit") };
  let storage = new Storage(storageOptions);
  try {
    const asyncStorage = createSqliteAsyncStorage(storage), h = seedProtectedFenceHarness(storage.db, "native-chat-acceptance", true);
    const native = await verifyRetainedNativeChatResult(storage.db, "native-chat-acceptance", {
      workerId: h.finalized.generation.workerId, workerGeneration: h.finalized.generation.workerGeneration,
      nodeId: h.finalized.generation.nodeId, nodeAdmissionGeneration: h.admitted.admission.admissionGeneration,
    }, h.fence);
    const rawLease = Buffer.alloc(32, 0x51).toString("base64url"), hash = (s: string) => createHash("sha256").update(s).digest("hex");
    const scope = { registryWorkspaceId: native.ref.registryWorkspaceId, assignmentId: native.ref.assignmentId };
    const renewed = storage.remoteWorkerAssignments.renewLease({ ...scope,
      expectedAssignmentGeneration: native.ref.assignmentGeneration, expectedLeaseRevision: native.lease.leaseRevision,
      expectedLeaseTokenSha256: native.token, leaseTokenSha256: hash(rawLease), workerSentThrough: 0, idempotencyKey: "native-chat-model-lease" }, h.fence);
    const lease = { ...native.ref, leaseRevision: renewed.lease.leaseRevision, leaseToken: rawLease };
    const authority = { ...native.ref, leaseTokenSha256: hash(rawLease), protectedAuthority: h.fence };
    const execution = storage.remoteWorkerAssignments.resolveActiveChatExecution(authority, h.fence);
    const workload = await projectRemoteWorkerNativeChatWorkload(asyncStorage, execution.workload, native.ref);
    const submission = buildWorkerInferenceSubmission(workload as never, lease);
    expect(submission.messages.at(-1)!.text).toContain('"exitCode":23');
    expect(workload.nativeChatContext?.schemaVersion).toBe("goatcitadel.remote-worker-native-chat-context.v2");
    expect(submission.messages.at(-1)).toMatchObject({ role: "user", name: "native_runtime_output" });
    expect(submission.messages.at(-1)!.text).toContain("useful native output");
    expect(submission.messages.filter(message => message.role === "system").some(message => message.text.includes("useful native output"))).toBe(false);
    const nativeOutputKey = { ...native.ref, nonce: native.expectation.nonce };
    const nativeOutputDocument = storage.remoteWorkerRuntimeReads.readNativeOutputArtifact(nativeOutputKey)!;
    const nativeOutputDownload = serializeRemoteWorkerRuntimeOutputArtifact(nativeOutputDocument);
    expect(nativeOutputDocument.output.streams.stdout.text).toBe("useful native output\n");
    expect(nativeOutputDocument.outcome.exitCode).toBe(23);
    storage.remoteWorkerBudgets.createGrant({ grantId: "native-chat-grant", registryWorkspaceId: "default", executionWorkspaceId: "default",
      workerId: h.finalized.generation.workerId, workerGeneration: h.finalized.generation.workerGeneration,
      // Controlled accounting only: cover the route's maximum-context reservation.
      maxRequests: 2, maxCostMicrousd: 50_000_000, expiresAt: new Date(Date.now() + 300_000).toISOString() }, "operator-a");
    const answer = "Native execution exited with code 23; retained stdout was: useful native output. The nonzero exit is not task-success proof.";
    const provider = vi.fn(async () => new Response(JSON.stringify({ id: "native-chat-controlled-response", model: "gpt-5.4",
      status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }],
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, total_tokens: 20 },
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", provider);
    const llm = new LlmService({ activeProviderId: "openai", activeModel: "gpt-5.4", providers: [{ providerId: "openai",
      label: "Controlled native fixture", baseUrl: "https://api.openai.com/v1", apiStyle: "openai-responses", defaultModel: "gpt-5.4", apiKey: "fixture-not-a-real-key" }] }, {}, {
      secretStore: Object.assign(new SecretStoreService(), { getSecret: () => undefined, isAvailable: () => false }),
      modelUsageAccounting: new ModelUsageAccountingService(storage.modelUsageEvents, "native-chat-acceptance", 60_000, 60_000),
    });
    const completionHost = { llmService: llm,
      config: { assistant: { memory: { enabled: false, qmd: { enabled: false, applyToChat: false } } } },
      memoryLifecycleService: { composeContext: vi.fn() }, hooksService: { runInlineHooks: async () => ({ runs: [] }), enqueueAfterHooks: vi.fn(), hasMutateHook: () => false },
      resolveMemoryWorkspaceRelativeDir: async () => "workspace", resolveChatCompletionHookWorkspaceId: async () => "default",
      persistContextManifestForCompletionRequest: vi.fn(), resolveFallbackTargets: () => [], recordDevDiagnostic: vi.fn(), publishRealtime: vi.fn() };
    const inference = new RemoteWorkerInferenceRuntime({ storage: asyncStorage, llm, completionHost,
      dispatchOwnerId: "native-chat-acceptance", listCallableCapabilities: async () => [],
      resolvePolicyContext: async () => ({ permissionProfileId: "safe" }) } as never);
    const model = await inference.performInference({ protectedAuthority: h.fence, submission });
    expect(model.request.state, JSON.stringify({ disposition: model.disposition, reason: model.request.blockReason,
      budget: model.request.budgetAuthorityState, calls: provider.mock.calls.length })).toBe("completed");
    expect(model.request.budgetAuthorityState).toBe("settled");
    expect(provider).toHaveBeenCalledOnce();
    const replay = await inference.performInference({ protectedAuthority: h.fence, submission });
    expect(replay.request.requestSha256).toBe(model.request.requestSha256);
    expect(provider).toHaveBeenCalledOnce();

    const artifacts = new RemoteWorkerArtifactRuntime(asyncStorage, join(root, "cas")), state = new Map<string, string>();
    const artifact = await publishWorkerChatArtifact({ lease, workload: workload as never, lines: [answer],
      state: { read: async key => state.get(key), write: async (key, value) => { state.set(key, value); }, delete: async key => { state.delete(key); } },
      call: async (phase, material) => {
        const { kind: _kind, ...body } = material;
        const input = { ...authority, ...body, idempotencyKey: `native-chat-artifact-${phase}` };
        if (phase === "open") return await artifacts.openUpload(input as never) as never;
        if (phase === "part") return await artifacts.appendPart(input as never) as never;
        const files = (body.files as Array<{ bytesBase64: string }>).map(({ bytesBase64, ...file }) => ({ ...file, bytes: Buffer.from(bytesBase64, "base64") }));
        const changed = Buffer.from(files[0]!.bytes); changed[0] = changed[0]! ^ 1;
        await expect(artifacts.commitArtifact({ ...input, files: [{ ...files[0], bytes: changed }], signal: new AbortController().signal } as never)).rejects.toThrow();
        return await artifacts.commitArtifact({ ...input, files, signal: new AbortController().signal } as never) as never;
      } });
    const events = storage.remoteWorkerAssignments.appendEvents({ ...scope, expectedAssignmentGeneration: native.ref.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, leaseTokenSha256: hash(rawLease), events: [{ sequence: 1, eventId: "native-chat-answer",
        eventType: "transcript_delta", previousEventSha256: "0".repeat(64), workerSentThrough: 1,
        payload: { schemaVersion: REMOTE_WORKER_ASSIGNMENT_EVENT_SCHEMA_VERSION, role: "assistant", text: answer } }] }, h.fence);
    const settlement = { ...scope, origin: "worker" as const, expectedAssignmentGeneration: native.ref.assignmentGeneration,
      expectedLeaseRevision: lease.leaseRevision, leaseTokenSha256: hash(rawLease), outcome: "completed" as const,
      finalEventSequence: 1, finalEventSha256: events.events[0]!.eventSha256, ...artifact, idempotencyKey: "native-chat-settle" };
    storage.remoteWorkerAssignments.settleAssignment(settlement, h.fence);
    expect(storage.remoteWorkerAssignments.settleAssignment(settlement, h.fence).disposition).toBe("replayed");

    const parent = storage.durableRuns.getRun(native.parent.runId), profile = storage.chatTurnCapabilityProfiles.findByRun(parent.runId)!;
    const payload = readDurableChatTurnExecutionPayloadAuthority({ workflowKey: parent.workflowKey, durableRunId: parent.runId, payload: parent.payload })!;
    const prepared = { workspaceId: profile.identity.workspaceId, session: { sessionId: profile.identity.sessionId },
      turnId: profile.identity.turnId, capabilityProfile: profile, assistantMessageId: payload.assistantMessageId,
      content: payload.request.content, userMessage: { messageId: payload.userMessageId, sessionId: payload.sessionId },
      turnAdmission: { identity: { admissionId: payload.admissionId, sessionIncarnationId: payload.sessionIncarnationId,
        materialSha256: payload.admissionMaterialSha256, workspaceId: payload.workspaceId, sessionId: payload.sessionId, turnId: payload.turnId,
        aggregateRevision: payload.admissionAggregateRevision, controllerGeneration: payload.admissionControllerGeneration },
        admittedRequest: payload.request, requestActor: payload.requestActor } };
    const handoff = new RemoteWorkerChatExecutionService(asyncStorage, join(root, "cas")), parentExecution = (await handoff.resolve(parent, prepared as never))!;
    const chunks = [];
    for await (const chunk of parentExecution.stream({ signal: new AbortController().signal,
      canonicalWriteFence: work => asyncStorage.runImmediateTransaction(async () => {
        if (!await asyncStorage.durableRuns.lockFreshActiveLeaseForUpdate(parent.runId, parent.leaseOwnerId!)) throw new Error("Parent claim lost.");
        return await work();
      }) })) chunks.push(chunk);
    expect(chunks.find(chunk => chunk.type === "message_done")).toMatchObject({ content: answer });
    await asyncStorage.runImmediateTransaction(async () => {
      await asyncStorage.chatMessages.upsert({ messageId: prepared.assistantMessageId, sessionId: prepared.session.sessionId,
        role: "assistant", actorType: "agent", actorId: "assistant", content: answer, sourceAuthority: "unknown", timestamp: new Date().toISOString() });
      await asyncStorage.chatTurnTraces.patch(prepared.turnId, { status: "completed", assistantMessageId: prepared.assistantMessageId });
      await parentExecution.recordAssistantCommit(prepared.assistantMessageId, answer);
    });
    await asyncStorage.durableRuns.updateRun({ runId: parent.runId, status: parent.status, expectedVersion: parent.version,
      metadata: { ...parent.metadata, retryPolicy: { ...DURABLE_RETRY_POLICY_DEFAULT } } });
    const finalizer = { runImmediateTransaction: asyncStorage.runImmediateTransaction.bind(asyncStorage), durableRuns: asyncStorage.durableRuns,
      chatMessages: asyncStorage.chatMessages, chatTurnTraces: asyncStorage.chatTurnTraces, chatToolRuns: asyncStorage.chatToolRuns,
      chatToolArtifacts: asyncStorage.chatToolArtifacts, resolvePostCommitEligibility: async () => ({ version: 1,
        autonomyEnabledAtParentSettlement: false, evalIntegrityTurn: false, humanSession: true }),
      recordDurableTimelineEvent: async (runId: string, eventType: string, eventPayload: unknown) => {
        await asyncStorage.durableRunEvents.append({ eventId: randomUUID(), runId, eventType, payload: eventPayload ?? {}, createdAt: new Date().toISOString() } as never);
      }, recordTerminalResultMaterialization: (runId: string, turn: never) => handoff.recordDurableCommit(runId, turn) };
    await finalizeDurableChatRun(finalizer as never, parent.runId, prepared as never, storage.chatTurnTraces.get(prepared.turnId), parent.leaseOwnerId);
    expect(storage.durableRuns.getRun(parent.runId)).toMatchObject({ status: "completed", metadata: { outputText: answer } });
    expect(storage.remoteWorkerAssignments.findTaskBoundChatAssignment({ executionWorkspaceId: prepared.workspaceId,
      sessionId: prepared.session.sessionId, turnId: prepared.turnId, durableRunId: parent.runId })?.materialization)
      .toMatchObject({ chatTranscriptCount: 1, durableRunResultCount: 1, count: 2 });
    const finished = storage.durableRuns.getRun(parent.runId);
    await finalizeDurableChatRun(finalizer as never, parent.runId, prepared as never, storage.chatTurnTraces.get(prepared.turnId));
    expect(storage.durableRuns.getRun(parent.runId)).toEqual(finished);
    storage.close();
    storage = new Storage(storageOptions);
    expect(serializeRemoteWorkerRuntimeOutputArtifact(storage.remoteWorkerRuntimeReads.readNativeOutputArtifact(nativeOutputKey)!))
      .toEqual(nativeOutputDownload);
    const nativeReplay = storage.remoteWorkerRuntimeResults.readForChatContinuation({ ...native.ref,
      durableRunId: native.parent.runId, continuation: native.continuation }).recorded!;
    expect(nativeReplay.result.backing).toEqual(native.retained.result.backing);
    expect(nativeReplay.result.backing?.journalBytes).toBe(21504);
    expect(nativeReplay.result.resultSha256).toBe(native.retained.result.resultSha256);
    const reopened = createSqliteAsyncStorage(storage);
    const replayExecution = (await new RemoteWorkerChatExecutionService(reopened, join(root, "cas")).resolve(finished, prepared as never))!;
    const replayChunks = [];
    for await (const chunk of replayExecution.stream({ signal: new AbortController().signal,
      canonicalWriteFence: work => reopened.runImmediateTransaction(work) })) replayChunks.push(chunk);
    expect(replayChunks).toEqual(chunks);
    expect(storage.remoteWorkerAssignments.findTaskBoundChatAssignment({ executionWorkspaceId: prepared.workspaceId,
      sessionId: prepared.session.sessionId, turnId: prepared.turnId, durableRunId: parent.runId })?.materialization.count).toBe(2);
    expect(provider).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals(); storage.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
