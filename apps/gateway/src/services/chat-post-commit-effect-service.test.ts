import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyViolationError, type CommitmentClassification } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import type { BackgroundReviewService } from "./background-review-service.js";
import {
  buildBackgroundReviewCounterSettingKey,
  ChatPostCommitEffectService,
  type ChatPostCommitEffectAuthorityPort,
  type ChatPostCommitEffectServiceDeps,
} from "./chat-post-commit-effect-service.js";
import type {
  ChatPostCommitAtomicStageAuthorityPort,
  ChatPostCommitEffectAuthorityContext,
} from "./chat-post-commit-effect-receipt.js";
import type { CommitmentClassifierService } from "./gateway/commitment-classifier-service.js";

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

describe("ChatPostCommitEffectService D3 authority and safe disposition", () => {
  it("keeps commitments live, orders the session guard before the domain write, and fast-replays", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-commitment", "commitments", "worker-current");
    const events: string[] = [];
    const authority = authorityHarness(events);
    const classifyTurnForCommitments = vi.fn(async () => {
      events.push("provider");
      return [classification("semantic-key")];
    });
    const persistTurnCommitments = vi.fn(() => {
      events.push("domain");
      storage.systemSettings.set("commitment-domain-write", 1);
      return [];
    });
    const service = createService(storage, {
      authority: authority.port,
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });
    const execution = context("effect-commitment", "worker-current");

    await expect(service.execute(commitmentInput(), execution)).resolves.toMatchObject({
      status: "classified",
      persistedCount: 0,
    });
    await expect(service.execute(commitmentInput(), execution)).resolves.toMatchObject({ status: "classified" });

    expect(events).toEqual(["predispatch", "provider", "guard", "domain", "settle:completed"]);
    expect(classifyTurnForCommitments).toHaveBeenCalledTimes(1);
    expect(persistTurnCommitments).toHaveBeenCalledTimes(1);
    expect(authority.predispatch).toHaveBeenCalledTimes(1);
    expect(authority.predispatch).toHaveBeenCalledWith(
      expect.objectContaining({ parentRunId: "parent-1", postCommitGenerationId: "generation-1" }),
    );
    expect(authority.run).toHaveBeenCalledTimes(1);
    expect(authority.run).toHaveBeenCalledWith(
      expect.objectContaining({
        parentRunId: "parent-1",
        postCommitGenerationId: "generation-1",
        childRunId: "effect-commitment",
        sourceTurnId: "turn-1",
        postCommitEligibility: frozenEligibility(),
      }),
      expect.any(Function),
    );
    expect(storage.systemSettings.get<number>("commitment-domain-write")?.value).toBe(1);
  });

  it("settles a predispatch denial as content-free late_blocked and never dispatches on replay", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-predispatch-late", "commitments", "worker-current");
    const authority = authorityHarness([], { predispatch: "late_blocked" });
    const classifyTurnForCommitments = vi.fn(async () => [classification("raw-secret-key")]);
    const persistTurnCommitments = vi.fn(() => []);
    const service = createService(storage, {
      authority: authority.port,
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });
    const execution = context("effect-predispatch-late", "worker-current");

    await expect(service.execute(commitmentInput(), execution)).resolves.toMatchObject({
      status: "late_blocked",
      disposition: "late_blocked",
    });
    await service.execute(commitmentInput(), execution);

    expect(classifyTurnForCommitments).not.toHaveBeenCalled();
    expect(persistTurnCommitments).not.toHaveBeenCalled();
    expect(authority.predispatch).toHaveBeenCalledTimes(1);
    expect(authority.run).toHaveBeenCalledTimes(1);
    const stage = canonicalStage(storage, "effect-predispatch-late", "commitments_write");
    expect(stage).toEqual({ completedAt: expect.any(String), disposition: "late_blocked" });
    expect("result" in stage).toBe(false);
  });

  it("drops provider output when the atomic authority guard turns late and never redispatches it", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-atomic-late", "commitments", "worker-current");
    const authority = authorityHarness([], { atomic: "late_blocked" });
    const classifyTurnForCommitments = vi.fn(async () => [
      {
        ...classification("provider-sensitive-key"),
        suggestedText: "RAW PROVIDER SUGGESTION MUST NOT PERSIST",
      },
    ]);
    const persistTurnCommitments = vi.fn(() => []);
    const service = createService(storage, {
      authority: authority.port,
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });
    const execution = context("effect-atomic-late", "worker-current");

    await service.execute(commitmentInput(), execution);
    await service.execute(commitmentInput(), execution);

    expect(classifyTurnForCommitments).toHaveBeenCalledTimes(1);
    expect(persistTurnCommitments).not.toHaveBeenCalled();
    const metadata = storage.durableRuns.getRun("effect-atomic-late").metadata;
    expect(JSON.stringify(metadata)).not.toContain("RAW PROVIDER SUGGESTION");
    expect(canonicalStage(storage, "effect-atomic-late", "commitments_write")).toEqual({
      completedAt: expect.any(String),
      disposition: "late_blocked",
    });
  });

  it("allowlists fast-replay stage results so legacy provider content is never returned", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-legacy-provider-result", "commitments", "worker-current");
    const run = storage.durableRuns.getRun("effect-legacy-provider-result");
    storage.durableRuns.updateRun({
      runId: run.runId,
      status: run.status,
      expectedVersion: run.version,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...(run.metadata ?? {}),
        generalChatPostCommitCanonical: {
          version: 1,
          effect: "commitments",
          stages: {
            commitments_write: {
              completedAt: new Date().toISOString(),
              result: {
                status: "classified",
                persistedCount: 1,
                suggestedText: "RAW PROVIDER CONTENT MUST NEVER REPLAY",
                skillMarkdown: "RAW LEGACY MARKDOWN MUST NEVER REPLAY",
              },
            },
          },
        },
      },
    });
    const classifyTurnForCommitments = vi.fn(async () => []);
    const service = createService(storage, {
      authority: authorityHarness([]).port,
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments: vi.fn(() => []),
      } as unknown as CommitmentClassifierService,
    });

    const result = await service.execute(commitmentInput(), context("effect-legacy-provider-result", "worker-current"));

    expect(result).toMatchObject({ status: "classified", persistedCount: 1 });
    expect(JSON.stringify(result)).not.toContain("RAW PROVIDER CONTENT");
    expect(JSON.stringify(result)).not.toContain("RAW LEGACY MARKDOWN");
    expect(classifyTurnForCommitments).not.toHaveBeenCalled();
  });

  it("lets the in-lock global autonomy check reduce allowed to late_blocked before the domain write", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-global-deny-flip", "commitments", "worker-current");
    let autonomyDisabled = false;
    const authority = authorityHarness([]);
    const classifyTurnForCommitments = vi.fn(async () => {
      autonomyDisabled = true;
      return [classification("provider-output-after-global-flip")];
    });
    const persistTurnCommitments = vi.fn(() => []);
    const service = createService(storage, {
      authority: authority.port,
      isAutonomyDisabled: () => autonomyDisabled,
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });

    await expect(
      service.execute(commitmentInput(), context("effect-global-deny-flip", "worker-current")),
    ).resolves.toMatchObject({ status: "late_blocked", disposition: "late_blocked" });

    expect(classifyTurnForCommitments).toHaveBeenCalledTimes(1);
    expect(persistTurnCommitments).not.toHaveBeenCalled();
    expect(authority.run).toHaveBeenCalledTimes(1);
    expect(canonicalStage(storage, "effect-global-deny-flip", "commitments_write")).toEqual({
      completedAt: expect.any(String),
      disposition: "late_blocked",
    });
  });

  it("fails closed when the frozen child identity and the authority port are not configured together", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-missing-port", "commitments", "worker-current");
    const classifyTurnForCommitments = vi.fn(async () => []);
    const withoutPort = createService(storage, {
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments: vi.fn(() => []),
      } as unknown as CommitmentClassifierService,
    });

    await expect(
      withoutPort.execute(commitmentInput(), context("effect-missing-port", "worker-current")),
    ).rejects.toThrow(/configured together/i);
    expect(classifyTurnForCommitments).not.toHaveBeenCalled();

    seedEffectRun(storage, "effect-missing-identity", "commitments", "worker-current");
    const withPort = createService(storage, { authority: authorityHarness([]).port });
    const noIdentity = {
      effectRunId: "effect-missing-identity",
      leaseOwnerId: "worker-current",
      parentRunId: "parent-1",
      generationId: "generation-1",
    };
    await expect(withPort.execute(commitmentInput(), noIdentity)).rejects.toThrow(/configured together/i);
  });

  it("fails closed when payload eligibility is missing or malformed and never dispatches a provider", async () => {
    const storage = createStorage();
    const classifyTurnForCommitments = vi.fn(async () => []);
    const commitmentClassifier = {
      classifyTurnForCommitments,
      persistTurnCommitments: vi.fn(() => []),
    } as unknown as CommitmentClassifierService;
    seedEffectRun(storage, "effect-eligibility-missing", "commitments", "worker-current");
    const missingService = createService(storage, {
      authority: authorityHarness([]).port,
      commitmentClassifier,
    });
    const { postCommitEligibility: _missing, ...missingInput } = commitmentInput();
    await expect(
      missingService.execute(missingInput, context("effect-eligibility-missing", "worker-current")),
    ).rejects.toThrow(/frozen authority does not match execution provenance/i);

    seedEffectRun(storage, "effect-eligibility-malformed", "commitments", "worker-current");
    const malformedInput = {
      ...commitmentInput(),
      postCommitEligibility: { ...frozenEligibility(), humanSession: "yes" },
    };
    await expect(
      missingService.execute(
        malformedInput as unknown as ReturnType<typeof commitmentInput>,
        context("effect-eligibility-malformed", "worker-current"),
      ),
    ).rejects.toThrow(/frozen authority does not match execution provenance/i);
    expect(classifyTurnForCommitments).not.toHaveBeenCalled();
  });

  it("uses N's frozen eligibility after delete/reactivate and never reads N+1 session metadata", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-old-incarnation", "commitments", "worker-current");
    // Represent the current reactivated N+1 row as prompt-pack/non-human. The
    // child authority remains explicitly frozen to N in `context(...)`.
    storage.chatSessionMeta.ensure("session-1", new Date().toISOString(), "workspace-1");
    storage.chatSessionMeta.patch("session-1", { origin: "prompt_pack" });
    const currentMetaRead = vi.spyOn(storage.chatSessionMeta, "get");
    const classifyTurnForCommitments = vi.fn(async () => [classification("frozen-n")]);
    const persistTurnCommitments = vi.fn(() => []);
    const service = createService(storage, {
      authority: authorityHarness([]).port,
      commitmentClassifier: {
        classifyTurnForCommitments,
        persistTurnCommitments,
      } as unknown as CommitmentClassifierService,
    });

    await expect(
      service.execute(commitmentInput(), context("effect-old-incarnation", "worker-current")),
    ).resolves.toMatchObject({ status: "classified" });

    expect(classifyTurnForCommitments).toHaveBeenCalledTimes(1);
    expect(persistTurnCommitments).toHaveBeenCalledTimes(1);
    expect(currentMetaRead).not.toHaveBeenCalled();
  });

  it("files operator facts with the governed review owner while keeping durable receipts content-free", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-background", "background_review", "worker-current");
    storage.systemSettings.set(buildBackgroundReviewCounterSettingKey("workspace-1"), 4);
    const legacyMutationCalls = {
      recordMemoryFacts: vi.fn(),
      prepareSuggestedSkillMutation: vi.fn(),
      applyPreparedSkillMutationFiles: vi.fn(),
      commitPreparedSkillMutation: vi.fn(),
      draftSkillMutation: vi.fn(),
    };
    const backgroundReview = {
      extractTurnMemoryFacts: vi.fn(async () => [
        { kind: "preference" as const, content: "The operator prefers teal accents.", confidence: 0.95 },
      ]),
      suggestTurnSkill: vi.fn(async () => ({
        shouldAuthor: true,
        summary: "RAW reusable CSV procedure must remain response-local",
      })),
      ...legacyMutationCalls,
    } as unknown as BackgroundReviewService;
    const proposeTraceMemoryCandidate = vi.fn(async () => ({ candidateId: "trace-review-1" }));
    const service = createService(storage, {
      authority: authorityHarness([], { readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version })
        .port,
      backgroundReview,
      proposeTraceMemoryCandidate,
    });

    const result = await service.execute(backgroundInput(), context("effect-background", "worker-current"));

    expect(result).toMatchObject({
      status: "evidence_recorded",
      memoryFactCount: 1,
      memoryReviewCandidateCount: 1,
      memoryReviewCandidateIds: ["trace-review-1"],
      skillProposed: true,
      promotionDisposition: "governed_trace_candidate_review_required",
    });
    expect(result.memoryEvidenceFingerprints).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(result.skillEvidenceFingerprint).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(proposeTraceMemoryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sourceSessionId: "session-1",
        sourceTurnId: "turn-1",
        proposedInsight: "The operator prefers teal accents.",
        candidateType: "operator_preference",
        metadata: expect.objectContaining({
          operatorProfileReviewCandidate: true,
          operatorProfileFactKind: "preference",
        }),
      }),
      "background-reviewer",
      "agent_proposed",
    );
    for (const call of Object.values(legacyMutationCalls)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(storage.skillLifecycle.list()).toEqual([]);
    const metadataText = JSON.stringify(storage.durableRuns.getRun("effect-background").metadata);
    expect(metadataText).not.toContain("The operator prefers teal accents.");
    expect(metadataText).not.toContain("RAW reusable CSV procedure");
    expect(metadataText).not.toContain("skillMarkdown");
    expect(metadataText).not.toContain("PreparedSkillMutationPlan");
  });

  it("runs the first eligible review per workspace, then returns to the five-turn cadence", async () => {
    const storage = createStorage();
    const extractTurnMemoryFacts = vi.fn(async () => [
      { kind: "goal" as const, content: "The operator wants concise release proof.", confidence: 0.9 },
    ]);
    let candidateSequence = 0;
    const proposeTraceMemoryCandidate = vi.fn(async (_input) => ({
      candidateId: `trace-review-${++candidateSequence}`,
    }));
    const service = createService(storage, {
      authority: authorityHarness([], { readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version })
        .port,
      backgroundReview: {
        extractTurnMemoryFacts,
        suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
      } as unknown as BackgroundReviewService,
      proposeTraceMemoryCandidate,
    });

    seedEffectRun(storage, "effect-warm-workspace-1", "background_review", "worker-current");
    await expect(
      service.execute(backgroundInput(), context("effect-warm-workspace-1", "worker-current")),
    ).resolves.toMatchObject({ status: "evidence_recorded", memoryReviewCandidateCount: 1 });

    seedEffectRun(storage, "effect-second-workspace-1", "background_review", "worker-current");
    await expect(
      service.execute(backgroundInput(), context("effect-second-workspace-1", "worker-current")),
    ).resolves.toMatchObject({ status: "skipped", reason: "counter_not_due" });

    seedEffectRun(storage, "effect-warm-workspace-2", "background_review", "worker-current");
    const workspaceTwoInput = { ...backgroundInput(), workspaceId: "workspace-2" };
    await expect(
      service.execute(
        workspaceTwoInput,
        context("effect-warm-workspace-2", "worker-current", { workspaceId: "workspace-2" }),
      ),
    ).resolves.toMatchObject({ status: "evidence_recorded", memoryReviewCandidateCount: 1 });

    expect(extractTurnMemoryFacts).toHaveBeenCalledTimes(2);
    expect(proposeTraceMemoryCandidate).toHaveBeenCalledTimes(2);
    expect(storage.systemSettings.get<number>(buildBackgroundReviewCounterSettingKey("workspace-1"))?.value).toBe(1);
    expect(storage.systemSettings.get<number>(buildBackgroundReviewCounterSettingKey("workspace-2"))?.value).toBe(0);
    expect(buildBackgroundReviewCounterSettingKey("workspace-1")).not.toContain("workspace-1");
  });

  it("records a governed rejection without leaking or directly applying the proposed fact", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-policy-rejection", "background_review", "worker-current");
    const service = createService(storage, {
      authority: authorityHarness([], { readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version })
        .port,
      backgroundReview: {
        extractTurnMemoryFacts: vi.fn(async () => [
          { kind: "constraint" as const, content: "Sensitive candidate text.", confidence: 0.9 },
        ]),
        suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
      } as unknown as BackgroundReviewService,
      proposeTraceMemoryCandidate: vi.fn(async () => {
        throw new PolicyViolationError({ message: "candidate blocked" });
      }),
    });

    const result = await service.execute(backgroundInput(), context("effect-policy-rejection", "worker-current"));

    expect(result).toMatchObject({
      status: "evidence_recorded",
      memoryReviewCandidateCount: 0,
      memoryReviewCandidateIds: [],
      memoryReviewCandidateRejectedCount: 1,
    });
    expect(JSON.stringify(storage.durableRuns.getRun("effect-policy-rejection").metadata)).not.toContain(
      "Sensitive candidate text.",
    );
    expect(storage.operatorProfiles.getByWorkspace("workspace-1")).toBeUndefined();
  });

  it("does not review delegated, autonomous, eval, or system turns", async () => {
    const storage = createStorage();
    const extractTurnMemoryFacts = vi.fn(async () => [
      { kind: "fact" as const, content: "This must never be proposed.", confidence: 0.95 },
    ]);
    const proposeTraceMemoryCandidate = vi.fn(async () => ({ candidateId: "must-not-exist" }));
    const service = createService(storage, {
      authority: authorityHarness([], { readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version })
        .port,
      backgroundReview: {
        extractTurnMemoryFacts,
        suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
      } as unknown as BackgroundReviewService,
      proposeTraceMemoryCandidate,
    });
    const cases = [
      {
        runId: "effect-delegated",
        workspaceId: "workspace-delegated",
        input: { delegatedChild: true },
        eligibility: frozenEligibility(),
        reason: "delegated_child",
      },
      {
        runId: "effect-autonomous",
        workspaceId: "workspace-autonomous",
        input: { autonomous: true },
        eligibility: frozenEligibility(),
        reason: "autonomous_turn",
      },
      {
        runId: "effect-eval",
        workspaceId: "workspace-eval",
        input: {},
        eligibility: { ...frozenEligibility(), evalIntegrityTurn: true },
        reason: "eval_integrity",
      },
      {
        runId: "effect-system",
        workspaceId: "workspace-system",
        input: {},
        eligibility: { ...frozenEligibility(), humanSession: false },
        reason: "non_human_session",
      },
      {
        runId: "effect-autonomy-disabled",
        workspaceId: "workspace-autonomy-disabled",
        input: {},
        eligibility: { ...frozenEligibility(), autonomyEnabledAtParentSettlement: false },
        reason: "autonomy_disabled",
      },
    ] as const;

    for (const item of cases) {
      seedEffectRun(storage, item.runId, "background_review", "worker-current");
      const input = {
        ...backgroundInput(),
        ...item.input,
        workspaceId: item.workspaceId,
        postCommitEligibility: item.eligibility,
      };
      await expect(
        service.execute(
          input,
          context(item.runId, "worker-current", {
            workspaceId: item.workspaceId,
            eligibility: item.eligibility,
          }),
        ),
      ).resolves.toMatchObject({ status: "skipped", reason: item.reason });
      expect(storage.systemSettings.get(buildBackgroundReviewCounterSettingKey(item.workspaceId))).toBeUndefined();
    }

    expect(extractTurnMemoryFacts).not.toHaveBeenCalled();
    expect(proposeTraceMemoryCandidate).not.toHaveBeenCalled();
  });

  it("retries idempotent retained evidence after an asynchronous publication failure", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-background-realtime-retry", "background_review", "worker-current");
    storage.systemSettings.set(buildBackgroundReviewCounterSettingKey("workspace-1"), 4);
    const publishRealtime = vi
      .fn()
      .mockRejectedValueOnce(new Error("retained realtime unavailable"))
      .mockResolvedValue(undefined);
    const service = createService(storage, {
      authority: authorityHarness([], { readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version })
        .port,
      publishRealtime,
    });
    const execution = context("effect-background-realtime-retry", "worker-current");

    await expect(service.execute(backgroundInput(), execution)).rejects.toThrow("retained realtime unavailable");
    await expect(service.execute(backgroundInput(), execution)).resolves.toMatchObject({ status: "evidence_recorded" });

    expect(publishRealtime).toHaveBeenCalledTimes(2);
    expect(publishRealtime.mock.calls[0]?.[2]).toEqual(publishRealtime.mock.calls[1]?.[2]);
  });

  it("replays an allowed background counter without re-guarding and terminalizes only the evidence stage", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-background-counter-replay", "background_review", "worker-current");
    storage.systemSettings.set(buildBackgroundReviewCounterSettingKey("workspace-1"), 4);
    const events: string[] = [];
    const authority = authorityHarness(events, {
      readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version,
    });
    const extractTurnMemoryFacts = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider interrupted after counter commit"))
      .mockResolvedValue([]);
    const service = createService(storage, {
      authority: authority.port,
      backgroundReview: {
        extractTurnMemoryFacts,
        suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
      } as unknown as BackgroundReviewService,
    });
    const execution = context("effect-background-counter-replay", "worker-current");

    await expect(service.execute(backgroundInput(), execution)).rejects.toThrow("provider interrupted");
    await expect(service.execute(backgroundInput(), execution)).resolves.toMatchObject({ status: "evidence_recorded" });

    expect(authority.run.mock.calls.map(([input]) => ({ stage: input.stage, terminal: input.terminal }))).toEqual([
      { stage: "background_counter", terminal: false },
      { stage: "background_evidence", terminal: true },
    ]);
    expect(events).toEqual(["predispatch", "guard", "retain:active", "predispatch", "guard", "settle:completed"]);
    expect(storage.systemSettings.get<number>(buildBackgroundReviewCounterSettingKey("workspace-1"))?.value).toBe(0);
  });

  it("treats a late background counter receipt as terminal and never re-enters the cancelled admission", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-background-counter-late", "background_review", "worker-current");
    storage.systemSettings.set(buildBackgroundReviewCounterSettingKey("workspace-1"), 4);
    const events: string[] = [];
    const authority = authorityHarness(events, { atomic: "late_blocked" });
    const extractTurnMemoryFacts = vi.fn(async () => []);
    const service = createService(storage, {
      authority: authority.port,
      backgroundReview: {
        extractTurnMemoryFacts,
        suggestTurnSkill: vi.fn(async () => ({ shouldAuthor: false })),
      } as unknown as BackgroundReviewService,
    });
    const execution = context("effect-background-counter-late", "worker-current");

    await expect(service.execute(backgroundInput(), execution)).resolves.toMatchObject({
      status: "late_blocked",
      disposition: "late_blocked",
    });
    await service.execute(backgroundInput(), execution);

    expect(authority.predispatch).toHaveBeenCalledTimes(1);
    expect(authority.run).toHaveBeenCalledTimes(1);
    expect(authority.run.mock.calls[0]?.[0]).toMatchObject({ stage: "background_counter", terminal: false });
    expect(events).toEqual(["predispatch", "guard", "settle:late_blocked"]);
    expect(extractTurnMemoryFacts).not.toHaveBeenCalled();
    expect(canonicalStage(storage, "effect-background-counter-late", "background_counter")).toEqual({
      completedAt: expect.any(String),
      disposition: "late_blocked",
    });
    expect(JSON.stringify(storage.durableRuns.getRun("effect-background-counter-late").metadata)).not.toContain(
      "background_evidence",
    );
  });

  it("drops a legacy raw background skill plan when the next evidence receipt commits", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-legacy-background", "background_review", "worker-current");
    const run = storage.durableRuns.getRun("effect-legacy-background");
    storage.durableRuns.updateRun({
      runId: run.runId,
      status: run.status,
      expectedVersion: run.version,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...(run.metadata ?? {}),
        generalChatPostCommitCanonical: {
          version: 1,
          effect: "background_review",
          stages: {
            background_counter: {
              completedAt: new Date().toISOString(),
              result: { due: true },
            },
            background_memory: {
              completedAt: new Date().toISOString(),
              result: { facts: ["RAW LEGACY MEMORY FACT MUST BE REMOVED"] },
            },
            background_skill: {
              completedAt: new Date().toISOString(),
              result: { skillMarkdown: "RAW LEGACY STAGE MARKDOWN MUST BE REMOVED" },
            },
          },
          backgroundSkillDecision: {
            version: 1,
            shouldAuthor: true,
            plan: { skillMarkdown: "RAW LEGACY SKILL MARKDOWN MUST BE REMOVED" },
          },
        },
      },
    });
    const service = createService(storage, {
      authority: authorityHarness([], {
        readDurableRunVersion: (runId) => storage.durableRuns.getRun(runId).version,
      }).port,
    });

    await service.execute(backgroundInput(), context("effect-legacy-background", "worker-current"));

    const metadataText = JSON.stringify(storage.durableRuns.getRun("effect-legacy-background").metadata);
    expect(metadataText).not.toContain("backgroundSkillDecision");
    expect(metadataText).not.toContain("RAW LEGACY SKILL MARKDOWN");
    expect(metadataText).not.toContain("RAW LEGACY MEMORY FACT");
    expect(metadataText).not.toContain("RAW LEGACY STAGE MARKDOWN");
  });

  it("keeps post-turn memory maintenance production-dark with no enqueue or maintenance call", async () => {
    const storage = createStorage();
    seedEffectRun(storage, "effect-maintenance", "memory_maintenance", "worker-current");
    const noteSuccessfulRootTurnSync = vi.fn();
    const requestDurableRunProcessing = vi.fn();
    const service = createService(storage, {
      authority: authorityHarness([]).port,
      legacyMemoryMaintenance: noteSuccessfulRootTurnSync,
      legacyRunRequest: requestDurableRunProcessing,
    });
    const execution = context("effect-maintenance", "worker-current");

    await expect(service.execute(maintenanceInput(), execution)).resolves.toMatchObject({
      status: "production_dark",
      enqueueDisposition: "not_enqueued",
    });
    await service.execute(maintenanceInput(), execution);

    expect(noteSuccessfulRootTurnSync).not.toHaveBeenCalled();
    expect(requestDurableRunProcessing).not.toHaveBeenCalled();
    expect(storage.memoryMaintenance.listRuns("workspace-1")).toEqual([]);
    expect(storage.durableRuns.listRuns(20).filter((run) => run.workflowKey === "memory.maintenance")).toEqual([]);
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
    attemptCount: 1,
    leaseOwnerId,
    leaseHeartbeatAt: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    metadata: { effect },
  });
}

