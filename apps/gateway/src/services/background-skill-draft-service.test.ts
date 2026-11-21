import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { BackgroundSkillDraftService } from "./background-skill-draft-service.js";
import type { LearningReviewSource } from "@goatcitadel/contracts";
import { loadApprovedCandidateSkill } from "./candidate-runtime-skills.js";
import {
  assertBackgroundSkillEvaluationCurrent,
  resolveBackgroundSkillEvaluationTarget,
} from "./background-skill-candidate-evidence.js";
import { SkillEvaluationService } from "./skill-evaluation-service.js";
const resources: { storage: Storage; root: string }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const r of resources.splice(0)) {
    r.storage.close();
    await fs.rm(r.root, { recursive: true, force: true });
  }
});
const markdown = [
  "---",
  "name: document-review",
  "description: Review supplied documents using repeatable evidence checks and explicit boundaries.",
  "---",
  "# Document review",
  ...Object.entries({
    "When to use": "Review a supplied document before publication.",
    Inputs: "A document and the expected requirements. Ask for missing inputs.",
    Instructions:
      "1. Read the supplied requirements.\n2. Compare each requirement with the document.\n3. Record discrepancies and their evidence.",
    "Failure handling": "Stop when the source is unavailable and ask for a readable copy.",
    Output: "A list of discrepancies with source references.",
    Verification: "Confirm every discrepancy against the original source.",
    Boundaries: "Do not publish or modify the supplied document. Ask for approval before any external action.",
  }).map(([heading, text]) => `## ${heading}\n${text}`),
].join("\n\n");
async function fixture(sourceCount = 1, freeze = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-background-skill-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  resources.push({ storage, root });
  const source: LearningReviewSource = {
    workspaceId: "default",
    sessionId: "s",
    sessionIncarnationId: "incarnation",
    controllerGeneration: 1,
    parentRunId: "parent",
    postCommitGenerationId: "generation",
    sourceTurnId: "turn",
    effectExecutionId: "effect",
    sourceHash: "a".repeat(64),
  };
  const queued = storage.backgroundLearningJobs.enqueue({ source, kind: "review", destinations: ["skill"], due: true });
  const batchSources = [source];
  for (let index = 2; index <= sourceCount; index++) {
    const next = {
      ...source,
      sourceTurnId: `turn-${index}`,
      parentRunId: `parent-${index}`,
      postCommitGenerationId: `generation-${index}`,
      effectExecutionId: `effect-${index}`,
    };
    batchSources.push(next);
    storage.backgroundLearningJobs.enqueue({ source: next, kind: "review", destinations: ["skill"], due: false });
    storage.chatTurnTraces.create({
      turnId: next.sourceTurnId,
      sessionId: "s",
      userMessageId: `u${index}`,
      assistantMessageId: `a${index}`,
      status: "completed",
      mode: "chat",
      webMode: "off",
      memoryMode: "auto",
      thinkingLevel: "standard",
      finishedAt: new Date().toISOString(),
      completion: { status: "complete", providerCallCount: 1, repaired: false },
    });
  }
  let job = storage.backgroundLearningJobs.get(queued.jobId)!;
  if (freeze) {
    const run = storage.durableRuns.tryClaimQueuedRunWithDatabaseClock({
      runId: job.runId,
      workerId: "skill-fixture",
      leaseDurationMs: 60_000,
    })!;
    job = storage.backgroundLearningJobs.freeze(job.jobId, { runId: run.runId, leaseOwnerId: run.leaseOwnerId! });
  }
  storage.chatTurnTraces.create({
    turnId: "turn",
    sessionId: "s",
    userMessageId: "u",
    assistantMessageId: "a",
    status: "completed",
    mode: "chat",
    webMode: "off",
    memoryMode: "auto",
    thinkingLevel: "standard",
    finishedAt: new Date().toISOString(),
    completion: { status: "complete", providerCallCount: 1, repaired: false },
  });
  vi.spyOn(storage.backgroundLearningJobs, "readEligibleSource").mockImplementation((input) => ({
    ...input,
    source: { ...input, sourceHash: source.sourceHash },
    userText: "Review this document",
    assistantText: "Compared the requirements and reported discrepancies.",
  }));
  const service = new BackgroundSkillDraftService({
    storage: createSqliteAsyncStorage(storage),
    rootDir: root,
    candidateRoot: "candidates",
  });
  return { root, storage, source, job, service, batchSources };
}
it("keeps two frozen source batches in one job distinct and replays each immutable draft", async () => {
  const f = await fixture(2),
    second = f.batchSources[1]!;
  const firstInput = { jobId: f.job.jobId, workspaceId: "default", sessionId: "s", sources: [f.source], markdown };
  const secondInput = { ...firstInput, sources: [second] };
  const first = await f.service.proposeBackgroundSkillDraft(firstInput),
    next = await f.service.proposeBackgroundSkillDraft(secondInput);
  expect(next.candidateId).not.toBe(first.candidateId);
  expect(next.versionId).not.toBe(first.versionId);
  expect(await f.service.proposeBackgroundSkillDraft(firstInput)).toEqual(first);
  expect(await f.service.proposeBackgroundSkillDraft(secondInput)).toEqual(next);
  expect(f.storage.capabilityProposals.list()).toHaveLength(2);
});
it("requires the frozen canonical source order before drafting and refuses reordered replay", async () => {
  const pending = await fixture(1, false);
  await expect(
    pending.service.proposeBackgroundSkillDraft({
      jobId: pending.job.jobId,
      workspaceId: "default",
      sessionId: "s",
      sources: [pending.source],
      markdown,
    }),
  ).rejects.toThrow(/frozen/i);
  const f = await fixture(2),
    input = { jobId: f.job.jobId, workspaceId: "default", sessionId: "s", sources: f.batchSources, markdown };
  await f.service.proposeBackgroundSkillDraft(input);
  await expect(
    f.service.proposeBackgroundSkillDraft({ ...input, sources: [...f.batchSources].reverse() }),
  ).rejects.toThrow(/frozen|order/i);
  expect(f.storage.capabilityProposals.list()).toHaveLength(1);
});
it("background_draft_is_inspectable_but_never_callable and replay returns the same version", async () => {
  const f = await fixture();
  const result = await f.service.proposeBackgroundSkillDraft({
    jobId: f.job.jobId,
    workspaceId: "default",
    sessionId: "s",
    sources: [f.source],
    markdown,
  });
  expect(result.activationPerformed).toBe(false);
  const candidate = f.storage.candidateSkillVersions.get(result.versionId);
  expect(candidate).toMatchObject({
    sourceKind: "background_workflow",
    lifecycleState: "candidate",
    createdByActorId: "system:background-learning",
  });
  expect(f.storage.candidateSkillVersions.listApprovedInstructions("default")).toEqual([]);
  expect(
    await loadApprovedCandidateSkill({
      rootDir: f.root,
      candidateRoot: path.join(f.root, "candidates"),
      workspaceId: "default",
      version: candidate,
    }),
  ).toBeUndefined();
  expect(
    await f.service.proposeBackgroundSkillDraft({
      jobId: f.job.jobId,
      workspaceId: "default",
      sessionId: "s",
      sources: [f.source],
      markdown,
    }),
  ).toEqual(result);
  expect(f.storage.capabilityProposals.list().length).toBe(1);
});
it("source changes, foreign work and failed turns cannot seed a background draft", async () => {
  const f = await fixture(),
    input = { jobId: f.job.jobId, workspaceId: "default", sessionId: "s", sources: [f.source], markdown };
  await expect(f.service.proposeBackgroundSkillDraft({ ...input, workspaceId: "foreign" })).rejects.toThrow();
  await expect(
    f.service.proposeBackgroundSkillDraft({ ...input, sources: [{ ...f.source, sourceHash: "b".repeat(64) }] }),
  ).rejects.toThrow();
  f.storage.chatTurnTraces.patch("turn", { completion: { status: "partial", providerCallCount: 1, repaired: false } });
  await expect(f.service.proposeBackgroundSkillDraft(input)).rejects.toThrow();
  expect(f.storage.candidateSkillVersions.list()).toEqual([]);
});
it("requires evaluation of the exact draft, rechecks canonical source evidence and loads only reviewed instructions", async () => {
  const f = await fixture(),
    storage = createSqliteAsyncStorage(f.storage),
    deps = { storage, rootDir: f.root, candidateRoot: "candidates" };
  const result = await f.service.proposeBackgroundSkillDraft({
    jobId: f.job.jobId,
    workspaceId: "default",
    sessionId: "s",
    sources: [f.source],
    markdown,
  });
  const version = f.storage.candidateSkillVersions.get(result.versionId);
  await expect(assertBackgroundSkillEvaluationCurrent(deps, version)).rejects.toThrow("Evaluate this exact draft");
  const evaluation = new SkillEvaluationService({
    storage,
    createCapabilityProposal: vi.fn(),
    resolveSkillForEvaluation: async (skillId) => {
      const candidate = await resolveBackgroundSkillEvaluationTarget(deps, skillId);
      return candidate ? { ...candidate.skill, skillId, candidateBinding: candidate.binding } : undefined;
    },
  });
  const evaluated = await evaluation.runSkillEvaluation(`candidate-version:${version.versionId}`, {
    scenarios: [
      { title: "Source task", prompt: "Review a supplied document", expectedOutcome: "Record discrepancies" },
      {
        title: "Unseen task",
        prompt: "Review an unrelated guide",
        expectedOutcome: "Check requirements and record evidence",
        tags: ["held_out"],
      },
    ],
    criteria: [
      { label: "Source evidence", description: "Records source evidence", requiredTerms: ["source", "evidence"] },
    ],
  });
  expect(evaluated.run.accepted).toBe(true);
  await expect(assertBackgroundSkillEvaluationCurrent(deps, version)).resolves.toBeUndefined();
  const approved = { ...version, lifecycleState: "approved" as const };
  // Projection fixture: actual approval/effect transitions are covered by the capability owner lane.
  expect(
    (
      await loadApprovedCandidateSkill({
        rootDir: f.root,
        candidateRoot: path.join(f.root, "candidates"),
        workspaceId: "default",
        version: approved,
      })
    )?.skill.instructionBody,
  ).toContain("Compare each requirement");
  expect(
    await loadApprovedCandidateSkill({
      rootDir: f.root,
      candidateRoot: path.join(f.root, "candidates"),
      workspaceId: "default",
      version: { ...approved, lifecycleState: "revoked" },
    }),
  ).toBeUndefined();
  vi.mocked(f.storage.backgroundLearningJobs.readEligibleSource).mockReturnValue(undefined);
  await expect(assertBackgroundSkillEvaluationCurrent(deps, version)).rejects.toThrow("current successful source");
});
