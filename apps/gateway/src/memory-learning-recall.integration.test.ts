import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { Storage, createLocalAsyncStorage } from "@goatcitadel/storage";
import type { MemoryLearningRecord, TraceMemoryCandidateRecord } from "@goatcitadel/contracts";
import { memoryRoutes } from "./routes/memory.js";
import { MemoryRouteService } from "./services/memory-route-service.js";
import { MemoryLifecycleService } from "./services/memory-lifecycle-service.js";
import { MemoryContextService } from "./services/memory-context-service.js";
import { MemoryWriteGateService } from "./services/memory-write-gate-service.js";
import { OperatorProfileService } from "./services/operator-profile-service.js";
import { ChatLearnedMemoryService } from "./services/chat-learned-memory-service.js";

it("promotes through the public API, recalls after restart, corrects and forgets without leaking scope or rewriting history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-learning-recall-"));
  expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^gc-learning-recall-/u);
  const storage = new Storage({
    dbPath: path.join(root, "runtime.sqlite"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  const store = createLocalAsyncStorage(storage);
  const app = Fastify();
  try {
    const workspace = storage.workspaces.create({ name: "Memory fixture A" });
    const other = storage.workspaces.create({ name: "Memory fixture B" });
    for (const [sessionId, workspaceId, kind] of [
      ["source", workspace.workspaceId, "dm"],
      ["fresh", workspace.workspaceId, "dm"],
      ["group", workspace.workspaceId, "group"],
      ["other", other.workspaceId, "dm"],
    ] as const) {
      storage.sessions.upsert({
        sessionId,
        sessionKey: sessionId,
        kind,
        channel: "mission",
        account: "fixture",
        timestamp: new Date().toISOString(),
      });
      storage.chatSessionMeta.ensure(sessionId, new Date().toISOString(), workspaceId);
      storage.chatSessionMeta.patch(sessionId, { origin: "operator" });
    }
    let owner: MemoryLifecycleService;
    let failUpdates = false;
    let modelCalls = 0;
    const llm = {
      getRuntimeConfig: () => ({
        activeProviderId: "fixture",
        activeModel: "fixture",
        providers: [{ providerId: "fixture", apiStyle: "openai-chat-completions" }],
      }),
      chatCompletions: async () => {
        modelCalls++;
        throw new Error("Fixture uses deterministic fallback; no provider dispatch.");
      },
    };
    const config = {
      rootDir: root,
      assistant: {
        workspaceDir: "workspace",
        memory: {
          enabled: true,
          qmd: {
            enabled: true,
            minPromptChars: 1,
            maxContextTokens: 500,
            cacheTtlSeconds: 300,
            maxTranscriptEvents: 10,
            maxMemoryFiles: 36,
            maxBytesPerFile: 8000,
            allowedExtensions: [".md"],
            distiller: { fallbackCheapModel: "fixture", timeoutMs: 100 },
          },
        },
      },
      toolPolicy: { sandbox: { writeJailRoots: [path.join(root, "workspace")] } },
    };
    const makeContext = () =>
      new MemoryContextService(
        store,
        llm as never,
        config as never,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        (input) => owner.collectTrustedRecallSources(input),
        {
          search: (input) => owner.searchEligibleCorpus(input),
          validate: (input) => owner.validateRecallSources(input),
        },
      );
    let context = makeContext();
    const makeOwner = () =>
      new MemoryLifecycleService({
        context,
        learned: new ChatLearnedMemoryService({ storage: store }),
        maintenance: {} as never,
        learnings: store.memoryLearnings,
        recallStorage: store,
        recallRepository: store.memoryRecall,
        isMemoryRecallEnabled: () => true,
        isLearningRecallEnabled: async () => true,
        writeGate: new MemoryWriteGateService(),
        admin: {
          gatewaySql: store.gatewaySql,
          memoryQualityIssues: store.memoryQualityIssues,
          requireFeatureEnabled: () => undefined,
          publishRealtime: vi.fn(async () => {
            if (failUpdates) throw new Error("Synthetic realtime outage");
          }),
          tryParseJson: <T>(raw: string | null | undefined, fallback: T): T =>
            raw ? (JSON.parse(raw) as T) : fallback,
        },
        resolveLearnedMemoryPolicy: async () => ({ allowWrite: true }),
        resolveSessionWorkspaceId: async (sessionId) => (await store.chatSessionMeta.get(sessionId))?.workspaceId,
        readTranscriptOrEmpty: async () => [],
      });
    owner = makeOwner();
    const profile = new OperatorProfileService({
      storage: store,
      isFeatureEnabled: () => true,
      readTrustedLearnings: (workspaceId) => owner.collectTrustedStandingLearnings(workspaceId),
    });
    app.decorate("gatewayConfig", { assistant: { auth: { mode: "none" } } } as never);
    app.decorate("requireOperatorAuth", async (request, reply) => {
      if (request.headers.authorization !== "Bearer fixture-operator")
        return reply.code(401).send({ error: "Unauthorized" });
    });
    app.decorate("services", { memory: new MemoryRouteService(owner) } as never);
    await app.register(memoryRoutes);
    const headers = { authorization: "Bearer fixture-operator" };
    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/memory/trace-candidates",
      headers,
      payload: {
        workspaceId: workspace.workspaceId,
        candidateType: "operator_preference",
        sourceText: "We completed the report and the operator explicitly chose concise verdicts before details.",
        proposedInsight: "Prefer concise verdicts before details in reports.",
        confidence: 0.9,
      },
    });
    expect(proposed.statusCode, proposed.body).toBe(202);
    const candidate = proposed.json<TraceMemoryCandidateRecord>();
    const recall = (sessionId = "fresh", workspaceId = workspace.workspaceId) =>
      context.compose({
        scope: "chat",
        sessionId,
        workspaceId,
        prompt: "Recall the report preference about concise verdicts before details.",
        queryEmbedding: [1, 0],
      });
    expect((await recall()).citations.some((c) => c.sourceType === "memory_learning")).toBe(false);
    expect(
      (await app.inject({ method: "POST", url: `/api/v1/memory/trace-candidates/${candidate.candidateId}/promote` }))
        .statusCode,
    ).toBe(401);
    failUpdates = true;
    const promoted = await app.inject({
      method: "POST",
      url: `/api/v1/memory/trace-candidates/${candidate.candidateId}/promote`,
      headers,
      payload: { workspaceId: workspace.workspaceId, expectedReviewHash: candidate.reviewHash },
    });
    expect(promoted.statusCode, promoted.body).toBe(200);
    failUpdates = false;
    const learning = promoted.json<MemoryLearningRecord>();
    expect(learning.workspaceId).toBe(workspace.workspaceId);
    const first = await recall();
    expect(first.citations).toContainEqual(
      expect.objectContaining({
        sourceType: "memory_learning",
        sourceRef: learning.learningId,
        sourceHash: learning.sourceHash,
      }),
    );
    expect(first.contextText).toContain("concise verdicts");
    expect(await profile.composeFrozenProfileDigest(workspace.workspaceId)).toContain("concise verdicts");
    expect((await recall("group")).citations.some((c) => c.sourceType === "memory_learning")).toBe(false);
    expect((await recall("other")).citations.some((c) => c.sourceType === "memory_learning")).toBe(false);
    expect((await recall("missing")).citations.some((c) => c.sourceType === "memory_learning")).toBe(false);
    context = makeContext();
    owner = makeOwner();
    expect((await recall()).citations.some((c) => c.sourceRef === learning.learningId)).toBe(true);
    const corrected = await app.inject({
      method: "POST",
      url: `/api/v1/memory/learnings/${learning.learningId}/supersede`,
      headers,
      payload: {
        workspaceId: workspace.workspaceId,
        key: "reports.reply_length",
        type: "operator_preference",
        insight: "Prefer detailed explanations in reports.",
        authority: "operator",
        correctionTarget: { sourceRef: learning.learningId, expectedSourceHash: learning.sourceHash },
      },
    });
    expect(corrected.statusCode, corrected.body).toBe(200);
    const next = corrected.json<{ next: MemoryLearningRecord }>().next;
    const afterCorrection = await recall();
    expect(afterCorrection.citations.some((c) => c.sourceRef === learning.learningId)).toBe(false);
    expect(afterCorrection.contextText).not.toContain("concise verdicts");
    expect(await profile.composeFrozenProfileDigest(workspace.workspaceId)).toContain("detailed explanations");
    const forgotten = await app.inject({
      method: "POST",
      url: `/api/v1/memory/learnings/${next.learningId}/forget`,
      headers,
    });
    expect(forgotten.statusCode, forgotten.body).toBe(200);
    expect((await recall()).citations.some((c) => c.sourceType === "memory_learning")).toBe(false);
    expect(await profile.composeFrozenProfileDigest(workspace.workspaceId)).toBeUndefined();
    expect((await store.memoryContexts.get(first.contextId)).contextText).toContain("concise verdicts");
    expect(storage.operatorProfiles.getByWorkspace(workspace.workspaceId)).toBeUndefined();
    const capture = async (messageId: string, content: string) => {
      await store.chatMessages.upsert({
        messageId,
        sessionId: "source",
        role: "user",
        actorType: "user",
        actorId: "fixture-operator",
        sourceAuthority: "operator",
        content,
        timestamp: new Date().toISOString(),
      });
      expect(await store.chatMessages.get(messageId)).toMatchObject({ sourceAuthority: "operator", content });
      expect(await store.chatSessionMeta.get("source")).toMatchObject({
        workspaceId: workspace.workspaceId,
        lifecycleStatus: "active",
        origin: "operator",
      });
      const callsBefore = modelCalls;
      await owner.extractLearnedMemory("source", content, { role: "user", sourceRef: messageId });
      expect(modelCalls).toBe(callsBefore);
      return (
        await owner.listTraceMemoryCandidates({ workspaceId: workspace.workspaceId, status: "proposed", limit: 200 })
      ).find((item) => item.sourceMessageId === messageId || item.metadata?.sourceMessageId === messageId);
    };
    const natural = await capture("natural-save", "Remember that I prefer concise replies.");
    expect(natural).toBeDefined();
    expect((natural!.metadata?.claim as { value?: string })?.value).toBe("concise");
    const acceptedNatural = await app.inject({
      method: "POST",
      url: `/api/v1/memory/trace-candidates/${natural!.candidateId}/promote`,
      headers,
      payload: { workspaceId: workspace.workspaceId, expectedReviewHash: natural!.reviewHash },
    });
    expect(acceptedNatural.statusCode, acceptedNatural.body).toBe(200);
    const savedNatural = acceptedNatural.json<MemoryLearningRecord>();
    expect(savedNatural.claim?.identity.predicate).toBe("reply_length");
    expect(
      (
        await context.compose({
          scope: "chat",
          sessionId: "fresh",
          workspaceId: workspace.workspaceId,
          prompt: "Recall the preference for concise replies.",
        })
      ).citations.some((c) => c.sourceRef === savedNatural.learningId),
    ).toBe(true);
    const correction = await capture("natural-correction", "No, use detailed explanations from now on.");
    expect(correction).toBeDefined();
    expect(correction!.metadata?.correctionTarget).toEqual({
      sourceRef: savedNatural.learningId,
      expectedSourceHash: savedNatural.sourceHash,
    });
    expect((await store.memoryLearnings.get(savedNatural.learningId))?.status).toBe("trusted");
    const acceptedCorrection = await app.inject({
      method: "POST",
      url: `/api/v1/memory/trace-candidates/${correction!.candidateId}/promote`,
      headers,
      payload: { workspaceId: workspace.workspaceId, expectedReviewHash: correction!.reviewHash },
    });
    expect(acceptedCorrection.statusCode, acceptedCorrection.body).toBe(200);
    expect(acceptedCorrection.json<MemoryLearningRecord>().claim?.value).toBe("detailed");
    expect((await store.memoryLearnings.get(savedNatural.learningId))?.status).toBe("superseded");
    const inferred = await capture("natural-inferred", "Prefiero respuestas concisas.");
    expect(inferred?.status).toBe("proposed");
    expect(
      (await store.learnedMemory.listItemsBySession("source", 200)).some(
        (item) => item.content === "Prefiero respuestas concisas." && item.status === "active",
      ),
    ).toBe(false);
    await store.chatMessages.upsert({
      messageId: "natural-inferred",
      sessionId: "source",
      role: "user",
      actorType: "user",
      actorId: "fixture-operator",
      sourceAuthority: "operator",
      content: "That was temporary context.",
      timestamp: new Date().toISOString(),
    });
    const staleSource = await app.inject({
      method: "POST",
      url: `/api/v1/memory/trace-candidates/${inferred!.candidateId}/promote`,
      headers,
      payload: { workspaceId: workspace.workspaceId, expectedReviewHash: inferred!.reviewHash },
    });
    expect(staleSource.statusCode, staleSource.body).toBe(409);
    expect(
      (await owner.listTraceMemoryCandidates({ workspaceId: workspace.workspaceId, status: "proposed" })).some(
        (item) => item.candidateId === inferred!.candidateId,
      ),
    ).toBe(true);
    const ambiguous = await capture("natural-ambiguous", "No, use bullet points in replies from now on.");
    expect(ambiguous?.metadata?.clarification).toBe("Which saved preference should this replace?");
    const unresolved = await app.inject({
      method: "POST",
      url: `/api/v1/memory/trace-candidates/${ambiguous!.candidateId}/promote`,
      headers,
      payload: { workspaceId: workspace.workspaceId, expectedReviewHash: ambiguous!.reviewHash },
    });
    expect(unresolved.statusCode, unresolved.body).toBe(409);
  } finally {
    await app.close();
    await store.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
