import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS,
  appendRemoteWorkerChatToolResults,
  remoteWorkerChatInferenceIdentity,
  remoteWorkerChatInferenceStepIndex,
} from "./remote-worker-chat-workflow.js";
import {
  normalizeRemoteWorkerInferenceMessages,
  remoteWorkerInferenceCanonicalSha256 as digest,
} from "./remote-worker-inference.js";

const scope = { registryWorkspaceId: "registry", assignmentId: "assignment", assignmentGeneration: 2 };
const messages = [
  { role: "system" as const, text: "Frozen instructions" },
  { role: "user" as const, text: "Read the note" },
];
const call = { callId: "call-read", modelToolName: "fs_read", argumentsJson: ' {"path":"note.txt"} ' };
const response = { text: "Reading the note.", toolCalls: [call] };
const resultJson = ' {"text": "Orion 7"} ';
const result = {
  status: "completed" as const,
  callId: call.callId,
  modelToolName: call.modelToolName,
  resultJson,
  resultSha256: digest(JSON.parse(resultJson)),
};

describe("canonical worker Chat workflow", () => {
  it("keeps the original request identity and admits exactly the bounded canonical steps", () => {
    expect(remoteWorkerChatInferenceIdentity(scope, 0)).toEqual({
      inferenceRequestId: "worker-assignment",
      attempt: 1,
      idempotencyKey: "inference:assignment:2",
    });
    for (let step = 0; step < REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS; step++) {
      const identity = remoteWorkerChatInferenceIdentity(scope, step);
      expect(remoteWorkerChatInferenceStepIndex({ ...scope, ...identity })).toBe(step);
      expect(() => remoteWorkerChatInferenceStepIndex({ ...scope, ...identity, attempt: 2 })).toThrow();
      expect(() =>
        remoteWorkerChatInferenceStepIndex({ ...scope, ...identity, idempotencyKey: "other-key" }),
      ).toThrow();
    }
    for (const step of [-1, 0.5, NaN, REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS])
      expect(() => remoteWorkerChatInferenceIdentity(scope, step)).toThrow("bound");
  });

  it("preserves admitted history, provider argument bytes and the exact settled result", () => {
    const next = appendRemoteWorkerChatToolResults(messages, response, [result]);
    expect(messages).toHaveLength(2);
    expect(next).toEqual([
      ...messages,
      { role: "assistant", text: response.text, toolCalls: [call] },
      { role: "tool", text: resultJson, tool_call_id: call.callId },
    ]);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next[2]!.toolCalls![0])).toBe(true);
    expect(digest(next)).not.toBe(digest(messages));
  });

  it("rejects missing, pending, substituted, reordered or oversized tool results", () => {
    expect(() => appendRemoteWorkerChatToolResults(messages, response, [])).toThrow("inventory");
    for (const changed of [
      { ...result, status: "waiting_approval" as const },
      { ...result, callId: "other-call" },
      { ...result, modelToolName: "other_tool" },
      { ...result, resultJson: '{"text":"changed"}' },
      { ...result, resultJson: "[]", resultSha256: digest([]) },
      { ...result, resultJson: "x".repeat(65_537) },
    ])
      expect(() => appendRemoteWorkerChatToolResults(messages, response, [changed])).toThrow();
    const second = { ...call, callId: "second" };
    expect(() =>
      appendRemoteWorkerChatToolResults(messages, { ...response, toolCalls: [call, second] }, [
        { ...result, callId: second.callId },
        result,
      ]),
    ).toThrow("exact completed");
  });

  it("rejects tool call identities reused by a later model step", () => {
    const next = appendRemoteWorkerChatToolResults(messages, response, [result]);
    expect(() => appendRemoteWorkerChatToolResults(next, response, [result])).toThrow("repeats an earlier step");
  });

  it("only admits tool-call history on assistant messages without new authority fields", () => {
    for (const entry of [
      { role: "user", text: "input", toolCalls: [call] },
      { role: "assistant", text: "", toolCalls: [call], tool_call_id: call.callId },
      { role: "assistant", text: "", toolCalls: [call], approved: true },
    ])
      expect(() => normalizeRemoteWorkerInferenceMessages([entry])).toThrow();
  });
});
