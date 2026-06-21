import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rm: vi.fn(async () => undefined),
  assertWritePathInJail: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    rm: mocks.rm,
  },
  rm: mocks.rm,
}));

vi.mock("@goatcitadel/policy-engine", () => ({
  assertWritePathInJail: mocks.assertWritePathInJail,
}));

vi.mock("./agents-route-service.js", () => ({
  createAgentsRoutePort: vi.fn((port) => ({
    probeAgents: () => ({
      workspaceId: port.normalizeWorkspaceId(" Team "),
      session: port.getSession("session-1"),
      prefs: port.getChatSessionPrefs("session-1"),
      candidate: port.createChatSessionSpecialistCandidate("session-1", { role: "qa" }),
      emitted: port.publishRealtime("agent_event", "agents"),
    }),
  })),
}));

vi.mock("./chat-attachment-service.js", () => ({
  getChatAttachment: vi.fn((host, attachmentId) => ({
    attachmentId,
    session: host.getSession("session-1"),
  })),
  readChatAttachmentContent: vi.fn((host, attachmentId) => ({
    attachmentId,
    workspaceId: host.normalizeWorkspaceId?.("workspace-raw"),
    emitted: host.publishRealtime?.("attachment_read", "attachments", { attachmentId }),
  })),
  uploadChatAttachment: vi.fn((host, input) => ({
    input,
    mediaJob: host.createMediaJob({ kind: "transcode", attachmentId: input.attachmentId }),
  })),
}));

vi.mock("./chat-command-service.js", () => ({
  listChatCommandCatalog: vi.fn(() => [{ command: "/delegate" }]),
}));

vi.mock("./chat-generated-artifact-service.js", () => ({
  createChatGeneratedArtifactFromTurn: vi.fn((deps, input) => ({
    input,
    session: deps.requireChatSession("session-1"),
  })),
  getChatGeneratedArtifact: vi.fn((deps, artifactId, options) => ({
    artifactId,
    options,
    session: deps.requireChatSession("session-1"),
  })),
  listChatGeneratedArtifacts: vi.fn((_deps, input) => ({ items: [input] })),
}));

vi.mock("./chat-message-route-runtime.js", () => ({
  answerChatUserInputPrompt: vi.fn((_host, sessionId, turnId, promptId, input) => ({
    sessionId,
    turnId,
    promptId,
    input,
  })),
  getChatThread: vi.fn((_host, sessionId) => ({ sessionId, turns: [] })),
  getTurnContextManifestForSession: vi.fn((_host, sessionId, turnId) => ({ sessionId, turnId })),
  selectChatBranchTurn: vi.fn((_host, sessionId, turnId) => ({ sessionId, turnId })),
}));

vi.mock("./chat-session-service.js", () => ({
  archiveChatSession: vi.fn((_deps, sessionId) => ({ op: "archive", sessionId })),
  archiveChatSessionsBulk: vi.fn((_deps, input) => ({ op: "archiveBulk", input })),
  assignChatSessionProject: vi.fn((_deps, sessionId, projectId) => ({ op: "assignProject", sessionId, projectId })),
  createChatSession: vi.fn(async (deps, input) => {
    await deps.removeChatSessionStoredFile("");
    await deps.removeChatSessionStoredFile("notes/session.md");
    return {
      input,
      workspaceId: deps.normalizeWorkspaceId(" Team "),
      grants: deps.ensureChatSessionRuntimeGrants("session-1"),
      required: deps.requireChatSession("session-1"),
      session: deps.getSession("session-1"),
      emitted: deps.publishRealtime("session_created", "chat", { sessionId: "session-1" }),
      cleared: deps.clearChatTurnWriteLease("session-1"),
      defaults: deps.ensureChatSessionModelDefaults("session-1", { providerId: "openai" }),
      autonomy: deps.hydrateChatPrefsWithAutonomy("session-1", { toolAutonomy: "safe_auto" }),
      patched: deps.patchSessionAutonomyPrefs("session-1", { toolAutonomy: "manual" }),
    };
  }),
  deleteChatSession: vi.fn((_deps, sessionId) => ({ op: "delete", sessionId })),
  getChatSessionBinding: vi.fn((_deps, sessionId) => ({ sessionId, binding: null })),
  listChatSessions: vi.fn((_deps, query) => ({ items: [query] })),
  pinChatSession: vi.fn((_deps, sessionId) => ({ sessionId, pinned: true })),
  restoreChatSession: vi.fn((_deps, sessionId) => ({ sessionId, archived: false })),
  searchChatSessions: vi.fn((_deps, input) => ({ items: [input], query: input.query })),
  setChatSessionBinding: vi.fn((_deps, input) => ({ input })),
  unpinChatSession: vi.fn((_deps, sessionId) => ({ sessionId, pinned: false })),
  updateChatSession: vi.fn((_deps, sessionId, input) => ({ sessionId, input })),
}));

