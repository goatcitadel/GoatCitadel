import { expect, it, vi } from "vitest";
import { REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION, remoteWorkerAssignmentCanonicalSha256 as digest,
  remoteWorkerChatInferenceIdentity } from "@goatcitadel/contracts";
import { nativeChatContextFixture } from "../../../../packages/contracts/src/remote-worker-native-chat-context-test-fixture.js";
import { buildWorkerInferenceSubmission } from "../../../remote-worker/src/worker-inference-execution.js";
import { RemoteWorkerInferenceRuntime, type RemoteWorkerInferenceRuntimeDependencies } from "./remote-worker-inference-runtime.js";
import { buildRemoteWorkerChatSequenceContext, readCanonicalWorkerChatInput, readCanonicalWorkerChatOutput } from "./remote-worker-chat-output-service.js";

it("binds the worker and Gateway to identical native facts and never reuses the pre-native answer", async () => {
  const nativeChatContext = nativeChatContextFixture();
  const scope = { registryWorkspaceId: "default", assignmentId: "assignment", assignmentGeneration: 1 };
  const identity = { schemaVersion: REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
    registryWorkspaceId: scope.registryWorkspaceId, assignmentId: scope.assignmentId,
    assignmentManifestSha256: digest("manifest"), durableRunId: "run", durableRunVersion: 1,
    durableRunPayloadSha256: digest("payload"), capabilityProfileId: "profile", capabilityProfileSha256: digest("profile"),
    contextSnapshotSha256: digest("context"), nativeContinuation: nativeChatContext.continuation, nativeChatContext };
  const workload = { ...identity, workloadSha256: digest(identity), payload: {
    capabilityProfileId: identity.capabilityProfileId, capabilityProfileHash: identity.capabilityProfileSha256,
    request: { content: "Explain the recorded execution outcome." } } };
  const lease = { ...scope, leaseRevision: 1, leaseToken: "a".repeat(43) };
  const submission = buildWorkerInferenceSubmission(workload, lease);
  const sequence = buildRemoteWorkerChatSequenceContext({} as never, {} as never, {
    workload, authority: { assignment: { manifest: { taskId: "task" } }, generation: { workerId: "worker", workerGeneration: 1 } },
  } as never);
  const inference = { getRequestByIdempotency: vi.fn(async () => undefined), listFramesAfter: vi.fn(),
    hasInferenceOutsideChatSequence: vi.fn(async () => false), listAssignmentChatRequests: vi.fn(async () => []) };
  expect(await readCanonicalWorkerChatInput(inference as never, scope, 0, sequence)).toEqual(submission.messages);
  expect(digest(sequence.baseMessages)).toBe(submission.inputSha256);
  expect(submission).toMatchObject(remoteWorkerChatInferenceIdentity({ ...scope, continuationSha256: sequence.continuationSha256 }, 0));
  expect(submission.inferenceRequestId).not.toBe(remoteWorkerChatInferenceIdentity(scope, 0).inferenceRequestId);
  expect(submission.messages.at(-1)!.text).toContain('"exitCode":23');
  await expect(readCanonicalWorkerChatOutput(inference as never, scope, sequence)).rejects.toThrow("settled canonical inference");
  expect(inference.getRequestByIdempotency).toHaveBeenCalledWith(scope.registryWorkspaceId, submission.idempotencyKey);
  expect(inference.listFramesAfter).not.toHaveBeenCalled();
  inference.listAssignmentChatRequests.mockRejectedValue(new Error("preserved prior model history unavailable"));
  await expect(readCanonicalWorkerChatInput(inference as never, scope, 0, sequence)).rejects.toThrow("preserved prior model history");
  await expect(readCanonicalWorkerChatOutput(inference as never, scope, sequence)).rejects.toThrow("preserved prior model history");
  const changed = { ...nativeChatContext, continuation: { ...nativeChatContext.continuation, resumeSha256: digest("another wake") } };
  expect(() => buildWorkerInferenceSubmission({ ...workload, nativeChatContext: changed }, lease)).toThrow();
  expect(() => buildRemoteWorkerChatSequenceContext({} as never, {} as never,
    { workload: { ...workload, nativeChatContext: changed } } as never)).toThrow("canonical continuation");
});

it("withholds tool and artifact sequence reconstruction while native continuation is pending", () => {
  expect(() => buildRemoteWorkerChatSequenceContext({} as never, {} as never,
    { workload: { nativeContinuation: { decision: "approved" }, payload: { request: { content: "old Chat request" } } } } as never))
    .toThrow("Native continuation");
});

it("withholds both replay and new provider work while canonical native continuation is pending", async () => {
  const resolveActiveChatExecution = vi.fn(async () => ({ workload: { nativeContinuation: { decision: "approved" } } }));
  const resolveActiveAuthorityByLeaseTokenHash = vi.fn(async () => ({ assignment: { registryWorkspaceId: "default", assignmentId: "assignment" },
    generation: { assignmentGeneration: 1 }, lease: { leaseRevision: 1 } }));
  const inspectReplay = vi.fn(), reserveForWorker = vi.fn(), llm = { resolveDispatchRoute: vi.fn(), chatCompletionsWithDispatchGuard: vi.fn() };
  const runtime = new RemoteWorkerInferenceRuntime({ storage: { remoteWorkerAssignments: { resolveActiveChatExecution, resolveActiveAuthorityByLeaseTokenHash },
    remoteWorkerInference: { inspectReplay }, remoteWorkerBudgets: { reserveForWorker } }, llm, completionHost: { llmService: llm },
    dispatchOwnerId: "native-continuation-test" } as unknown as RemoteWorkerInferenceRuntimeDependencies);
  const messages = [{ role: "user" as const, text: "Hello." }];
  await expect(runtime.performInference({ protectedAuthority: {} as never, submission: { registryWorkspaceId: "default", assignmentId: "assignment",
    assignmentGeneration: 1, inferenceRequestId: "inference", attempt: 1, idempotencyKey: "native-gate:1", leaseToken: "private-token",
    messages, inputSha256: digest(messages), contextSha256: digest("context"), modelIntentSha256: digest("model"),
    outputTokenCeiling: 100, reasoningTokenCeiling: 0, temperatureMilli: 0 } })).rejects.toThrow();
  expect(resolveActiveChatExecution).toHaveBeenCalledTimes(1);
  expect(inspectReplay).not.toHaveBeenCalled(); expect(reserveForWorker).not.toHaveBeenCalled();
  expect(llm.resolveDispatchRoute).not.toHaveBeenCalled(); expect(llm.chatCompletionsWithDispatchGuard).not.toHaveBeenCalled();
});