function createService(
  storage: Storage,
  overrides: {
    authority?: ChatPostCommitEffectAuthorityPort;
    commitmentClassifier?: CommitmentClassifierService;
    backgroundReview?: BackgroundReviewService;
    proposeTraceMemoryCandidate?: ChatPostCommitEffectServiceDeps["proposeTraceMemoryCandidate"];
    isAutonomyDisabled?: () => boolean;
    publishRealtime?: ChatPostCommitEffectServiceDeps["publishRealtime"];
    legacyMemoryMaintenance?: ReturnType<typeof vi.fn>;
    legacyRunRequest?: ReturnType<typeof vi.fn>;
  } = {},
): ChatPostCommitEffectService {
  const deps = {
    storage: createSqliteAsyncStorage(storage),
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
      } as unknown as BackgroundReviewService),
    proposeTraceMemoryCandidate:
      overrides.proposeTraceMemoryCandidate ?? vi.fn(async (_input) => ({ candidateId: "trace-review-default" })),
    ...(overrides.authority ? { effectAuthority: overrides.authority } : {}),
    ...(!overrides.authority ? { allowUnfencedForTests: true as const } : {}),
    isAutonomyDisabled: async () => overrides.isAutonomyDisabled?.() ?? false,
    isReplayScratchSession: () => false,
    publishRealtime: overrides.publishRealtime ?? vi.fn(async () => undefined),
    // Deliberately unsupported legacy dependencies: tests prove the service never calls them.
    memoryMaintenance: { noteSuccessfulRootTurnSync: overrides.legacyMemoryMaintenance },
    requestDurableRunProcessing: overrides.legacyRunRequest,
  } as ChatPostCommitEffectServiceDeps & {
    memoryMaintenance: { noteSuccessfulRootTurnSync?: ReturnType<typeof vi.fn> };
    requestDurableRunProcessing?: ReturnType<typeof vi.fn>;
  };
  return new ChatPostCommitEffectService(deps);
}

