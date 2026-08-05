import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const storageUpsertMany = vi.fn();
const storageTurnCreate = vi.fn();
const storageSetActiveLeaf = vi.fn();
const storageCostInsert = vi.fn();
const storageCandidateFind = vi.fn();
const storageCandidateUpsert = vi.fn((record: unknown) => record);
const storageCandidateRevisionCreate = vi.fn();
const storageClose = vi.fn();

vi.mock("@goatcitadel/storage", () => ({
  Storage: class Storage {
    chatMessages = {
      upsertMany: storageUpsertMany,
    };

    chatTurnTraces = {
      create: storageTurnCreate,
    };

    chatSessionBranchState = {
      setActiveLeaf: storageSetActiveLeaf,
    };

    costLedger = {
      insert: storageCostInsert,
    };

    candidateSkillVersions = {
      find: storageCandidateFind,
      upsert: storageCandidateUpsert,
    };

    skillAggregateRevisions = {
      createWithInitialRevision: storageCandidateRevisionCreate,
      ensure: vi.fn(),
    };

    close() {
      storageClose();
    }
  },
}));

import { devVerificationRoutes } from "./dev-verification.js";

function decorateDevVerification(app: FastifyInstance, methods: Record<string, unknown>) {
  app.decorate("services", {
    devVerification: {
      storage: {
        waitUntilReady: vi.fn(async () => undefined),
        chatMessages: { upsertMany: storageUpsertMany },
        chatTurnTraces: { create: storageTurnCreate },
        chatSessionBranchState: { setActiveLeaf: storageSetActiveLeaf },
        costLedger: { insert: storageCostInsert },
        candidateSkillVersions: {
          find: storageCandidateFind,
          upsert: storageCandidateUpsert,
        },
        skillAggregateRevisions: {
          ensure: vi.fn(),
          createInitialRevisionFence: storageCandidateRevisionCreate,
        },
        runImmediateTransaction: vi.fn(async (callback: () => unknown) => await callback()),
      },
      ...methods,
    },
  } as never);
}

