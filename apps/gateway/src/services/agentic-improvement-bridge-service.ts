import { createHash } from "node:crypto";
import type {
  AgenticCapabilityAvailability,
  AgenticDiagnosticSignal,
  AgenticImprovementEvidenceRef,
  AgenticImprovementProposalSummary,
  PromptPackRunRecord,
  PromptPackTestRecord,
} from "@goatcitadel/contracts";

type BridgeEvidenceSource = AgenticImprovementEvidenceRef["source"];

export interface AgenticDiagnosticProposalInput {
  diagnostic: AgenticDiagnosticSignal;
  runId?: string;
  taskId?: string;
  surface?: "chat" | "cowork" | "code";
  rollbackRef?: string;
}

export interface PromptLabInvalidRunProposalInput {
  run: PromptPackRunRecord;
  test?: Pick<PromptPackTestRecord, "code" | "title" | "diagnosticMetadata">;
  packName?: string;
  rollbackRef?: string;
}

export interface MissingCapabilityProposalInput {
  capability: AgenticCapabilityAvailability;
  requestedBy?: string;
  rollbackRef?: string;
}

export interface SkillDriftProposalInput {
  skillId: string;
  skillName: string;
  observedIssue: string;
  proposedChange?: string;
  driftRef?: string;
  severity?: "low" | "medium" | "high";
  rollbackRef?: string;
}

export interface MemoryMissProposalInput {
  missId: string;
  observedIssue: string;
  sessionId?: string;
  turnId?: string;
  query?: string;
  proposedChange?: string;
  rollbackRef?: string;
}

export interface RepeatedFailureProposalInput {
  failureId: string;
  failureClass: string;
  observedIssue: string;
  count: number;
  sampleRefs?: string[];
  proposedChange?: string;
  rollbackRef?: string;
}

export interface AgenticImprovementBridgeInput {
  diagnostics?: AgenticDiagnosticProposalInput[];
  promptLabInvalidRuns?: PromptLabInvalidRunProposalInput[];
  missingCapabilities?: MissingCapabilityProposalInput[];
  skillDrifts?: SkillDriftProposalInput[];
  memoryMisses?: MemoryMissProposalInput[];
  repeatedFailures?: RepeatedFailureProposalInput[];
}

export interface AgenticImprovementProposalActionStatuses {
  approve: "ready";
  reject: "ready";
  snooze: "ready";
}

export interface AgenticImprovementProposalTrust {
  reviewFirst: true;
  silentMutation: false;
  mutationApplied: false;
  requiresOperatorDecision: true;
}

export interface AgenticImprovementBridgeProposal extends AgenticImprovementProposalSummary {
  actionStatuses: AgenticImprovementProposalActionStatuses;
  trust: AgenticImprovementProposalTrust;
}

const REVIEW_ACTION_STATUSES: AgenticImprovementProposalActionStatuses = {
  approve: "ready",
  reject: "ready",
  snooze: "ready",
};

const REVIEW_FIRST_TRUST: AgenticImprovementProposalTrust = {
  reviewFirst: true,
  silentMutation: false,
  mutationApplied: false,
  requiresOperatorDecision: true,
};

export class AgenticImprovementBridgeService {
  public buildProposalSummaries(input: AgenticImprovementBridgeInput): AgenticImprovementBridgeProposal[] {
    return dedupeByProposalId([
      ...(input.diagnostics ?? []).map((item) => this.fromAgenticDiagnostic(item)),
      ...(input.promptLabInvalidRuns ?? []).map((item) => this.fromPromptLabInvalidRun(item)),
      ...(input.missingCapabilities ?? [])
        .filter((item) => item.capability.status !== "callable" || !item.capability.callable)
        .map((item) => this.fromMissingCapability(item)),
      ...(input.skillDrifts ?? []).map((item) => this.fromSkillDrift(item)),
      ...(input.memoryMisses ?? []).map((item) => this.fromMemoryMiss(item)),
      ...(input.repeatedFailures ?? []).map((item) => this.fromRepeatedFailure(item)),
    ]);
  }

