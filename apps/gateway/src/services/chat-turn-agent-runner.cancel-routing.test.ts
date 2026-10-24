import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCompletionResponse, ChatTurnTraceRecord, RealtimeEvent } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { issueChatProviderFallbackAuthorization } from "./chat-provider-fallback-authority.js";
import { markChatTurnCancelled, type ChatTurnCancellationDeps } from "./chat-turn-cancellation.js";
import { ChatTurnAgentRunner, type ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import type { LlmDispatchGuard } from "./llm-dispatch-guard.js";

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

const PROMPT = "Write a numbered list of 300 harmless test words.";

/** Streams one delta, then the operator cancels and the provider aborts, as in the live C-02 task. */
async function runCancelledTurn(options: { fallbackAuthorized: boolean }) {
  const { storage } = await createFixture();
  const controller = new AbortController();
  let cancelled: ChatTurnTraceRecord | undefined;
  const createChatCompletionStream = vi.fn(async () =>
    (async function* () {
      yield { choices: [{ index: 0, delta: { content: "1. apple\n" } }] };
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
  const authorizeProviderFallback = vi.fn(async () =>
    issueChatProviderFallbackAuthorization({
      sessionId: "session-cancel",
      turnId: "turn-cancel",
      runId: "run-cancel",
      primary: { providerId: "claude-code-cli", model: "claude-sonnet-5-5" },
      fallback: { providerId: "fixture-fallback", model: "fixture-fallback-model" },
      allowLocalToCloud: false,
      revalidateBeforeFallback: async () => undefined,
      dispatchGuard: (async () => undefined) as unknown as LlmDispatchGuard,
    }),
  );
  const runner = new ChatTurnAgentRunner({
    storage,
    listToolCatalog: () => [],
    createChatCompletion: vi.fn(async (): Promise<ChatCompletionResponse> => {
      throw new Error("The streaming path must answer this turn.");
    }),
    createChatCompletionStream,
    invokeTool: vi.fn(async () => {
      throw new Error("This fixture must not invoke tools.");
    }),
    ...(options.fallbackAuthorized ? { authorizeProviderFallback } : {}),
  });
  const input: ChatTurnAgentRunnerInput = {
    sessionId: "session-cancel",
    workspaceId: "workspace-cancel",
    turnId: "turn-cancel",
    userMessageId: "message-cancel",
    content: PROMPT,
    mode: "chat",
    providerId: "claude-code-cli",
    model: "claude-sonnet-5-5",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    historyMessages: [{ role: "user", content: PROMPT }],
    signal: controller.signal,
    ...(options.fallbackAuthorized
      ? { canonicalDurableRunId: "run-cancel", canonicalWriteFence: async (work) => await work() }
      : {}),
  };

  const deltas: string[] = [];
  try {
    for await (const chunk of runner.runStream(input)) {
      if (chunk.type === "delta" && chunk.delta) deltas.push(chunk.delta);
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }
  if (options.fallbackAuthorized) expect(authorizeProviderFallback).toHaveBeenCalledTimes(1);
  expect(deltas.join("")).toContain("apple");
  expect(cancelled?.status).toBe("cancelled");
  const stored = await storage.chatTurnTraces.get("turn-cancel");
  expect(stored.status).toBe("cancelled");
  return [cancelled!, stored];
}

describe("a Chat turn cancelled mid-stream keeps its routing identity", () => {
  it("records the provider and model that streamed the partial text when no fallback can answer", async () => {
    for (const trace of await runCancelledTurn({ fallbackAuthorized: false })) {
      expect(trace.routing).toMatchObject({
        primaryProviderId: "claude-code-cli",
        primaryModel: "claude-sonnet-5-5",
        effectiveProviderId: "claude-code-cli",
        effectiveModel: "claude-sonnet-5-5",
      });
    }
  });

  it("keeps the requested route but does not guess the answering one when a fallback was authorized", async () => {
    for (const trace of await runCancelledTurn({ fallbackAuthorized: true })) {
      expect(trace.routing).toMatchObject({
        primaryProviderId: "claude-code-cli",
        primaryModel: "claude-sonnet-5-5",
      });
      expect(trace.routing.effectiveProviderId).toBeUndefined();
      expect(trace.routing.effectiveModel).toBeUndefined();
    }
  });
});
