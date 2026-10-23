import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ChatTurnTraceRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { markChatTurnCancelled, type ChatTurnCancellationDeps } from "./chat-turn-cancellation.js";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";

const fixtures: Array<{ storage: AsyncStorage; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.storage.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

// Returned inside an object: awaiting the storage proxy itself would treat it as a thenable.
async function createFixture(): Promise<{ storage: AsyncStorage }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-cancel-routing-"));
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
  fixtures.push({ storage, directory });
  await storage.chatSessionMeta.ensure("session-cancel", undefined, "workspace-cancel");
  return { storage };
}

function createCancellationDeps(storage: AsyncStorage): ChatTurnCancellationDeps {
  return {
    storage,
    getActiveChatTurnStream: () => undefined,
    parseDurableChatTurnPayload: () => undefined,
    createHydratedChatTurnTrace: async (_turnId, trace) => trace,
    recordDevDiagnostic: vi.fn(),
    publishRealtime: vi.fn(async () => ({}) as RealtimeEvent),
  };
}

describe("a Chat turn cancelled mid-stream keeps its routing identity", () => {
  it("records the provider and model that streamed the partial text", async () => {
    const { storage } = await createFixture();
    const controller = new AbortController();
    let cancelled: ChatTurnTraceRecord | undefined;
    const createChatCompletionStream = vi.fn(async () =>
      (async function* () {
        yield { choices: [{ index: 0, delta: { content: "1. apple\n" } }] };
        // The operator cancels after the first delta; the provider then aborts.
        cancelled = await markChatTurnCancelled(
          createCancellationDeps(storage),
          "session-cancel",
          "turn-cancel",
          "operator",
        );
        controller.abort();
        const abort = new Error("Chat turn cancelled.");
        abort.name = "AbortError";
        throw abort;
      })(),
    );
    const createChatCompletion = vi.fn(async (): Promise<ChatCompletionResponse> => {
      throw new Error("The streaming path must answer this turn.");
    });
    const runner = new ChatTurnAgentRunner({
      storage,
      listToolCatalog: () => [],
      createChatCompletion,
      createChatCompletionStream,
      invokeTool: vi.fn(async () => {
        throw new Error("This fixture must not invoke tools.");
      }),
    });

    const deltas: string[] = [];
    try {
      for await (const chunk of runner.runStream({
        sessionId: "session-cancel",
        workspaceId: "workspace-cancel",
        turnId: "turn-cancel",
        userMessageId: "message-cancel",
        content: "Write a numbered list of 300 harmless test words.",
        mode: "chat",
        providerId: "claude-code-cli",
        model: "claude-sonnet-5-5",
        webMode: "off",
        memoryMode: "off",
        retrievalMode: "standard",
        thinkingLevel: "standard",
        toolAutonomy: "manual",
        historyMessages: [{ role: "user", content: "Write a numbered list of 300 harmless test words." }],
        signal: controller.signal,
      })) {
        if (chunk.type === "delta" && chunk.delta) deltas.push(chunk.delta);
      }
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    }

    expect(deltas.join("")).toContain("apple");
    expect(cancelled?.status).toBe("cancelled");
    const stored = await storage.chatTurnTraces.get("turn-cancel");
    expect(stored.status).toBe("cancelled");
    for (const trace of [cancelled!, stored]) {
      expect(trace.routing).toMatchObject({
        primaryProviderId: "claude-code-cli",
        primaryModel: "claude-sonnet-5-5",
        effectiveProviderId: "claude-code-cli",
        effectiveModel: "claude-sonnet-5-5",
      });
    }
  });
});
