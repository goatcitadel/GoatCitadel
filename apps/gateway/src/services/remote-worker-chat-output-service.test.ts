import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_INFERENCE_FRAME_GENESIS_SHA256,
  REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
  remoteWorkerInferenceFramePayloadSha256,
  remoteWorkerInferenceFrameSha256,
  remoteWorkerInferenceUsageEventIdsSha256,
  type RemoteWorkerInferenceFramePayload,
  type RemoteWorkerInferenceToolCall,
} from "@goatcitadel/contracts";
import { readCanonicalWorkerChatOutput } from "./remote-worker-chat-output-service.js";

function fixture(toolCalls?: readonly RemoteWorkerInferenceToolCall[]) {
  const scope = { registryWorkspaceId: "default", assignmentId: "assignment-1", assignmentGeneration: 1 };
  const key = { ...scope, inferenceRequestId: "inference-1", attempt: 1 };
  const record = {
    ...key,
    state: "completed",
    budgetAuthorityState: "settled",
    outputFrameCount: 2,
    terminalFrameSequence: 2,
    effectiveRouteSha256: "a".repeat(64),
    usageEventIdsJson: '["usage-1"]',
    usageEventIdsSha256: remoteWorkerInferenceUsageEventIdsSha256(["usage-1"]),
  };
  const payloads: RemoteWorkerInferenceFramePayload[] = [
    { schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION, kind: "output_text", text: "Verified response." },
    {
      schemaVersion: REMOTE_WORKER_INFERENCE_FRAME_SCHEMA_VERSION,
      kind: "terminal",
      terminalState: "completed",
      usageEventId: "usage-1",
      ...(toolCalls ? { toolCalls } : {}),
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
  const inference = { getRequestByIdempotency: vi.fn(async () => record), listFramesAfter: vi.fn(async () => frames) };
  return { scope, key, record, frames, inference };
}

describe("canonical worker Chat output", () => {
  it("refuses to publish a model response that still requires tool execution", async () => {
    const f = fixture([{ callId: "call-1", modelToolName: "fs_read", argumentsJson: "{}" }]);
    await expect(readCanonicalWorkerChatOutput(f.inference as never, f.scope)).rejects.toThrow("requires governed tool completion");
  });

  it("keeps upload and protected-authority objects out of the storage parameter binding", async () => {
    const { scope, key, inference } = fixture();
    const input = {
      ...scope,
      signal: new AbortController().signal,
      protectedAuthority: { secretFixtureMarker: "must-not-reach-query" },
      bytes: new Uint8Array([1, 2]),
    };
    expect(await readCanonicalWorkerChatOutput(inference as never, input)).toMatchObject({
      text: "Verified response.",
      usageEventIds: ["usage-1"],
    });
    expect(inference.listFramesAfter).toHaveBeenCalledExactlyOnceWith(key, 0);
  });

  it("rejects changed frame content and a terminal frame bound to another usage event", async () => {
    const corrupted = fixture();
    corrupted.frames[0]!.payloadJson = corrupted.frames[0]!.payloadJson.replace(
      "Verified response.",
      "Other response.",
    );
    await expect(readCanonicalWorkerChatOutput(corrupted.inference as never, corrupted.scope)).rejects.toThrow(
      "frame chain",
    );
    const wrongUsage = fixture();
    wrongUsage.record.usageEventIdsJson = '["usage-2"]';
    wrongUsage.record.usageEventIdsSha256 = remoteWorkerInferenceUsageEventIdsSha256(["usage-2"]);
    await expect(readCanonicalWorkerChatOutput(wrongUsage.inference as never, wrongUsage.scope)).rejects.toThrow(
      "no completed canonical response",
    );
  });
});
