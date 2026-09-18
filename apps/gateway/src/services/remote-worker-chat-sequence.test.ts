import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  appendRemoteWorkerChatToolResults,
  appendRemoteWorkerNativeChatContext,
  remoteWorkerNativeChatContextSha256,
  remoteWorkerChatInferenceIdentity,
  remoteWorkerInferenceCanonicalSha256 as digest,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  remoteWorkerInferenceCanonicalRequestBody,
  remoteWorkerInferenceRequestSha256,
  REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
  type RemoteWorkerInferenceFramePayload,
  type RemoteWorkerInferenceMessage,
} from "@goatcitadel/contracts";
import {
  readCanonicalWorkerChatInput,
  readCanonicalWorkerChatOutput,
  type RemoteWorkerChatSequenceContext,
} from "./remote-worker-chat-output-service.js";
import { readCanonicalWorkerModelToolResult } from "./remote-worker-chat-tool-result.js";
import { readRemoteWorkerNativeChatHistory } from "./remote-worker-native-chat-history.js";
import { nativeChatContextFixture, nativeChatOutputContextFixture } from "../../../../packages/contracts/src/remote-worker-native-chat-context-test-fixture.js";
import { projectRemoteWorkerNativeChatWorkload } from "./remote-worker-native-chat-workload.js";
import { buildWorkerInferenceSubmission } from "../../../remote-worker/src/worker-inference-execution.js";

vi.mock("./remote-worker-chat-tool-result.js", () => ({ readCanonicalWorkerModelToolResult: vi.fn() }));

const scope = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 1 };
const call = { callId: "call-read", modelToolName: "fs_read", argumentsJson: '{"path":"note.txt"}' };
const baseMessages = [
  { role: "system" as const, text: "Admitted instructions" },
  { role: "user" as const, text: "Read the note" },
];
const result = {
  status: "completed" as const,
  intentId: "intent-read",
  toolRunId: "tool-read",
  resultJson: '{"text":"Orion 7"}',
  resultSha256: digest({ text: "Orion 7" }),
};
const identity = { workspaceId: "workspace", sessionId: "session", turnId: "turn", durableRunId: "run" };
const context = {
  profile: { profileId: "profile", identity, hashes: { profileHash: "a".repeat(64) } },
  baseMessages,
  contextSha256: "b".repeat(64),
  taskId: "task",
  workerId: "worker",
  workerGeneration: 2,
  toolStorage: {},
} as unknown as RemoteWorkerChatSequenceContext;

beforeEach(() => vi.mocked(readCanonicalWorkerModelToolResult).mockReset().mockResolvedValue(result));

