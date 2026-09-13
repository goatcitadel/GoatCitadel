import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";
import {
  REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION,
  remoteWorkerChatInferenceMessages,
  sealRemoteWorkerChatContext,
  verifyRemoteWorkerChatContext,
  verifyRemoteWorkerChatContextBinding,
  trySealRemoteWorkerChatContextForTurn,
  sealRemoteWorkerChatContextForTurn,
  RemoteWorkerChatContextLimitError,
  REMOTE_WORKER_CHAT_CONTEXT_MAX_BYTES,
  type RemoteWorkerChatContextMaterial,
} from "./remote-worker-chat-context.js";
import { normalizeRemoteWorkerInferenceAuthorizedSubmission } from "./remote-worker-inference.js";

const hash = (value: unknown) => sha256Hex(canonicalJsonString(value));
const request = { content: "Use the attachment.", policyTaskId: "task-1" };
const admissionMaterialSha256 = hash({ version: 2, request });
const material: RemoteWorkerChatContextMaterial = {
  schemaVersion: REMOTE_WORKER_CHAT_CONTEXT_SCHEMA_VERSION,
  durableRunId: "run-1",
  admissionId: "admission-1",
  sessionIncarnationId: "incarnation-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  capabilityProfileId: "profile-1",
  capabilityProfileSha256: "a".repeat(64),
  requestMaterialSha256: hash({ version: 1, admissionMaterialSha256, request }),
  messages: [
    { role: "system", content: "Frozen guidance." },
    { role: "developer", content: "Preserve cafe\u0301 exactly." },
    { role: "user", content: "Read the previous result." },
    { role: "assistant", content: "The previous result was 7." },
    { role: "tool", name: "fs.read", tool_call_id: "call-1", content: [{ type: "text", text: "Prior tool result." }] },
    {
      role: "user",
      content: [
        { type: "text", text: request.content },
        { type: "image_url", image_url: { url: "data:image/png;base64,cHVibGlj" } },
      ],
    },
  ],
};

function payload() {
  return {
    version: "chat.turn.execute.v2",
    admissionId: material.admissionId,
    sessionIncarnationId: material.sessionIncarnationId,
    workspaceId: material.workspaceId,
    sessionId: material.sessionId,
    turnId: material.turnId,
    admissionMaterialSha256,
    admissionAggregateRevision: 1,
    admissionControllerGeneration: 1,
    effectiveRequestMaterialSha256: material.requestMaterialSha256,
    policyRunIdDerivation: { version: 1, kind: "durable_run_id", runId: material.durableRunId },
    requestActor: { actorId: "operator-a", actorKind: "operator" },
    capabilityProfileId: material.capabilityProfileId,
    capabilityProfileHash: material.capabilityProfileSha256,
    userMessageId: "user-1",
    assistantMessageId: "assistant-1",
    branchKind: "append",
    threadEventType: "chat_thread_turn_appended",
    request,
  };
}

describe("remote Chat context", () => {
  it("keeps oversized local input intact while refusing an incomplete worker snapshot", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(REMOTE_WORKER_CHAT_CONTEXT_MAX_BYTES) }];
    expect(() => sealRemoteWorkerChatContextForTurn(material.durableRunId, payload(), messages))
      .toThrow(RemoteWorkerChatContextLimitError);
    expect(trySealRemoteWorkerChatContextForTurn(material.durableRunId, payload(), messages)).toBeUndefined();
    expect(messages[0]!.content).toHaveLength(REMOTE_WORKER_CHAT_CONTEXT_MAX_BYTES);
    expect(trySealRemoteWorkerChatContextForTurn(material.durableRunId, payload(),
      Array.from({ length: 257 }, () => ({ role: "user" as const, content: "Previous message." }))))
      .toBeUndefined();
    expect(trySealRemoteWorkerChatContextForTurn(material.durableRunId, payload(), material.messages))
      .toEqual(sealRemoteWorkerChatContextForTurn(material.durableRunId, payload(), material.messages));
  });

  it("never converts invalid admission or message authority into a local placement fallback", () => {
    expect(() => trySealRemoteWorkerChatContextForTurn(material.durableRunId, { ...payload(), admissionId: "" },
      material.messages)).toThrow();
    expect(() => trySealRemoteWorkerChatContextForTurn(material.durableRunId, payload(), []))
      .toThrow("at least one message");
    expect(() => trySealRemoteWorkerChatContextForTurn(material.durableRunId, payload(),
      [{ role: "untrusted" as never, content: "message" }])).toThrow("Invalid remote Chat context message");
  });

  it("retains exact history, roles, Unicode, tool identities and structured attachment bytes", () => {
    const snapshot = sealRemoteWorkerChatContext(material);
    expect(verifyRemoteWorkerChatContextBinding(snapshot, payload())).toEqual(snapshot);
    expect(snapshot.messages).toEqual(material.messages);
    expect(Object.isFrozen(snapshot.messages.at(-1)?.content)).toBe(true);
    const messages = remoteWorkerChatInferenceMessages(snapshot);
    const normalized = normalizeRemoteWorkerInferenceAuthorizedSubmission({
      registryWorkspaceId: "workspace-1",
      assignmentId: "assignment-1",
      assignmentGeneration: 1,
      inferenceRequestId: "inference-1",
      attempt: 1,
      idempotencyKey: "inference:1",
      messages,
      inputSha256: hash(messages),
      contextSha256: snapshot.contextSha256,
      modelIntentSha256: "b".repeat(64),
      outputTokenCeiling: 100,
      reasoningTokenCeiling: 0,
      temperatureMilli: 0,
    });
    expect(
      normalized.messages.map((message) => ({
        role: message.role,
        content: message.parts ?? message.text,
        ...(message.name ? { name: message.name } : {}),
        ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      })),
    ).toEqual(material.messages);
  });

  it("rejects altered bytes, added configuration, foreign turns and a changed admitted request", () => {
    const snapshot = sealRemoteWorkerChatContext(material);
    expect(() =>
      verifyRemoteWorkerChatContext({ ...snapshot, messages: [{ role: "user", content: "different" }] }),
    ).toThrow(/hash/);
    expect(() =>
      verifyRemoteWorkerChatContext(Object.assign({}, snapshot, { providerId: "another-provider" })),
    ).toThrow(/Unsupported/);
    for (const change of [
      { sessionId: "other" },
      { turnId: "other" },
      { capabilityProfileHash: "c".repeat(64) },
      { request: { ...request, content: "different" } },
    ])
      expect(() => verifyRemoteWorkerChatContextBinding(snapshot, { ...payload(), ...change })).toThrow(
        /admitted durable turn/,
      );
  });

  it("rejects oversized, cyclic and executable content instead of changing it", () => {
    expect(() =>
      sealRemoteWorkerChatContext({ ...material, messages: [{ role: "user", content: "x".repeat(400_000) }] }),
    ).toThrow(/byte bound/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const part of [cyclic, { text: () => "x" }, new Date()])
      expect(() =>
        sealRemoteWorkerChatContext({
          ...material,
          messages: [{ role: "user", content: [part as Record<string, unknown>] }],
        }),
      ).toThrow();
  });
});
