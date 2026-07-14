import { describe, expect, it } from "vitest";
import type { DurableRunRecord } from "@goatcitadel/contracts";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { assertDurableChatCapabilityProfileBinding, parseDurableChatTurnPayload } from "./durable-execution-service.js";

function prepared(profile?: { profileId: string; profileHash: string; durableRunId?: string }) {
  return {
    ...(profile
      ? {
          capabilityProfile: {
            profileId: profile.profileId,
            hashes: { profileHash: profile.profileHash },
            identity: { durableRunId: profile.durableRunId },
          },
        }
      : {}),
  } as unknown as Pick<PreparedAgentChatTurn, "capabilityProfile">;
}

describe("durable Chat capability profile binding", () => {
  it("accepts only an exact profile id, hash, and durable-run binding", () => {
    const hash = "a".repeat(64);
    expect(() =>
      assertDurableChatCapabilityProfileBinding(
        "run-1",
        { capabilityProfileId: "profile-1", capabilityProfileHash: hash },
        prepared({ profileId: "profile-1", profileHash: hash, durableRunId: "run-1" }),
      ),
    ).not.toThrow();

    for (const candidate of [
      prepared(),
      prepared({ profileId: "profile-other", profileHash: hash, durableRunId: "run-1" }),
      prepared({ profileId: "profile-1", profileHash: "b".repeat(64), durableRunId: "run-1" }),
      prepared({ profileId: "profile-1", profileHash: hash, durableRunId: "run-other" }),
    ]) {
      expect(() =>
        assertDurableChatCapabilityProfileBinding(
          "run-1",
          { capabilityProfileId: "profile-1", capabilityProfileHash: hash },
          candidate,
        ),
      ).toThrow(/malformed or missing bound capability profile/);
    }
  });

  it("keeps profile-less historical payloads on the explicit legacy path", () => {
    expect(() => assertDurableChatCapabilityProfileBinding("legacy-run", {}, prepared())).not.toThrow();
  });

  it("rejects malformed payloads that carry only one capability reference", () => {
    const base = {
      version: "chat.turn.execute.v1",
      sessionId: "session-1",
      turnId: "turn-1",
      userMessageId: "message-1",
      assistantMessageId: "assistant-1",
      branchKind: "append",
      threadEventType: "chat_thread_turn_appended",
      request: { content: "Resume exactly." },
    };
    const run = (payload: Record<string, unknown>) =>
      ({
        runId: "run-1",
        workflowKey: "chat.turn.execute",
        status: "queued",
        attemptCount: 0,
        maxAttempts: 3,
        version: 1,
        payload,
        metadata: {},
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      }) as DurableRunRecord;
    expect(parseDurableChatTurnPayload(run({ ...base, capabilityProfileId: "profile-1" }))).toBeUndefined();
    expect(parseDurableChatTurnPayload(run({ ...base, capabilityProfileHash: "a".repeat(64) }))).toBeUndefined();
  });
});
