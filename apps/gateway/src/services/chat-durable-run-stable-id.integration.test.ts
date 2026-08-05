import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ChatSendMessageRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { beginDurableChatRun } from "./chat-durable-run-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { DurableRunService } from "./durable-run-service.js";
import type { ServiceContext } from "./service-context.js";

describe("stable durable delegated Chat run identity", () => {
  it("converges repeated begin calls on one real durable row and one provider-processing identity", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-stable-durable-chat-"));
    const storage = new Storage({
      dbPath: path.join(root, "gateway.db"),
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    });
    try {
      const asyncStorage = createSqliteAsyncStorage(storage);
      const durableRunService = new DurableRunService({
        storage: asyncStorage,
        requireFeatureEnabled: vi.fn(),
        publishRealtime: vi.fn(),
      } as unknown as ServiceContext);
      const processingRunIds = new Set<string>();
      let providerExecutions = 0;
      const deps = {
        shouldUseDurableExecution: true,
        createDurableRun: (input: Parameters<DurableRunService["createDurableRun"]>[0]) =>
          durableRunService.createDurableRun(input, {
            publishRealtime: false,
            idempotentIfExists: true,
          }),
        buildDurablePayloadRecord: () => ({
          version: "chat.turn.execute.v1",
          sessionId: "session-stable",
          turnId: "turn-stable",
          request: { content: "Run stable child work" },
        }),
        persistChatStreamChunk: vi.fn(),
        requestDurableRunProcessing: (runId: string) => {
          if (!processingRunIds.has(runId)) {
            processingRunIds.add(runId);
            providerExecutions += 1;
          }
        },
      };
      const prepared = {
        session: { sessionId: "session-stable" },
        content: "Run stable child work",
        userEventId: "user-stable",
        assistantMessageId: "assistant-stable",
        turnId: "turn-stable",
        branchKind: "append",
        prefs: { mode: "chat" },
        normalized: { mode: "chat" },
      } as PreparedAgentChatTurn;
      const request = { content: "Run stable child work", mode: "chat" } as ChatSendMessageRequest;

      const first = await beginDurableChatRun(deps, prepared, request, "chat_thread_turn_appended", {
        runId: "durable-chat-stable",
      });
      const duplicate = await beginDurableChatRun(deps, prepared, request, "chat_thread_turn_appended", {
        runId: "durable-chat-stable",
      });

      expect(first?.runId).toBe("durable-chat-stable");
      expect(duplicate?.runId).toBe(first?.runId);
      expect(storage.durableRuns.listRuns(20).filter((run) => run.runId === "durable-chat-stable")).toHaveLength(1);
      expect(storage.durableRuns.listCheckpoints("durable-chat-stable")).toHaveLength(1);
      expect(processingRunIds).toEqual(new Set(["durable-chat-stable"]));
      expect(providerExecutions).toBe(1);

      await expect(
        durableRunService.createDurableRun(
          {
            runId: "durable-chat-stable",
            workflowKey: "chat.turn.execute",
            payload: { conflicting: true },
          },
          { publishRealtime: false, idempotentIfExists: true },
        ),
      ).rejects.toThrow(/different immutable workflow payload/);
    } finally {
      storage.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
