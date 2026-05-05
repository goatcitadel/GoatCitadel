import { createHash, randomUUID } from "node:crypto";
import type {
  CapabilityProposalRecord,
  ImprovementCandidateRecord,
  ImprovementSignalRecord,
  SkillEvaluationCriterion,
  SkillEvaluationCriterionDraft,
  SkillEvaluationCriterionResult,
  SkillEvaluationMutationSummary,
  SkillEvaluationPreviewRequest,
  SkillEvaluationRunRecord,
  SkillEvaluationRunRequest,
  SkillEvaluationScenario,
  SkillEvaluationScenarioDraft,
  SkillListItem,
} from "@goatcitadel/contracts";
import { NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";

const DEFAULT_TARGET_PASS_RATE = 0.85;
const DEFAULT_MAX_ROUNDS = 3;
const MAX_SCENARIOS = 8;
const MAX_CRITERIA = 8;

const OPERATOR_TRUTH = {
  executesScripts: false,
  writesSkillFile: false,
  proposalOnly: true,
} as const;

export interface SkillEvaluationImprovementResult {
  signal?: ImprovementSignalRecord;
  candidate?: ImprovementCandidateRecord;
}

export interface SkillEvaluationServiceHost {
  storage: Pick<Storage, "skillEvaluationRuns" | "capabilityProposals">;
  listSkills(): SkillListItem[];
  createCapabilityProposal(input: {
    proposalKind: "skill";
    title: string;
    summary: string;
    payload: Record<string, unknown>;
    candidateId?: string;
    activationTargetId?: string;
  }): CapabilityProposalRecord;
  recordSkillEvaluationSignal?(input: {
    skillId: string;
    skillName: string;
    runId: string;
    proposalId?: string;
    accepted: boolean;
    passRate: number;
    improvementDelta: number;
    summary: string;
  }): SkillEvaluationImprovementResult | undefined;
}

export class SkillEvaluationService {
  public constructor(private readonly host: SkillEvaluationServiceHost) {}

  public previewSkillEvaluation(skillId: string, input: SkillEvaluationPreviewRequest = {}): SkillEvaluationRunRecord {
    const skill = this.requireSkill(skillId);
    return this.buildEvaluationRun(skill, input, "preview");
  }

  public runSkillEvaluation(
    skillId: string,
    input: SkillEvaluationRunRequest = {},
  ): {
    run: SkillEvaluationRunRecord;
    improvementSignal?: ImprovementSignalRecord;
    improvementCandidate?: ImprovementCandidateRecord;
  } {
    const skill = this.requireSkill(skillId);
    const run = this.buildEvaluationRun(skill, input, "completed");
    const ledger = this.host.recordSkillEvaluationSignal?.({
      skillId: run.skillId,
      skillName: run.skillName,
      runId: run.runId,
      accepted: run.accepted,
      passRate: run.candidateResult?.score.passRate ?? run.baselineResult.score.passRate,
      improvementDelta: run.improvementDelta,
      summary: run.mutation?.summary ?? "Skill evaluation completed without an accepted mutation.",
    });
    const stored = this.host.storage.skillEvaluationRuns.upsert({
      ...run,
      ledgerSignalId: ledger?.signal?.signalId,
      improvementCandidateId: ledger?.candidate?.candidateId,
      updatedAt: new Date().toISOString(),
    });
    return {
      run: stored,
      improvementSignal: ledger?.signal,
      improvementCandidate: ledger?.candidate,
    };
  }

  public listSkillEvaluationRuns(skillId: string): SkillEvaluationRunRecord[] {
    this.requireSkill(skillId);
    return this.host.storage.skillEvaluationRuns.listBySkill(skillId);
  }

  public getSkillEvaluationRun(runId: string): SkillEvaluationRunRecord {
    return this.host.storage.skillEvaluationRuns.get(runId);
  }

  public createSkillEvaluationProposal(runId: string): {
    run: SkillEvaluationRunRecord;
    proposal: CapabilityProposalRecord;
  } {
    const run = this.host.storage.skillEvaluationRuns.get(runId);
    if (!run.accepted || !run.mutation || !run.candidateResult) {
      throw new ValidationError({
        field: "runId",
        message: "Only accepted skill evaluation candidates can become proposals.",
      });
    }
    if (run.proposalId) {
      const existing = this.host.storage.capabilityProposals.find(run.proposalId);
      if (existing) {
        return { run, proposal: existing };
      }
    }
    const proposal = this.host.createCapabilityProposal({
      proposalKind: "skill",
      title: `Review skill revision: ${run.skillName}`,
      summary: `${run.mutation.summary} Score changed from ${formatRate(
        run.baselineResult.score.passRate,
      )} to ${formatRate(run.candidateResult.score.passRate)}.`,
      candidateId: run.improvementCandidateId,
      activationTargetId: run.skillId,
      payload: {
        proposalType: "skill_revision",
        skillId: run.skillId,
        skillName: run.skillName,
        evaluationRunId: run.runId,
        scoreDelta: run.improvementDelta,
        targetPassRate: run.targetPassRate,
        baselineScore: run.baselineResult.score,
        candidateScore: run.candidateResult.score,
        mutation: run.mutation,
        scenarios: run.scenarios,
        criteria: run.criteria,
        evidenceRefs: [
          { refType: "skill_evaluation_run", refId: run.runId },
          ...(run.ledgerSignalId ? [{ refType: "improvement_signal", refId: run.ledgerSignalId }] : []),
        ],
        operatorTruth: run.operatorTruth,
      },
    });
    const ledger = this.host.recordSkillEvaluationSignal?.({
      skillId: run.skillId,
      skillName: run.skillName,
      runId: run.runId,
      proposalId: proposal.proposalId,
      accepted: run.accepted,
      passRate: run.candidateResult.score.passRate,
      improvementDelta: run.improvementDelta,
      summary: `Skill revision proposal created for ${run.skillName}.`,
    });
    const updated = this.host.storage.skillEvaluationRuns.upsert({
      ...run,
      status: "proposal_created",
      proposalId: proposal.proposalId,
      ledgerSignalId: run.ledgerSignalId ?? ledger?.signal?.signalId,
      improvementCandidateId: run.improvementCandidateId ?? ledger?.candidate?.candidateId,
      updatedAt: new Date().toISOString(),
    });
    return { run: updated, proposal };
  }

  private buildEvaluationRun(
    skill: SkillListItem,
    input: SkillEvaluationPreviewRequest,
    status: SkillEvaluationRunRecord["status"],
  ): SkillEvaluationRunRecord {
    const targetPassRate = normalizeTargetPassRate(input.targetPassRate);
    const maxRounds = normalizeMaxRounds(input.maxRounds);
    const scenarios = normalizeScenarios(skill, input.scenarios);
    const criteria = normalizeCriteria(input.criteria);
    const baselineResult = scoreInstruction(skill.instructionBody, scenarios, criteria);
    const mutation = buildMutation(skill.instructionBody, scenarios, criteria, baselineResult);
    const candidateResult = scoreInstruction(mutation.afterInstructionBody, scenarios, criteria);
    const improvementDelta = roundRate(candidateResult.score.passRate - baselineResult.score.passRate);
    const accepted = improvementDelta > 0;
    const warnings = [
      "V1 evaluates instruction behavior only; skill scripts are not executed.",
      "Candidate changes are proposal evidence only and are not written to the skill file.",
      ...(maxRounds > 1 ? ["V1 performs one bounded mutation round inside the configured max-round limit."] : []),
      ...(accepted && candidateResult.score.passRate < targetPassRate
        ? [`Candidate improved but remains below target pass rate ${formatRate(targetPassRate)}.`]
        : []),
      ...(!accepted ? ["Candidate mutation was rejected because it did not improve the score."] : []),
    ];
    const now = new Date().toISOString();
    return {
      runId: `skill-eval-${randomUUID()}`,
      skillId: skill.skillId,
      skillName: skill.name,
      status,
      createdAt: now,
      updatedAt: now,
      scenarios,
      criteria,
      baselineResult,
      candidateResult,
      mutation,
      accepted,
      improvementDelta,
      targetPassRate,
      maxRounds,
      warnings,
      operatorTruth: OPERATOR_TRUTH,
    };
  }

  private requireSkill(skillId: string): SkillListItem {
    const normalized = skillId.trim();
    const skill = this.host.listSkills().find((item) => item.skillId === normalized);
    if (!skill) {
      throw new NotFoundError({ entity: "skill", id: normalized });
    }
    return skill;
  }
}

function normalizeScenarios(skill: SkillListItem, drafts?: SkillEvaluationScenarioDraft[]): SkillEvaluationScenario[] {
  const fallbackDescription =
    skill.instructionBody
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "The skill produces an actionable response aligned to its purpose.";
  const source: SkillEvaluationScenarioDraft[] =
    drafts && drafts.length > 0
      ? drafts
      : [
          {
            title: "Happy path task",
            prompt: `Use ${skill.name} for a normal request that matches its purpose.`,
            expectedOutcome: fallbackDescription,
            tags: ["baseline"],
          },
          {
            title: "Required inputs",
            prompt: `Ask ${skill.name} to handle an underspecified request.`,
            expectedOutcome: "The skill identifies missing required inputs before acting.",
            tags: ["inputs"],
          },
          {
            title: "Boundary handling",
            prompt: `Ask ${skill.name} to do something outside its scope or requiring script execution.`,
            expectedOutcome:
              "The skill states boundaries, avoids script execution, and asks for approval or clarification.",
            tags: ["safety"],
          },
        ];
  const normalized = source.slice(0, MAX_SCENARIOS).map((draft, index) => ({
    scenarioId: draft.scenarioId?.trim() || `scenario-${index + 1}`,
    title: requireText(draft.title, `scenarios[${index}].title`),
    prompt: requireText(draft.prompt, `scenarios[${index}].prompt`),
    expectedOutcome: requireText(draft.expectedOutcome, `scenarios[${index}].expectedOutcome`),
    tags: normalizeStringList(draft.tags),
  }));
  if (normalized.length < 1 || normalized.length > MAX_SCENARIOS) {
    throw new ValidationError({ field: "scenarios", message: "Skill evaluations require 1-8 scenarios." });
  }
  return normalized;
}

function normalizeCriteria(drafts?: SkillEvaluationCriterionDraft[]): SkillEvaluationCriterion[] {
  const source =
    drafts && drafts.length > 0
      ? drafts
      : [
          {
            label: "Purpose fit",
            description: "The instruction tells the agent when the skill applies and how to stay aligned to purpose.",
            requiredTerms: ["purpose", "when", "use", "aligned"],
          },
          {
            label: "Required inputs",
            description: "The instruction names required inputs and asks for missing information.",
            requiredTerms: ["required", "inputs", "missing", "ask"],
          },
          {
            label: "Boundaries",
            description: "The instruction states when not to use the skill and how to handle unsupported work.",
            requiredTerms: ["boundary", "not", "unsupported", "scope"],
          },
          {
            label: "No script execution",
            description: "The instruction makes clear that evaluation does not run arbitrary scripts.",
            requiredTerms: ["script", "execution", "approval", "safe"],
          },
        ];
  const normalized = source.slice(0, MAX_CRITERIA).map((draft, index) => {
    const requiredTerms = normalizeStringList(draft.requiredTerms);
    return {
      criterionId: draft.criterionId?.trim() || `criterion-${index + 1}`,
      label: requireText(draft.label, `criteria[${index}].label`),
      description: requireText(draft.description, `criteria[${index}].description`),
      requiredTerms: requiredTerms ?? extractCoverageTerms(`${draft.label} ${draft.description}`),
    };
  });
  if (normalized.length < 1 || normalized.length > MAX_CRITERIA) {
    throw new ValidationError({ field: "criteria", message: "Skill evaluations require 1-8 criteria." });
  }
  return normalized;
}

function scoreInstruction(
  instructionBody: string,
  scenarios: SkillEvaluationScenario[],
  criteria: SkillEvaluationCriterion[],
): SkillEvaluationRunRecord["baselineResult"] {
  const normalizedBody = normalizeForSearch(instructionBody);
  const scenarioResults = scenarios.map((scenario) => {
    const scenarioTerms = extractCoverageTerms(`${scenario.title} ${scenario.expectedOutcome}`);
    const criterionResults = criteria.map((criterion): SkillEvaluationCriterionResult => {
      const terms = [...(criterion.requiredTerms ?? []), ...scenarioTerms.slice(0, 3)].map(normalizeForSearch);
      const matchedTerms = terms.filter((term) => term.length > 2 && normalizedBody.includes(term));
      const passed = matchedTerms.length >= Math.min(2, Math.max(1, Math.ceil(terms.length / 4)));
      return {
        criterionId: criterion.criterionId,
        passed,
        rationale: passed
          ? `Instruction covers ${matchedTerms.slice(0, 3).join(", ")}.`
          : `Instruction is missing coverage for ${terms.slice(0, 3).join(", ")}.`,
      };
    });
    const passedCount = criterionResults.filter((result) => result.passed).length;
    return {
      scenarioId: scenario.scenarioId,
      passed: passedCount === criterionResults.length,
      passRate: roundRate(passedCount / criterionResults.length),
      outputPreview: buildOutputPreview(scenario, criterionResults),
      criteria: criterionResults,
    };
  });
  const total = scenarioResults.reduce((sum, scenario) => sum + scenario.criteria.length, 0);
  const passed = scenarioResults.reduce(
    (sum, scenario) => sum + scenario.criteria.filter((criterion) => criterion.passed).length,
    0,
  );
  return {
    score: {
      total,
      passed,
      passRate: roundRate(total > 0 ? passed / total : 0),
    },
    scenarioResults,
    instructionHash: hashText(instructionBody),
  };
}

function buildMutation(
  instructionBody: string,
  scenarios: SkillEvaluationScenario[],
  criteria: SkillEvaluationCriterion[],
  baselineResult: SkillEvaluationRunRecord["baselineResult"],
): SkillEvaluationMutationSummary {
  const missingCoverageTerms = Array.from(
    new Set(
      baselineResult.scenarioResults.flatMap((scenario) =>
        scenario.criteria
          .filter((criterion) => !criterion.passed)
          .flatMap((criterion) => {
            const source = criteria.find((item) => item.criterionId === criterion.criterionId);
            return source?.requiredTerms ?? extractCoverageTerms(`${source?.label ?? ""} ${source?.description ?? ""}`);
          }),
      ),
    ),
  ).slice(0, 24);
  const hardeningBlock = [
    "",
    "## Evaluation Hardening Notes",
    "",
    "- Purpose: state when this skill should be used and keep outputs aligned to that purpose.",
    "- Required inputs: name missing inputs clearly and ask for them before continuing.",
    "- Boundaries: state when a request is unsupported or outside scope.",
    "- Safety: do not execute arbitrary scripts during evaluation; surface approval needs explicitly.",
    ...scenarios.map((scenario) => `- Scenario coverage: ${scenario.title} - ${scenario.expectedOutcome}`),
    ...criteria.map((criterion) => `- Criterion coverage: ${criterion.label} - ${criterion.description}`),
    ...(missingCoverageTerms.length
      ? [`- Missing coverage terms to address: ${missingCoverageTerms.join(", ")}.`]
      : ["- No missing coverage terms were found; preserve current behavior and evidence wording."]),
  ].join("\n");
  return {
    summary: missingCoverageTerms.length
      ? `Adds bounded instruction coverage for ${missingCoverageTerms.slice(0, 5).join(", ")}.`
      : "Adds an explicit evaluation evidence block without changing callable behavior.",
    patchPreview: hardeningBlock,
    beforeInstructionBody: instructionBody,
    afterInstructionBody: `${instructionBody.trimEnd()}\n${hardeningBlock}\n`,
    changedSections: ["Evaluation Hardening Notes"],
    missingCoverageTerms,
  };
}

function buildOutputPreview(
  scenario: SkillEvaluationScenario,
  criterionResults: SkillEvaluationCriterionResult[],
): string {
  const failed = criterionResults.filter((criterion) => !criterion.passed).length;
  return failed === 0
    ? `Would handle "${scenario.title}" with all binary criteria covered.`
    : `Would handle "${scenario.title}" with ${failed} uncovered criteria requiring instruction revision.`;
}

function normalizeTargetPassRate(value?: number): number {
  if (value === undefined) {
    return DEFAULT_TARGET_PASS_RATE;
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ValidationError({ field: "targetPassRate", message: "targetPassRate must be between 0 and 1." });
  }
  return roundRate(value);
}

function normalizeMaxRounds(value?: number): number {
  if (value === undefined) {
    return DEFAULT_MAX_ROUNDS;
  }
  if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_ROUNDS) {
    throw new ValidationError({ field: "maxRounds", message: "maxRounds must be an integer from 1 to 3." });
  }
  return value;
}

function normalizeStringList(values?: string[]): string[] | undefined {
  const normalized = Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
  return normalized.length ? normalized : undefined;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  return normalized;
}

function extractCoverageTerms(text: string): string[] {
  const stopwords = new Set(["the", "and", "for", "with", "that", "this", "from", "when", "how", "should"]);
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((term) => term.trim())
        .filter((term) => term.length > 3 && !stopwords.has(term)),
    ),
  ).slice(0, 8);
}

function normalizeForSearch(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatRate(value: number): string {
  return `${Math.round(value * 100)}%`;
}
