import { expect, it } from "vitest";
import { ChatLearningReceiptService } from "./chat-learning-receipt-service.js";
function fixture() {
  const entry = {
    entryId: "entry",
    kind: "memory_context",
    metadata: {
      usageBinding: { operationId: "op", dispatchGeneration: "generation" },
      sourceCitations: [{ sourceType: "memory_learning", sourceRef: "used", sourceHash: "a".repeat(64) }],
    },
  };
  const deps = {
    storage: {
      chatSessionMeta: { get: async () => ({ workspaceId: "A", origin: "operator", lifecycleStatus: "active" }) },
      sessions: { getBySessionId: async () => ({ kind: "dm" }) },
      chatTurnTraces: {
        get: async () => ({ turnId: "t", sessionId: "s", userMessageId: "u", assistantMessageId: "a" }),
      },
      contextManifests: {
        maybeGetDetailByTurn: async () => ({ manifest: { turnId: "t", sessionId: "s" }, entries: [entry] }),
      },
      modelUsageEvents: {
        list: async () => ({
          items: [
            {
              workspaceId: "A",
              sessionId: "s",
              turnId: "t",
              operationId: "op",
              dispatchGeneration: "generation",
              transportStatus: "accepted",
              terminalOutcome: "succeeded",
            },
          ],
        }),
      },
      memoryLearnings: {
        get: async () => ({ learningId: "saved", workspaceId: "A", status: "trusted", sourceHash: "b".repeat(64) }),
      },
      backgroundLearningJobs: { listForSourceTurn: async () => [] },
      capabilityProposals: { find: async () => undefined },
      candidateSkillVersions: { find: async () => undefined },
    },
    memory: {
      listTraceMemoryCandidatesForTurn: async () => ({
        items: [
          {
            candidateId: "proposal",
            workspaceId: "A",
            status: "promoted",
            promotedLearningId: "saved",
            proposedInsight: "A reviewed lesson",
          },
        ],
        truncated: false,
      }),
    },
    readMemoryReady: async () => false,
  };
  return { deps, entry, service: new ChatLearningReceiptService(deps as never) };
}
it("distinguishes saved but not recall-ready from source use proven by a successful bound dispatch", async () => {
  const f = fixture(),
    result = await f.service.getTurnLearningReceipt("s", "t", "A");
  expect(result.applied[0]).toMatchObject({ ref: "saved", state: "saved_not_ready" });
  expect(result.usedSources).toEqual([
    expect.objectContaining({ ref: "used", sourceHash: "a".repeat(64), kind: "memory", state: "used_in_turn" }),
  ]);
  expect(result.usedSources.some((source) => source.ref === "saved")).toBe(false);
});
it("does not turn failed, foreign or legacy context into a use receipt", async () => {
  const f = fixture();
  f.deps.storage.modelUsageEvents.list = async () => ({ items: [] }) as never;
  expect((await f.service.getTurnLearningReceipt("s", "t", "A")).usedSources).toEqual([]);
  await expect(f.service.getTurnLearningReceipt("s", "t", "B")).rejects.toThrow();
  f.deps.storage.contextManifests.maybeGetDetailByTurn = async () =>
    ({ manifest: { turnId: "t", sessionId: "foreign" }, entries: [f.entry] }) as never;
  expect((await f.service.getTurnLearningReceipt("s", "t", "A")).usedSources).toEqual([]);
});
it("links the exact workspace-scoped skill version from a successful model dispatch", async () => {
  const f = fixture();
  const entry = {
    ...f.entry,
    kind: "system_message",
    metadata: {
      ...f.entry.metadata,
      admittedSkills: [
        { skillId: "extra:reviewed-abc", instructionSha256: "a".repeat(64), sourceRef: "candidate:c:v1" },
      ],
    },
  };
  f.deps.storage.contextManifests.maybeGetDetailByTurn = async () => ({
    manifest: { turnId: "t", sessionId: "s" },
    entries: [entry],
  });
  let workspaceId = "A";
  f.deps.storage.candidateSkillVersions.find = async () =>
    ({ candidateId: "c", versionId: "v1", workspaceId, title: "Weekly project brief" }) as never;
  const skill = async () =>
    (await f.service.getTurnLearningReceipt("s", "t", "A")).usedSources.find((source) => source.kind === "skill");
  expect(await skill()).toMatchObject({
    skillVersion: { name: "Weekly project brief", versionId: "v1" },
    href: "/library/candidate_skill/candidate%3Ac%3Av1?workspaceId=A",
  });
  workspaceId = "foreign";
  expect((await skill())?.skillVersion).toBeUndefined();
});
it("shows only the frozen skill batch containing the source turn and withholds unbound legacy job references", async () => {
  const f = fixture();
  const job = {
    jobId: "job",
    runId: "run",
    status: "completed",
    sources: [{ sourceTurnId: "t" }, { sourceTurnId: "other-turn" }],
    skillProposalIds: ["mine", "other"],
    stageResults: [
      { stage: "skill", from: 0, through: 1, skillProposalIds: ["mine"] },
      { stage: "skill", from: 1, through: 2, skillProposalIds: ["other"] },
    ],
  };
  f.deps.storage.backgroundLearningJobs.listForSourceTurn = async () => [job] as never;
  f.deps.storage.capabilityProposals.find = async (id: string) =>
    ({ candidateId: `candidate-${id}`, payload: { versionId: id } }) as never;
  f.deps.storage.candidateSkillVersions.find = async (id: string) =>
    ({
      workspaceId: "A",
      candidateId: `candidate-${id}`,
      versionId: id,
      instructionArtifact: { sha256: "a".repeat(64) },
      lifecycleState: "candidate",
    }) as never;
  expect(
    (await f.service.getTurnLearningReceipt("s", "t", "A")).proposals
      .filter((proposal) => proposal.kind === "skill")
      .map((proposal) => ({ proposalId: proposal.proposalId, href: proposal.href })),
  ).toEqual([{ proposalId: "mine", href: "/library/candidate_skill/candidate%3Acandidate-mine%3Amine?workspaceId=A" }]);
  f.deps.storage.backgroundLearningJobs.listForSourceTurn = async () => [{ ...job, stageResults: undefined }] as never;
  expect(
    (await f.service.getTurnLearningReceipt("s", "t", "A")).proposals.filter((proposal) => proposal.kind === "skill"),
  ).toEqual([]);
});

it("marks bounded standing-memory admission as partial and caps combined dispatch sources", async () => {
  const f = fixture();
  const entries = Array.from({ length: 3 }, (_, batch) => ({
    ...f.entry,
    kind: "system_message",
    metadata: {
      usageBinding: { operationId: "op", dispatchGeneration: "generation" },
      admittedMemories: Array.from({ length: 50 }, (_, index) => ({
        sourceType: "memory_learning",
        sourceRef: "standing-" + batch + "-" + index,
        sourceHash: "c".repeat(64),
      })),
    },
  }));
  f.deps.storage.contextManifests.maybeGetDetailByTurn = async () =>
    ({ manifest: { turnId: "t", sessionId: "s" }, entries }) as never;
  const result = await f.service.getTurnLearningReceipt("s", "t", "A");
  expect(result.truncated).toBe(true);
  expect(result.usedSources.length).toBeLessThanOrEqual(80);
  expect(result.usedSources.length).toBeGreaterThan(0);
});
