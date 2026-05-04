import { describe, expect, it, vi } from "vitest";
import type { ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import { prepareAgentChatTurn, type ChatTurnPrepHost } from "./chat-turn-prep-service.js";

function createPrefs(mode: ChatSessionPrefsRecord["mode"]): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode,
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4-mini",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    proactiveMode: "off",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
  } as ChatSessionPrefsRecord;
}

function createHost(mode: ChatSessionPrefsRecord["mode"]) {
  let guidanceSystemInstruction = "";
  const prefs = createPrefs(mode);
  const host = {
    storage: {
      chatSessionMeta: {
        ensure: vi.fn(() => ({
          sessionId: "session-1",
          workspaceId: "default",
          lifecycleStatus: "active",
        })),
      },
      chatAttachments: {
        listByIds: vi.fn(() => []),
      },
      chatSessionPrefs: {
        patch: vi.fn(() => prefs),
      },
      chatSessionProjects: {
        get: vi.fn(() => undefined),
      },
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({ providers: [] })),
    },
    getSession: vi.fn(() => ({ sessionId: "session-1" })),
    ensureChatSessionRuntimeGrants: vi.fn(),
    maybeAutoTitleChatSession: vi.fn(),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    routeFromSession: vi.fn(() => ({ channel: "chat", account: "operator" })),
    ingestEvent: vi.fn(async () => undefined),
    patchSessionAutonomyPrefs: vi.fn(() => ({
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
    })),
    ensureChatSessionModelDefaults: vi.fn(() => prefs),
    getSessionAutonomyPrefs: vi.fn(() => ({
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
    })),
    buildDefaultChatPersonalityOverlay: vi.fn(() =>
      [
        "Chat personality overlay:",
        "- Personality: Operator",
        "- Instruction: Use crisp language.",
        "- Boundary: This overlay changes voice and framing only.",
      ].join("\n"),
    ),
    resolveRuntimeGuidance: vi.fn(async () => ({ systemInstruction: "Base Chat guidance." })),
    resolveThreadKnowledgeContext: vi.fn(async () => ({ systemInstruction: "Thread knowledge.", citations: [] })),
    loadChatTurnSessionState: vi.fn(async () => ({
      traces: [],
      tracesById: new Map(),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
      turnLineageById: new Map(),
    })),
    buildLlmMessagesFromBranchPath: vi.fn(async (_sessionId, _pathTurnIds, _userMessage, options) => {
      guidanceSystemInstruction = options?.guidanceSystemInstruction ?? "";
      return [];
    }),
    createChatCompletion: vi.fn(async () => ({ id: "completion-1", message: { role: "assistant", content: "" } })),
  } as unknown as ChatTurnPrepHost;
  return {
    host,
    readGuidance: () => guidanceSystemInstruction,
  };
}

describe("prepareAgentChatTurn personality overlay", () => {
  it("adds the global personality overlay only for Chat mode", async () => {
    const chat = createHost("chat");
    await prepareAgentChatTurn(chat.host, "session-1", { content: "hello" });

    expect(chat.readGuidance()).toContain("Chat personality overlay:");
    expect(chat.readGuidance()).toContain("Use crisp language.");
    expect(chat.host.buildDefaultChatPersonalityOverlay).toHaveBeenCalled();

    const cowork = createHost("cowork");
    await prepareAgentChatTurn(cowork.host, "session-1", { content: "hello" });

    expect(cowork.readGuidance()).not.toContain("Chat personality overlay:");
    expect(cowork.host.buildDefaultChatPersonalityOverlay).not.toHaveBeenCalled();
  });
});
