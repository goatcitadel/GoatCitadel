import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CandidateSkillVersionRecord, CapabilityArtifactRecord, ChatMessageRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { listMissingTrackedRouteAccessClasses } from "./route-access.js";
import { registerDevVerificationProviderExerciseRoute } from "./dev-verification-provider-exercise.js";
import { withMemoryEmbeddingMetadata } from "../services/memory-embedding-metadata.js";

const listDiagnosticsQuerySchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  category: z.string().trim().min(1).optional(),
  correlationId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(500).default(150),
});

const seedScenarioSchema = z.object({
  workspaceName: z.string().trim().min(1).default("Verification Demo Workspace"),
  sessionTitle: z.string().trim().min(1).default("Verification Demo Session"),
  sessionCount: z.coerce.number().int().min(1).max(40).default(12),
  longThreadTurns: z.coerce.number().int().min(2).max(120).default(24),
});

const chatApprovalScenarioSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
});

const chatUserInputScenarioSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
});

const chatAttachmentEvidenceScenarioSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
});

const memoryItemSeedSchema = z.object({
  workspaceId: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
  metadata: z.record(z.unknown()).optional(),
  pinned: z.boolean().optional(),
});

const agenticTaskSeedSchema = z.object({
  workspaceId: z.string().trim().min(1),
  tasks: z
    .array(
      z.object({
        taskId: z.string().trim().min(1),
        runId: z.string().trim().min(1),
        status: z.enum(["queued", "planning", "running", "approval_required", "paused", "completed", "failed"]),
        surface: z.enum(["chat", "cowork", "code"]).default("chat"),
        parentSessionId: z.string().trim().min(1).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export const devVerificationRoutes: FastifyPluginAsync = async (fastify) => {
  const devVerificationEnabled = () => fastify.services.devVerification.isDevDiagnosticsEnabled();

  fastify.get("/api/v1/dev/verification/status", async (_request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const llmConfig = fastify.services.devVerification.getLlmConfig();
    const providers = llmConfig.providers.map((provider) => {
      const status = fastify.services.devVerification.getProviderSecretStatus(provider.providerId);
      return {
        providerId: provider.providerId,
        label: provider.label,
        hasSecret: status.hasSecret,
        source: status.source,
        active: provider.providerId === llmConfig.activeProviderId,
        defaultModel: provider.defaultModel,
      };
    });
    return reply.send({
      diagnosticsEnabled: devVerificationEnabled(),
      rootDir: fastify.gatewayConfig.rootDir,
      activeProviderId: llmConfig.activeProviderId,
      activeModel: llmConfig.activeModel,
      providers,
      latestDiagnosticsCount: fastify.services.devVerification.listDevDiagnostics({ limit: 500 }).items.length,
    });
  });

  fastify.get("/api/v1/dev/verification/diagnostics-snapshot", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = listDiagnosticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.services.devVerification.listDevDiagnostics(parsed.data));
  });

  fastify.get("/api/v1/dev/verification/route-access-manifest", async (_request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const items = [...fastify.routeAccessManifest];
    const accessClasses = [...new Set(items.map((item) => item.accessClass).filter(Boolean))];
    return reply.send({
      items,
      accessClasses,
      missingTracked: listMissingTrackedRouteAccessClasses(fastify),
    });
  });

  fastify.post("/api/v1/dev/verification/seed", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = seedScenarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = fastify.services.devVerification.createWorkspace({
      name: parsed.data.workspaceName,
      slug: `verification-${randomUUID().slice(0, 8)}`,
      description: "Deterministic verification workspace seeded for automated testing.",
    });
    const sessions = [
      ...Array.from({ length: Math.max(0, parsed.data.sessionCount - 1) }, (_item, index) =>
        fastify.services.devVerification.createChatSession({
          title: `${parsed.data.sessionTitle} ${index + 2}`,
          workspaceId: workspace.workspaceId,
        }),
      ),
      fastify.services.devVerification.createChatSession({
        title: parsed.data.sessionTitle,
        workspaceId: workspace.workspaceId,
      }),
    ];
    const session = sessions[sessions.length - 1];
    if (!session) {
      return reply.code(500).send({ error: "Verification seed did not create any chat sessions." });
    }
    const now = Date.now();
    const storage = new Storage({
      dbPath: fastify.gatewayConfig.dbPath,
      transcriptsDir: path.join(fastify.gatewayConfig.rootDir, "data", "transcripts"),
      auditDir: path.join(fastify.gatewayConfig.rootDir, "data", "audit"),
    });
    try {
      const messages: ChatMessageRecord[] = [];
      messages.push({
        messageId: randomUUID(),
        sessionId: session.sessionId,
        role: "user",
        actorType: "user",
        actorId: "verification-operator",
        content: "Summarize the current release posture and format the result as markdown.",
        timestamp: new Date(now - 120_000).toISOString(),
      });
      messages.push({
        messageId: randomUUID(),
        sessionId: session.sessionId,
        role: "assistant",
        actorType: "agent",
        actorId: "goatherder",
        content: [
          "# Verification Demo",
          "",
          "- Installer path is primary.",
          "- Diagnostics are enabled.",
          "- Office stays optional but available.",
          "",
          "```ts",
          "const status = 'green';",
          "```",
          "",
          "[Open README](https://github.com/goatcitadel/GoatCitadel)",
        ].join("\n"),
        timestamp: new Date(now - 75_000).toISOString(),
        tokenInput: 160,
        tokenOutput: 110,
        costUsd: 0.0026,
      });

      for (let index = 0; index < parsed.data.longThreadTurns; index += 1) {
        const offset = now - 60_000 + index * 1_000;
        messages.push({
          messageId: randomUUID(),
          sessionId: session.sessionId,
          role: (index % 2 === 0 ? "user" : "assistant") as ChatMessageRecord["role"],
          actorType: (index % 2 === 0 ? "user" : "agent") as ChatMessageRecord["actorType"],
          actorId: index % 2 === 0 ? "verification-operator" : "goatherder",
          content:
            index % 2 === 0
              ? `Verification long-thread prompt ${index + 1}`
              : `Verification long-thread response ${index + 1}`,
          timestamp: new Date(offset).toISOString(),
        });
      }
      storage.chatMessages.upsertMany(messages);
      let parentTurnId: string | undefined;
      let activeLeafTurnId: string | undefined;
      for (let index = 0; index < messages.length; index += 1) {
        const userMessage = messages[index];
        if (!userMessage || userMessage.role !== "user") {
          continue;
        }
        const assistantMessage = messages[index + 1]?.role === "assistant" ? messages[index + 1] : undefined;
        const turnId = randomUUID();
        storage.chatTurnTraces.create({
          turnId,
          sessionId: session.sessionId,
          userMessageId: userMessage.messageId,
          parentTurnId,
          assistantMessageId: assistantMessage?.messageId,
          status: assistantMessage ? "completed" : "running",
          mode: "chat",
          model: assistantMessage ? "verification-seed" : undefined,
          webMode: "auto",
          memoryMode: "auto",
          thinkingLevel: "standard",
          startedAt: userMessage.timestamp,
          finishedAt: assistantMessage?.timestamp ?? userMessage.timestamp,
        });
        parentTurnId = turnId;
        activeLeafTurnId = turnId;
        if (assistantMessage) {
          index += 1;
        }
      }
      if (activeLeafTurnId) {
        storage.chatSessionBranchState.setActiveLeaf(session.sessionId, activeLeafTurnId);
      }
      storage.costLedger.insert({
        sessionId: session.sessionId,
        agentId: "goatherder",
        providerId: "verification-stub",
        modelId: "verification-model",
        tokenInput: 160,
        tokenOutput: 110,
        tokenCachedInput: 0,
        costUsd: 0.0026,
        createdAt: new Date(now - 75_000).toISOString(),
      });
      await seedVerificationCapabilityCandidate(storage, fastify.gatewayConfig.rootDir);
    } finally {
      storage.close();
    }

    return reply.code(201).send({
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
      sessionIds: sessions.map((item) => item.sessionId),
      sessionTitle: parsed.data.sessionTitle,
      candidateId: VERIFICATION_CAPABILITY_CANDIDATE_ID,
      candidateVersionId: VERIFICATION_CAPABILITY_CANDIDATE_VERSION_ID,
    });
  });

  fastify.post("/api/v1/dev/verification/chat-approval-scenario", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = chatApprovalScenarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const now = new Date().toISOString();
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const storage = fastify.services.devVerification.storage;

    const approval = await fastify.services.devVerification.createApproval({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: {
        sessionId: parsed.data.sessionId,
        turnId,
        workspaceId: parsed.data.workspaceId,
        command: "pnpm test",
      },
      preview: {
        title: "Verification chat approval",
        command: "pnpm test",
      },
      linkage: {
        sessionId: parsed.data.sessionId,
        turnId,
        workspaceId: parsed.data.workspaceId,
      },
    });
    const approvalWaitRunId = storage.approvalWaitRuns.getRunId(approval.approvalId);
    const chatTurnDurableWait = fastify.services.devVerification.seedDurableChatWait({
      workspaceId: parsed.data.workspaceId,
      sessionId: parsed.data.sessionId,
      turnId,
      userMessageId,
      content: "Run the governed verification command.",
      authActorId: request.authActorId,
      authActorSource: request.authActorSource,
      traceStatus: "waiting_for_approval",
      waitForEvent: {
        eventKey: "approval.resolved",
        correlationId: approval.approvalId,
      },
      now,
    });

    storage.chatMessages.upsert({
      messageId: userMessageId,
      sessionId: parsed.data.sessionId,
      role: "user",
      actorType: "user",
      actorId: "verification-operator",
      content: "Run the governed verification command.",
      timestamp: now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: parsed.data.sessionId,
      userMessageId,
      assistantMessageId: chatTurnDurableWait.assistantMessageId,
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      durable: {
        runId: chatTurnDurableWait.runId,
        status: "waiting",
        checkpointKind: "run_waiting",
      },
      failure: {
        failureClass: "approval_required",
        message: "Waiting for verification approval.",
        retryable: true,
        recommendedAction: "approve_pending_step",
      },
      startedAt: now,
    });
    // The chat thread response hydrates `trace.toolRuns` from this table, and
    // the client's `deriveThreadPendingApproval` requires a toolRun with
    // status: "approval_required" before it will surface the prompt. Without
    // this row the thread-driven effect in useChatOutboundExecution.ts clobbers
    // the queue-derived pendingApproval back to null, causing the visual lane's
    // chat-pending-approval scenario to flake.
    storage.chatToolRuns.create({
      toolRunId: randomUUID(),
      turnId,
      sessionId: parsed.data.sessionId,
      toolName: "shell.exec",
      status: "approval_required",
      approvalId: approval.approvalId,
      args: { command: "pnpm test" },
      startedAt: now,
    });
    storage.chatInlineApprovals.upsert({
      approvalId: approval.approvalId,
      sessionId: parsed.data.sessionId,
      turnId,
      kind: approval.kind,
      toolName: "shell.exec",
      status: "pending",
      reason: "Waiting for verification chat approval.",
      riskLevel: approval.riskLevel,
      expiresAt: approval.expiresAt,
      details: {
        scenario: "verification-chat-approval",
      },
      createdAt: now,
    });
    storage.chatSessionBranchState.setActiveLeaf(parsed.data.sessionId, turnId);
    await fastify.services.devVerification.settleDurableChatWait(chatTurnDurableWait.runId);

    return reply.code(201).send({
      sessionId: parsed.data.sessionId,
      workspaceId: parsed.data.workspaceId,
      turnId,
      userMessageId,
      approvalId: approval.approvalId,
      approvalWaitRunId,
      chatTurnDurableRunId: chatTurnDurableWait.runId,
    });
  });

  fastify.post("/api/v1/dev/verification/chat-attachment-evidence-scenario", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = chatAttachmentEvidenceScenarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(fastify.services.devVerification.seedChatAttachmentEvidence(parsed.data));
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  fastify.post("/api/v1/dev/verification/chat-user-input-scenario", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = chatUserInputScenarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const now = new Date().toISOString();
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const promptId = randomUUID();
    const storage = fastify.services.devVerification.storage;
    const content = "Help me choose the next verification step for this run.";
    const chatTurnDurableWait = fastify.services.devVerification.seedDurableChatWait({
      workspaceId: parsed.data.workspaceId,
      sessionId: parsed.data.sessionId,
      turnId,
      userMessageId,
      content,
      authActorId: request.authActorId,
      authActorSource: request.authActorSource,
      traceStatus: "waiting_for_user_input",
      waitForEvent: {
        eventKey: "chat.user_input.resolved",
        correlationId: promptId,
      },
      now,
    });

    storage.chatMessages.upsert({
      messageId: userMessageId,
      sessionId: parsed.data.sessionId,
      role: "user",
      actorType: "user",
      actorId: "verification-operator",
      content,
      timestamp: now,
    });
    storage.chatTurnTraces.create({
      turnId,
      sessionId: parsed.data.sessionId,
      userMessageId,
      assistantMessageId: chatTurnDurableWait.assistantMessageId,
      status: "waiting_for_user_input",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      pendingUserInput: {
        promptId,
        turnId,
        kind: "single_select",
        title: "Pick the next verification step",
        question: "Which path should the verification run take from here?",
        required: true,
        dismissible: false,
        submitLabel: "Submit answer",
        options: [
          {
            optionId: "option-a",
            label: "Continue with the current plan",
            description: "Keep the existing run posture and resume on the previous step.",
          },
          {
            optionId: "option-b",
            label: "Pause for manual review",
            description: "Hold the run so the operator can inspect intermediate evidence.",
          },
        ],
      },
      durable: {
        runId: chatTurnDurableWait.runId,
        status: "waiting",
        checkpointKind: "run_waiting",
      },
      startedAt: now,
    });
    storage.chatSessionBranchState.setActiveLeaf(parsed.data.sessionId, turnId);
    await fastify.services.devVerification.settleDurableChatWait(chatTurnDurableWait.runId);

    return reply.code(201).send({
      sessionId: parsed.data.sessionId,
      workspaceId: parsed.data.workspaceId,
      turnId,
      userMessageId,
      promptId,
      chatTurnDurableRunId: chatTurnDurableWait.runId,
    });
  });

  fastify.post("/api/v1/dev/verification/agentic-task-seed", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = agenticTaskSeedSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const items = parsed.data.tasks.map((item) => {
      const current = fastify.services.tasks.getTask(item.taskId, { workspaceId: parsed.data.workspaceId });
      return fastify.services.tasks.updateTaskWithRevision(
        item.taskId,
        {
          agenticContext: {
            ...(current.agenticContext ?? {}),
            runId: item.runId,
            status: item.status,
            surface: item.surface,
            contextMode: "isolated",
            parentSessionId: item.parentSessionId,
          },
        },
        current.revision,
        { workspaceId: parsed.data.workspaceId },
      );
    });
    return reply.code(201).send({ items });
  });

  fastify.post("/api/v1/dev/verification/memory-item-seed", async (request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = memoryItemSeedSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const storage = fastify.services.devVerification.storage;
    const itemId = `mem_${randomUUID().replace(/-/g, "")}`;
    const now = new Date().toISOString();
    const requestAbort = createRequestAbortScope(request, reply);
    let metadataWithEmbedding: Record<string, unknown>;
    try {
      metadataWithEmbedding = await withMemoryEmbeddingMetadata(
        parsed.data.metadata ?? {},
        `${parsed.data.title}\n${parsed.data.content}`,
        undefined,
        {
          signal: requestAbort.signal,
          ...(fastify.services.devVerification.acquireLocalEmbeddingLease
            ? { acquireLocalServiceLease: fastify.services.devVerification.acquireLocalEmbeddingLease }
            : {}),
        },
      );
    } finally {
      requestAbort.dispose();
    }
    storage.db
      .prepare(
        `
        INSERT INTO memory_items (
          item_id,
          workspace_id,
          namespace,
          title,
          content,
          metadata_json,
          pinned,
          ttl_override_seconds,
          expires_at,
          status,
          created_at,
          updated_at,
          forgotten_at
        ) VALUES (
          @itemId,
          @workspaceId,
          @namespace,
          @title,
          @content,
          @metadataJson,
          @pinned,
          NULL,
          NULL,
          'active',
          @createdAt,
          @updatedAt,
          NULL
        )
      `,
      )
      .run({
        itemId,
        workspaceId: parsed.data.workspaceId,
        namespace: parsed.data.namespace,
        title: parsed.data.title,
        content: parsed.data.content,
        metadataJson: JSON.stringify(metadataWithEmbedding),
        pinned: parsed.data.pinned ? 1 : 0,
        createdAt: now,
        updatedAt: now,
      });

    return reply.code(201).send({
      itemId,
      workspaceId: parsed.data.workspaceId,
      namespace: parsed.data.namespace,
      title: parsed.data.title,
      content: parsed.data.content,
      pinned: parsed.data.pinned ?? false,
      lifecycleState: "active",
      createdAt: now,
      updatedAt: now,
    });
  });

  fastify.post("/api/v1/dev/verification/durable-recovery-seed", async (_request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }

    const now = new Date().toISOString();
    const orphanLeaseHeartbeatAt = new Date(Date.now() - 30_000).toISOString();
    const orphanLeaseExpiresAt = new Date(Date.now() - 15_000).toISOString();
    const orphanApproval = await fastify.services.devVerification.createApproval({
      kind: "verification.approval.wait",
      riskLevel: "danger",
      payload: {
        scope: "durable-recovery",
        scenario: "orphaned-approval-wait",
      },
      preview: {
        title: "Verification orphaned approval wait",
      },
    });
    const orphanApprovalResolved = fastify.services.devVerification.storage.approvals.resolve(
      orphanApproval.approvalId,
      {
        decision: "approve",
        resolvedBy: "verification-seed",
        resolutionNote: "Seeded resolved approval for orphan recovery verification.",
      },
    );
    const orphanRunId = fastify.services.devVerification.storage.approvalWaitRuns.getRunId(orphanApproval.approvalId);
    if (!orphanRunId) {
      return reply.code(500).send({ error: "Failed to seed orphan approval wait run." });
    }
    fastify.services.devVerification.storage.approvalWaitRuns.markResolved(
      orphanApproval.approvalId,
      orphanApprovalResolved.resolvedAt,
    );
    const orphanRun = fastify.services.devVerification.storage.durableRuns.updateRun({
      runId: orphanRunId,
      status: "running",
      startedAt: now,
      clearFinishedAt: true,
      clearLastError: true,
      leaseOwnerId: "verification-orphan-worker",
      leaseHeartbeatAt: orphanLeaseHeartbeatAt,
      leaseExpiresAt: orphanLeaseExpiresAt,
      updatedAt: now,
    });

    const deadLetterApproval = await fastify.services.devVerification.createApproval({
      kind: "verification.approval.wait",
      riskLevel: "danger",
      payload: {
        scope: "durable-recovery",
        scenario: "dead-letter-approval-wait",
      },
      preview: {
        title: "Verification dead-letter approval wait",
      },
    });
    const deadLetterApprovalResolved = fastify.services.devVerification.storage.approvals.resolve(
      deadLetterApproval.approvalId,
      {
        decision: "approve",
        resolvedBy: "verification-seed",
        resolutionNote: "Seeded resolved approval for dead-letter recovery verification.",
      },
    );
    const deadLetterRunId = fastify.services.devVerification.storage.approvalWaitRuns.getRunId(
      deadLetterApproval.approvalId,
    );
    if (!deadLetterRunId) {
      return reply.code(500).send({ error: "Failed to seed dead-letter approval wait run." });
    }
    fastify.services.devVerification.storage.approvalWaitRuns.markResolved(
      deadLetterApproval.approvalId,
      deadLetterApprovalResolved.resolvedAt,
    );
    const deadLetterRun = fastify.services.devVerification.storage.durableRuns.updateRun({
      runId: deadLetterRunId,
      status: "dead_lettered",
      startedAt: now,
      finishedAt: now,
      lastError: "Seeded dead letter for durable recovery verification.",
      updatedAt: now,
    });
    const deadLetter = fastify.services.devVerification.storage.durableRuns.upsertDeadLetter({
      runId: deadLetterRunId,
      reason: "verification_seed_dead_letter",
      payload: {
        approvalId: deadLetterApproval.approvalId,
        scenario: "dead-letter-approval-wait",
      },
      createdAt: now,
    });

    return reply.code(201).send({
      orphanRecovery: {
        approvalId: orphanApproval.approvalId,
        runId: orphanRunId,
        status: orphanRun.status,
        leaseExpiresAt: orphanRun.leaseExpiresAt,
      },
      deadLetterRecovery: {
        approvalId: deadLetterApproval.approvalId,
        runId: deadLetterRunId,
        status: deadLetterRun.status,
        deadLetterId: deadLetter.deadLetterId,
      },
    });
  });

  fastify.post("/api/v1/dev/verification/realtime-truth-seed", async (_request, reply) => {
    if (!devVerificationEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }

    const storage = fastify.services.devVerification.storage.realtimeEvents;
    const oldCreatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // Use a near-future cutoff so the seed deterministically clears any retained preexisting
    // events before appending the explicit verification events. That guarantees a real replay gap.
    const pruneCutoff = new Date(Date.now() + 1000).toISOString();
    const staleEvent = storage.append(
      "verification_replay_gap_seed",
      "events",
      { kind: "verification_seed" },
      undefined,
      oldCreatedAt,
    );
    const prunedCount = storage.pruneOlderThan(pruneCutoff);
    const explicitEvent = fastify.services.devVerification.publishRealtime(
      "verification_memory_refresh",
      "memory",
      {
        kind: "verification_explicit_metadata",
        workspaceId: "default",
        summary: "Explicit metadata verification event.",
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          workspaceId: "default",
        },
      },
    );
    const compatibilityEvent = fastify.services.devVerification.publishRealtime("approval_hint_emitted", "approvals", {
      kind: "verification_compatibility_seed",
      note: "Compatibility fallback verification event.",
    });

    return reply.code(201).send({
      staleCursor: String(staleEvent.sequence),
      prunedCount,
      bounds: fastify.services.devVerification.getRealtimeEventSequenceBounds(),
      explicitEvent,
      compatibilityEvent,
    });
  });

  registerDevVerificationProviderExerciseRoute(fastify, devVerificationEnabled);
};

