import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatSendMessageResponse, ChatSessionRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { OrchestrationRouterInput } from "../orchestration/types.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { executeDelegatedPlanStep, type ChatTurnStreamHost } from "./chat-turn-stream-service.js";

const storages: Storage[] = [];
const createdDirs: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("executeDelegatedPlanStep", () => {
  it("persists a delegated child as running while the child turn is still in flight", async () => {
    const { storage } = createHarness();
    storage.chatDelegationRuns.create({
      runId: "run-1",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Find local business contacts.",
      roles: ["Worker"],
      mode: "sequential",
      status: "running",
    });
    storage.chatDelegationSteps.create({
      stepId: "run-1:worker-step",
      runId: "run-1",
      role: "worker",
      label: "Worker",
      index: 1,
      status: "pending",
      providerId: "openai-codex",
      model: "gpt-5.5",
    });

    let resolveChild!: (response: ChatSendMessageResponse) => void;
    const childResponse = new Promise<ChatSendMessageResponse>((resolve) => {
      resolveChild = resolve;
    });
    const agentSendChatMessage = vi.fn(() => childResponse);
    const host = createHost(storage, agentSendChatMessage);

    const executing = executeDelegatedPlanStep(host, createPreparedTurn(), {
      task: {
        mode: "cowork",
        objective: "Find local business contacts.",
        conversation: [],
      } as OrchestrationRouterInput["task"],
      plan: { summary: "Research contacts.", steps: [] } as never,
      priorSteps: [],
      step: {
        stepId: "worker-step",
        role: "worker",
        label: "Worker",
        objective: "Visit official sources and extract public contact evidence.",
        providerId: "openai-codex",
        model: "gpt-5.5",
      } as never,
      stepIndex: 1,
      runId: "run-1",
    });

    await vi.waitFor(() => expect(agentSendChatMessage).toHaveBeenCalledTimes(1));
    expect(storage.chatDelegationSteps.get("run-1:worker-step")).toMatchObject({
      status: "running",
      childSessionId: "child-session",
      summary: "Worker is running delegated work.",
    });

    resolveChild(createChildResponse());
    await expect(executing).resolves.toMatchObject({
      status: "completed",
      childSessionId: "child-session",
      childTurnId: "child-turn",
    });
  });

  it("steers local-business contact work through the structured research tool first", async () => {
    const { storage } = createHarness();
    storage.chatDelegationRuns.create({
      runId: "run-91303",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective:
        "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?",
      roles: ["Worker"],
      mode: "sequential",
      status: "running",
    });
    storage.chatDelegationSteps.create({
      stepId: "run-91303:worker-step",
      runId: "run-91303",
      role: "worker",
      label: "Worker",
      index: 1,
      status: "pending",
    });

    let resolveChild!: (response: ChatSendMessageResponse) => void;
    const childResponse = new Promise<ChatSendMessageResponse>((resolve) => {
      resolveChild = resolve;
    });
    const agentSendChatMessage = vi.fn(() => childResponse);
    const host = createHost(storage, agentSendChatMessage);

    const executing = executeDelegatedPlanStep(host, createPreparedTurn(), {
      task: {
        mode: "cowork",
        objective:
          "Can you locate all the boardgame/tabletop game stores within a 10-mile radius of 91303 and find the email addresses and who I should address in them?",
        conversation: [],
      } as OrchestrationRouterInput["task"],
      plan: { summary: "Research local business contacts.", steps: [] } as never,
      priorSteps: [],
      step: {
        stepId: "worker-step",
        role: "worker",
        label: "Worker",
        objective: "Find boardgame/tabletop game stores near 91303 and verify public email/contact evidence.",
        expectedOutput: "Source-backed candidates with emails, contact names, missing fields, and blockers.",
        suggestedTools: ["browser.search", "browser.navigate"],
      } as never,
      stepIndex: 1,
      runId: "run-91303",
    });

    await vi.waitFor(() => expect(agentSendChatMessage).toHaveBeenCalledTimes(1));

    const delegatedRequest = agentSendChatMessage.mock.calls[0]?.[1];
    expect(delegatedRequest?.content).toContain(
      "Suggested tools: local_business.research, browser.search, browser.navigate",
    );
    expect(delegatedRequest?.content).toContain("call local_business.research before broad browser browsing");

    resolveChild(createChildResponse());
    await expect(executing).resolves.toMatchObject({ status: "completed" });
  });
});

function createHarness(): { storage: Storage } {
  const root = path.join(os.tmpdir(), `goatcitadel-chat-turn-stream-${randomUUID()}`);
  createdDirs.push(root);
  fs.mkdirSync(root, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  return { storage };
}

function createHost(
  storage: Storage,
  agentSendChatMessage: ReturnType<typeof vi.fn<() => Promise<ChatSendMessageResponse>>>,
): ChatTurnStreamHost {
  return {
    storage: createSqliteAsyncStorage(storage),
    createChatSession: vi.fn(
      () =>
        ({
          sessionId: "child-session",
          title: "Delegate · Worker",
          createdAt: "2026-06-22T00:00:00.000Z",
          updatedAt: "2026-06-22T00:00:00.000Z",
        }) as ChatSessionRecord,
    ),
    inheritDelegatedSessionToolGrants: vi.fn(),
    updateChatSessionPrefs: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    agentSendChatMessage,
  } as unknown as ChatTurnStreamHost;
}

function createPreparedTurn(): PreparedAgentChatTurn {
  return {
    session: { sessionId: "parent-session" },
    route: { sessionId: "parent-session", turnId: "parent-turn" },
    citadelId: "personal",
    workspaceId: "default",
    content: "Find local business contacts.",
    userEventId: "event-1",
    userMessage: { messageId: "user-message", role: "user", content: "Find contacts." },
    prefs: {
      providerId: "openai-codex",
      model: "gpt-5.5",
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "deep",
      speedMode: "standard",
      codeAutoApply: false,
      orchestrationProviderPreference: "quality",
      orchestrationReviewDepth: "standard",
    },
    autonomy: { retrievalMode: "standard" },
    normalized: { normalizationProfile: "default" },
    modelRouterDecision: {},
    retrievalTrace: {},
    threadKnowledgeCitations: [],
    resolvedGuidance: {},
    conversationMessages: [],
    history: [],
    turnId: "parent-turn",
    assistantMessageId: "assistant-message",
    branchKind: "append",
    effectiveToolAutonomy: "safe_auto",
  } as PreparedAgentChatTurn;
}

function createChildResponse(): ChatSendMessageResponse {
  const trace: ChatTurnTraceRecord = {
    turnId: "child-turn",
    sessionId: "child-session",
    userMessageId: "child-user-message",
    branchKind: "append",
    status: "completed",
    mode: "cowork",
    model: "gpt-5.5",
    webMode: "deep",
    memoryMode: "off",
    thinkingLevel: "deep",
    startedAt: "2026-06-22T00:00:00.000Z",
    finishedAt: "2026-06-22T00:01:00.000Z",
    toolRuns: [],
    citations: [],
    routing: { effectiveProviderId: "openai-codex", effectiveModel: "gpt-5.5" },
  };
  return {
    sessionId: "child-session",
    userMessage: { messageId: "child-user-message", role: "user", content: "Delegated work" } as never,
    assistantMessage: { messageId: "child-assistant-message", role: "assistant", content: "Done." } as never,
    transport: "inline",
    model: "gpt-5.5",
    turnId: "child-turn",
    trace,
    citations: [],
    routing: trace.routing,
  };
}
