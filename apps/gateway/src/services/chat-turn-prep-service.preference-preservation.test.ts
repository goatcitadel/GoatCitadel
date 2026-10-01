import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessageRecord, ChatSendMessageRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { prepareAgentChatTurn, type ChatTurnPrepHost } from "./chat-turn-prep-service.js";
import { freezeChatTurnExecutionRequest } from "./session-control-service.js";

const SESSION_ID = "session-preserved-prefs";
const fixtures: Array<{ storage: AsyncStorage; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.storage.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

async function createFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "goat-prep-prefs-"));
  const storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(directory, "transcripts"),
      auditDir: path.join(directory, "audit"),
    }),
  );
  fixtures.push({ storage, directory });
  await storage.sessions.upsert({
    sessionId: SESSION_ID,
    sessionKey: "mission:operator:prefs",
    kind: "dm",
    channel: "mission",
    account: "operator",
    timestamp: "2026-09-30T00:00:00.000Z",
  });
  await storage.chatSessionMeta.ensure(SESSION_ID, undefined, "default");
  await storage.chatSessionPrefs.patch(SESSION_ID, {
    mode: "chat",
    providerId: "fixture-provider",
    model: "fixture-model",
    thinkingLevel: "extended",
    webMode: "auto",
    memoryMode: "auto",
    codeAutoApply: "aggressive_auto",
    orchestrationIntensity: "balanced",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    toolAutonomy: "manual",
  });
  await storage.sessionAutonomyPrefs.patch(SESSION_ID, {
    proactiveMode: "off",
    maxActionsPerHour: 3,
    maxActionsPerTurn: 1,
    cooldownSeconds: 120,
    retrievalMode: "layered",
  });
  const userMessage: ChatMessageRecord = {
    messageId: "message-prefs",
    sessionId: SESSION_ID,
    role: "user",
    actorType: "user",
    actorId: "operator",
    sourceAuthority: "operator",
    content: "Explain integer addition briefly.",
    timestamp: "2026-09-30T00:00:01.000Z",
  };
  const host: ChatTurnPrepHost = {
    storage,
    llmService: {
      getRuntimeConfig: () => {
        throw new Error("Provider discovery is outside this preference regression.");
      },
      getModelContextWindow: () => 128_000,
    },
    getSession: (sessionId) => storage.sessions.getBySessionId(sessionId),
    ensureChatSessionRuntimeGrants: async () => undefined,
    maybeAutoTitleChatSession: async () => undefined,
    normalizeWorkspaceId: (workspaceId) => workspaceId ?? "default",
    routeFromSession: (session) => ({ channel: session.channel, account: session.account }),
    ingestEvent: async () => {
      throw new Error("The admitted user message already exists.");
    },
    patchSessionAutonomyPrefs: (sessionId, input) => storage.sessionAutonomyPrefs.patch(sessionId, input),
    ensureChatSessionModelDefaults: (_sessionId, prefs) => prefs,
    getSessionAutonomyPrefs: (sessionId) => storage.sessionAutonomyPrefs.ensure(sessionId),
    buildDefaultChatPersonalityOverlay: async () => undefined,
    resolveRuntimeGuidance: async (workspaceId) => ({
      workspaceId,
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    }),
    resolveThreadKnowledgeContext: async () => ({ citations: [], attachments: [] }),
    loadChatTurnSessionState: async () => ({
      traces: [],
      tracesById: new Map(),
      turnLineageById: new Map(),
      messages: [userMessage],
      messagesById: new Map([[userMessage.messageId, userMessage]]),
      childrenByTurnId: new Map(),
    }),
    buildLlmMessagesFromBranchPath: async (_sessionId, _path, currentMessage) => [
      { role: "user", content: currentMessage?.content ?? "" },
    ],
    createChatCompletion: async () => {
      throw new Error("Preparation must not dispatch a provider.");
    },
    isFeatureEnabled: async () => true,
    resolveChatRoutedContextSources: async () => {
      throw new Error("No routed context was requested.");
    },
  };
  return { storage, host, userMessage };
}

