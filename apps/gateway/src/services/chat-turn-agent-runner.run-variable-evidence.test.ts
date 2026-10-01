import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUN_VARIABLE_SCHEMA_VERSION,
  hashRunVariableSchema,
  type ChatCompletionResponse,
  type ChatSendMessageRequest,
  type ChatTurnTraceRecord,
  type RunVariableSchema,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { resolveChatRunVariableRequest } from "./chat-run-variable-service.js";
import { ChatTurnAgentRunner } from "./chat-turn-agent-runner.js";
import { freezeChatTurnExecutionRequest } from "./session-control-service.js";

const fixtures: Array<{ storage: AsyncStorage; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.storage.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-run-variable-trace-"));
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
  fixtures.push({ storage, directory });
  await storage.chatSessionMeta.ensure("session-variable", undefined, "workspace-variable");
  const schema: RunVariableSchema = {
    version: RUN_VARIABLE_SCHEMA_VERSION,
    fields: [
      { id: "topic", label: "Topic", type: "text", required: true },
      { id: "count", label: "Count", type: "number", required: true },
      { id: "concise", label: "Concise", type: "boolean", required: true },
    ],
  };
  const saved = await storage.promptPacks.replacePackTests({
    packId: "pack-variable",
    name: "Typed trace fixture",
    runVariableSchema: schema,
    tests: [
      {
        code: "TRACE",
        title: "Trace",
        prompt: "Explain {{topic}} in {{count}} points. Concise: {{concise}}.",
        orderIndex: 0,
      },
    ],
  });
  const request: ChatSendMessageRequest = {
    content: "Explain arithmetic in 2 points. Concise: true.",
    templateInvocation: {
      ownerKind: "prompt_pack",
      ownerId: saved.pack.packId,
      ownerRevision: saved.pack.updatedAt,
      templateId: saved.tests[0]!.testId,
      schemaHash: hashRunVariableSchema(schema),
      values: { topic: "arithmetic", count: 2, concise: true },
    },
  };
  return { storage, request };
}

async function execute(storage: AsyncStorage, request: ChatSendMessageRequest, rerouted: boolean) {
  const createChatCompletion = vi.fn(
    async (): Promise<ChatCompletionResponse> => ({
      model: rerouted ? "fixture-fallback-model" : "fixture-model",
      choices: [
        { index: 0, message: { role: "assistant", content: "Arithmetic combines numbers using defined operations." } },
      ],
      ...(rerouted
        ? { routing: { effectiveProviderId: "fixture-fallback", effectiveModel: "fixture-fallback-model" } }
        : {}),
    }),
  );
  const invokeTool = vi.fn(async () => {
    throw new Error("This fixture must not invoke tools.");
  });
  const runner = new ChatTurnAgentRunner({ storage, listToolCatalog: () => [], createChatCompletion, invokeTool });
  const traces: ChatTurnTraceRecord[] = [];
  for await (const chunk of runner.runStream({
    sessionId: "session-variable",
    workspaceId: "workspace-variable",
    turnId: "turn-variable",
    userMessageId: "message-variable",
    content: request.content,
    runVariableEvidence: request.runVariableEvidence,
    mode: "chat",
    providerId: "fixture-provider",
    model: "fixture-model",
    webMode: "off",
    memoryMode: "off",
    retrievalMode: "standard",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    historyMessages: [{ role: "user", content: request.content }],
  })) {
    if (chunk.type === "trace_update" && chunk.trace) traces.push(chunk.trace);
  }
  expect(createChatCompletion).toHaveBeenCalledTimes(1);
  expect(invokeTool).not.toHaveBeenCalled();
  return { traces, stored: await storage.chatTurnTraces.get("turn-variable") };
}

describe("typed invocation evidence through runner settlement", () => {
  it.each([false, true])(
    "retains resolved and frozen evidence in initial, terminal and stored traces (rerouted=%s)",
    async (rerouted) => {
      const { storage, request } = await createFixture();
      const resolved = await resolveChatRunVariableRequest(storage, "session-variable", request);
      const frozen = freezeChatTurnExecutionRequest(resolved);
      expect(frozen.templateInvocation).toEqual(request.templateInvocation);
      expect(frozen.runVariableEvidence).toEqual(resolved.runVariableEvidence);
      // Execution uses admitted values even if a caller's mutable input changes afterward.
      request.templateInvocation!.values.topic = "later draft";
      const { traces, stored } = await execute(storage, frozen, rerouted);
      expect(traces[0]?.routing.runVariables).toEqual(frozen.runVariableEvidence);
      expect(traces.at(-1)?.status).toBe("completed");
      expect(traces.at(-1)?.routing.runVariables).toEqual(frozen.runVariableEvidence);
      expect(stored.status).toBe("completed");
      expect(stored.routing.runVariables).toEqual(frozen.runVariableEvidence);
      expect(stored.routing.runVariables?.bindings).toEqual({ topic: "arithmetic", count: 2, concise: true });
      expect(stored.routing.effectiveProviderId).toBe(rerouted ? "fixture-fallback" : "fixture-provider");
      expect(stored.routing.effectiveModel).toBe(rerouted ? "fixture-fallback-model" : "fixture-model");
    },
  );

  it("does not invent template evidence for ordinary text", async () => {
    const { storage } = await createFixture();
    const resolved = await resolveChatRunVariableRequest(storage, "session-variable", {
      content: "Explain arithmetic.",
    });
    const { traces, stored } = await execute(storage, freezeChatTurnExecutionRequest(resolved), false);
    expect(stored.status).toBe("completed");
    expect(traces.every((trace) => trace.routing.runVariables === undefined)).toBe(true);
    expect(stored.routing.runVariables).toBeUndefined();
  });
});