vi.mock("./chat-thread-knowledge-service.js", () => ({
  attachChatThreadKnowledgeAttachment: vi.fn(async (deps, sessionId, input) => ({
    session: deps.getSession(sessionId),
    input,
    ingest: await deps.knowledgeDocsIngest({ sourceType: "text", source: "doc", namespace: "chat" }),
  })),
  listChatThreadKnowledgeAttachments: vi.fn(async (deps, sessionId) => ({
    session: deps.getSession(sessionId),
    content: await deps.readChatAttachmentContent("attachment-1"),
    query: await deps.knowledgeEmbeddingsQuery({ namespace: "chat", query: "facts" }),
  })),
  removeChatThreadKnowledgeAttachment: vi.fn((_deps, sessionId, attachmentId) => ({ sessionId, attachmentId })),
}));

vi.mock("./chat-tool-artifact-service.js", () => ({
  getChatToolArtifactContent: vi.fn((_host, artifactId, options) => ({ artifactId, options })),
}));

vi.mock("./chat-workbench-service.js", () => ({
  applyChatSessionWorkbenchPatch: vi.fn((deps, sessionId, input) => ({
    sessionId,
    input,
    session: deps.requireChatSession(sessionId),
    emitted: deps.publishRealtime("chat", "workbench", { sessionId }),
  })),
  createChatSessionWorkbenchWorktree: vi.fn((_deps, sessionId, input) => ({ sessionId, input })),
  exportChatSessionWorkbenchPatch: vi.fn((_deps, sessionId) => ({ sessionId, patch: "" })),
  getChatSessionWorkbench: vi.fn((_deps, sessionId) => ({ sessionId, workbench: true })),
  getChatSessionWorkbenchDiff: vi.fn((_deps, sessionId) => ({ sessionId, diff: "" })),
  getChatSessionWorkbenchFile: vi.fn((_deps, sessionId, relativePath) => ({ sessionId, relativePath })),
  getChatSessionWorkbenchFileDiff: vi.fn((_deps, sessionId, relativePath) => ({ sessionId, relativePath, diff: "" })),
  getChatSessionWorkbenchOutput: vi.fn((_deps, sessionId) => ({ sessionId, output: "" })),
  getChatSessionWorkbenchTree: vi.fn((_deps, sessionId) => ({ sessionId, items: [] })),
  revertChatSessionWorkbenchChanges: vi.fn((_deps, sessionId) => ({ sessionId, reverted: true })),
  revertChatSessionWorkbenchFile: vi.fn((_deps, sessionId, input) => ({ sessionId, input, reverted: true })),
  runChatSessionWorkbenchCommand: vi.fn((_deps, sessionId, input) => ({ sessionId, input, exitCode: 0 })),
  runChatSessionWorkbenchFileOperation: vi.fn((_deps, sessionId, input) => ({ sessionId, input, operated: true })),
  saveChatSessionWorkbenchFile: vi.fn((_deps, sessionId, input) => ({ sessionId, input, saved: true })),
}));

