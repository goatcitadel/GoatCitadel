import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompletionRequest,
  ChatSendMessageRequest,
  ChatSessionPrefsRecord,
  CodeModeReadiness,
} from "@goatcitadel/contracts";
import { SCHEDULED_TURN_PERMISSION_PROFILE_ID } from "@goatcitadel/contracts";
import { CODE_MODE_REQUEST_PROMPT_LINE } from "./base-agent-system-prompt.js";
import { prepareAgentChatTurn, type ChatTurnPrepHost } from "./chat-turn-prep-service.js";

// A delegated child's admission authority has its own suite; here it only has to let the child turn through.
vi.mock("./chat-local-delegation-authority.js", () => ({
  assertLocalDelegationTurnAuthority: vi.fn(async () => undefined),
}));

const CATALOG = ["fs.read", "docs.extract_text", "code_mode.request"];
const READY: CodeModeReadiness = { enabled: true, sandboxEnabled: true, sandboxSupported: true, canRun: true };
const UNSUPPORTED: CodeModeReadiness = {
  enabled: false,
  sandboxEnabled: false,
  sandboxSupported: false,
  canRun: false,
  reason: "sandbox_unsupported",
};

function createHost(readiness: CodeModeReadiness | "missing" | "throws") {
  let guidance: ChatCompletionRequest["messages"][number]["content"] | undefined;
  const historyOptions: Array<{ codeModeRequestEligible?: boolean } | undefined> = [];
  const prefs = {
    sessionId: "session-1",
    mode: "chat",
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4-mini",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    proactiveMode: "off",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    createdAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
  } as ChatSessionPrefsRecord;
  const autonomy = { proactiveMode: "off", retrievalMode: "standard", reflectionMode: "off" };
  const meta = { sessionId: "session-1", workspaceId: "default", lifecycleStatus: "active" };
  const getCodeModeReadiness = vi.fn(async () => {
    if (readiness === "throws") throw new Error("readiness unavailable");
    return readiness as CodeModeReadiness;
  });
  const host = {
    storage: {
      chatSessionMeta: { get: vi.fn(() => meta), ensure: vi.fn(() => meta), patch: vi.fn() },
      chatAttachments: { listByIds: vi.fn(() => []) },
      chatSessionPrefs: { ensure: vi.fn(() => prefs), patch: vi.fn(() => prefs) },
      chatSessionProjects: { get: vi.fn(() => undefined) },
      chatFanoutInvocations: { listActive: vi.fn(() => []) },
      chatSideChats: { getByChildSession: vi.fn(() => undefined) },
      chatSpecialistCandidates: { listAutoRoutable: vi.fn(() => []) },
      workspaces: { find: vi.fn(() => undefined) },
      systemSettings: { get: vi.fn(() => undefined) },
    },
    llmService: { getRuntimeConfig: vi.fn(() => ({ providers: [] })) },
    getSession: vi.fn(() => ({ sessionId: "session-1" })),
    ensureChatSessionRuntimeGrants: vi.fn(),
    maybeAutoTitleChatSession: vi.fn(),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    routeFromSession: vi.fn(() => ({ channel: "chat", account: "operator" })),
    ingestEvent: vi.fn(async () => undefined),
    patchSessionAutonomyPrefs: vi.fn(() => autonomy),
    ensureChatSessionModelDefaults: vi.fn(() => prefs),
    getSessionAutonomyPrefs: vi.fn(() => autonomy),
    buildDefaultChatPersonalityOverlay: vi.fn(() => undefined),
    resolveRuntimeGuidance: vi.fn(async () => ({
      workspaceId: "default",
      systemInstruction: "",
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    })),
    resolveThreadKnowledgeContext: vi.fn(async () => ({ citations: [] })),
    loadChatTurnSessionState: vi.fn(async () => ({
      traces: [],
      tracesById: new Map(),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
      turnLineageById: new Map(),
    })),
    buildLlmMessagesFromBranchPath: vi.fn(
      async (
        _sessionId: string,
        _pathTurnIds: string[],
        _userMessage: unknown,
        options?: { guidanceSystemInstruction?: typeof guidance; codeModeRequestEligible?: boolean },
      ) => {
        guidance = options?.guidanceSystemInstruction;
        historyOptions.push(options);
        return [];
      },
    ),
    createChatCompletion: vi.fn(async () => ({ id: "completion-1", message: { role: "assistant", content: "" } })),
    isFeatureEnabled: vi.fn(() => false),
    resolveBasePromptCapabilityCatalog: vi.fn(async () => ({ toolNames: CATALOG })),
    ...(readiness === "missing" ? {} : { getCodeModeReadiness }),
  } as unknown as ChatTurnPrepHost;
  return {
    host,
    getCodeModeReadiness,
    historyOptions,
    readGuidance: () =>
      typeof guidance === "string"
        ? guidance
        : Array.isArray(guidance)
          ? guidance.map((block) => String((block as { text?: unknown }).text ?? "")).join("\n\n")
          : "",
  };
}