  public fromAgenticDiagnostic(input: AgenticDiagnosticProposalInput): AgenticImprovementBridgeProposal {
    const diagnostic = input.diagnostic;
    const proposalId = proposalIdFor("agentic-diagnostic", [
      diagnostic.code,
      diagnostic.signalId,
      input.runId,
      input.taskId,
    ]);
    const repeated = diagnostic.code === "repeated_tool_result" || diagnostic.code === "post_compaction_loop";
    const missingClaim =
      diagnostic.code === "missing_claimed_artifact" ||
      diagnostic.code === "missing_claimed_file" ||
      diagnostic.code === "missing_claimed_test";
    return buildProposal({
      proposalId,
      title: `Review agentic diagnostic: ${diagnostic.title}`,
      observedIssue: diagnostic.summary,
      proposedChange: repeated
        ? "Add a bounded retry/loop guard for this run path and require fresh evidence before another retry."
        : missingClaim
          ? "Require artifact verification before the run can be marked complete or delivered."
          : `Review the ${diagnostic.code} handling path and add a targeted guard or validation checkpoint.`,
      risk: diagnostic.severity === "critical" ? "high" : diagnostic.severity === "warning" ? "medium" : "low",
      callableImpact: repeated || missingClaim ? "narrows" : "none",
      rollbackRef: input.rollbackRef ?? rollbackRefFor("agentic-diagnostic", proposalId),
      evidence: [
        evidence("agentic_diagnostic", diagnostic.signalId, diagnostic.title, diagnostic.summary),
        ...optionalEvidence("agentic_diagnostic", input.runId, "Agentic run", input.surface),
        ...optionalEvidence("agentic_diagnostic", input.taskId, "Task record", diagnostic.evidenceRef),
      ],
    });
  }