function createRequestAbortScope(
  request: FastifyRequest,
  reply: FastifyReply,
): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("dev_verification_memory_seed_client_aborted"));
    }
  };
  request.raw.once("aborted", abort);
  reply.raw.once("close", abort);
  if (request.raw.aborted) {
    abort();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    },
  };
}

const VERIFICATION_CAPABILITY_CANDIDATE_ID = "usability-browser-candidate";
const VERIFICATION_CAPABILITY_CANDIDATE_VERSION_ID = "usability-browser-candidate-v1";
const VERIFICATION_CAPABILITY_CANDIDATE_CREATED_AT = "2026-07-29T00:00:00.000Z";

async function seedVerificationCapabilityCandidate(storage: Storage, rootDir: string): Promise<void> {
  const bundleRoot = `data/capability-candidates/${VERIFICATION_CAPABILITY_CANDIDATE_ID}/${VERIFICATION_CAPABILITY_CANDIDATE_VERSION_ID}`;
  const manifestArtifact = await writeVerificationCandidateArtifact(
    rootDir,
    bundleRoot,
    "manifest.json",
    JSON.stringify(
      {
        schemaVersion: 1,
        candidateId: VERIFICATION_CAPABILITY_CANDIDATE_ID,
        versionId: VERIFICATION_CAPABILITY_CANDIDATE_VERSION_ID,
      },
      null,
      2,
    ),
    "application/json",
  );
  const instructionArtifact = await writeVerificationCandidateArtifact(
    rootDir,
    bundleRoot,
    "SKILL.md",
    [
      "---",
      "name: usability-browser-candidate",
      "description: Deterministic inspect-only capability candidate for isolated usability verification.",
      "---",
      "",
      "# Usability browser candidate",
      "",
      "This fixture remains inactive and must never enter the callable catalog without governance.",
      "",
    ].join("\n"),
    "text/markdown",
  );
  const proofArtifact = await writeVerificationCandidateArtifact(
    rootDir,
    bundleRoot,
    "proof.json",
    JSON.stringify({ fixture: true, callable: false, lifecycleState: "candidate" }, null, 2),
    "application/json",
  );
  const record: CandidateSkillVersionRecord = {
    candidateId: VERIFICATION_CAPABILITY_CANDIDATE_ID,
    versionId: VERIFICATION_CAPABILITY_CANDIDATE_VERSION_ID,
    sourceKind: "manual",
    title: "Usability browser candidate",
    summary: "Deterministic inspect-only capability candidate for isolated usability verification.",
    bundleRoot,
    lifecycleState: "candidate",
    manifestArtifact,
    instructionArtifact,
    proofArtifact,
    createdAt: VERIFICATION_CAPABILITY_CANDIDATE_CREATED_AT,
    updatedAt: VERIFICATION_CAPABILITY_CANDIDATE_CREATED_AT,
  };
  const existing = storage.candidateSkillVersions.find(VERIFICATION_CAPABILITY_CANDIDATE_VERSION_ID);
  if (existing) {
    if (existing.candidateId !== VERIFICATION_CAPABILITY_CANDIDATE_ID || existing.lifecycleState !== "candidate") {
      throw new Error("verification capability candidate identity or lifecycle state conflicts with canonical storage");
    }
    storage.skillAggregateRevisions.ensure(
      "candidate_skill",
      VERIFICATION_CAPABILITY_CANDIDATE_ID,
      VERIFICATION_CAPABILITY_CANDIDATE_CREATED_AT,
    );
    return;
  }
  storage.skillAggregateRevisions.createWithInitialRevision(
    "candidate_skill",
    VERIFICATION_CAPABILITY_CANDIDATE_ID,
    () => ({ value: storage.candidateSkillVersions.upsert(record), changed: true }),
    VERIFICATION_CAPABILITY_CANDIDATE_CREATED_AT,
  );
}

async function writeVerificationCandidateArtifact(
  rootDir: string,
  bundleRoot: string,
  filename: string,
  content: string,
  mimeType: string,
): Promise<CapabilityArtifactRecord> {
  const relPath = `${bundleRoot}/${filename}`;
  const targetPath = path.resolve(rootDir, ...relPath.split("/"));
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  return {
    artifactId: `usability-browser-candidate-${filename.replaceAll(/[^a-z0-9]+/giu, "-").replace(/^-|-$/gu, "")}`,
    relPath,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
    mimeType,
    createdAt: VERIFICATION_CAPABILITY_CANDIDATE_CREATED_AT,
  };
}