import { NotFoundError } from "@goatcitadel/contracts";
import { composeChatRouteDependencies } from "./gateway-route-composition-chat.js";

function fn<TArgs extends unknown[] = unknown[], TResult = unknown>(impl: (...args: TArgs) => TResult) {
  return vi.fn(impl);
}

function createGateway() {
  const gateway = {
    config: {
      rootDir: "F:/code/personal-ai",
      assistant: {
        workspaceDir: "workspace",
      },
      toolPolicy: {
        sandbox: {
          writeJailRoots: ["F:/code/personal-ai/workspace"],
        },
      },
    },
    storage: {
      workspaces: {
        find: fn((workspaceId: string) =>
          workspaceId === "normalized:engineering"
            ? { workspaceId, citadelId: "company" }
            : workspaceId === "normalized:workspace-1"
              ? { workspaceId, citadelId: "personal" }
              : { workspaceId, citadelId: "personal" },
        ),
      },
      chatProjects: {
        get: fn((projectId: string) => ({
          projectId,
          workspaceId: projectId === "project-engineering" ? "engineering" : "workspace-1",
        })),
      },
      chatDelegationRuns: {
        get: fn((runId: string) => ({ runId, sessionId: runId === "foreign-run" ? "other-session" : "session-1" })),
      },
      chatDelegationSteps: {
        listByRun: fn((runId: string) => [{ runId, stepId: "step-1" }]),
      },
      chatSpecialistCandidates: {
        listBySession: fn((sessionId: string, limit: number) => [{ sessionId, limit }]),
        get: fn((candidateId: string) => ({
          candidateId,
          sessionId: candidateId === "foreign-candidate" ? "other-session" : "session-1",
        })),
        patch: fn((candidateId: string, input: Record<string, unknown>) => ({ candidateId, input })),
      },
      chatSessionMeta: {
        ensure: fn((sessionId: string) => ({
          sessionId,
          pinnedGoal: "ship kanban",
          goalTurnBudget: 10,
          goalTurnsUsed: 3,
          goalSetAt: "2026-05-15T10:00:00Z",
        })),
        patch: fn((sessionId: string, input: Record<string, unknown>) => ({
          sessionId,
          pinnedGoal: input.pinnedGoal === null ? undefined : (input.pinnedGoal as string | undefined),
          goalTurnBudget: input.goalTurnBudget === null ? undefined : (input.goalTurnBudget as number | undefined),
          goalTurnsUsed: 0,
          goalSetAt: input.goalSetAt === null ? undefined : (input.goalSetAt as string | undefined),
        })),
      },
    },
    steerService: {
      registerActiveTurn: fn(() => undefined),
      unregisterActiveTurn: fn(() => undefined),
      enqueue: fn((input: { sessionId: string; instruction: string }) => ({
        sessionId: input.sessionId,
        turnId: "t-1",
        accepted: true,
      })),
      drainPending: fn(() => []),
    },
    operatorSummaryCache: {},
    mediaVoiceService: {
      createMediaJob: fn((input: Record<string, unknown>) => ({ jobId: "media-1", input })),
    },
    capabilitySystemService: {
      listChatPendingApprovals: fn((sessionId: string) => [{ sessionId, approvalId: "approval-1" }]),
    },
    approvalRuntime: {
      resolveChatToolApproval: fn((sessionId: string, approvalId: string, decision: string, options: unknown) => ({
        sessionId,
        approvalId,
        decision,
        options,
      })),
    },
    chatTurnRuntime: {
      agentSendChatMessage: fn((sessionId: string, input: unknown) => ({ method: "send", sessionId, input })),
      agentSendChatMessageStream: fn((sessionId: string, input: unknown) => ({
        method: "sendStream",
        sessionId,
        input,
      })),
      cancelChatTurn: fn((sessionId: string, turnId: string, cancelledBy: string) => ({
        sessionId,
        turnId,
        cancelledBy,
      })),
      editChatTurn: fn((sessionId: string, turnId: string, input: unknown) => ({
        method: "edit",
        sessionId,
        turnId,
        input,
      })),
      editChatTurnStream: fn((sessionId: string, turnId: string, input: unknown) => ({
        method: "editStream",
        sessionId,
        turnId,
        input,
      })),
      resumeAgentChatTurnStream: fn((sessionId: string, turnId: string, sinceEventId: string) => ({
        sessionId,
        turnId,
        sinceEventId,
      })),
      retryChatTurn: fn((sessionId: string, turnId: string, input: unknown) => ({
        method: "retry",
        sessionId,
        turnId,
        input,
      })),
      retryChatTurnStream: fn((sessionId: string, turnId: string, input: unknown) => ({
        method: "retryStream",
        sessionId,
        turnId,
        input,
      })),
      routePreflight: fn((sessionId: string, input: unknown) => ({ sessionId, input, status: "ok" })),
    },
    chatProjectService: {
      archiveChatProject: fn((projectId: string) => ({ projectId, archived: true })),
      createChatProject: fn((input: unknown) => ({ projectId: "project-1", input })),
      hardDeleteChatProject: fn((projectId: string) => ({ projectId, deleted: true })),
      importChatProject: fn((input: unknown) => ({ projectId: "imported", input })),
      listChatProjects: fn((view: string, limit: number, workspaceId?: string) => ({ view, limit, workspaceId })),
      restoreChatProject: fn((projectId: string) => ({ projectId, archived: false })),
      updateChatProject: fn((projectId: string, input: unknown) => ({ projectId, input })),
    },
    memoryLifecycleService: {
      listSessionLearnedMemory: fn((sessionId: string, limit: number) => [{ sessionId, limit }]),
      rebuildSessionLearnedMemory: fn((sessionId: string) => ({ sessionId, rebuilt: true })),
      updateSessionLearnedMemory: fn((sessionId: string, itemId: string, input: unknown) => ({
        sessionId,
        itemId,
        input,
      })),
    },
    chatProactiveService: {
      getChatSessionProactiveStatus: fn((sessionId: string) => ({ sessionId, enabled: true })),
      listChatSessionProactiveRuns: fn((sessionId: string, limit: number) => [{ sessionId, limit }]),
      triggerChatSessionProactive: fn((sessionId: string, input: unknown) => ({ sessionId, input })),
      updateChatSessionProactivePolicy: fn((sessionId: string, input: unknown) => ({ sessionId, input })),
    },
    researchService: {
      getRun: fn((sessionId: string, runId: string) => ({ sessionId, runId })),
    },
    normalizeWorkspaceId: fn((workspaceId?: string) => `normalized:${workspaceId?.trim() ?? "default"}`),
    getSession: fn((sessionId: string) => ({ sessionId })),
    requireChatSession: fn((sessionId: string) => ({ sessionId, required: true })),
    ensureChatSessionRuntimeGrants: fn((sessionId: string) => ({ sessionId, granted: true })),
    getChatSessionPrefs: fn((sessionId: string) => ({ sessionId, mode: "chat" })),
    createChatSessionSpecialistCandidate: fn((sessionId: string, input: unknown) => ({ sessionId, input })),
    publishRealtime: fn((eventType: string, source: string, payload?: unknown, options?: unknown) => ({
      eventType,
      source,
      payload,
      options,
    })),
    clearChatTurnWriteLease: fn((sessionId: string) => ({ sessionId, cleared: true })),
    ensureChatSessionModelDefaults: fn((sessionId: string, prefs: unknown) => ({ sessionId, prefs, defaults: true })),
    hydrateChatPrefsWithAutonomy: fn((sessionId: string, prefs: unknown) => ({ sessionId, prefs, hydrated: true })),
    patchSessionAutonomyPrefs: fn((sessionId: string, patch: unknown) => ({ sessionId, patch })),
    acceptChatDelegation: fn((sessionId: string, input: unknown) => ({ sessionId, input, accepted: true })),
    runChatDelegation: fn((sessionId: string, input: unknown) => ({ sessionId, input, run: true })),
    runChatDelegationStream: fn((sessionId: string, input: unknown, options?: unknown) => ({
      sessionId,
      input,
      options,
      stream: true,
    })),
    suggestChatDelegation: fn((sessionId: string, input: unknown) => ({ sessionId, input, suggestions: [] })),
    listChatMessages: fn((sessionId: string, limit: number, cursor?: string) => ({ sessionId, limit, cursor })),
    parseChatCommand: fn((sessionId: string, commandText: string, options?: unknown) => ({
      sessionId,
      commandText,
      options,
    })),
    updateChatSessionPrefs: fn((sessionId: string, input: unknown) => ({ sessionId, input })),
    runChatResearch: fn((sessionId: string, input: unknown) => ({ sessionId, input })),
    invokeAndUnwrap: fn(async (request: unknown, realtimeType: string) => ({ request, realtimeType })),
  };
  return gateway;
}