function authorityHarness(
  events: string[],
  decisions: {
    predispatch?: "allowed" | "late_blocked";
    atomic?: "allowed" | "late_blocked";
    readDurableRunVersion?: (runId: string) => number;
  } = {},
) {
  const predispatch = vi.fn(async () => {
    events.push("predispatch");
    return decisions.predispatch ?? "allowed";
  });
  const atomicStage: ChatPostCommitAtomicStageAuthorityPort = {
    async run<_TValue>(input, callback) {
      events.push("guard");
      const authorityDisposition = decisions.atomic ?? "allowed";
      const callbackResult = await callback({
        disposition: authorityDisposition,
        admission: { admissionId: "active-child-admission" },
        durableRunVersion: decisions.readDurableRunVersion?.(input.childRunId) ?? 1,
      });
      if (authorityDisposition === "late_blocked" && callbackResult.disposition !== "late_blocked") {
        throw new Error("test authority callback attempted to upgrade late_blocked");
      }
      const disposition =
        authorityDisposition === "late_blocked" || callbackResult.disposition === "late_blocked"
          ? "late_blocked"
          : "allowed";
      const terminal = disposition === "late_blocked" || input.terminal;
      events.push(
        disposition === "late_blocked" ? "settle:late_blocked" : terminal ? "settle:completed" : "retain:active",
      );
      return {
        disposition,
        value: callbackResult.value,
        admission: { admissionId: terminal ? "terminal-child-admission" : "active-child-admission" },
      };
    },
  };
  const run = vi.spyOn(atomicStage, "run");
  return {
    predispatch,
    run,
    port: { predispatch, atomicStage } satisfies ChatPostCommitEffectAuthorityPort,
  };
}