describe("dev verification routes", () => {
  let app: FastifyInstance | null = null;
  let tempRoot: string | null = null;

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    storageUpsertMany.mockReset();
    storageTurnCreate.mockReset();
    storageSetActiveLeaf.mockReset();
    storageCostInsert.mockReset();
    storageCandidateFind.mockReset();
    storageCandidateUpsert.mockClear();
    storageCandidateRevisionCreate.mockClear();
    storageClose.mockReset();
    if (app) {
      await app.close();
      app = null;
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("returns provider readiness when enabled", async () => {
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      getLlmConfig: () => ({
        activeProviderId: "glm",
        activeModel: "glm-5",
        providers: [
          {
            providerId: "glm",
            label: "GLM",
            defaultModel: "glm-5",
          },
          {
            providerId: "openai",
            label: "OpenAI",
            defaultModel: "gpt-5-mini",
          },
        ],
      }),
      getProviderSecretStatus: (providerId: string) => ({
        providerId,
        hasSecret: providerId === "glm",
        source: providerId === "glm" ? "env" : "none",
      }),
      listDevDiagnostics: () => ({
        items: [{ id: "evt-1" }],
      }),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dev/verification/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      diagnosticsEnabled: true,
      rootDir: "f:/tmp/goatcitadel-dev",
      activeProviderId: "glm",
      activeModel: "glm-5",
      providers: [
        {
          providerId: "glm",
          label: "GLM",
          hasSecret: true,
          source: "env",
          active: true,
          defaultModel: "glm-5",
        },
        {
          providerId: "openai",
          label: "OpenAI",
          hasSecret: false,
          source: "none",
          active: false,
          defaultModel: "gpt-5-mini",
        },
      ],
      latestDiagnosticsCount: 1,
    });
  });

  it("seeds deterministic workspace and sessions", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-dev-verification-"));
    await mkdir(path.join(tempRoot, "data", "transcripts"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "audit"), { recursive: true });

    const createWorkspace = vi.fn((input: { name: string; slug: string; description: string }) => ({
      workspaceId: "workspace-1",
      ...input,
    }));
    const createChatSession = vi.fn((input: { title: string; workspaceId: string }) => ({
      sessionId: `session-${createChatSession.mock.calls.length}`,
      ...input,
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createWorkspace,
      createChatSession,
    });
    app.decorate("gatewayConfig", {
      rootDir: tempRoot,
      dbPath: path.join(tempRoot, "data", "index.db"),
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/seed",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        sessionCount: 3,
        longThreadTurns: 6,
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect(createChatSession).toHaveBeenCalledTimes(3);
    expect(response.json()).toEqual({
      workspaceId: "workspace-1",
      sessionId: "session-3",
      sessionIds: ["session-1", "session-2", "session-3"],
      sessionTitle: "Verification Demo Session",
      candidateId: "usability-browser-candidate",
      candidateVersionId: "usability-browser-candidate-v1",
    });
    expect(storageUpsertMany).toHaveBeenCalledTimes(1);
    expect(storageTurnCreate).toHaveBeenCalled();
    expect(storageSetActiveLeaf).toHaveBeenCalledWith("session-3", expect.any(String));
    expect(storageCostInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-3",
        providerId: "verification-stub",
        modelId: "verification-model",
        costUsd: 0.0026,
      }),
    );
    expect(storageCandidateRevisionCreate).toHaveBeenCalledWith(
      "candidate_skill",
      "usability-browser-candidate",
      "2026-07-29T00:00:00.000Z",
    );
    expect(storageCandidateUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateId: "usability-browser-candidate",
        versionId: "usability-browser-candidate-v1",
        lifecycleState: "candidate",
        sourceKind: "manual",
      }),
    );
    expect(storageClose).not.toHaveBeenCalled();
  });

  it("seeds a deterministic chat approval resume scenario", async () => {
    const createApproval = vi.fn(async () => ({
      approvalId: "approval-1",
      kind: "shell.exec",
      riskLevel: "danger",
      status: "pending",
      payload: {},
      preview: {},
      createdAt: "2026-04-10T00:00:00.000Z",
      expiresAt: "2026-04-10T00:10:00.000Z",
      explanationStatus: "not_requested",
    }));
    const seedDurableChatWait = vi.fn(() => ({
      runId: "durable-turn-1",
      assistantMessageId: "assistant-1",
      version: 1,
    }));
    const settleDurableChatWait = vi.fn(async () => undefined);
    const inlineUpsert = vi.fn();
    const chatMessageUpsert = vi.fn();
    const branchSetActiveLeaf = vi.fn();
    const approvalWaitGetRunId = vi.fn(() => "approval-wait-1");
    const chatToolRunCreate = vi.fn((input: { toolRunId: string }) => ({ toolRunId: input.toolRunId }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    app.decorateRequest("authActorId", "loopback:verification-route-test");
    app.decorateRequest("authActorSource", "loopback");
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createApproval,
      seedDurableChatWait,
      settleDurableChatWait,
      storage: {
        approvalWaitRuns: {
          getRunId: approvalWaitGetRunId,
        },
        chatMessages: {
          upsert: chatMessageUpsert,
        },
        chatTurnTraces: {
          create: storageTurnCreate,
        },
        chatToolRuns: {
          create: chatToolRunCreate,
        },
        chatInlineApprovals: {
          upsert: inlineUpsert,
        },
        chatSessionBranchState: {
          setActiveLeaf: branchSetActiveLeaf,
        },
      },
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/chat-approval-scenario",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        sessionId: "session-1",
        workspaceId: "workspace-1",
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        linkage: expect.objectContaining({
          sessionId: "session-1",
          workspaceId: "workspace-1",
        }),
      }),
    );
    expect(seedDurableChatWait).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        turnId: expect.any(String),
        userMessageId: expect.any(String),
        authActorId: "loopback:verification-route-test",
        authActorSource: "loopback",
        traceStatus: "waiting_for_approval",
        waitForEvent: { eventKey: "approval.resolved", correlationId: "approval-1" },
      }),
    );
    expect(storageTurnCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        assistantMessageId: "assistant-1",
        status: "waiting_for_approval",
        durable: expect.objectContaining({ runId: "durable-turn-1" }),
      }),
    );
    // The client's `deriveThreadPendingApproval` requires a toolRun with
    // status: "approval_required" linked to this approval. Without it the
    // thread-driven effect clobbers the queue-derived prompt to null and the
    // visual lane's chat-pending-approval scenario flakes.
    expect(chatToolRunCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: expect.any(String),
        toolName: "shell.exec",
        status: "approval_required",
        approvalId: "approval-1",
      }),
    );
    expect(inlineUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "approval-1",
        sessionId: "session-1",
        status: "pending",
      }),
    );
    expect(branchSetActiveLeaf).toHaveBeenCalledWith("session-1", expect.any(String));
    expect(settleDurableChatWait).toHaveBeenCalledWith("durable-turn-1");
    expect(response.json()).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      approvalId: "approval-1",
      approvalWaitRunId: "approval-wait-1",
      chatTurnDurableRunId: "durable-turn-1",
    });
  });

  it("seeds deterministic Chat attachment evidence only through the enabled private fixture", async () => {
    const seedChatAttachmentEvidence = vi.fn(() => ({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      citationId: "citation-1",
      toolRunId: "tool-run-1",
      sourceAttachmentId: "source-1",
      sourceUrl: "https://fixture.example.invalid/usability-attachment-source",
    }));
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      seedChatAttachmentEvidence,
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/chat-attachment-evidence-scenario",
      payload: { sessionId: "session-1", workspaceId: "workspace-1" },
    });

    expect(response.statusCode).toBe(201);
    expect(seedChatAttachmentEvidence).toHaveBeenCalledWith({
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });
    expect(response.json()).toMatchObject({
      turnId: "turn-1",
      citationId: "citation-1",
      toolRunId: "tool-run-1",
      sourceAttachmentId: "source-1",
    });
  });

  it("seeds a durable admitted Chat user-input continuation", async () => {
    const seedDurableChatWait = vi.fn(() => ({
      runId: "durable-input-1",
      assistantMessageId: "assistant-input-1",
      version: 1,
    }));
    const settleDurableChatWait = vi.fn(async () => undefined);
    const chatMessageUpsert = vi.fn();
    const branchSetActiveLeaf = vi.fn();
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    app.decorateRequest("authActorId", "loopback:verification-route-test");
    app.decorateRequest("authActorSource", "loopback");
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      seedDurableChatWait,
      settleDurableChatWait,
      storage: {
        chatMessages: { upsert: chatMessageUpsert },
        chatTurnTraces: { create: storageTurnCreate },
        chatSessionBranchState: { setActiveLeaf: branchSetActiveLeaf },
      },
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/chat-user-input-scenario",
      payload: { sessionId: "session-input", workspaceId: "workspace-1" },
    });

    expect(response.statusCode).toBe(201);
    expect(seedDurableChatWait).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sessionId: "session-input",
        authActorId: "loopback:verification-route-test",
        authActorSource: "loopback",
        traceStatus: "waiting_for_user_input",
        waitForEvent: {
          eventKey: "chat.user_input.resolved",
          correlationId: expect.any(String),
        },
      }),
    );
    expect(storageTurnCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-input",
        assistantMessageId: "assistant-input-1",
        status: "waiting_for_user_input",
        durable: expect.objectContaining({ runId: "durable-input-1" }),
      }),
    );
    expect(settleDurableChatWait).toHaveBeenCalledWith("durable-input-1");
    expect(response.json()).toMatchObject({
      sessionId: "session-input",
      workspaceId: "workspace-1",
      chatTurnDurableRunId: "durable-input-1",
    });
  });

  it("links deterministic fixture tasks to stable agentic run identities", async () => {
    const getTask = vi.fn((taskId: string) => ({
      taskId,
      revision: 3,
      workspaceId: "workspace-1",
      title: "Fixture task",
      status: "blocked",
      priority: "normal",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:00.000Z",
    }));
    const updateTaskWithRevision = vi.fn((_taskId, update) => ({ taskId: _taskId, revision: 4, ...update }));
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    app.decorate("services", {
      devVerification: { isDevDiagnosticsEnabled: () => true },
      tasks: { getTask, updateTaskWithRevision },
    } as never);
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/agentic-task-seed",
      payload: {
        workspaceId: "workspace-1",
        tasks: [
          {
            taskId: "task-1",
            runId: "verification-agentic-task-1",
            status: "approval_required",
            surface: "chat",
            parentSessionId: "session-1",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(getTask).toHaveBeenCalledWith("task-1", { workspaceId: "workspace-1" });
    expect(updateTaskWithRevision).toHaveBeenCalledWith(
      "task-1",
      {
        agenticContext: {
          runId: "verification-agentic-task-1",
          status: "approval_required",
          surface: "chat",
          contextMode: "isolated",
          parentSessionId: "session-1",
        },
      },
      3,
      { workspaceId: "workspace-1" },
    );
    expect(response.json().items[0]).toMatchObject({
      taskId: "task-1",
      agenticContext: { runId: "verification-agentic-task-1", status: "approval_required" },
    });
  });

  it("seeds deterministic memory items for verification lanes", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
    const run = vi.fn();
    const prepare = vi.fn(() => ({ run }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      storage: {
        db: {
          prepare,
        },
      },
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const missingWorkspaceResponse = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/memory-item-seed",
      payload: {
        namespace: "memory-truth",
        title: "Missing workspace",
        content: "This seed must be rejected.",
      },
    });
    expect(missingWorkspaceResponse.statusCode).toBe(400);
    expect(run).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/memory-item-seed",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        workspaceId: "workspace-1",
        namespace: "memory-truth",
        title: "Verification memory item",
        content: "This item is used by verification lanes.",
        metadata: {
          lane: "memory-truth",
        },
        pinned: true,
      }),
    });

    expect(response.statusCode).toBe(201);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: expect.stringMatching(/^mem_/),
        workspaceId: "workspace-1",
        namespace: "memory-truth",
        title: "Verification memory item",
        content: "This item is used by verification lanes.",
        metadataJson: expect.any(String),
        pinned: 1,
      }),
    );
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("workspace_id"));
    // W1: the seeded item carries an embedding (in the extractMemoryEmbedding shape)
    // merged alongside the caller-supplied metadata.
    const seededMetadata = JSON.parse(run.mock.calls[0][0].metadataJson as string);
    expect(seededMetadata.lane).toBe("memory-truth");
    expect(Array.isArray(seededMetadata.embedding)).toBe(true);
    expect(seededMetadata.embedding.length).toBeGreaterThan(0);
    expect(seededMetadata.embedding.every((value: number) => Number.isFinite(value))).toBe(true);
    expect(seededMetadata.embeddingMetadata).toMatchObject({ provider: "pseudo" });
    expect(response.json()).toMatchObject({
      itemId: expect.stringMatching(/^mem_/),
      workspaceId: "workspace-1",
      namespace: "memory-truth",
      title: "Verification memory item",
      pinned: true,
      lifecycleState: "active",
    });
  });

  it("holds a Gateway local embedding lease across llama.cpp memory seed generation", async () => {
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "llamacpp");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "http://127.0.0.1:8080/embedding");
    const fetchEmbedding = vi.fn(
      async () =>
        new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchEmbedding);
    const release = vi.fn();
    const acquireLocalEmbeddingLease = vi.fn(async () => ({ release }));
    const run = vi.fn();

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      acquireLocalEmbeddingLease,
      storage: {
        db: {
          prepare: vi.fn(() => ({ run })),
        },
      },
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/memory-item-seed",
      payload: {
        workspaceId: "workspace-lease",
        namespace: "memory-truth",
        title: "Lease-governed memory",
        content: "This write uses the configured llama.cpp embedding runtime.",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(acquireLocalEmbeddingLease).toHaveBeenCalledWith({
      providerId: "llamacpp",
      url: "http://127.0.0.1:8080/embedding",
      purpose: "memory_write",
      signal: expect.any(AbortSignal),
    });
    expect(fetchEmbedding).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(run.mock.calls[0][0].metadataJson as string);
    expect(metadata.embeddingMetadata).toMatchObject({ provider: "llamacpp", dimensions: 8 });
  });

  it("does not request a local runtime lease for pseudo or remote memory embeddings", async () => {
    const acquireLocalEmbeddingLease = vi.fn(async () => ({ release: vi.fn() }));
    const run = vi.fn();
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      acquireLocalEmbeddingLease,
      storage: {
        db: {
          prepare: vi.fn(() => ({ run })),
        },
      },
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "pseudo");
    const pseudoResponse = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/memory-item-seed",
      payload: {
        workspaceId: "workspace-pseudo",
        namespace: "memory-truth",
        title: "Pseudo memory",
        content: "Pseudo embeddings never create local process demand.",
      },
    });
    expect(pseudoResponse.statusCode).toBe(201);

    vi.stubEnv("GOATCITADEL_EMBEDDINGS_PROVIDER", "remote");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_DIMENSIONS", "8");
    vi.stubEnv("GOATCITADEL_EMBEDDINGS_URL", "https://embeddings.example/v1/embeddings");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const remoteResponse = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/memory-item-seed",
      payload: {
        workspaceId: "workspace-remote",
        namespace: "memory-truth",
        title: "Remote memory",
        content: "Remote embeddings do not borrow the host-managed llama process.",
      },
    });

    expect(remoteResponse.statusCode).toBe(201);
    expect(acquireLocalEmbeddingLease).not.toHaveBeenCalled();
  });

  it("seeds orphaned and dead-letter durable recovery scenarios", async () => {
    const createApproval = vi
      .fn()
      .mockResolvedValueOnce({
        approvalId: "approval-orphan",
        kind: "verification.approval.wait",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-04-10T00:00:00.000Z",
        explanationStatus: "not_requested",
      })
      .mockResolvedValueOnce({
        approvalId: "approval-dead",
        kind: "verification.approval.wait",
        riskLevel: "danger",
        status: "pending",
        payload: {},
        preview: {},
        createdAt: "2026-04-10T00:00:00.000Z",
        explanationStatus: "not_requested",
      });
    const approvalResolve = vi.fn((approvalId: string) => ({
      approvalId,
      resolvedAt: "2026-04-10T00:00:05.000Z",
    }));
    const getRunId = vi.fn((approvalId: string) => (approvalId === "approval-orphan" ? "run-orphan" : "run-dead"));
    const markResolved = vi.fn();
    const updateRun = vi.fn((input: Record<string, unknown>) => input);
    const upsertDeadLetter = vi.fn(() => ({ deadLetterId: "dead-letter-1" }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createApproval,
      storage: {
        approvals: {
          resolve: approvalResolve,
        },
        approvalWaitRuns: {
          getRunId,
          markResolved,
        },
        durableRuns: {
          updateRun,
          upsertDeadLetter,
        },
      },
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/durable-recovery-seed",
    });

    expect(response.statusCode).toBe(201);
    expect(createApproval).toHaveBeenCalledTimes(2);
    expect(approvalResolve).toHaveBeenCalledTimes(2);
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-orphan",
        status: "running",
        leaseOwnerId: "verification-orphan-worker",
        leaseHeartbeatAt: expect.any(String),
        leaseExpiresAt: expect.any(String),
      }),
    );
    expect(updateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-dead",
        status: "dead_lettered",
      }),
    );
    expect(upsertDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-dead",
        reason: "verification_seed_dead_letter",
      }),
    );
    expect(response.json()).toMatchObject({
      orphanRecovery: {
        approvalId: "approval-orphan",
        runId: "run-orphan",
        status: "running",
      },
      deadLetterRecovery: {
        approvalId: "approval-dead",
        runId: "run-dead",
        status: "dead_lettered",
        deadLetterId: "dead-letter-1",
      },
    });
  });

  it("wraps provider exercise failures in a successful response payload", async () => {
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        scenario: "simple",
        providerId: "glm",
        model: "glm-5",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      requestedProviderId: "glm",
      requestedModel: "glm-5",
      providerId: null,
      model: null,
      scenario: "simple",
      error: "provider unavailable",
    });
  });

  it("uses json_object for DeepSeek structured verification payloads", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "deepseek-chat",
      choices: [{ message: { role: "assistant", content: '{"summary":"ok","confidence":"high"}' } }],
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        scenario: "structured",
        providerId: "deepseek",
        model: "deepseek-chat",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "deepseek",
        model: "deepseek-chat",
        memory: {
          enabled: false,
          mode: "off",
        },
        response_format: {
          type: "json_object",
        },
      }),
      expect.objectContaining({ callKind: "utility", utilityKind: "dev_provider_exercise" }),
    );
  });

  it("keeps json_schema for non-DeepSeek structured verification payloads", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "gpt-4.1-mini",
      choices: [{ message: { role: "assistant", content: '{"summary":"ok","confidence":"high"}' } }],
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        scenario: "structured",
        providerId: "openai",
        model: "gpt-4.1-mini",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-4.1-mini",
        memory: {
          enabled: false,
          mode: "off",
        },
        response_format: expect.objectContaining({
          type: "json_schema",
        }),
      }),
      expect.objectContaining({ callKind: "utility", utilityKind: "dev_provider_exercise" }),
    );
  });

  it("sets strict json_schema for Anthropic structured verification payloads", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "claude-sonnet-4-6",
      choices: [{ message: { role: "assistant", content: '{"summary":"ok","confidence":"high"}' } }],
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      headers: {
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        scenario: "structured",
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "anthropic",
        model: "claude-sonnet-4-6",
        memory: {
          enabled: false,
          mode: "off",
        },
        response_format: expect.objectContaining({
          type: "json_schema",
          json_schema: expect.objectContaining({
            strict: true,
          }),
        }),
      }),
      expect.objectContaining({ callKind: "utility", utilityKind: "dev_provider_exercise" }),
    );
  });

  it("returns the tracked route-access manifest for verification lanes", async () => {
    app = Fastify();
    app.decorate("routeAccessManifest", [
      {
        method: "GET",
        url: "/api/v1/events",
        accessClass: "authenticated-read",
        classificationSource: "explicit",
        tracked: true,
      },
      {
        method: "POST",
        url: "/api/v1/auth/device-requests",
        accessClass: "public",
        classificationSource: "explicit",
        tracked: true,
      },
    ] as never);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/dev/verification/route-access-manifest",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          method: "GET",
          url: "/api/v1/events",
          accessClass: "authenticated-read",
          classificationSource: "explicit",
          tracked: true,
        },
        {
          method: "POST",
          url: "/api/v1/auth/device-requests",
          accessClass: "public",
          classificationSource: "explicit",
          tracked: true,
        },
      ],
      accessClasses: ["authenticated-read", "public"],
      missingTracked: [],
    });
  });

  it("seeds deterministic realtime truth events and replay-gap cursor data", async () => {
    const append = vi.fn().mockReturnValueOnce({
      eventId: "evt-stale",
      sequence: 7,
      eventType: "verification_replay_gap_seed",
      source: "events",
      timestamp: "2026-04-21T00:00:00.000Z",
      payload: { kind: "verification_seed" },
    });
    const pruneOlderThan = vi.fn(() => 1);
    const publishRealtime = vi
      .fn()
      .mockReturnValueOnce({
        eventId: "evt-explicit",
        sequence: 8,
        eventType: "verification_memory_refresh",
        source: "memory",
        timestamp: "2026-04-22T00:00:00.000Z",
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: { workspaceId: "default" },
        payload: { kind: "verification_explicit_metadata" },
      })
      .mockReturnValueOnce({
        eventId: "evt-compat",
        sequence: 9,
        eventType: "approval_hint_emitted",
        source: "approvals",
        timestamp: "2026-04-22T00:00:01.000Z",
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
        payload: { kind: "verification_compatibility_seed" },
      });

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      storage: {
        realtimeEvents: {
          append,
          pruneOlderThan,
        },
      },
      publishRealtime,
      getRealtimeEventSequenceBounds: () => ({
        oldestSequence: 8,
        newestSequence: 9,
      }),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/realtime-truth-seed",
    });

    expect(response.statusCode).toBe(201);
    expect(append).toHaveBeenCalledWith(
      "verification_replay_gap_seed",
      "events",
      { kind: "verification_seed" },
      undefined,
      expect.any(String),
    );
    expect(pruneOlderThan).toHaveBeenCalledWith(expect.any(String));
    expect(publishRealtime).toHaveBeenNthCalledWith(
      1,
      "verification_memory_refresh",
      "memory",
      expect.objectContaining({
        workspaceId: "default",
      }),
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          workspaceId: "default",
        },
      },
    );
    expect(publishRealtime).toHaveBeenNthCalledWith(
      2,
      "approval_hint_emitted",
      "approvals",
      expect.objectContaining({
        kind: "verification_compatibility_seed",
      }),
    );
    expect(response.json()).toMatchObject({
      staleCursor: "7",
      prunedCount: 1,
      bounds: {
        oldestSequence: 8,
        newestSequence: 9,
      },
      explicitEvent: {
        eventId: "evt-explicit",
      },
      compatibilityEvent: {
        eventId: "evt-compat",
      },
    });
  });

  it("returns disabled status consistently across verification endpoints", async () => {
    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => false,
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const endpoints = [
      { method: "GET", url: "/api/v1/dev/verification/status" },
      { method: "GET", url: "/api/v1/dev/verification/diagnostics-snapshot" },
      { method: "GET", url: "/api/v1/dev/verification/route-access-manifest" },
      { method: "POST", url: "/api/v1/dev/verification/seed", payload: {} },
      { method: "POST", url: "/api/v1/dev/verification/provider-exercise", payload: { scenario: "simple" } },
    ] as const;

    for (const endpoint of endpoints) {
      const response = await app.inject(endpoint);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Development verification endpoints are disabled." });
    }
  });

  it("validates diagnostics snapshot and provider exercise payloads before service calls", async () => {
    const listDevDiagnostics = vi.fn();
    const createChatCompletion = vi.fn();

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      listDevDiagnostics,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const diagnostics = await app.inject({
      method: "GET",
      url: "/api/v1/dev/verification/diagnostics-snapshot?limit=0",
    });
    const provider = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      payload: {
        scenario: "not-real",
      },
    });

    expect(diagnostics.statusCode).toBe(400);
    expect(provider.statusCode).toBe(400);
    expect(listDevDiagnostics).not.toHaveBeenCalled();
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("exercises stream and tool provider verification payloads", async () => {
    async function* streamChunks() {
      yield {
        model: "gpt-test-actual",
        choices: [{ delta: { content: "first" } }],
      };
      yield {
        choices: [{ delta: { content: "second" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        model_usage_event_id: "usage-stream-1",
        routing: {
          effectiveProviderId: "openai",
          effectiveModel: "gpt-test-actual",
        },
      };
    }
    const createChatCompletionStream = vi.fn(() => streamChunks());
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-echo-1",
                  type: "function",
                  function: {
                    name: "echo_status",
                    arguments: '{"message":"goatcitadel-provider-tool-roundtrip"}',
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        modelUsageEventIds: ["usage-tool-call"],
        routing: { effectiveProviderId: "openai", effectiveModel: "gpt-test-actual" },
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "assistant", content: [{ text: "tool ready" }] } }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        modelUsageEventIds: ["usage-tool-result"],
        routing: { effectiveProviderId: "openai", effectiveModel: "gpt-test-actual" },
      });

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream,
    });
    app.decorate("gatewayConfig", {
      rootDir: "f:/tmp/goatcitadel-dev",
    } as never);
    await app.register(devVerificationRoutes);

    const stream = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      payload: {
        scenario: "stream",
        providerId: "openai",
        model: "gpt-test",
      },
    });
    const tools = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      payload: {
        scenario: "tools",
        providerId: "openai",
        model: "gpt-test",
      },
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.json()).toMatchObject({
      ok: true,
      scenario: "stream",
      chunkCount: 2,
      requestedModel: "gpt-test",
      model: "gpt-test-actual",
      outputPreview: "firstsecond",
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      modelUsageEventIds: ["usage-stream-1"],
    });
    expect(createChatCompletionStream).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-test",
        stream: true,
      }),
      expect.objectContaining({ callKind: "utility", utilityKind: "dev_provider_exercise" }),
    );
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      ok: true,
      scenario: "tools",
      requestedModel: "gpt-test",
      model: "gpt-test-actual",
      outputPreview: expect.stringContaining("tool ready"),
      toolCallObserved: true,
      toolResultRoundTrip: true,
      modelUsageEventIds: ["usage-tool-call", "usage-tool-result"],
    });
    expect(createChatCompletion).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "echo_status" }),
          }),
        ],
        tool_choice: "required",
        parallel_tool_calls: false,
      }),
      expect.objectContaining({ callKind: "utility", utilityKind: "dev_provider_exercise" }),
    );
    expect(createChatCompletion).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            tool_calls: [expect.objectContaining({ id: "call-echo-1" })],
          }),
          expect.objectContaining({
            role: "tool",
            tool_call_id: "call-echo-1",
            content: expect.stringContaining("goatcitadel-provider-tool-roundtrip"),
          }),
        ]),
      }),
      expect.objectContaining({ callKind: "utility", utilityKind: "dev_provider_exercise" }),
    );
    expect(createChatCompletion.mock.calls[1]?.[0]).not.toHaveProperty("tools");
  });

  it("rejects requested-model routing metadata as provider-returned model evidence", async () => {
    async function* streamChunks() {
      yield {
        choices: [{ delta: { content: "routing only" } }],
        routing: { effectiveProviderId: "openai", effectiveModel: "gpt-requested" },
      };
    }
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ message: { role: "assistant", content: "routing only" } }],
      routing: { effectiveProviderId: "openai", effectiveModel: "gpt-requested" },
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(() => streamChunks()),
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    for (const scenario of ["simple", "stream"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/dev/verification/provider-exercise",
        payload: { scenario, providerId: "openai", model: "gpt-requested" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: false,
        scenario,
        requestedModel: "gpt-requested",
        providerId: null,
        model: null,
        error: expect.stringContaining("did not report a returned model"),
      });
    }
  });

  it("rejects empty provider text and malformed structured evidence", async () => {
    async function* emptyStream() {
      yield { model: "gpt-test-actual", choices: [{ delta: { content: "" } }] };
    }
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "assistant", content: "" } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "assistant", content: '{"summary":"ok","confidence":""}' } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "user", content: "not assistant output" } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [
          {
            message: {
              role: "assistant",
              content: '{"summary":"ok","confidence":"high","unexpected":true}',
            },
          },
        ],
      });

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(() => emptyStream()),
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const requests = [
      { scenario: "simple", error: "contained no assistant text" },
      { scenario: "structured", error: "only non-empty string summary and confidence fields" },
      { scenario: "stream", error: "contained no assistant text" },
      { scenario: "simple", error: "was not an assistant message" },
      { scenario: "structured", error: "only non-empty string summary and confidence fields" },
    ] as const;
    for (const item of requests) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/dev/verification/provider-exercise",
        payload: { scenario: item.scenario, providerId: "openai", model: "gpt-test" },
      });
      expect(response.json()).toMatchObject({
        ok: false,
        scenario: item.scenario,
        model: null,
        error: expect.stringContaining(item.error),
      });
    }
  });

  it("rejects malformed tool-call roles and types across both protocol phases", async () => {
    const validToolCall = {
      id: "call-valid",
      type: "function",
      function: {
        name: "echo_status",
        arguments: '{"message":"goatcitadel-provider-tool-roundtrip"}',
      },
    };
    const createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "tool", content: "", tool_calls: [validToolCall] } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "assistant", content: "", tool_calls: [{ ...validToolCall, type: "custom" }] } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "assistant", content: "", tool_calls: [validToolCall] } }],
      })
      .mockResolvedValueOnce({
        model: "gpt-test-actual",
        choices: [{ message: { role: "user", content: "not an assistant result" } }],
      });

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    for (const expectedError of [
      "tool-call response was not an assistant message",
      "tool call was not a function call",
      "follow-up response was not an assistant message",
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/dev/verification/provider-exercise",
        payload: { scenario: "tools", providerId: "openai", model: "gpt-test" },
      });
      expect(response.json()).toMatchObject({
        ok: false,
        model: null,
        error: expect.stringContaining(expectedError),
      });
    }
    expect(createChatCompletion).toHaveBeenCalledTimes(4);
  });

  it("fails provider tool verification when the model answers without a tool call", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "gpt-test-actual",
      choices: [{ message: { role: "assistant", content: "tool ready" } }],
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      payload: { scenario: "tools", providerId: "openai", model: "gpt-test" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: false,
      scenario: "tools",
      error: expect.stringContaining("expected exactly one tool call"),
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("fails provider tool verification when the tool arguments do not match the safe probe", async () => {
    const createChatCompletion = vi.fn(async () => ({
      model: "gpt-test-actual",
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-wrong-1",
                type: "function",
                function: { name: "echo_status", arguments: '{"message":"wrong"}' },
              },
            ],
          },
        },
      ],
    }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createChatCompletion,
      createChatCompletionStream: vi.fn(),
    });
    app.decorate("gatewayConfig", { rootDir: "f:/tmp/goatcitadel-dev" } as never);
    await app.register(devVerificationRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/dev/verification/provider-exercise",
      payload: { scenario: "tools", providerId: "openai", model: "gpt-test" },
    });

    expect(response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("unexpected arguments"),
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });
});