async function prepare(
  readiness: CodeModeReadiness | "missing" | "throws",
  request: Partial<ChatSendMessageRequest> = {},
) {
  const harness = createHost(readiness);
  await prepareAgentChatTurn(harness.host, "session-1", { content: "read the attached plan", ...request });
  return harness;
}

describe("prepareAgentChatTurn Code Mode tool catalog", () => {
  it("lists no Code Mode tool on a machine that cannot run the sandbox", async () => {
    const harness = await prepare(UNSUPPORTED, { authActorSource: "token" });
    const guidance = harness.readGuidance();

    expect(guidance).toContain("fs.read");
    expect(guidance).not.toContain("docs.extract_text");
    expect(guidance).not.toContain("code_mode.request");
    expect(guidance).not.toContain(CODE_MODE_REQUEST_PROMPT_LINE);
    expect(harness.historyOptions.every((options) => options?.codeModeRequestEligible === false)).toBe(true);
  });

  it("lists code_mode.request and its section on an operator Chat turn that can run Code Mode, never the script tools", async () => {
    const harness = await prepare(READY, { authActorSource: "token" });
    const guidance = harness.readGuidance();

    expect(guidance).toContain("code_mode.request");
    expect(guidance).toContain(CODE_MODE_REQUEST_PROMPT_LINE);
    expect(guidance).not.toContain("docs.");
    expect(harness.historyOptions.length).toBeGreaterThan(0);
    expect(harness.historyOptions.every((options) => options?.codeModeRequestEligible === true)).toBe(true);
  });

  it("leaves code_mode.request out of a delegated child turn", async () => {
    const harness = await prepare(READY, {
      authActorSource: "token",
      parentDelegationStepId: "step-1",
      policyRunId: "run-1",
      policyTaskId: "task-1",
    });
    const guidance = harness.readGuidance();

    expect(guidance).toContain("fs.read");
    expect(guidance).not.toContain("code_mode.request");
    expect(guidance).not.toContain("docs.extract_text");
    expect(harness.getCodeModeReadiness).not.toHaveBeenCalled();
  });

  it("leaves code_mode.request out of a scheduled turn", async () => {
    const harness = await prepare(READY, {
      authActorSource: "none",
      permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    });

    expect(harness.readGuidance()).not.toContain("code_mode.request");
  });

  it("fails closed when readiness cannot be read", async () => {
    for (const readiness of ["missing", "throws"] as const) {
      const harness = await prepare(readiness, { authActorSource: "token" });
      const guidance = harness.readGuidance();

      expect(guidance).toContain("fs.read");
      expect(guidance).not.toContain("code_mode.request");
      expect(guidance).not.toContain("docs.extract_text");
      expect(harness.historyOptions.every((options) => options?.codeModeRequestEligible === false)).toBe(true);
    }
  });
});