  public fromPromptLabInvalidRun(input: PromptLabInvalidRunProposalInput): AgenticImprovementBridgeProposal {
    const signals = input.run.integrity?.signals ?? [];
    const proposalId = proposalIdFor("prompt-lab-invalid-run", [
      input.run.runId,
      input.run.packId,
      input.run.testId,
      signals.join("|"),
    ]);
    const testLabel = input.test ? `${input.test.code}: ${input.test.title}` : input.run.testId;
    return buildProposal({
      proposalId,
      title: `Review invalid Prompt Lab row: ${testLabel}`,
      observedIssue: [
        `Prompt Lab marked run ${input.run.runId} as ${input.run.integrity?.validationStatus ?? "unknown"}.`,
        signals.length > 0 ? `Signals: ${signals.join(", ")}.` : undefined,
        input.run.error ? `Error: ${input.run.error}.` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      proposedChange:
        "Keep the row out of score math, preserve runtime integrity evidence, and add/repair harness handling before rerunning.",
      risk:
        input.run.status === "failed" || signals.some((signal) => /durable|trace|truncated|interrupted/i.test(signal))
          ? "medium"
          : "low",
      callableImpact: "none",
      rollbackRef: input.rollbackRef ?? rollbackRefFor("prompt-lab", proposalId),
      evidence: [
        evidence("prompt_lab", input.run.runId, "Prompt Lab invalid run", input.run.error),
        ...optionalEvidence("prompt_lab", input.run.sessionId, "Prompt Lab session", input.packName),
        ...(input.test?.diagnosticMetadata?.capabilityTargets ?? []).map((target) =>
          evidence("prompt_lab", target, "Capability target", testLabel),
        ),
      ],
    });
  }

  public fromMissingCapability(input: MissingCapabilityProposalInput): AgenticImprovementBridgeProposal {
    const capability = input.capability;
    const proposalId = proposalIdFor("missing-capability", [
      capability.capabilityId,
      capability.status,
      capability.reasons.join("|"),
    ]);
    return buildProposal({
      proposalId,
      title: `Review missing capability: ${capability.label}`,
      observedIssue: [
        `${capability.label} is ${capability.status} and callable=${capability.callable}.`,
        capability.reasons.length > 0 ? `Reasons: ${capability.reasons.join(", ")}.` : undefined,
      ]
        .filter(Boolean)
        .join(" "),
      proposedChange: buildCapabilityProposalChange(capability),
      risk:
        capability.family === "provider" || capability.family === "plugin" || capability.family === "mcp"
          ? "medium"
          : "low",
      callableImpact: "widens_after_approval",
      rollbackRef: input.rollbackRef ?? rollbackRefFor("capability", proposalId),
      evidence: [
        evidence(evidenceSourceForCapability(capability), capability.capabilityId, capability.label, input.requestedBy),
      ],
    });
  }

  public fromSkillDrift(input: SkillDriftProposalInput): AgenticImprovementBridgeProposal {
    const proposalId = proposalIdFor("skill-drift", [input.skillId, input.observedIssue, input.driftRef]);
    return buildProposal({
      proposalId,
      title: `Review skill drift: ${input.skillName}`,
      observedIssue: input.observedIssue,
      proposedChange:
        input.proposedChange ??
        "Open a skill revision proposal with before/after instructions and evaluation evidence before changing the skill.",
      risk: input.severity ?? "medium",
      callableImpact: "none",
      rollbackRef: input.rollbackRef ?? rollbackRefFor("skill", proposalId),
      evidence: [evidence("skill_evaluation", input.skillId, input.skillName, input.driftRef)],
    });
  }

  public fromMemoryMiss(input: MemoryMissProposalInput): AgenticImprovementBridgeProposal {
    const proposalId = proposalIdFor("memory-miss", [input.missId, input.sessionId, input.turnId, input.query]);
    return buildProposal({
      proposalId,
      title: "Review memory miss",
      observedIssue: input.observedIssue,
      proposedChange:
        input.proposedChange ??
        "Add retrieval diagnostics or a reviewable memory candidate; do not write durable memory without operator approval.",
      risk: "medium",
      callableImpact: "none",
      rollbackRef: input.rollbackRef ?? rollbackRefFor("memory", proposalId),
      evidence: [
        evidence("memory", input.missId, "Memory miss", input.query),
        ...optionalEvidence("memory", input.sessionId, "Session", input.turnId),
      ],
    });
  }

  public fromRepeatedFailure(input: RepeatedFailureProposalInput): AgenticImprovementBridgeProposal {
    const proposalId = proposalIdFor("repeated-failure", [input.failureId, input.failureClass, String(input.count)]);
    return buildProposal({
      proposalId,
      title: `Review repeated failure: ${input.failureClass}`,
      observedIssue: `${input.observedIssue} Repeat count: ${input.count}.`,
      proposedChange:
        input.proposedChange ??
        "Create a bounded repair-policy proposal with replay evidence, retry limits, and an explicit rollback checkpoint.",
      risk: input.count >= 5 ? "high" : "medium",
      callableImpact: "narrows",
      rollbackRef: input.rollbackRef ?? rollbackRefFor("repeated-failure", proposalId),
      evidence: [
        evidence("agentic_diagnostic", input.failureId, input.failureClass, input.observedIssue),
        ...(input.sampleRefs ?? []).slice(0, 5).map((ref) => evidence("agentic_diagnostic", ref, "Failure sample")),
      ],
    });
  }
}

function buildProposal(input: Omit<AgenticImprovementProposalSummary, "status">): AgenticImprovementBridgeProposal {
  return {
    ...input,
    status: "proposal",
    rollbackRef: input.rollbackRef,
    evidence: compactEvidence(input.evidence),
    actionStatuses: REVIEW_ACTION_STATUSES,
    trust: REVIEW_FIRST_TRUST,
  };
}

function evidence(
  source: BridgeEvidenceSource,
  sourceId: string,
  title: string,
  summary?: string,
): AgenticImprovementEvidenceRef {
  return {
    source,
    sourceId,
    title,
    ...(summary?.trim() ? { summary: summary.trim() } : {}),
  };
}

function optionalEvidence(
  source: BridgeEvidenceSource,
  sourceId: string | undefined,
  title: string,
  summary?: string,
): AgenticImprovementEvidenceRef[] {
  return sourceId?.trim() ? [evidence(source, sourceId.trim(), title, summary)] : [];
}

function buildCapabilityProposalChange(capability: AgenticCapabilityAvailability): string {
  if (capability.status === "blocked") {
    return "Create a reviewable enablement proposal that explains the block, required approval, and exact callable exposure change.";
  }
  if (capability.status === "unavailable") {
    return "Create an install/configuration proposal with health-check evidence before exposing this capability as callable.";
  }
  return "Review why this inspectable capability is not callable and propose the smallest approved exposure change.";
}

function evidenceSourceForCapability(capability: AgenticCapabilityAvailability): BridgeEvidenceSource {
  if (capability.family === "provider") {
    return "provider";
  }
  if (capability.family === "plugin" || capability.family === "mcp") {
    return "plugin";
  }
  if (capability.family === "channel") {
    return "channel";
  }
  if (capability.family === "skill") {
    return "skill_evaluation";
  }
  return "agentic_diagnostic";
}

function compactEvidence(evidenceRefs: AgenticImprovementEvidenceRef[]): AgenticImprovementEvidenceRef[] {
  const seen = new Set<string>();
  const compacted: AgenticImprovementEvidenceRef[] = [];
  for (const ref of evidenceRefs) {
    const sourceId = ref.sourceId.trim();
    if (!sourceId) {
      continue;
    }
    const key = `${ref.source}:${sourceId}:${ref.title}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compacted.push({ ...ref, sourceId });
  }
  return compacted;
}

function dedupeByProposalId(proposals: AgenticImprovementBridgeProposal[]): AgenticImprovementBridgeProposal[] {
  const byId = new Map<string, AgenticImprovementBridgeProposal>();
  for (const proposal of proposals) {
    if (!byId.has(proposal.proposalId)) {
      byId.set(proposal.proposalId, proposal);
    }
  }
  return [...byId.values()];
}

function proposalIdFor(prefix: string, values: Array<string | undefined>): string {
  return `${prefix}-${hashParts(values).slice(0, 16)}`;
}

function rollbackRefFor(prefix: string, proposalId: string): string {
  return `review-only:${prefix}:${proposalId}`;
}

function hashParts(values: Array<string | undefined>): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value?.trim() || "none");
    hash.update("\0");
  }
  return hash.digest("hex");
}
