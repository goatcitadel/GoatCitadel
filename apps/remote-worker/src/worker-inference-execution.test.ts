import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  sealRemoteWorkerChatContextForTurn,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";
import {
  buildWorkerInferenceSubmission,
  projectWorkerInferenceResponse,
  workerInferenceRequestHash,
} from "./worker-inference-execution.js";
import { sha256Utf8 } from "./connected-worker-routes.js";
const lease = {
  registryWorkspaceId: "default",
  assignmentId: "task-1",
  assignmentGeneration: 1,
  leaseRevision: 1,
  leaseToken: "a".repeat(43),
};
const workloadIdentity = {
  schemaVersion: REMOTE_WORKER_ASSIGNMENT_WORKLOAD_SCHEMA_VERSION,
  registryWorkspaceId: "default",
  assignmentId: "task-1",
  assignmentManifestSha256: "a".repeat(64),
  durableRunId: "durable-1",
  durableRunVersion: 1,
  durableRunPayloadSha256: "c".repeat(64),
  capabilityProfileId: "profile-1",
  capabilityProfileSha256: "e".repeat(64),
  contextSnapshotSha256: "b".repeat(64),
};
const workload = {
  ...workloadIdentity,
  workloadSha256: sha256Utf8(canonicalJsonString(workloadIdentity)),
  payload: {
    capabilityProfileId: workloadIdentity.capabilityProfileId,
    capabilityProfileHash: workloadIdentity.capabilityProfileSha256,
    request: { content: "Summarize the accepted task." },
  },
};
function admittedWorkload() {
  const request = { ...workload.payload.request, policyTaskId: "task-1" };
  const admissionMaterialSha256 = sha256Utf8(canonicalJsonString({ version: 2, request }));
  const payload = {
    version: "chat.turn.execute.v2",
    admissionId: "admission-1",
    sessionIncarnationId: "incarnation-1",
    workspaceId: "default",
    sessionId: "session-1",
    turnId: "turn-1",
    admissionMaterialSha256,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    effectiveRequestMaterialSha256: sha256Utf8(canonicalJsonString({ version: 1, admissionMaterialSha256, request })),
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: workload.durableRunId },
    requestActor: { actorId: "operator-a", actorKind: "operator" },
    capabilityProfileId: workload.capabilityProfileId,
    capabilityProfileHash: workload.capabilityProfileSha256,
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
  const chatContext = sealRemoteWorkerChatContextForTurn(workload.durableRunId, payload, [
    { role: "system", content: "Use the frozen workspace instructions." },
    { role: "user", content: "The project is cafe\u0301." },
    { role: "assistant", content: "I will preserve the project name." },
    { role: "tool", name: "fs.read", tool_call_id: "call-1", content: "Version 7." },
    {
      role: "user",
      content: [
        { type: "text", text: request.content },
        { type: "image_url", image_url: { url: "data:image/png;base64,cHVibGlj" } },
      ],
    },
  ]);
  const identity = {
    ...workloadIdentity,
    durableRunPayloadSha256: sha256Utf8(canonicalJsonString(payload)),
    contextSnapshotSha256: chatContext.contextSha256,
  };
  return { ...identity, payload, chatContext, workloadSha256: sha256Utf8(canonicalJsonString(identity)) };
}
function result(toolCalls?: readonly RemoteWorkerInferenceToolCall[]) {
  const submission = buildWorkerInferenceSubmission(workload, lease);
  const route = "d".repeat(64);
  let previous = "0".repeat(64);
  const payloads = [
    {
      schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
      kind: "output_text" as const,
      text: "The accepted task is summarized.",
    },
    {
      schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
      kind: "terminal" as const,
      terminalState: "completed" as const,
      usageEventId: "gateway-usage-1",
      ...(toolCalls ? { toolCalls } : {}),
    },
  ];
  const frames = payloads.map((payload, index) => {
    const payloadSha256 = remoteWorkerInferenceFramePayloadSha256(payload);
    const frame = {
      frameSequence: index + 1,
      frameKind: payload.kind,
      payloadJson: canonicalJsonString(payload),
      payloadSha256,
      previousFrameSha256: previous,
      frameSha256: remoteWorkerInferenceFrameSha256({
        ...submission,
        frameSequence: index + 1,
        frameKind: payload.kind,
        payloadSha256,
        previousFrameSha256: previous,
        effectiveRouteSha256: route,
      }),
    };
    previous = frame.frameSha256;
    return frame;
  });
  return {
    submission,
    body: {
      disposition: "delivered",
      request: {
        registryWorkspaceId: submission.registryWorkspaceId,
        assignmentId: submission.assignmentId,
        assignmentGeneration: 1,
        inferenceRequestId: submission.inferenceRequestId,
        attempt: 1,
        state: "completed",
        requestSha256: workerInferenceRequestHash(submission),
        effectiveRouteSha256: route,
        usageEventIds: ["gateway-usage-1"],
        usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256(["gateway-usage-1"]),
      },
      frames,
    },
  };
}
describe("worker inference execution", () => {
  it("retains verified tool requests without treating interim text as a completed task", () => {
    const toolCalls = [{ callId: "call-1", modelToolName: "fs_read", argumentsJson: '{"path":"note.txt"}' }];
    const f = result(toolCalls);
    const projected = projectWorkerInferenceResponse(f.body, f.submission);
    expect(projected).toMatchObject({ status: "requires_tools", toolCalls, usageEventIds: ["gateway-usage-1"] });
    const terminal = f.body.frames.at(-1)!;
    terminal.payloadJson = terminal.payloadJson.replace("note.txt", "other.txt");
    expect(() => projectWorkerInferenceResponse(f.body, f.submission)).toThrow(/hash/);
  });

  it("carries the admitted history, tool identity and structured attachment without rewriting it", () => {
    const admitted = admittedWorkload();
    const submission = buildWorkerInferenceSubmission(admitted, lease);
    expect(
      submission.messages.map((message) => ({
        role: message.role,
        content: message.parts ?? message.text,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
    ).toEqual(admitted.chatContext.messages);
    expect(submission.contextSha256).toBe(admitted.chatContext.contextSha256);
    expect(submission.inputSha256).toBe(sha256Utf8(canonicalJsonString(submission.messages)));
  });

  it("rejects missing, altered, substituted and cross-turn context before submitting inference", () => {
    const admitted = admittedWorkload();
    expect(() => buildWorkerInferenceSubmission({ ...admitted, chatContext: undefined }, lease)).toThrow(
      /context snapshot/,
    );
    expect(() =>
      buildWorkerInferenceSubmission(
        {
          ...admitted,
          chatContext: {
            ...admitted.chatContext,
            messages: [{ role: "user", content: "Replacement input." }],
          },
        },
        lease,
      ),
    ).toThrow(/hash/);
    const changedContext = sealRemoteWorkerChatContextForTurn(admitted.durableRunId, admitted.payload, [
      { role: "user", content: admitted.payload.request.content },
    ]);
    expect(() => buildWorkerInferenceSubmission({ ...admitted, chatContext: changedContext }, lease)).toThrow(
      /workload identity/,
    );
    expect(() =>
      buildWorkerInferenceSubmission({ ...admitted, payload: { ...admitted.payload, turnId: "another-turn" } }, lease),
    ).toThrow(/admitted durable turn/);
  });

  it("uses the accepted request and only returns verified provider output with canonical usage", () => {
    const { submission, body } = result();
    expect(submission.messages).toEqual([{ role: "user", text: "Summarize the accepted task." }]);
    expect(projectWorkerInferenceResponse(body, submission)).toMatchObject({
      status: "completed",
      lines: ["The accepted task is summarized."],
      usageEventIds: ["gateway-usage-1"],
    });
    expect(workerInferenceRequestHash({ ...submission, leaseToken: "b".repeat(43) })).toBe(body.request.requestSha256);
  });
  it("rejects cross-assignment, changed payload, reordered frames, missing completion and overlong input", () => {
    const { submission, body } = result();
    expect(() => buildWorkerInferenceSubmission({ ...workload, assignmentId: "other" }, lease)).toThrow(/assignment/);
    expect(() => buildWorkerInferenceSubmission({ ...workload, durableRunId: "other" }, lease)).toThrow(/hash/);
    expect(() =>
      buildWorkerInferenceSubmission({ ...workload, capabilityProfileSha256: "f".repeat(64) }, lease),
    ).toThrow(/assignment/);
    expect(() =>
      buildWorkerInferenceSubmission({ ...workload, payload: { request: { content: "x".repeat(64001) } } }, lease),
    ).toThrow(/bounded/);
    expect(() =>
      projectWorkerInferenceResponse({ ...body, request: { ...body.request, assignmentId: "other" } }, submission),
    ).toThrow(/bind/);
    expect(() => projectWorkerInferenceResponse({ ...body, frames: [...body.frames].reverse() }, submission)).toThrow(
      /order/,
    );
    expect(() => projectWorkerInferenceResponse({ ...body, frames: body.frames.slice(0, 1) }, submission)).toThrow(
      /completed/,
    );
    expect(() =>
      projectWorkerInferenceResponse(
        { ...body, frames: [{ ...body.frames[0], payloadSha256: "f".repeat(64) }, body.frames[1]] },
        submission,
      ),
    ).toThrow(/hash/);
  });
  it("parks pending approvals and exposes no partial output as success", () => {
    const { submission, body } = result();
    expect(projectWorkerInferenceResponse({ ...body, disposition: "waiting_approval" }, submission)).toMatchObject({
      status: "waiting",
      lines: [],
    });
    expect(projectWorkerInferenceResponse({ ...body, disposition: "dispatch_unknown" }, submission)).toMatchObject({
      status: "blocked",
      lines: [],
    });
  });

  it("retains every provider retry and rejects missing, changed or mismatched usage evidence", () => {
    const { submission, body } = result();
    const usageEventIds = ["gateway-output-cap-attempt", "gateway-usage-1"];
    const request = {
      ...body.request,
      usageEventIds,
      usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256(usageEventIds),
    };
    expect(projectWorkerInferenceResponse({ ...body, request }, submission).usageEventIds).toEqual(usageEventIds);
    expect(() =>
      projectWorkerInferenceResponse(
        {
          ...body,
          request: {
            ...request,
            usageEventIdsSha256: "f".repeat(64),
          },
        },
        submission,
      ),
    ).toThrow(/hash/);
    expect(() =>
      projectWorkerInferenceResponse(
        {
          ...body,
          request: {
            ...request,
            usageEventIds: undefined,
          },
        },
        submission,
      ),
    ).toThrow(/usage/);
    const reversed = [...usageEventIds].reverse();
    expect(() =>
      projectWorkerInferenceResponse(
        {
          ...body,
          request: {
            ...request,
            usageEventIds: reversed,
            usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256(reversed),
          },
        },
        submission,
      ),
    ).toThrow(/canonical usage/);
  });
});