function fixture() {
  const continued = appendRemoteWorkerChatToolResults(baseMessages, { text: "Reading.", toolCalls: [call] }, [
    { ...result, callId: call.callId, modelToolName: call.modelToolName },
  ]);
  const step = (index: number, messages: readonly RemoteWorkerInferenceMessage[], continuationSha256?: string, final = false) => {
    const key = { ...scope, ...remoteWorkerChatInferenceIdentity({ ...scope, continuationSha256 }, index) };
    const usageEventId = `${continuationSha256 ? "native-" : ""}usage-${index}`;
    const submission = { ...key, messages, inputSha256: digest(messages), contextSha256: context.contextSha256,
      modelIntentSha256: digest("model"), outputTokenCeiling: 100, reasoningTokenCeiling: 0, temperatureMilli: 0 };
    const record = {
      ...key,
      state: "completed",
      budgetAuthorityState: "settled",
      outputFrameCount: 2,
      terminalFrameSequence: 2,
      effectiveRouteSha256: "c".repeat(64),
      usageEventIdsJson: JSON.stringify([usageEventId]),
      usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256([usageEventId]),
      contextSha256: context.contextSha256,
      routedContextSha256: context.contextSha256,
      capabilityProfileSha256: context.profile.hashes.profileHash,
      executionWorkspaceId: identity.workspaceId,
      sessionId: identity.sessionId,
      turnId: identity.turnId,
      durableRunId: identity.durableRunId,
      taskId: context.taskId,
      workerId: context.workerId,
      workerGeneration: context.workerGeneration,
      inputSha256: digest(messages),
      modelIntentSha256: submission.modelIntentSha256,
      outputTokenCeiling: submission.outputTokenCeiling,
      reasoningTokenCeiling: submission.reasoningTokenCeiling,
      temperatureMilli: submission.temperatureMilli,
      requestBodyJson: JSON.stringify(remoteWorkerInferenceCanonicalRequestBody(submission)),
      requestSha256: remoteWorkerInferenceRequestSha256(submission),
    };
    const payloads: RemoteWorkerInferenceFramePayload[] = [
      {
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "output_text",
        text: index === 0 && !final ? "Reading." : "Orion 7",
      },
      {
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "terminal",
        terminalState: "completed",
        usageEventId,
        ...(index === 0 && !final ? { toolCalls: [call] } : {}),
      },
    ];
    let previous = REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256;
    const frames = payloads.map((payload, index) => {
      const material = {
        ...key,
        frameSequence: index + 1,
        frameKind: payload.kind,
        payloadSha256: remoteWorkerInferenceFramePayloadSha256(payload),
        previousFrameSha256: previous,
        effectiveRouteSha256: record.effectiveRouteSha256,
      };
      previous = remoteWorkerInferenceFrameSha256(material);
      return { ...material, frameSha256: previous, payloadJson: JSON.stringify(payload) };
    });
    return { record, frames };
  };
  const steps = [step(0, baseMessages), step(1, continued)];
  const inference = {
    listAssignmentChatRequests: vi.fn(async () => steps.map(step => step.record)),
    getRequestByIdempotency: vi.fn(
      async (_registry: string, key: string) => steps.find((step) => step.record.idempotencyKey === key)?.record,
    ),
    listFramesAfter: vi.fn(
      async (key: { inferenceRequestId: string }) =>
        steps.find((step) => step.record.inferenceRequestId === key.inferenceRequestId)?.frames ?? [],
    ),
  };
  return { inference, steps, continued, step };
}

