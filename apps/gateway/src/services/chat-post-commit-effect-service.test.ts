import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitmentClassification } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import type { BackgroundReviewService } from "./background-review-service.js";
import { ChatPostCommitEffectService } from "./chat-post-commit-effect-service.js";
import { DurableWorkerInterruptionError } from "./durable-run-service.js";
import type { CommitmentClassifierService } from "./gateway/commitment-classifier-service.js";
import type { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { RealtimeEventService } from "./realtime-event-service.js";
import { SkillMutationService, type PreparedSkillMutationPlan } from "./skill-mutation-service.js";

const roots: string[] = [];
const storages: Storage[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ChatPostCommitEffectService canonical replay", () => {
  it("rolls back a commitment write when the receipt crashes and persists only the replay classification", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-commitment", "commitments", "worker-current");
    let classificationAttempt = 0;
    const classifyTurnForCommitments = vi.fn(async (): Promise<CommitmentClassification[]> => {
      classificationAttempt += 1;
      return [classification(`semantic-key-${classificationAttempt}`)];
    });
    const persistTurnCommitments = vi.fn((_input: unknown, classifications: CommitmentClassification[]) =>
      classifications.map((item, index) =>
        storage.agentCommitments.upsertByDedupe({
          commitmentId: `commitment-${classificationAttempt}-${index}`,
          sessionId: "session-1",
          workspaceId: "workspace-1",
          kind: item.kind,
          dueAt: item.dueAt,
          confidence: item.confidence,
          dedupeKey: item.dedupeKey,
          suggestedText: item.suggestedText,
        }),
      ),
    );
    const service = createService(storage, {
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });
    const originalUpdate = storage.durableRuns.updateRun.bind(storage.durableRuns);
    let failReceipt = true;
    const updateSpy = vi.spyOn(storage.durableRuns, "updateRun").mockImplementation((input) => {
      if (failReceipt && hasStage(input.metadata, "commitments_write")) {
        failReceipt = false;
        throw new Error("simulated crash after commitment write");
      }
      return originalUpdate(input);
    });

    await expect(service.execute(commitmentInput(), context("effect-commitment", "worker-current"))).rejects.toThrow(
      "simulated crash after commitment write",
    );
    expect(storage.agentCommitments.listBySession("session-1")).toEqual([]);

    updateSpy.mockRestore();
    await expect(
      service.execute(commitmentInput(), context("effect-commitment", "worker-current")),
    ).resolves.toMatchObject({
      status: "classified",
      persistedCount: 1,
    });
    await service.execute(commitmentInput(), context("effect-commitment", "worker-current"));

    expect(classifyTurnForCommitments).toHaveBeenCalledTimes(2);
    expect(persistTurnCommitments).toHaveBeenCalledTimes(2);
    expect(storage.agentCommitments.listBySession("session-1").map((item) => item.dedupeKey)).toEqual([
      "semantic-key-2",
    ]);
  });

  it("fences a stale worker after takeover and lets only the current owner commit", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-takeover", "commitments", "worker-new");
    const persistTurnCommitments = vi.fn(() => []);
    const service = createService(storage, {
      commitmentClassifier: {
        classifyTurnForCommitments: vi.fn(async () => [classification("takeover")]),
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });

    await expect(service.execute(commitmentInput(), context("effect-takeover", "worker-stale"))).rejects.toMatchObject({
      name: "DurableWorkerInterruptionError",
      kind: "lease_lost",
    } satisfies Partial<DurableWorkerInterruptionError>);
    expect(persistTurnCommitments).not.toHaveBeenCalled();

    await service.execute(commitmentInput(), context("effect-takeover", "worker-new"));
    expect(persistTurnCommitments).toHaveBeenCalledTimes(1);
  });

  it("advances the background counter and commits memory/skill writes once across replay", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-background", "background_review", "worker-current");
    storage.systemSettings.set("background_review_turns_since_v1", 4);
    const extractTurnMemoryFacts = vi.fn(async () => [
      { kind: "fact" as const, content: "Uses teal", confidence: 0.9 },
    ]);
    const suggestTurnSkill = vi.fn(async () => ({
      shouldAuthor: true,
      skillMarkdown: "---\nname: Teal workflow\ndescription: Reusable teal workflow.\n---\n# Teal workflow\n",
    }));
    const recordMemoryFacts = vi.fn(() => {
      storage.systemSettings.set("background-memory-write", 1);
      return { outcome: "applied" as const, record: {}, blockedFacts: [] };
    });
    const runImmediateTransaction = storage.runImmediateTransaction.bind(storage);
    let transactionDepth = 0;
    const transactionSpy = vi.spyOn(storage, "runImmediateTransaction").mockImplementation((work) =>
      runImmediateTransaction(() => {
        transactionDepth += 1;
        try {
          return work();
        } finally {
          transactionDepth -= 1;
        }
      }),
    );
    const prepareSuggestedSkillMutation = vi.fn(() => preparedSkillPlan("effect-background"));
    const applyPreparedSkillMutationFiles = vi.fn(() => expect(transactionDepth).toBe(0));
    const commitPreparedSkillMutation = vi.fn(() => {
      expect(transactionDepth).toBeGreaterThan(0);
      storage.systemSettings.set("background-skill-write", 1);
      return { skillId: "background-review-test" };
    });
    const realtime = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-test" });
    const liveListener = vi.fn();
    realtime.subscribeRealtime(liveListener);
    const service = createService(storage, {
      backgroundReview: {
        extractTurnMemoryFacts,
        suggestTurnSkill,
        recordMemoryFacts,
        prepareSuggestedSkillMutation,
        applyPreparedSkillMutationFiles,
        commitPreparedSkillMutation,
      } as unknown as BackgroundReviewService,
      publishRealtime: (eventType, source, payload) => realtime.publishRealtime(eventType, source, payload),
    });
    const originalUpdate = storage.durableRuns.updateRun.bind(storage.durableRuns);
    let failMemoryReceipt = true;
    const updateSpy = vi.spyOn(storage.durableRuns, "updateRun").mockImplementation((input) => {
      if (failMemoryReceipt && hasStage(input.metadata, "background_memory")) {
        failMemoryReceipt = false;
        throw new Error("simulated crash after memory write");
      }
      return originalUpdate(input);
    });

    await expect(service.execute(backgroundInput(), context("effect-background", "worker-current"))).rejects.toThrow(
      "simulated crash after memory write",
    );
    expect(storage.systemSettings.get("background-memory-write")).toBeUndefined();
    expect(storage.systemSettings.get<number>("background_review_turns_since_v1")?.value).toBe(0);
    expect(liveListener).not.toHaveBeenCalled();

    updateSpy.mockRestore();
    await service.execute(backgroundInput(), context("effect-background", "worker-current"));
    await service.execute(backgroundInput(), context("effect-background", "worker-current"));

    expect(extractTurnMemoryFacts).toHaveBeenCalledTimes(2);
    expect(recordMemoryFacts).toHaveBeenCalledTimes(2);
    expect(suggestTurnSkill).toHaveBeenCalledTimes(1);
    expect(prepareSuggestedSkillMutation).toHaveBeenCalledTimes(1);
    expect(applyPreparedSkillMutationFiles).toHaveBeenCalledTimes(1);
    expect(commitPreparedSkillMutation).toHaveBeenCalledTimes(1);
    expect(storage.systemSettings.get<number>("background-memory-write")?.value).toBe(1);
    expect(storage.systemSettings.get<number>("background-skill-write")?.value).toBe(1);
    expect(storage.systemSettings.get<number>("background_review_turns_since_v1")?.value).toBe(0);
    expect(liveListener).toHaveBeenCalledTimes(1);
    transactionSpy.mockRestore();
  });

  it("replays one persisted skill plan after the lifecycle and receipt transaction rolls back", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-skill-crash", "background_review", "worker-current");
    storage.systemSettings.set("background_review_turns_since_v1", 4);
    const mutation = createSkillMutationService(storage);
    const suggestTurnSkill = vi.fn(async () => ({
      shouldAuthor: true,
      skillMarkdown:
        "---\nname: Crash replay skill\ndescription: Exact durable crash replay skill.\n---\n# Original durable plan\n",
    }));
    const backgroundReview = createPreparedSkillBackground(mutation, suggestTurnSkill);
    const service = createService(storage, { backgroundReview });
    const originalUpdate = storage.durableRuns.updateRun.bind(storage.durableRuns);
    let failReceipt = true;
    const updateSpy = vi.spyOn(storage.durableRuns, "updateRun").mockImplementation((input) => {
      if (failReceipt && hasStage(input.metadata, "background_skill")) {
        failReceipt = false;
        throw new Error("simulated crash after skill files and lifecycle");
      }
      return originalUpdate(input);
    });

    await expect(service.execute(backgroundInput(), context("effect-skill-crash", "worker-current"))).rejects.toThrow(
      "simulated crash after skill files and lifecycle",
    );

    const plan = readPersistedSkillPlan(storage, "effect-skill-crash");
    const skillFilePath = path.join(mutation.selfSkillsRoot, plan.skillId, "SKILL.md");
    expect(fs.readFileSync(skillFilePath, "utf8")).toContain("Original durable plan");
    expect(storage.skillLifecycle.find(plan.skillId)).toBeUndefined();

    updateSpy.mockRestore();
    suggestTurnSkill.mockResolvedValue({
      shouldAuthor: true,
      skillMarkdown: "---\nname: Crash replay skill\ndescription: Different provider retry.\n---\n# Must not replace\n",
    });
    await service.execute(backgroundInput(), context("effect-skill-crash", "worker-current"));

    expect(suggestTurnSkill).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(skillFilePath, "utf8")).toContain("Original durable plan");
    expect(fs.readFileSync(skillFilePath, "utf8")).not.toContain("Must not replace");
    expect(storage.skillLifecycle.find(plan.skillId)?.provenance?.sourceRef).toBe("effect-skill-crash");
  });

  it("lets a takeover worker converge on the persisted plan after the stale worker loses its lease", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-skill-takeover", "background_review", "worker-stale");
    storage.systemSettings.set("background_review_turns_since_v1", 4);
    const mutation = createSkillMutationService(storage);
    const suggestTurnSkill = vi.fn(async () => ({
      shouldAuthor: true,
      skillMarkdown: "---\nname: Takeover skill\ndescription: Exact durable takeover skill.\n---\n# Takeover plan\n",
    }));
    let takeOverAfterFiles = true;
    const backgroundReview = createPreparedSkillBackground(mutation, suggestTurnSkill, () => {
      if (!takeOverAfterFiles) {
        return;
      }
      takeOverAfterFiles = false;
      const current = storage.durableRuns.getRun("effect-skill-takeover");
      storage.durableRuns.updateRun({
        runId: current.runId,
        status: "running",
        leaseOwnerId: "worker-new",
        leaseHeartbeatAt: new Date().toISOString(),
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        expectedVersion: current.version,
      });
    });
    const service = createService(storage, { backgroundReview });

    await expect(
      service.execute(backgroundInput(), context("effect-skill-takeover", "worker-stale")),
    ).rejects.toMatchObject({ name: "DurableWorkerInterruptionError", kind: "lease_lost" });
    const plan = readPersistedSkillPlan(storage, "effect-skill-takeover");
    expect(storage.skillLifecycle.find(plan.skillId)).toBeUndefined();

    await service.execute(backgroundInput(), context("effect-skill-takeover", "worker-new"));

    expect(suggestTurnSkill).toHaveBeenCalledTimes(1);
    expect(storage.skillLifecycle.find(plan.skillId)?.provenance?.sourceRef).toBe("effect-skill-takeover");
    expect(fs.readFileSync(path.join(mutation.selfSkillsRoot, plan.skillId, "SKILL.md"), "utf8")).toContain(
      "Takeover plan",
    );
  });

  it("rejects an unsafe suggested skill before durable plan persistence", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-skill-unsafe", "background_review", "worker-current");
    storage.systemSettings.set("background_review_turns_since_v1", 4);
    const mutation = createSkillMutationService(storage);
    const suggestTurnSkill = vi.fn(async () => ({
      shouldAuthor: true,
      skillMarkdown:
        "---\nname: Unsafe durable skill\ndescription: Unsafe generated helper.\n---\n# Run rm -rf / immediately\n",
    }));
    const service = createService(storage, {
      backgroundReview: createPreparedSkillBackground(mutation, suggestTurnSkill),
    });

    await expect(service.execute(backgroundInput(), context("effect-skill-unsafe", "worker-current"))).rejects.toThrow(
      /skill draft rejected/i,
    );

    const receipt = storage.durableRuns.getRun("effect-skill-unsafe").metadata?.generalChatPostCommitCanonical as
      | { backgroundSkillDecision?: unknown }
      | undefined;
    expect(receipt?.backgroundSkillDecision).toBeUndefined();
    expect(fs.existsSync(mutation.selfSkillsRoot) ? fs.readdirSync(mutation.selfSkillsRoot) : []).toEqual([]);
  });

  it("rolls back maintenance enqueue writes before the receipt, then creates exactly one run on replay", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-maintenance", "memory_maintenance", "worker-new");
    let enqueueAttempt = 0;
    const noteSuccessfulRootTurnSync = vi.fn(() => {
      enqueueAttempt += 1;
      const now = new Date().toISOString();
      const durableRun = storage.durableRuns.createRun({
        runId: `maintenance-durable-${enqueueAttempt}`,
        workflowKey: "memory.maintenance",
        metadata: { workspaceId: "workspace-1" },
      });
      const maintenanceRun = storage.memoryMaintenance.createRun({
        runId: `maintenance-run-${enqueueAttempt}`,
        durableRunId: durableRun.runId,
        workspaceId: "workspace-1",
        triggerSource: "hybrid_due",
        status: "queued",
        policySnapshot: {},
        sourceSessionCount: 0,
        changedArtifactCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      return {
        status: "enqueued" as const,
        workspaceId: "workspace-1",
        memoryMaintenanceRunId: maintenanceRun.runId,
        durableRunId: durableRun.runId,
      };
    });
    const realtime = new RealtimeEventService({ storage, getGatewayNodeId: () => "node-test" });
    const liveListener = vi.fn();
    const requestDurableRunProcessing = vi.fn();
    realtime.subscribeRealtime(liveListener);
    const service = createService(storage, {
      memoryMaintenance: { noteSuccessfulRootTurnSync } as unknown as MemoryMaintenanceService,
      publishRealtime: (eventType, source, payload) => realtime.publishRealtime(eventType, source, payload),
      requestDurableRunProcessing,
    });

    await expect(
      service.execute(maintenanceInput(), context("effect-maintenance", "worker-stale")),
    ).rejects.toMatchObject({ name: "DurableWorkerInterruptionError", kind: "lease_lost" });
    expect(noteSuccessfulRootTurnSync).not.toHaveBeenCalled();

    const originalUpdate = storage.durableRuns.updateRun.bind(storage.durableRuns);
    let failReceipt = true;
    const updateSpy = vi.spyOn(storage.durableRuns, "updateRun").mockImplementation((input) => {
      if (failReceipt && hasStage(input.metadata, "memory_maintenance_evaluation")) {
        failReceipt = false;
        throw new Error("simulated crash after maintenance enqueue");
      }
      return originalUpdate(input);
    });
    await expect(service.execute(maintenanceInput(), context("effect-maintenance", "worker-new"))).rejects.toThrow(
      "simulated crash after maintenance enqueue",
    );
    expect(storage.memoryMaintenance.listRuns("workspace-1")).toEqual([]);
    expect(storage.durableRuns.listRuns(20).filter((run) => run.workflowKey === "memory.maintenance")).toEqual([]);
    expect(liveListener).not.toHaveBeenCalled();
    expect(requestDurableRunProcessing).not.toHaveBeenCalled();

    updateSpy.mockRestore();
    await service.execute(maintenanceInput(), context("effect-maintenance", "worker-new"));
    await service.execute(maintenanceInput(), context("effect-maintenance", "worker-new"));

    expect(noteSuccessfulRootTurnSync).toHaveBeenCalledTimes(2);
    expect(storage.memoryMaintenance.listRuns("workspace-1")).toHaveLength(1);
    expect(storage.durableRuns.listRuns(20).filter((run) => run.workflowKey === "memory.maintenance")).toHaveLength(1);
    expect(liveListener).toHaveBeenCalledTimes(2);
    expect(requestDurableRunProcessing).toHaveBeenCalledTimes(2);
  });
});

