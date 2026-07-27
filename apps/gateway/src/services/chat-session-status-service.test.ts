import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { ChatSessionStatusService } from "./chat-session-status-service.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-chat-status-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  storage.chatSessionMeta.ensure("session-1", "2026-07-27T00:00:00.000Z", "workspace-1");
  storage.chatSessionPrefs.ensure("session-1", "2026-07-27T00:00:00.000Z");
  storage.chatSessionPrefs.patch("session-1", { providerId: "openai", model: "gpt-status" });
  const service = new ChatSessionStatusService({
    storage,
    getModelContextWindow: () => 128_000,
    getRuntimeIdentity: () => ({
      schemaVersion: 1,
      kind: "development",
      version: "1.0.0",
      integrity: "unknown",
      identitySource: "unavailable",
      release: {
        verified: false,
        certificateState: "absent",
        requiredProof: { total: 0, passed: 0, missing: 0, failed: 0, stale: 0 },
        acceptedFailureCount: 0,
        acceptedFailures: [],
        certificateAttestation: { status: "not_applicable" },
        runtimePayloadIntegrity: { status: "not_applicable" },
        reasonCodes: ["identity_sha_unavailable"],
        reasons: ["identity unavailable"],
      },
    }),
    now: () => "2026-07-27T01:00:00.000Z",
  });
  return { storage, service };
}

describe("ChatSessionStatusService", () => {
  it("aggregates trace, attention, context, usage, and unavailable evidence without inventing health", () => {
    const { storage, service } = harness();
    storage.chatTurnTraces.create({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "message-1",
      mode: "chat",
      webMode: "off",
      memoryMode: "auto",
      thinkingLevel: "standard",
      status: "waiting_for_user_input",
      routing: { effectiveProviderId: "anthropic", effectiveModel: "claude-status" },
      pendingUserInput: {
        promptId: "prompt-1",
        turnId: "turn-1",
        kind: "text",
        title: "Need input",
        question: "Continue?",
        required: true,
      },
      startedAt: "2026-07-27T00:30:00.000Z",
    });
    storage.approvals.create({
      kind: "tool.invoke",
      riskLevel: "caution",
      payload: {},
      preview: {},
      linkage: { sessionId: "session-1", turnId: "turn-1", workspaceId: "workspace-1" },
    });

    const status = service.getOperatorStatus("session-1");

    expect(status.model).toEqual({
      availability: "available",
      value: { providerId: "anthropic", model: "claude-status", selectionSource: "turn_trace" },
    });
    expect(status.context).toMatchObject({
      availability: "available",
      value: { contextWindowTokens: 128_000, attachmentCount: 0 },
    });
    expect(status.work).toMatchObject({
      availability: "available",
      value: { turnCounts: { waiting_for_user_input: 1 } },
    });
    expect(status.attention.availability === "available" && status.attention.value.pendingApprovals).toHaveLength(1);
    expect(status.attention.availability === "available" && status.attention.value.pendingUserInputs).toHaveLength(1);
    expect(status.capabilities).toMatchObject({ availability: "unavailable" });
    expect(status.build).toMatchObject({ availability: "unavailable" });
    expect(status.usage).toMatchObject({ availability: "available", value: { attemptCount: 0 } });
  });

  it("returns a smaller model-safe projection without workspace or attention identifiers", () => {
    const { service } = harness();
    const projection = service.getModelProjection("session-1");
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("workspace-1");
    expect(projection.context).toMatchObject({ availability: "available", value: { contextWindowTokens: 128_000 } });
    expect(projection.attention).toEqual({
      availability: "available",
      value: { pendingApprovalCount: 0, pendingUserInputCount: 0 },
    });
  });

  it("denies unknown sessions", () => {
    const { service } = harness();
    expect(() => service.getOperatorStatus("missing")).toThrow("Chat session missing not found");
  });
});