function context(
  effectRunId: string,
  leaseOwnerId: string,
  options: {
    workspaceId?: string;
    sessionId?: string;
    turnId?: string;
    eligibility?: ReturnType<typeof frozenEligibility>;
  } = {},
) {
  return {
    effectRunId,
    leaseOwnerId,
    parentRunId: "parent-1",
    generationId: "generation-1",
    postCommitAuthority: authorityContext(effectRunId, leaseOwnerId, options),
  };
}

function authorityContext(
  effectRunId: string,
  leaseOwnerId: string,
  options: {
    workspaceId?: string;
    sessionId?: string;
    turnId?: string;
    eligibility?: ReturnType<typeof frozenEligibility>;
  } = {},
): ChatPostCommitEffectAuthorityContext {
  const workspaceId = options.workspaceId ?? "workspace-1";
  const sessionId = options.sessionId ?? "session-1";
  const turnId = options.turnId ?? "turn-1";
  return {
    parent: {
      admissionId: "parent-admission-1",
      sessionIncarnationId: "parent-incarnation-1",
      workspaceId,
      sessionId,
      turnId,
      aggregateRevision: 1,
      controllerGeneration: 1,
      materialSha256: "a".repeat(64),
    },
    child: {
      admissionId: `child-admission-${effectRunId}`,
      sessionIncarnationId: "parent-incarnation-1",
      workspaceId,
      sessionId,
      aggregateRevision: 1,
      controllerGeneration: 1,
      actorKind: "operator",
      actorId: "operator-1",
      operation: "chat_post_commit_child",
      materialSha256: "b".repeat(64),
    },
    childDurableClaim: { durableRunId: effectRunId, leaseOwnerId, attemptCount: 1 },
    postCommitEligibility: options.eligibility ?? frozenEligibility(),
  };
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
    postCommitEligibility: frozenEligibility(),
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
    postCommitEligibility: frozenEligibility(),
  };
}

function maintenanceInput() {
  return {
    effect: "memory_maintenance" as const,
    sessionId: "session-1",
    workspaceId: "workspace-1",
    turnId: "turn-1",
    delegatedChild: false,
    postCommitEligibility: frozenEligibility(),
  };
}

function frozenEligibility() {
  return {
    version: 1 as const,
    autonomyEnabledAtParentSettlement: true,
    evalIntegrityTurn: false,
    humanSession: true,
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

function canonicalStage(storage: Storage, runId: string, stage: string): Record<string, unknown> {
  const canonical = storage.durableRuns.getRun(runId).metadata?.generalChatPostCommitCanonical as
    | { stages?: Record<string, Record<string, unknown>> }
    | undefined;
  const receipt = canonical?.stages?.[stage];
  if (!receipt) {
    throw new Error(`Expected canonical stage ${stage}`);
  }
  return receipt;
}