function createStorage(): Storage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-post-commit-effects-"));
  roots.push(root);
  const storage = new Storage({
    dbPath: path.join(root, "goatcitadel.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  return storage;
}

function seedEffectRun(
  storage: Storage,
  runId: string,
  effect: "commitments" | "background_review" | "memory_maintenance",
  leaseOwnerId: string,
): void {
  storage.durableRuns.createRun({
    runId,
    workflowKey: "chat.post_commit.effect",
    status: "running",
    leaseOwnerId,
    leaseHeartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    metadata: { effect },
  });
}

function createService(
  storage: Storage,
  overrides: {
    commitmentClassifier?: CommitmentClassifierService;
    backgroundReview?: BackgroundReviewService;
    memoryMaintenance?: MemoryMaintenanceService;
    publishRealtime?: (eventType: string, source: string, payload: Record<string, unknown>) => void;
    requestDurableRunProcessing?: ReturnType<typeof vi.fn>;
  } = {},
): ChatPostCommitEffectService {
  return new ChatPostCommitEffectService({
    storage,
    commitmentClassifier:
      overrides.commitmentClassifier ??
      ({
        classifyTurnForCommitments: vi.fn(async () => []),
        persistTurnCommitments: vi.fn(() => []),
      } as unknown as CommitmentClassifierService),
    backgroundReview:
      overrides.backgroundReview ??
      ({
        extractTurnMemoryFacts: vi.fn(async () => []),
        suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
        recordMemoryFacts: vi.fn(),
        prepareSuggestedSkillMutation: vi.fn(() => undefined),
        applyPreparedSkillMutationFiles: vi.fn(),
        commitPreparedSkillMutation: vi.fn(),
      } as unknown as BackgroundReviewService),
    memoryMaintenance:
      overrides.memoryMaintenance ??
      ({ noteSuccessfulRootTurnSync: vi.fn(() => ({ status: "evaluated" })) } as unknown as MemoryMaintenanceService),
    isAutonomyDisabled: () => false,
    isReplayScratchSession: () => false,
    publishRealtime: overrides.publishRealtime ?? vi.fn(),
    requestDurableRunProcessing: overrides.requestDurableRunProcessing ?? vi.fn(),
  });
}

function context(effectRunId: string, leaseOwnerId: string) {
  return { effectRunId, leaseOwnerId, parentRunId: "parent-1", generationId: "generation-1" };
}

function commitmentInput() {
  return {
    effect: "commitments" as const,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    turnId: "turn-1",
    autonomous: false,
    userText: "Please follow up tomorrow.",
    assistantText: "I will check in.",
  };
}

function backgroundInput() {
  return {
    effect: "background_review" as const,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    turnId: "turn-1",
    delegatedChild: false,
    autonomous: false,
    userText: "Remember my teal preference.",
    assistantText: "Understood.",
  };
}

function maintenanceInput() {
  return {
    effect: "memory_maintenance" as const,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    turnId: "turn-1",
    delegatedChild: false,
  };
}

function classification(dedupeKey: string): CommitmentClassification {
  return {
    kind: "follow_up",
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    confidence: 0.95,
    dedupeKey,
    suggestedText: "How did it go?",
  };
}

function createSkillMutationService(storage: Storage): SkillMutationService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-post-commit-skills-"));
  roots.push(root);
  return new SkillMutationService({ rootDir: root, skillLifecycle: storage.skillLifecycle });
}

function createPreparedSkillBackground(
  mutation: SkillMutationService,
  suggestTurnSkill: ReturnType<typeof vi.fn>,
  afterApply?: () => void,
): BackgroundReviewService {
  return {
    extractTurnMemoryFacts: vi.fn(async () => []),
    suggestTurnSkill,
    recordMemoryFacts: vi.fn(),
    prepareSuggestedSkillMutation: (
      suggestion: { shouldAuthor: boolean; skillMarkdown?: string },
      sourceTurnId: string | undefined,
      effectRunId: string,
    ) => {
      if (!suggestion.shouldAuthor || !suggestion.skillMarkdown) {
        return undefined;
      }
      return mutation.prepareDurableSkillMutation({
        skillId: `background-review-${effectRunId}`,
        evaluationRunId: effectRunId,
        sourceTurnId,
        skillMarkdown: suggestion.skillMarkdown,
      });
    },
    applyPreparedSkillMutationFiles: (plan: PreparedSkillMutationPlan) => {
      mutation.applyPreparedSkillMutationFilesSync(plan);
      afterApply?.();
    },
    commitPreparedSkillMutation: (plan: PreparedSkillMutationPlan) => mutation.commitPreparedSkillMutation(plan),
  } as unknown as BackgroundReviewService;
}

function readPersistedSkillPlan(storage: Storage, effectRunId: string): PreparedSkillMutationPlan {
  const receipt = storage.durableRuns.getRun(effectRunId).metadata?.generalChatPostCommitCanonical as
    | { backgroundSkillDecision?: { shouldAuthor?: boolean; plan?: PreparedSkillMutationPlan } }
    | undefined;
  if (!receipt?.backgroundSkillDecision?.shouldAuthor || !receipt.backgroundSkillDecision.plan) {
    throw new Error("Expected a persisted background skill plan.");
  }
  return receipt.backgroundSkillDecision.plan;
}

function preparedSkillPlan(effectRunId: string): PreparedSkillMutationPlan {
  return {
    version: 1,
    skillId: "background-review-test",
    evaluationRunId: effectRunId,
    sourceTurnId: "turn-1",
    skillMarkdown: "---\nname: Background review test\ndescription: Durable test skill.\n---\n# Test\n",
    preparedAt: "2026-07-11T00:00:00.000Z",
    changeHash: "a".repeat(64),
  };
}

function hasStage(metadata: Record<string, unknown> | undefined, stage: string): boolean {
  const receipt = metadata?.generalChatPostCommitCanonical as { stages?: Record<string, unknown> } | undefined;
  return Boolean(receipt?.stages?.[stage]);
}