describe("Chat send preparation preserves operator preferences", () => {
  it.each([false, true])(
    "keeps exact saved base/autonomy values and revision through preparation and replay (explicit route=%s)",
    async (explicitRoute) => {
      const { storage, host, userMessage } = await createFixture();
      const before = await storage.chatSessionPrefs.get(SESSION_ID);
      const autonomyBefore = await storage.sessionAutonomyPrefs.get(SESSION_ID);
      if (!before || !autonomyBefore) throw new Error("The fixture preferences must exist.");
      const request: ChatSendMessageRequest = freezeChatTurnExecutionRequest({
        content: userMessage.content,
        ...(explicitRoute
          ? {
              mode: "chat",
              providerId: before.providerId,
              model: before.model,
              thinkingLevel: before.thinkingLevel,
              webMode: before.webMode,
              memoryMode: before.memoryMode,
              speedMode: before.speedMode,
              subagentPolicy: before.subagentPolicy,
              prefsOverride: { mode: "chat" },
            }
          : {}),
      });
      for (const branchKind of ["append", "retry"] as const) {
        const prepared = await prepareAgentChatTurn(host, SESSION_ID, request, {
          branchKind,
          existingUserMessage: userMessage,
          ingestUserMessage: false,
          turnId: "turn-prefs",
        });
        expect(await storage.chatSessionPrefs.get(SESSION_ID)).toEqual(before);
        expect(await storage.sessionAutonomyPrefs.get(SESSION_ID)).toEqual(autonomyBefore);
        expect(prepared.prefs).toMatchObject({
          revision: before.revision,
          codeAutoApply: "aggressive_auto",
          orchestrationIntensity: "balanced",
          orchestrationProviderPreference: "balanced",
          orchestrationReviewDepth: "standard",
          toolAutonomy: "manual",
        });
        expect(prepared.autonomy).toEqual(autonomyBefore);
      }
    },
  );

  it("persists intentional request overrides without resetting unrelated saved choices", async () => {
    const { storage, host, userMessage } = await createFixture();
    const before = await storage.chatSessionPrefs.get(SESSION_ID);
    const autonomyBefore = await storage.sessionAutonomyPrefs.get(SESSION_ID);
    if (!before || !autonomyBefore) throw new Error("The fixture preferences must exist.");
    const request = freezeChatTurnExecutionRequest({
      content: userMessage.content,
      providerId: "fixture-explicit",
      model: "fixture-explicit-model",
      thinkingLevel: "standard",
      prefsOverride: {
        mode: "chat",
        providerId: "lower-priority-provider",
        model: "lower-priority-model",
        orchestrationReviewDepth: "off",
        proactiveMode: "auto_safe",
        autonomyBudget: { maxActionsPerTurn: 2 },
      },
    });
    const prepared = await prepareAgentChatTurn(host, SESSION_ID, request, {
      existingUserMessage: userMessage,
      ingestUserMessage: false,
      turnId: "turn-explicit-prefs",
    });
    const saved = await storage.chatSessionPrefs.get(SESSION_ID);
    if (!saved) throw new Error("The saved preferences must exist.");
    expect(saved).toEqual({
      ...before,
      revision: before.revision + 2,
      updatedAt: saved.updatedAt,
      providerId: "fixture-explicit",
      model: "fixture-explicit-model",
      thinkingLevel: "standard",
      orchestrationReviewDepth: "off",
    });
    const autonomySaved = await storage.sessionAutonomyPrefs.get(SESSION_ID);
    if (!autonomySaved) throw new Error("The saved autonomy preferences must exist.");
    expect(autonomySaved).toEqual({
      ...autonomyBefore,
      revision: saved.revision,
      updatedAt: autonomySaved.updatedAt,
      proactiveMode: "auto_safe",
      maxActionsPerTurn: 2,
    });
    expect(prepared.autonomy).toEqual(autonomySaved);
    expect(prepared.prefs).toMatchObject({ providerId: "fixture-explicit", model: "fixture-explicit-model" });
    await prepareAgentChatTurn(host, SESSION_ID, request, {
      existingUserMessage: userMessage,
      ingestUserMessage: false,
      branchKind: "retry",
      turnId: "turn-explicit-prefs",
    });
    expect(await storage.chatSessionPrefs.get(SESSION_ID)).toEqual(saved);
    expect(await storage.sessionAutonomyPrefs.get(SESSION_ID)).toEqual(autonomySaved);
  });
});
