import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const storageUpsertMany = vi.fn();
const storageTurnCreate = vi.fn();
const storageSetActiveLeaf = vi.fn();
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

    close() {
      storageClose();
    }
  },
}));

import { devVerificationRoutes } from "./dev-verification.js";

function decorateDevVerification(app: FastifyInstance, methods: Record<string, unknown>) {
  app.decorate("services", { devVerification: methods } as never);
}

describe("dev verification routes", () => {
  let app: FastifyInstance | null = null;
  let tempRoot: string | null = null;

  afterEach(async () => {
    storageUpsertMany.mockReset();
    storageTurnCreate.mockReset();
    storageSetActiveLeaf.mockReset();
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
    });
    expect(storageUpsertMany).toHaveBeenCalledTimes(1);
    expect(storageTurnCreate).toHaveBeenCalled();
    expect(storageSetActiveLeaf).toHaveBeenCalledWith("session-3", expect.any(String));
    expect(storageClose).toHaveBeenCalledTimes(1);
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
    const durableCreateRun = vi.fn(() => ({ runId: "durable-turn-1" }));
    const inlineUpsert = vi.fn();
    const chatMessageUpsert = vi.fn();
    const branchSetActiveLeaf = vi.fn();
    const approvalWaitGetRunId = vi.fn(() => "approval-wait-1");
    const chatToolRunCreate = vi.fn((input: { toolRunId: string }) => ({ toolRunId: input.toolRunId }));

    app = Fastify();
    app.decorate("routeAccessManifest", []);
    decorateDevVerification(app, {
      isDevDiagnosticsEnabled: () => true,
      createApproval,
      storage: {
        approvalWaitRuns: {
          getRunId: approvalWaitGetRunId,
        },
        durableRuns: {
          createRun: durableCreateRun,
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
    expect(durableCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowKey: "approval.wait",
        status: "waiting",
        payload: expect.objectContaining({
          version: "approval.wait.v1",
          approvalId: "approval-1",
        }),
        metadata: {
          surface: "chat",
          waitForEvent: {
            eventKey: "approval.resolved",
            correlationId: "approval-1",
          },
        },
      }),
    );
    expect(storageTurnCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
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
    expect(response.json()).toMatchObject({
      sessionId: "session-1",
      workspaceId: "workspace-1",
      approvalId: "approval-1",
      approvalWaitRunId: "approval-wait-1",
      chatTurnDurableRunId: "durable-turn-1",
    });
  });

  it("seeds deterministic memory items for verification lanes", async () => {
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
      providerId: "glm",
      model: "glm-5",
      scenario: "simple",
      error: "provider unavailable",
    });
  });

  it("uses json_object for DeepSeek structured verification payloads", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ message: { content: '{"summary":"ok","confidence":"high"}' } }],
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
    );
  });

  it("keeps json_schema for non-DeepSeek structured verification payloads", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ message: { content: '{"summary":"ok","confidence":"high"}' } }],
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
    );
  });

  it("sets strict json_schema for Anthropic structured verification payloads", async () => {
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ message: { content: '{"summary":"ok","confidence":"high"}' } }],
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
      yield { choices: [{ delta: { content: "first" } }] };
      yield { choices: [{ delta: { content: "second" } }] };
    }
    const createChatCompletionStream = vi.fn(() => streamChunks());
    const createChatCompletion = vi.fn(async () => ({
      choices: [{ message: { content: [{ text: "tool ready" }] } }],
    }));

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
      outputPreview: expect.stringContaining("first"),
    });
    expect(createChatCompletionStream).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-test",
        stream: true,
      }),
    );
    expect(tools.statusCode).toBe(200);
    expect(tools.json()).toMatchObject({
      ok: true,
      scenario: "tools",
      outputPreview: expect.stringContaining("tool ready"),
    });
    expect(createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            type: "function",
            function: expect.objectContaining({ name: "echo_status" }),
          }),
        ],
        tool_choice: "auto",
      }),
    );
  });
});
