import type {
  CapabilityCatalogEntry,
  CapabilityProposalRecord,
  HarnessAuditPillarRecord,
  HarnessAuditReportRecord,
  SkillActivationPolicy,
  SkillImportHistoryRecord,
  SkillListItem,
} from "@goatcitadel/contracts";

interface BuildHarnessAuditInput {
  skills: SkillListItem[];
  policy: SkillActivationPolicy;
  inspectableCatalog: CapabilityCatalogEntry[];
  proposals: CapabilityProposalRecord[];
  importHistory: SkillImportHistoryRecord[];
  improvementReportCount: number;
}

export function buildHarnessAuditReport(input: BuildHarnessAuditInput): HarnessAuditReportRecord {
  const enabledSkills = input.skills.filter((skill) => skill.state === "enabled");
  const sleepingSkills = input.skills.filter((skill) => skill.state === "sleep");
  const trustedSkills = input.skills.filter((skill) => skill.lifecycleState === "trusted");
  const candidateEntries = input.inspectableCatalog.filter((entry) => entry.kind === "candidate_skill");
  const proposalEntries = input.inspectableCatalog.filter((entry) => entry.kind === "proposal");
  const importedSkills = input.skills.filter((skill) => skill.source === "extra");
  const recentRejectedImports = input.importHistory.filter((item) => item.outcome === "rejected").length;
  const contextAnchors = countMatchingSkills(input.skills, ["planning", "research", "documentation", "qa"]);

  const rawPillars: HarnessAuditPillarRecord[] = [
    {
      pillarId: "skill_composition",
      label: "Skill Composition",
      score: clampScore(52 + Math.min(input.skills.length, 10) * 4 + Math.min(trustedSkills.length, 5) * 2),
      status: statusForScore(52 + Math.min(input.skills.length, 10) * 4 + Math.min(trustedSkills.length, 5) * 2),
      rationale: "GoatCitadel already carries a real native skill catalog instead of relying on imported harness glue.",
      nativeDestination: "Configure > Agents > Skills",
      evidence: [
        `${input.skills.length} installed skills`,
        `${enabledSkills.length} enabled and ${sleepingSkills.length} sleeping`,
        `${trustedSkills.length} trusted lifecycle entries`,
      ],
      recommendedActions: [
        "Keep imported skills disabled until they earn a concrete operator use case.",
        "Prefer native audit and routing rules over meta-skills that rewrite the harness indirectly.",
      ],
    },
    {
      pillarId: "context_engineering",
      label: "Context Engineering",
      score: clampScore(45 + contextAnchors * 12),
      status: statusForScore(45 + contextAnchors * 12),
      rationale: "Context is already shaped by first-party planning, research, documentation, and QA skill lanes.",
      nativeDestination: "Chat / Cowork / Code guidance",
      evidence: [
        `${contextAnchors} bundled context-anchor skills detected`,
        "Workspace guidance and AGENTS-driven behavior remain first-party",
      ],
      recommendedActions: [
        "Use Harness Engineer's pillar framing as documentation language, not as a second control plane.",
      ],
    },
    {
      pillarId: "orchestration_routing",
      label: "Orchestration & Routing",
      score: clampScore(58 + Math.min(candidateEntries.length, 4) * 5 + Math.min(proposalEntries.length, 4) * 4),
      status: statusForScore(58 + Math.min(candidateEntries.length, 4) * 5 + Math.min(proposalEntries.length, 4) * 4),
      rationale:
        "Cowork, specialist candidates, and capability proposals already give GoatCitadel a native routing story.",
      nativeDestination: "Operate > Cowork / Configure > Agents",
      evidence: [
        `${candidateEntries.length} candidate capabilities in the inspectable catalog`,
        `${proposalEntries.length} inspectable proposals`,
        `${input.proposals.length} persisted proposal records`,
      ],
      recommendedActions: [
        "Mine external swarm or harness skills for language and audit heuristics only.",
        "Keep routing changes visible through candidates and proposals before activation.",
      ],
    },
    {
      pillarId: "persistence_state",
      label: "Persistence & State",
      score: clampScore(64 + Math.min(importedSkills.length, 3) * 3 + Math.min(input.improvementReportCount, 6) * 2),
      status: statusForScore(
        64 + Math.min(importedSkills.length, 3) * 3 + Math.min(input.improvementReportCount, 6) * 2,
      ),
      rationale: "Skill lifecycle, import provenance, and weekly replay artifacts already persist in native stores.",
      nativeDestination: "Observe > Improvement / Configure > Agents",
      evidence: [
        `${importedSkills.length} repo-managed imported skills`,
        `${input.improvementReportCount} weekly improvement reports`,
        "Capability catalog and lifecycle metadata are inspectable",
      ],
      recommendedActions: [
        "Keep durable learnings in proposals, candidates, and improvement logs instead of self-mutating prompts.",
      ],
    },
    {
      pillarId: "quality_feedback",
      label: "Quality Gates & Feedback",
      score: clampScore(40 + Math.min(input.improvementReportCount, 8) * 6 + Math.min(input.proposals.length, 6) * 3),
      status: statusForScore(
        40 + Math.min(input.improvementReportCount, 8) * 6 + Math.min(input.proposals.length, 6) * 3,
      ),
      rationale: "Weekly replay and inspectable proposals make the feedback loop native, reviewable, and bounded.",
      nativeDestination: "Observe > Improvement",
      evidence: [
        `${input.improvementReportCount} replay-backed weekly reports`,
        `${input.proposals.length} proposal records available for inspection`,
      ],
      recommendedActions: ["Prefer report-first and proposal-backed improvements over autonomous apply loops."],
    },
    {
      pillarId: "permissions_safety",
      label: "Permissions & Safety",
      score: clampScore(
        60 +
          (input.policy.requireFirstUseConfirmation ? 18 : 0) +
          Math.round(input.policy.guardedAutoThreshold * 20) +
          Math.min(recentRejectedImports, 3) * 2,
      ),
      status: statusForScore(
        60 +
          (input.policy.requireFirstUseConfirmation ? 18 : 0) +
          Math.round(input.policy.guardedAutoThreshold * 20) +
          Math.min(recentRejectedImports, 3) * 2,
      ),
      rationale:
        "The native posture already biases toward disabled-by-default installs, first-use confirmation, and guarded auto-activation.",
      nativeDestination: "Configure > Agents > Skills",
      evidence: [
        `guarded auto threshold ${input.policy.guardedAutoThreshold.toFixed(2)}`,
        input.policy.requireFirstUseConfirmation ? "first-use confirmation enabled" : "first-use confirmation disabled",
        `${recentRejectedImports} recent rejected imports`,
      ],
      recommendedActions: ["Keep Capability Evolver-style self-modification outside the callable surface."],
    },
    {
      pillarId: "ergonomics_trust",
      label: "Ergonomics & Trust Calibration",
      score: clampScore(
        50 +
          Math.min(enabledSkills.length, 6) * 3 +
          (input.policy.requireFirstUseConfirmation ? 10 : 0) +
          Math.min(sleepingSkills.length, 4) * 2,
      ),
      status: statusForScore(
        50 +
          Math.min(enabledSkills.length, 6) * 3 +
          (input.policy.requireFirstUseConfirmation ? 10 : 0) +
          Math.min(sleepingSkills.length, 4) * 2,
      ),
      rationale: "Operators can progressively disclose power instead of inheriting an opaque harness meta-system.",
      nativeDestination: "Configure > Agents / Operate > Approvals",
      evidence: [
        `${enabledSkills.length} directly callable skills`,
        `${sleepingSkills.length} guarded skills available for stronger matches`,
      ],
      recommendedActions: ["Use the audit as an operator lens and teaching aid, not as a separate hidden runtime."],
    },
  ];

  const pillars: HarnessAuditPillarRecord[] = rawPillars.map((pillar) => ({
    ...pillar,
    score: clampScore(pillar.score),
    status: statusForScore(pillar.score),
  }));

  const overallScore = Math.round(pillars.reduce((sum, pillar) => sum + pillar.score, 0) / pillars.length);
  return {
    generatedAt: new Date().toISOString(),
    summary:
      "Native harness audit lens across skill composition, context, routing, persistence, quality gates, safety, and trust calibration. Use it to absorb external framework ideas without importing a second control plane.",
    overallScore,
    overallStatus: statusForScore(overallScore),
    pillars,
    strategyGlossary: [
      {
        tag: "repair",
        description: "Fix a concrete failure or missing response path without widening autonomous power.",
      },
      {
        tag: "harden",
        description: "Tighten policy, evidence, or review gates so risky paths become more legible and fail closed.",
      },
      {
        tag: "stabilize",
        description: "Reduce repeat regressions by improving routing, defaults, and repeatable operator playbooks.",
      },
    ],
  };
}

function countMatchingSkills(skills: SkillListItem[], needles: string[]): number {
  const normalized = skills.map((skill) =>
    [skill.skillId, skill.name, ...(skill.tags ?? []), ...skill.keywords].join(" ").toLowerCase(),
  );
  return needles.filter((needle) => normalized.some((item) => item.includes(needle))).length;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function statusForScore(score: number): HarnessAuditPillarRecord["status"] {
  if (score >= 80) {
    return "strong";
  }
  if (score >= 60) {
    return "watch";
  }
  return "attention";
}
