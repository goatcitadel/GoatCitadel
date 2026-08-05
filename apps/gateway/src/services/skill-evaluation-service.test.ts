import { describe, expect, it, vi } from "vitest";
import type { CapabilityProposalRecord, SkillEvaluationRunRecord, SkillListItem } from "@goatcitadel/contracts";
import { SkillEvaluationService } from "./skill-evaluation-service.js";

describe("SkillEvaluationService", () => {
  it("scores instruction behavior, accepts only improved mutations, and does not write skill files", async () => {
    const skill = createSkill();
    const storage = createStorage();
    const service = new SkillEvaluationService({
      storage,
      listSkills: () => [skill],
      createCapabilityProposal: vi.fn(),
      recordSkillEvaluationSignal: vi.fn(() => ({
        signal: { signalId: "signal-1" } as never,
        candidate: { candidateId: "candidate-1" } as never,
      })),
    });

    const response = await service.runSkillEvaluation(skill.skillId, {
      scenarios: [
        {
          title: "Boundary check",
          prompt: "Use the skill outside scope.",
          expectedOutcome: "State boundaries and do not execute scripts.",
        },
      ],
      criteria: [
        {
          label: "No script execution",
          description: "Evaluation instructions explicitly avoid script execution.",
          requiredTerms: ["script", "execution", "approval"],
        },
      ],
    });

    expect(response.run.accepted).toBe(true);
    expect(response.run.operatorTruth).toMatchObject({ executesScripts: false, writesSkillFile: false });
    expect(response.run.mutation?.afterInstructionBody).toContain("Evaluation Hardening Notes");
    expect(skill.instructionBody).toBe("Use this skill for focused planning.");
    expect(response.run.ledgerSignalId).toBe("signal-1");
    expect(response.run.improvementCandidateId).toBe("candidate-1");
    expect(storage.runs.get(response.run.runId)).toMatchObject({ runId: response.run.runId });
  });

  it("creates proposal evidence without activating the candidate directly", async () => {
    const skill = createSkill();
    const storage = createStorage();
    const createCapabilityProposal = vi.fn((input) => {
      const now = "2026-05-04T00:00:00.000Z";
      const proposal: CapabilityProposalRecord = {
        proposalId: "proposal-1",
        proposalKind: "skill",
        status: "proposed",
        title: input.title,
        summary: input.summary,
        payload: input.payload,
        candidateId: input.candidateId,
        activationTargetId: input.activationTargetId,
        createdAt: now,
        updatedAt: now,
      };
      storage.proposals.set(proposal.proposalId, proposal);
      return proposal;
    });
    const service = new SkillEvaluationService({
      storage,
      listSkills: () => [skill],
      createCapabilityProposal,
      recordSkillEvaluationSignal: vi.fn(() => undefined),
    });

    const run = (await service.runSkillEvaluation(skill.skillId)).run;
    const response = await service.createSkillEvaluationProposal(run.runId);

    expect(createCapabilityProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalKind: "skill",
        activationTargetId: skill.skillId,
      }),
    );
    expect(response.proposal.status).toBe("proposed");
    expect(response.proposal.payload).toMatchObject({
      proposalType: "skill_revision",
      evaluationRunId: run.runId,
      operatorTruth: { proposalOnly: true },
    });
    expect(response.run.status).toBe("proposal_created");
  });
});

function createSkill(): SkillListItem {
  return {
    skillId: "planning",
    name: "Planning",
    source: "managed",
    dir: "skills/planning",
    declaredTools: [],
    requires: [],
    keywords: [],
    instructionBody: "Use this skill for focused planning.",
    mtime: "2026-05-04T00:00:00.000Z",
    state: "enabled",
    callable: true,
  };
}

function createStorage() {
  const runs = new Map<string, SkillEvaluationRunRecord>();
  const proposals = new Map<string, CapabilityProposalRecord>();
  return {
    runs,
    proposals,
    skillEvaluationRuns: {
      upsert(input: SkillEvaluationRunRecord) {
        runs.set(input.runId, input);
        return input;
      },
      get(runId: string) {
        const run = runs.get(runId);
        if (!run) {
          throw new Error("missing run");
        }
        return run;
      },
      listBySkill(skillId: string) {
        return Array.from(runs.values()).filter((run) => run.skillId === skillId);
      },
    },
    capabilityProposals: {
      find(proposalId: string) {
        return proposals.get(proposalId);
      },
    },
  } as never;
}
