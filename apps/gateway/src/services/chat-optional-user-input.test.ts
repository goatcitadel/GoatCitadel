import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { createOptionalInputFixture } from "../../../../packages/storage/src/chat-optional-input-test-fixture.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { readChatOptionalInput, registerChatOptionalInput } from "./chat-optional-user-input.js";
import { buildDurableChatCanonicalWriteFence } from "./chat-turn-dispatch-service.js";

describe("optional Chat input storage bridge", () => {
  it("reads and answers an issued prompt through the async storage facade on its exact durable turn", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goat-optional-bridge-"));
    const raw = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    });
    try {
      const fixture = createOptionalInputFixture(raw.db);
      raw.db
        .prepare(
          `UPDATE durable_runs SET status = 'running', attempt_count = 1, lease_owner_id = 'worker-bridge',
        lease_expires_at = @expiresAt WHERE run_id = @runId`,
        )
        .run({ runId: fixture.runId, expiresAt: new Date(Date.now() + 300_000).toISOString() });
      raw.db
        .prepare(
          `UPDATE chat_turn_traces SET status = 'running', pending_user_input_json = NULL WHERE turn_id = @turnId`,
        )
        .run({ turnId: fixture.turnId });
      const storage = createSqliteAsyncStorage(raw);
      const admission = {
        identity: fixture.resolution.admissionIdentity,
        durableClaim: { durableRunId: fixture.runId, leaseOwnerId: "worker-bridge", attemptCount: 1 },
      };
      const canonicalWriteFence = buildDurableChatCanonicalWriteFence(
        {
          storage,
          sessionControlRuntimeOwner: {
            assertActiveTurnWrite: async () =>
              await storage.sessionMutationAdmissions.assertActiveTurnWrite({
                ...admission.identity,
                durableClaim: admission.durableClaim,
                requireExactDurablePayloadIdentity: true,
              }),
          },
        } as never,
        { turnId: fixture.turnId, turnAdmission: admission } as never,
        fixture.runId,
        { durableLeaseOwnerId: "worker-bridge", streamRegistration: { requireActive: () => undefined } as never },
      )!;
      const input = {
        mode: "chat",
        sessionId: fixture.resolution.admissionIdentity.sessionId,
        turnId: fixture.turnId,
        policyRunId: fixture.runId,
        canonicalWriteFence,
      } as ChatTurnAgentRunnerInput;
      const prompt = {
        promptId: fixture.resolution.promptId,
        turnId: fixture.turnId,
        kind: "text" as const,
        title: "Style",
        question: "Which style?",
        required: false,
        delivery: "background" as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      expect(await canonicalWriteFence(() => registerChatOptionalInput(storage, input, prompt))).toEqual(prompt);
      expect((await canonicalWriteFence(() => readChatOptionalInput(storage, input))).prompts).toEqual([prompt]);
      await storage.sessionMutationAdmissions.answerDurableChatOptionalInput({
        ...fixture.resolution,
        expectedWaitingRunVersion: 3,
      });
      expect((await canonicalWriteFence(() => readChatOptionalInput(storage, input))).replies).toHaveLength(1);
      expect((await storage.chatTurnTraces.get(fixture.turnId)).pendingUserInput).toBeUndefined();
      await expect(readChatOptionalInput(storage, { ...input, sessionId: "foreign" })).rejects.toThrow("binding");
      await expect(readChatOptionalInput(storage, { ...input, canonicalWriteFence: undefined })).rejects.toThrow(
        "durable",
      );
      await storage.durableRuns.updateRun({
        runId: fixture.runId,
        status: "running",
        expectedVersion: 4,
        leaseOwnerId: "takeover-worker",
      });
      await expect(canonicalWriteFence(() => readChatOptionalInput(storage, input))).rejects.toThrow();
    } finally {
      raw.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
