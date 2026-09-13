import { describe, expect, it } from "vitest";
import { canonicalJsonString, type RemoteWorkerChatToolResult } from "@goatcitadel/contracts";
import { projectWorkerChatToolResponse } from "./worker-chat-tool-execution.js";
import { sha256Utf8 } from "./connected-worker-routes.js";
import type { WorkerInferenceResult } from "./worker-inference-execution.js";

function fixture() {
  const selection = { kind: "chat.tool" as const, inferenceRequestId: "request-1", attempt: 1, callIndex: 0 };
  const inference: WorkerInferenceResult = {
    status: "requires_tools",
    lines: [],
    usageEventIds: ["usage-1"],
    requestSha256: "a".repeat(64),
    toolCalls: [{ callId: "call-1", modelToolName: "fs_read", argumentsJson: '{"path":"note.txt"}' }],
  };
  const tool: RemoteWorkerChatToolResult = {
    ...selection,
    status: "completed",
    requestSha256: inference.requestSha256,
    callId: "call-1",
    modelToolName: "fs_read",
    toolRunId: "remote-tool:intent-1",
    intentId: "intent-1",
    resultJson: '{"text":"Orion 7"}',
    resultSha256: sha256Utf8(canonicalJsonString({ text: "Orion 7" })),
  };
  return { selection, inference, body: { disposition: "chat_tool_recorded", tool } };
}

describe("worker model tool response binding", () => {
  it("accepts only the exact retained model call and hashed canonical result", () => {
    const f = fixture();
    expect(projectWorkerChatToolResponse(f.body, f.selection, f.inference)).toEqual(f.body.tool);
    for (const patch of [
      { attempt: 2 },
      { callIndex: 1 },
      { callId: "another" },
      { modelToolName: "fs_write" },
      { requestSha256: "b".repeat(64) },
      { intentId: "other" },
      { resultJson: '{"text":"Changed"}' },
      { resultJson: '"not an object"' },
      { resultJson: " ".repeat(65_537) },
      { status: "waiting_approval" },
      { status: "blocked" },
    ])
      expect(() =>
        projectWorkerChatToolResponse({ ...f.body, tool: { ...f.body.tool, ...patch } }, f.selection, f.inference),
      ).toThrow();
  });
  it("retains approval waits without exposing a successful result", () => {
    const f = fixture();
    const { resultJson, resultSha256, ...waiting } = f.body.tool;
    void resultJson;
    void resultSha256;
    expect(
      projectWorkerChatToolResponse(
        { ...f.body, tool: { ...waiting, status: "waiting_approval" } },
        f.selection,
        f.inference,
      ).status,
    ).toBe("waiting_approval");
  });
});