describe("composeChatRouteDependencies", () => {
  beforeEach(() => {
    mocks.rm.mockClear();
    mocks.assertWritePathInJail.mockClear();
  });

  it("wires chat route ports to gateway facade methods and extracted helpers", async () => {
    const gateway = createGateway();
    const deps = composeChatRouteDependencies(gateway as never) as any;

    expect(deps.agents.probeAgents()).toMatchObject({
      workspaceId: "normalized:Team",
      session: { sessionId: "session-1" },
      candidate: { sessionId: "session-1" },
    });
    expect(deps.chatAttachments.getChatAttachment("attachment-1")).toMatchObject({
      attachmentId: "attachment-1",
      session: { sessionId: "session-1" },
    });
    expect(deps.chatAttachments.readChatAttachmentContent("attachment-1")).toMatchObject({
      attachmentId: "attachment-1",
      workspaceId: "normalized:workspace-raw",
    });
    expect(deps.chatAttachments.uploadChatAttachment({ attachmentId: "attachment-2" })).toMatchObject({
      mediaJob: { jobId: "media-1" },
    });

    await expect(deps.chatSessions.createChatSession({ title: "New" })).resolves.toMatchObject({
      workspaceId: "normalized:Team",
      required: { required: true },
      defaults: { defaults: true },
      autonomy: { hydrated: true },
    });
    expect(mocks.assertWritePathInJail).toHaveBeenCalledWith("F:\\code\\personal-ai\\workspace\\notes\\session.md", [
      "F:/code/personal-ai/workspace",
    ]);
    expect(mocks.rm).toHaveBeenCalledWith("F:\\code\\personal-ai\\workspace\\notes\\session.md", { force: true });

    expect(deps.chatSessions.archiveChatSession("session-1")).toMatchObject({ op: "archive" });
    expect(deps.chatSessions.archiveChatSessionsBulk({ ids: ["session-1"] })).toMatchObject({ op: "archiveBulk" });
    expect(deps.chatSessions.applyChatSessionWorkbenchPatch("session-1", { diff: "x" })).toMatchObject({
      session: { required: true },
    });
    expect(deps.chatSessions.assignChatSessionProject("session-1", "project-1")).toMatchObject({
      projectId: "project-1",
    });
    await expect(
      deps.chatSessions.attachChatThreadKnowledgeAttachment("session-1", { attachmentId: "a" }),
    ).resolves.toMatchObject({
      session: { sessionId: "session-1" },
      ingest: { realtimeType: "knowledge_docs_ingest" },
    });
    expect(deps.chatSessions.createChatGeneratedArtifactFromTurn({ turnId: "turn-1" })).toMatchObject({
      session: { required: true },
    });
    expect(deps.chatSessions.createChatSessionWorkbenchWorktree("session-1", { branch: "main" })).toMatchObject({
      sessionId: "session-1",
    });
    expect(deps.chatSessions.deleteChatSession("session-1")).toMatchObject({ op: "delete" });
    expect(deps.chatSessions.exportChatSessionWorkbenchPatch("session-1")).toMatchObject({ patch: "" });
    expect(deps.chatSessions.getChatGeneratedArtifact("artifact-1", { includeContent: true })).toMatchObject({
      artifactId: "artifact-1",
    });
    expect(deps.chatSessions.getChatSessionBinding("session-1")).toMatchObject({ binding: null });
    expect(deps.chatSessions.getChatSessionWorkbench("session-1")).toMatchObject({ workbench: true });
    expect(deps.chatSessions.getChatSessionWorkbenchDiff("session-1")).toMatchObject({ diff: "" });
    expect(deps.chatSessions.getChatSessionWorkbenchFile("session-1", "README.md")).toMatchObject({
      relativePath: "README.md",
    });
    expect(deps.chatSessions.getChatSessionWorkbenchFileDiff("session-1", "README.md")).toMatchObject({ diff: "" });
    expect(deps.chatSessions.getChatSessionWorkbenchOutput("session-1")).toMatchObject({ output: "" });
    expect(deps.chatSessions.getChatSessionWorkbenchTree("session-1")).toMatchObject({ items: [] });
    expect(deps.chatSessions.listChatGeneratedArtifacts({ sessionId: "session-1" })).toMatchObject({
      items: [{ sessionId: "session-1" }],
    });
    expect(deps.chatSessions.listChatSessions({ limit: 1 })).toMatchObject({ items: [{ limit: 1 }] });
    expect(deps.chatSessions.searchChatSessions({ query: "deploy" })).toMatchObject({
      query: "deploy",
      items: [{ query: "deploy" }],
    });
    await expect(deps.chatSessions.listChatThreadKnowledgeAttachments("session-1")).resolves.toMatchObject({
      content: { attachmentId: "attachment-1" },
      query: { realtimeType: "knowledge_embeddings_query" },
    });
    expect(deps.chatSessions.pinChatSession("session-1")).toMatchObject({ pinned: true });
    expect(deps.chatSessions.removeChatThreadKnowledgeAttachment("session-1", "attachment-1")).toMatchObject({
      attachmentId: "attachment-1",
    });
    expect(deps.chatSessions.restoreChatSession("session-1")).toMatchObject({ archived: false });
    expect(deps.chatSessions.revertChatSessionWorkbenchChanges("session-1")).toMatchObject({ reverted: true });
    expect(deps.chatSessions.revertChatSessionWorkbenchFile("session-1", { path: "README.md" })).toMatchObject({
      reverted: true,
    });
    expect(deps.chatSessions.runChatSessionWorkbenchCommand("session-1", { command: "pnpm test" })).toMatchObject({
      exitCode: 0,
    });
    expect(
      deps.chatSessions.runChatSessionWorkbenchFileOperation("session-1", {
        operation: "create_file",
        path: "src/new.ts",
      }),
    ).toMatchObject({ operated: true });
    expect(deps.chatSessions.saveChatSessionWorkbenchFile("session-1", { path: "README.md" })).toMatchObject({
      saved: true,
    });
    expect(deps.chatSessions.setChatSessionBinding({ sessionId: "session-1" })).toMatchObject({
      input: { sessionId: "session-1" },
    });
    expect(deps.chatSessions.unpinChatSession("session-1")).toMatchObject({ pinned: false });
    expect(deps.chatSessions.updateChatSession("session-1", { title: "Updated" })).toMatchObject({
      input: { title: "Updated" },
    });

    expect(deps.chatDelegate.acceptChatDelegation("session-1", { accepted: true })).toMatchObject({ accepted: true });
    expect(deps.chatDelegate.getChatDelegationRun("session-1", "run-1")).toMatchObject({
      run: { runId: "run-1" },
      steps: [{ stepId: "step-1" }],
    });
    expect(() => deps.chatDelegate.getChatDelegationRun("session-1", "foreign-run")).toThrow(NotFoundError);
    expect(deps.chatDelegate.runChatDelegation("session-1", { goal: "ship" })).toMatchObject({ run: true });
    const abortController = new AbortController();
    expect(
      deps.chatDelegate.runChatDelegationStream("session-1", { goal: "ship" }, { abortSignal: abortController.signal }),
    ).toMatchObject({ stream: true, options: { abortSignal: abortController.signal } });
    expect(deps.chatDelegate.suggestChatDelegation("session-1", { goal: "ship" })).toMatchObject({ suggestions: [] });

    expect(deps.chatTools.getChatToolArtifactContent("artifact-1", { encoding: "text" })).toMatchObject({
      artifactId: "artifact-1",
    });
    expect(deps.chatTools.listChatPendingApprovals("session-1")).toEqual([
      { sessionId: "session-1", approvalId: "approval-1" },
    ]);
    expect(
      deps.chatTools.resolveChatToolApproval("session-1", "approval-1", "approved", { actor: "operator" }),
    ).toMatchObject({
      decision: "approved",
    });

    expect(deps.chatMessages.agentSendChatMessage("session-1", { content: "hi" })).toMatchObject({ method: "send" });
    expect(deps.chatMessages.agentSendChatMessageStream("session-1", { content: "hi" })).toMatchObject({
      method: "sendStream",
    });
    expect(
      deps.chatMessages.answerChatUserInputPrompt("session-1", "turn-1", "prompt-1", { value: "x" }),
    ).toMatchObject({
      promptId: "prompt-1",
    });
    expect(deps.chatMessages.cancelChatTurn("session-1", "turn-1", "operator")).toMatchObject({
      cancelledBy: "operator",
    });
    expect(deps.chatMessages.editChatTurn("session-1", "turn-1", { content: "edit" })).toMatchObject({
      method: "edit",
    });
    expect(deps.chatMessages.editChatTurnStream("session-1", "turn-1", { content: "edit" })).toMatchObject({
      method: "editStream",
    });
    expect(deps.chatMessages.getChatThread("session-1")).toMatchObject({ turns: [] });
    expect(deps.chatMessages.getTurnContextManifestForSession("session-1", "turn-1")).toMatchObject({
      turnId: "turn-1",
    });
    expect(deps.chatMessages.listChatMessages("session-1", 10, "cursor-1")).toMatchObject({ cursor: "cursor-1" });
    expect(deps.chatMessages.resumeAgentChatTurnStream("session-1", "turn-1", "event-1")).toMatchObject({
      sinceEventId: "event-1",
    });
    expect(deps.chatMessages.retryChatTurn("session-1", "turn-1", { reason: "again" })).toMatchObject({
      method: "retry",
    });
    expect(deps.chatMessages.retryChatTurnStream("session-1", "turn-1", { reason: "again" })).toMatchObject({
      method: "retryStream",
    });
    expect(deps.chatMessages.routePreflight("session-1", { content: "hi" })).toMatchObject({ status: "ok" });
    expect(deps.chatMessages.selectChatBranchTurn("session-1", "turn-1")).toMatchObject({ turnId: "turn-1" });

    expect(deps.chatProjects.archiveChatProject("project-1")).toMatchObject({ archived: true });
    expect(deps.chatProjects.createChatProject({ name: "Project" })).toMatchObject({ projectId: "project-1" });
    expect(deps.chatProjects.hardDeleteChatProject("project-1")).toMatchObject({ deleted: true });
    expect(deps.chatProjects.importChatProject({ name: "Import" })).toMatchObject({ projectId: "imported" });
    expect(deps.chatProjects.listChatProjects("active", 5, "workspace-1")).toMatchObject({
      view: "active",
      workspaceId: "normalized:workspace-1",
    });
    expect(deps.chatProjects.restoreChatProject("project-1")).toMatchObject({ archived: false });
    expect(deps.chatProjects.updateChatProject("project-1", { name: "New" })).toMatchObject({
      input: { name: "New" },
    });

    expect(deps.chatSupport.commands.listChatCommandCatalog()).toEqual([{ command: "/delegate" }]);
    expect(
      deps.chatSupport.commands.parseChatCommand("session-1", "/delegate qa", { resolvedBy: "operator-test" }),
    ).toMatchObject({
      commandText: "/delegate qa",
      options: { resolvedBy: "operator-test" },
    });
    expect(deps.chatSupport.learnedMemory.listChatSessionLearnedMemory("session-1", 3)).toEqual([
      { sessionId: "session-1", limit: 3 },
    ]);
    expect(deps.chatSupport.learnedMemory.rebuildChatSessionLearnedMemory("session-1")).toMatchObject({
      rebuilt: true,
    });
    expect(
      deps.chatSupport.learnedMemory.updateChatSessionLearnedMemory("session-1", "memory-1", { text: "x" }),
    ).toMatchObject({
      itemId: "memory-1",
    });
    expect(deps.chatSupport.prefs.getChatSessionPrefs("session-1")).toMatchObject({ mode: "chat" });
    expect(deps.chatSupport.prefs.updateChatSessionPrefs("session-1", { mode: "cowork" })).toMatchObject({
      input: { mode: "cowork" },
    });
    expect(deps.chatSupport.proactive.getChatSessionProactiveStatus("session-1")).toMatchObject({ enabled: true });
    expect(deps.chatSupport.proactive.listChatSessionProactiveRuns("session-1", 4)).toEqual([
      { sessionId: "session-1", limit: 4 },
    ]);
    expect(deps.chatSupport.proactive.triggerChatSessionProactive("session-1", { reason: "manual" })).toMatchObject({
      input: { reason: "manual" },
    });
    expect(deps.chatSupport.proactive.updateChatSessionProactivePolicy("session-1", { enabled: false })).toMatchObject({
      input: { enabled: false },
    });
    expect(deps.chatSupport.research.getChatResearchRun("session-1", "research-1")).toMatchObject({
      runId: "research-1",
    });
    expect(deps.chatSupport.research.runChatResearch("session-1", { query: "news" })).toMatchObject({
      input: { query: "news" },
    });
    expect(
      deps.chatSupport.specialists.createChatSessionSpecialistCandidate("session-1", { role: "QA" }),
    ).toMatchObject({
      input: { role: "QA" },
    });
    expect(deps.chatSupport.specialists.listChatSessionSpecialistCandidates("session-1")).toEqual({
      items: [{ sessionId: "session-1", limit: 200 }],
    });
    await expect(
      deps.chatSupport.steer.submitChatSteerInstruction("session-1", { instruction: "focus" }),
    ).resolves.toMatchObject({
      sessionId: "session-1",
      turnId: "t-1",
      accepted: true,
    });
    await expect(deps.chatSupport.goal.getChatSessionGoal("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      goal: "ship kanban",
      turnBudget: 10,
      turnsUsed: 3,
    });
    await expect(
      deps.chatSupport.goal.setChatSessionGoal("session-1", { goal: "ship", turnBudget: 5 }),
    ).resolves.toMatchObject({
      sessionId: "session-1",
      goal: "ship",
      turnBudget: 5,
    });
    await expect(deps.chatSupport.goal.clearChatSessionGoal("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      goal: null,
      turnBudget: null,
    });
    expect(
      deps.chatSupport.specialists.updateChatSessionSpecialistCandidate("session-1", "candidate-1", { role: "QA" }),
    ).toMatchObject({
      candidateId: "candidate-1",
    });
    expect(() =>
      deps.chatSupport.specialists.updateChatSessionSpecialistCandidate("session-1", "foreign-candidate", {
        role: "QA",
      }),
    ).toThrow("Specialist candidate does not belong to this session.");
  });

  it("rejects explicit Citadel and workspace mismatches before chat project services run", () => {
    const gateway = createGateway();
    const deps = composeChatRouteDependencies(gateway as never) as any;

    expect(() => deps.chatProjects.listChatProjects("active", 5, "engineering", "personal")).toThrow(
      /belongs to citadel company, not personal/,
    );
    expect(gateway.chatProjectService.listChatProjects).not.toHaveBeenCalled();
  });
});
