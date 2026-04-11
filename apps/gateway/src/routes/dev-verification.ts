import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { ChatCompletionRequest, ChatMessageRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";

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

const providerExerciseSchema = z.object({
  providerId: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  scenario: z.enum(["simple", "stream", "tools", "structured"]),
});

const chatApprovalScenarioSchema = z.object({
  sessionId: z.string().trim().min(1),
  workspaceId: z.string().trim().min(1),
});

export const devVerificationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/api/v1/dev/verification/status", async (_request, reply) => {
    if (!fastify.gateway.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const llmConfig = fastify.gateway.getLlmConfig();
    const providers = llmConfig.providers.map((provider) => {
      const status = fastify.gateway.getProviderSecretStatus(provider.providerId);
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
      diagnosticsEnabled: fastify.gateway.isDevDiagnosticsEnabled(),
      rootDir: fastify.gatewayConfig.rootDir,
      activeProviderId: llmConfig.activeProviderId,
      activeModel: llmConfig.activeModel,
      providers,
      latestDiagnosticsCount: fastify.gateway.listDevDiagnostics({ limit: 500 }).items.length,
    });
  });

  fastify.get("/api/v1/dev/verification/diagnostics-snapshot", async (request, reply) => {
    if (!fastify.gateway.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = listDiagnosticsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return reply.send(fastify.gateway.listDevDiagnostics(parsed.data));
  });

  fastify.post("/api/v1/dev/verification/seed", async (request, reply) => {
    if (!fastify.gateway.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = seedScenarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workspace = fastify.gateway.createWorkspace({
      name: parsed.data.workspaceName,
      slug: `verification-${randomUUID().slice(0, 8)}`,
      description: "Deterministic verification workspace seeded for automated testing.",
    });
    const sessions = [
      ...Array.from({ length: Math.max(0, parsed.data.sessionCount - 1) }, (_item, index) => (
        fastify.gateway.createChatSession({
          title: `${parsed.data.sessionTitle} ${index + 2}`,
          workspaceId: workspace.workspaceId,
        })
      )),
      fastify.gateway.createChatSession({
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
          "[Open README](https://github.com/spurnout/GoatCitadel)",
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
          content: index % 2 === 0
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
        const assistantMessage = messages[index + 1]?.role === "assistant"
          ? messages[index + 1]
          : undefined;
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
    } finally {
      storage.close();
    }

    return reply.code(201).send({
      workspaceId: workspace.workspaceId,
      sessionId: session.sessionId,
      sessionIds: sessions.map((item) => item.sessionId),
      sessionTitle: parsed.data.sessionTitle,
    });
  });

  fastify.post("/api/v1/dev/verification/chat-approval-scenario", async (request, reply) => {
    if (!fastify.gateway.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = chatApprovalScenarioSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const now = new Date().toISOString();
    const turnId = randomUUID();
    const userMessageId = randomUUID();
    const storage = fastify.gateway.storage;

    const approval = await fastify.gateway.createApproval({
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
    const chatTurnDurableRun = storage.durableRuns.createRun({
      workflowKey: "approval.wait",
      status: "waiting",
      payload: {
        version: "approval.wait.v1",
        approvalId: approval.approvalId,
        approvalKind: approval.kind,
        createdAt: approval.createdAt,
      },
      metadata: {
        surface: "chat",
        waitForEvent: {
          eventKey: "approval.resolved",
          correlationId: approval.approvalId,
        },
      },
      startedAt: now,
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
      status: "waiting_for_approval",
      mode: "chat",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      durable: {
        runId: chatTurnDurableRun.runId,
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

    return reply.code(201).send({
      sessionId: parsed.data.sessionId,
      workspaceId: parsed.data.workspaceId,
      turnId,
      userMessageId,
      approvalId: approval.approvalId,
      approvalWaitRunId,
      chatTurnDurableRunId: chatTurnDurableRun.runId,
    });
  });

  fastify.post("/api/v1/dev/verification/durable-recovery-seed", async (_request, reply) => {
    if (!fastify.gateway.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }

    const now = new Date().toISOString();
    const orphanApproval = await fastify.gateway.createApproval({
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
    const orphanApprovalResolved = fastify.gateway.storage.approvals.resolve(orphanApproval.approvalId, {
      decision: "approve",
      resolvedBy: "verification-seed",
      resolutionNote: "Seeded resolved approval for orphan recovery verification.",
    });
    const orphanRunId = fastify.gateway.storage.approvalWaitRuns.getRunId(orphanApproval.approvalId);
    if (!orphanRunId) {
      return reply.code(500).send({ error: "Failed to seed orphan approval wait run." });
    }
    fastify.gateway.storage.approvalWaitRuns.markResolved(orphanApproval.approvalId, orphanApprovalResolved.resolvedAt);
    fastify.gateway.storage.durableRuns.updateRun({
      runId: orphanRunId,
      status: "running",
      startedAt: now,
      finishedAt: undefined,
      lastError: undefined,
      updatedAt: now,
    });

    const deadLetterApproval = await fastify.gateway.createApproval({
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
    const deadLetterApprovalResolved = fastify.gateway.storage.approvals.resolve(deadLetterApproval.approvalId, {
      decision: "approve",
      resolvedBy: "verification-seed",
      resolutionNote: "Seeded resolved approval for dead-letter recovery verification.",
    });
    const deadLetterRunId = fastify.gateway.storage.approvalWaitRuns.getRunId(deadLetterApproval.approvalId);
    if (!deadLetterRunId) {
      return reply.code(500).send({ error: "Failed to seed dead-letter approval wait run." });
    }
    fastify.gateway.storage.approvalWaitRuns.markResolved(
      deadLetterApproval.approvalId,
      deadLetterApprovalResolved.resolvedAt,
    );
    fastify.gateway.storage.durableRuns.updateRun({
      runId: deadLetterRunId,
      status: "dead_lettered",
      startedAt: now,
      finishedAt: now,
      lastError: "Seeded dead letter for durable recovery verification.",
      updatedAt: now,
    });
    const deadLetter = fastify.gateway.storage.durableRuns.upsertDeadLetter({
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
      },
      deadLetterRecovery: {
        approvalId: deadLetterApproval.approvalId,
        runId: deadLetterRunId,
        deadLetterId: deadLetter.deadLetterId,
      },
    });
  });

  fastify.post("/api/v1/dev/verification/provider-exercise", async (request, reply) => {
    if (!fastify.gateway.isDevDiagnosticsEnabled()) {
      return reply.code(404).send({ error: "Development verification endpoints are disabled." });
    }
    const parsed = providerExerciseSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const startedAt = Date.now();
    try {
      const payload = buildProviderExercisePayload(parsed.data.scenario, parsed.data.providerId, parsed.data.model);
      if (parsed.data.scenario === "stream") {
        let chunkCount = 0;
        let preview = "";
        for await (const chunk of fastify.gateway.createChatCompletionStream(payload)) {
          chunkCount += 1;
          if (!preview) {
            preview = JSON.stringify(chunk).slice(0, 240);
          }
        }
        return reply.send({
          ok: true,
          providerId: payload.providerId,
          model: payload.model,
          scenario: parsed.data.scenario,
          elapsedMs: Date.now() - startedAt,
          chunkCount,
          outputPreview: preview,
        });
      }

      const result = await fastify.gateway.createChatCompletion(payload);
      const firstChoice = Array.isArray(result.choices) ? result.choices[0] : undefined;
      const content = typeof firstChoice?.message?.content === "string"
        ? firstChoice.message.content
        : JSON.stringify(firstChoice?.message?.content ?? "").slice(0, 240);
      return reply.send({
        ok: true,
        providerId: payload.providerId,
        model: payload.model,
        scenario: parsed.data.scenario,
        elapsedMs: Date.now() - startedAt,
        outputPreview: content.slice(0, 240),
      });
    } catch (error) {
      return reply.send({
        ok: false,
        providerId: parsed.data.providerId,
        model: parsed.data.model,
        scenario: parsed.data.scenario,
        elapsedMs: Date.now() - startedAt,
        error: (error as Error).message,
      });
    }
  });
};

function buildProviderExercisePayload(
  scenario: z.infer<typeof providerExerciseSchema>["scenario"],
  providerId?: string,
  model?: string,
): ChatCompletionRequest {
  const base: ChatCompletionRequest = {
    providerId,
    model,
    memory: {
      enabled: false,
      mode: "off",
    },
    messages: [
      {
        role: "system" as const,
        content: "You are a concise verification responder. Reply compactly.",
      },
      {
        role: "user" as const,
        content: scenario === "structured"
          ? "Return a short JSON object with keys summary and confidence."
          : "Reply with one short sentence confirming the provider is healthy.",
      },
    ],
  };

  if (scenario === "tools") {
    return {
      ...base,
      tools: [{
        type: "function",
        function: {
          name: "echo_status",
          description: "Echo a health status message.",
          parameters: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
          },
        },
      }],
      tool_choice: "auto",
    };
  }

  if (scenario === "structured") {
    if (providerId === "deepseek") {
      return {
        ...base,
        response_format: {
          type: "json_object",
        },
      };
    }
    return {
      ...base,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "verification_status",
          ...(providerId === "anthropic" ? { strict: true } : {}),
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              confidence: { type: "string" },
            },
            required: ["summary", "confidence"],
            additionalProperties: false,
          },
        },
      },
    };
  }

  if (scenario === "stream") {
    return {
      ...base,
      stream: true,
    };
  }

  return base;
}
