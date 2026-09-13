import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  appendRemoteWorkerChatToolResults,
  remoteWorkerChatInferenceIdentity,
  remoteWorkerInferenceCanonicalSha256 as digest,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  type RemoteWorkerInferenceFramePayload,
  type RemoteWorkerInferenceMessage,
} from "@goatcitadel/contracts";
import {
  readCanonicalWorkerChatInput,
  readCanonicalWorkerChatOutput,
  type RemoteWorkerChatSequenceContext,
} from "./remote-worker-chat-output-service.js";
import { readCanonicalWorkerModelToolResult } from "./remote-worker-chat-tool-result.js";

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
  profile: { identity, hashes: { profileHash: "a".repeat(64) } },
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
  const step = (index: number, messages: readonly RemoteWorkerInferenceMessage[]) => {
    const key = { ...scope, ...remoteWorkerChatInferenceIdentity(scope, index) };
    const usageEventId = `usage-${index}`;
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
    };
    const payloads: RemoteWorkerInferenceFramePayload[] = [
      {
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "output_text",
        text: index === 0 ? "Reading." : "Orion 7",
      },
      {
        schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
        kind: "terminal",
        terminalState: "completed",
        usageEventId,
        ...(index === 0 ? { toolCalls: [call] } : {}),
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
    getRequestByIdempotency: vi.fn(
      async (_registry: string, key: string) => steps.find((step) => step.record.idempotencyKey === key)?.record,
    ),
    listFramesAfter: vi.fn(
      async (key: { inferenceRequestId: string }) =>
        steps.find((step) => step.record.inferenceRequestId === key.inferenceRequestId)?.frames ?? [],
    ),
  };
  return { inference, steps, continued };
}

describe("canonical worker model/tool sequence", () => {
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