describe("canonical worker model/tool sequence", () => {
  it.each(["metadata", "output"])("carries prior history and native %s through workload projection, the real worker input builder and canonical final output", async kind => {
    const f = fixture(), native = kind === "output" ? nativeChatOutputContextFixture() : nativeChatContextFixture();
    const workloadIdentity = { schemaVersion: REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
      registryWorkspaceId: scope.registryWorkspaceId, assignmentId: scope.assignmentId,
      assignmentManifestSha256: digest("manifest"), durableRunId: identity.durableRunId, durableRunVersion: 1,
      durableRunPayloadSha256: digest("payload"), capabilityProfileId: "profile", capabilityProfileSha256: context.profile.hashes.profileHash,
      contextSnapshotSha256: context.contextSha256, nativeContinuation: native.continuation, nativeChatContext: native };
    const workload = { ...workloadIdentity, workloadSha256: digest(workloadIdentity), payload: {
      capabilityProfileId: "profile", capabilityProfileHash: context.profile.hashes.profileHash,
      request: { content: "Read the note" } } };
    // This legacy fixture has one frozen user message; retain the same base on both owners.
    const nativeBase = [{ role: "user" as const, text: "Read the note" }];
    const localContext = { ...context, baseMessages: nativeBase };
    const old = f.step(0, nativeBase, undefined, true);
    f.steps.splice(0, f.steps.length, old);
    const storage = { remoteWorkerInference: f.inference,
      remoteWorkerAssignments: { findAssignmentAggregate: vi.fn(async () => ({
        assignment: { manifestSha256: workload.assignmentManifestSha256, manifest: { durableRunId: identity.durableRunId, taskId: context.taskId } },
        generation: { assignmentGeneration: 1, workerId: context.workerId, workerGeneration: context.workerGeneration },
      })) }, chatTurnCapabilityProfiles: { findByRun: vi.fn(async () => context.profile) } };
    const projected = await projectRemoteWorkerNativeChatWorkload(storage as never, workload as never, scope);
    const submission = buildWorkerInferenceSubmission(projected as never, { ...scope, leaseRevision: 2, leaseToken: "a".repeat(43) });
    if (kind === "output") {
      expect(submission.messages.at(-1)!.text).toContain("useful native output");
      expect(submission.messages.at(-1)!.role).toBe("user");
    }
    const sequence = { ...localContext, baseMessages: appendRemoteWorkerNativeChatContext(nativeBase, native),
      nativeContext: native, continuationSha256: remoteWorkerNativeChatContextSha256(native) };
    expect(await readCanonicalWorkerChatInput(f.inference as never, scope, 0, sequence)).toEqual(submission.messages);
    expect(projected.nativeChatHistory?.priorModelSteps).toBe(1);
    expect(submission.messages[1]).toEqual({ role: "assistant", text: "Orion 7" });
    f.steps.push(f.step(0, submission.messages, sequence.continuationSha256, true));
    expect(await readCanonicalWorkerChatOutput(f.inference as never, scope, sequence)).toMatchObject({
      text: "Orion 7", usageEventIds: ["usage-0", "native-usage-0"],
    });
    await expect(readCanonicalWorkerChatInput(f.inference as never, scope, 15, sequence)).rejects.toThrow("assignment-wide model step limit");
    expect(() => buildWorkerInferenceSubmission({ ...projected, nativeChatHistory: {
      ...projected.nativeChatHistory, messages: [{ role: "user", text: "substitute" }],
    } }, { ...scope, leaseRevision: 2, leaseToken: "a".repeat(43) })).toThrow();
  });

  it.each(["metadata", "output"])("preserves a prior native %s boundary and its model output across another native wake", async kind => {
    const f = fixture();
    const earlier = kind === "output" ? nativeChatOutputContextFixture("\u0001".repeat(32768)) : nativeChatContextFixture();
    const messages = appendRemoteWorkerNativeChatContext(f.continued, earlier);
    f.steps[1] = f.step(0, messages, remoteWorkerNativeChatContextSha256(earlier), true);
    const next = { ...earlier, continuation: { ...earlier.continuation, resumeSha256: digest("next-native-wake") } };
    const { history } = await readRemoteWorkerNativeChatHistory(f.inference as never, scope, context, next);
    expect(history.messages).toEqual([...messages, { role: "assistant", text: "Orion 7" }]);
    expect(history.priorModelSteps).toBe(2);
    expect(history.usageEventIds).toEqual(["usage-0", "native-usage-0"]);
  });

  it("reconstructs pre-native model and tool history with the consumed step count and usage", async () => {
    const f = fixture();
    const { history, toolIntentIds } = await readRemoteWorkerNativeChatHistory(f.inference as never, scope, context, nativeChatContextFixture());
    expect(history).toMatchObject({ messages: [...f.continued, { role: "assistant", text: "Orion 7" }],
      priorModelSteps: 2, priorRequestSha256s: f.steps.map(step => step.record.requestSha256),
      usageEventIds: ["usage-0", "usage-1"] });
    expect(toolIntentIds).toEqual(["intent-read"]);
  });

  it("withholds native history on missing, substituted or unsettled prior model records", async () => {
    for (const field of ["requestSha256", "inputSha256", "contextSha256", "workerId", "state", "budgetAuthorityState"] as const) {
      const f = fixture();
      Object.assign(f.steps[0]!.record, { [field]: "changed" });
      await expect(readRemoteWorkerNativeChatHistory(f.inference as never, scope, context, nativeChatContextFixture())).rejects.toThrow();
    }
    const f = fixture();
    f.steps.splice(0, 1);
    await expect(readRemoteWorkerNativeChatHistory(f.inference as never, scope, context, nativeChatContextFixture())).rejects.toThrow();
  });

  it("does not convert an unresolved earlier tool or oversized assignment inventory into native history", async () => {
    const f = fixture();
    vi.mocked(readCanonicalWorkerModelToolResult).mockResolvedValue({ ...result, status: "waiting_approval" });
    await expect(readRemoteWorkerNativeChatHistory(f.inference as never, scope, context, nativeChatContextFixture())).rejects.toThrow("unresolved tools");
    f.inference.listAssignmentChatRequests.mockResolvedValue(Array.from({ length: 17 }, () => f.steps[0]!.record));
    await expect(readRemoteWorkerNativeChatHistory(f.inference as never, scope, context, nativeChatContextFixture())).rejects.toThrow("assignment-wide model step limit");
  });

  it("reconstructs the exact next request and publishes only the final answer with every root usage identity", async () => {
    const f = fixture();
    expect(await readCanonicalWorkerChatInput(f.inference as never, scope, 1, context)).toEqual(f.continued);
    expect(await readCanonicalWorkerChatOutput(f.inference as never, scope, context)).toMatchObject({
      text: "Orion 7",
      usageEventIds: ["usage-0", "usage-1"],
      steps: [
        { record: f.steps[0]!.record, usageEventIds: ["usage-0"] },
        { record: f.steps[1]!.record, usageEventIds: ["usage-1"] },
      ],
    });
  });

  it("rejects forged history, step input, context or worker scope before publication", async () => {
    for (const [field, changed] of [
      ["inputSha256", digest("different input")],
      ["contextSha256", digest("different context")],
      ["workerGeneration", 9],
      ["taskId", "different-task"],
      ["attempt", 2],
    ] as const) {
      const f = fixture();
      Object.assign(f.steps[1]!.record, { [field]: changed });
      await expect(readCanonicalWorkerChatOutput(f.inference as never, scope, context)).rejects.toThrow();
    }
    const f = fixture();
    await expect(
      readCanonicalWorkerChatInput(f.inference as never, scope, 1, {
        ...context,
        baseMessages: [{ role: "user", text: "Replacement history" }],
      }),
    ).rejects.toThrow("canonical execution or input");
  });

  it("does not continue missing requests or unfinished tools", async () => {
    const f = fixture();
    vi.mocked(readCanonicalWorkerModelToolResult).mockResolvedValue({ ...result, status: "waiting_approval" });
    await expect(readCanonicalWorkerChatInput(f.inference as never, scope, 1, context)).rejects.toThrow(
      "unresolved tools",
    );
    vi.mocked(readCanonicalWorkerModelToolResult).mockResolvedValue(undefined);
    await expect(readCanonicalWorkerChatOutput(f.inference as never, scope, context)).rejects.toThrow(
      "unresolved tools",
    );
    f.steps.splice(0, 1);
    await expect(readCanonicalWorkerChatInput(f.inference as never, scope, 1, context)).rejects.toThrow(
      "settled canonical inference",
    );
  });

  it.each([
    "missing frame", "reordered frames", "changed text", "changed chain",
    "changed route", "unsettled budget", "changed usage", "missing terminal",
  ])("refuses publication with %s in retained inference", async corruption => {
    const f = fixture();
    const final = f.steps[1]!;
    switch (corruption) {
      case "missing frame": final.frames.pop(); break;
      case "reordered frames": final.frames.reverse(); break;
      case "changed text": {
        const payload = JSON.parse(final.frames[0]!.payloadJson);
        final.frames[0]!.payloadJson = JSON.stringify({ ...payload, text: "Substituted answer" });
        break;
      }
      case "changed chain": final.frames[1]!.previousFrameSha256 = digest("foreign frame"); break;
      case "changed route": final.record.effectiveRouteSha256 = digest("foreign route"); break;
      case "unsettled budget": final.record.budgetAuthorityState = "reserved"; break;
      case "changed usage": final.record.usageEventIdsJson = JSON.stringify(["foreign-usage"]); break;
      case "missing terminal": final.record.terminalFrameSequence = 3; break;
    }
    await expect(readCanonicalWorkerChatOutput(f.inference as never, scope, context)).rejects.toThrow();
  });

  it("rejects result drift and a request after the final answer", async () => {
    const f = fixture();
    vi.mocked(readCanonicalWorkerModelToolResult).mockResolvedValue({
      ...result,
      resultJson: '{"text":"substituted"}',
    });
    await expect(readCanonicalWorkerChatInput(f.inference as never, scope, 1, context)).rejects.toThrow(
      "result hash changed",
    );
    vi.mocked(readCanonicalWorkerModelToolResult).mockResolvedValue(result);
    await expect(readCanonicalWorkerChatInput(f.inference as never, scope, 2, context)).rejects.toThrow(
      "cannot authorize another model step",
    );
  });
});
