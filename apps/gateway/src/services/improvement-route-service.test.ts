import { describe, expect, it, vi } from "vitest";
import { ImprovementRouteService, type ImprovementAuditPort } from "./improvement-route-service.js";

describe("ImprovementRouteService", () => {
  it("delegates improvement route operations to the improvement service with original arguments", () => {
    const improvement = fakeImprovement();
    const service = new ImprovementRouteService({ audit: fakeAudit(), improvement });

    const calls: Array<[keyof typeof improvement, () => unknown, unknown[]]> = [
      ["listCapabilityGapEvents", () => service.listCapabilityGapEvents(5), [5]],
      ["listRepairCandidates", () => service.listRepairCandidates(6), [6]],
      [
        "updateRepairCandidateValidation",
        () => service.updateRepairCandidateValidation("candidate-1", { status: "passed" } as never),
        ["candidate-1", { status: "passed" }],
      ],
      ["listImprovementSignals", () => service.listImprovementSignals(7, "workspace-1"), [7, "workspace-1"]],
      ["getImprovementSignal", () => service.getImprovementSignal("signal-1"), ["signal-1"]],
      ["listImprovementCandidates", () => service.listImprovementCandidates(8, "workspace-2"), [8, "workspace-2"]],
      ["getImprovementCandidateDetail", () => service.getImprovementCandidate("candidate-2"), ["candidate-2"]],
      ["listCuratorReviewItems", () => service.listCuratorReviewItems({ limit: 9 } as never), [{ limit: 9 }]],
      ["getCuratorReviewItem", () => service.getCuratorReviewItem("candidate-3"), ["candidate-3"]],
      [
        "validateImprovementCandidate",
        () => service.validateImprovementCandidate("candidate-4", { verdict: "pass" } as never),
        ["candidate-4", { verdict: "pass" }],
      ],
      [
        "approveImprovementCandidate",
        () => service.approveImprovementCandidate("candidate-5", { note: "ship" } as never),
        ["candidate-5", { note: "ship" }],
      ],
      [
        "rejectImprovementCandidate",
        () => service.rejectImprovementCandidate("candidate-6", { reason: "risk" } as never),
        ["candidate-6", { reason: "risk" }],
      ],
      [
        "snoozeImprovementCandidate",
        () => service.snoozeImprovementCandidate("candidate-7", { until: "tomorrow" } as never),
        ["candidate-7", { until: "tomorrow" }],
      ],
      [
        "activateImprovementCandidate",
        () => service.activateImprovementCandidate("candidate-8", { mode: "manual" } as never),
        ["candidate-8", { mode: "manual" }],
      ],
      [
        "promoteImprovementCandidate",
        () => service.promoteImprovementCandidate("candidate-9", { branch: "main" } as never),
        ["candidate-9", { branch: "main" }],
      ],
      ["requestImprovementActivation", () => service.requestImprovementActivation("candidate-10"), ["candidate-10"]],
      ["getImprovementActivation", () => service.getImprovementActivation("activation-1"), ["activation-1"]],
      ["pauseImprovementActivation", () => service.pauseImprovementActivation("activation-2"), ["activation-2"]],
      ["rollbackImprovementActivation", () => service.rollbackImprovementActivation("activation-3"), ["activation-3"]],
      ["listImprovementReports", () => service.listImprovementReports(10), [10]],
      ["getImprovementReport", () => service.getImprovementReport("report-1"), ["report-1"]],
      [
        "runImprovementReplayManually",
        () => service.runImprovementReplayManually({ limit: 2 } as never),
        [{ limit: 2 }],
      ],
      ["listDecisionReplayRuns", () => service.listDecisionReplayRuns(11), [11]],
      ["getDecisionReplayRun", () => service.getDecisionReplayRun("run-1"), ["run-1"]],
      ["approveDecisionAutoTune", () => service.approveDecisionAutoTune("tune-1"), ["tune-1"]],
      ["revertDecisionAutoTune", () => service.revertDecisionAutoTune("tune-2"), ["tune-2"]],
      [
        "createReplayOverrideDraft",
        () => service.createReplayOverrideDraft("run-2", { prompt: "new" } as never),
        ["run-2", { prompt: "new" }],
      ],
      [
        "executeReplayOverride",
        () => service.executeReplayOverride("run-3", { prompt: "apply" } as never),
        ["run-3", { prompt: "apply" }],
      ],
      ["getReplayDiffSummary", () => service.getReplayDiffSummary("replay-1"), ["replay-1"]],
    ];

    for (const [method, invoke, args] of calls) {
      const expectedResult =
        method === "listImprovementReports" ? [{ id: "report-1" }, { id: "report-2" }] : { method };
      expect(invoke()).toEqual(expectedResult);
      expect(improvement[method]).toHaveBeenCalledWith(...args);
    }
  });

  it("builds a harness audit report from audit signals and improvement reports", () => {
    const improvement = fakeImprovement();
    const audit = fakeAudit();
    const service = new ImprovementRouteService({ audit, improvement });

    const report = service.getHarnessAuditReport();

    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.pillars.map((pillar) => pillar.pillarId)).toContain("permissions_safety");
    expect(report.pillars.flatMap((pillar) => pillar.evidence)).toEqual(
      expect.arrayContaining(["3 installed skills", "2 weekly improvement reports"]),
    );
    expect(audit.listCapabilityCatalog).toHaveBeenCalledWith("inspectable");
    expect(audit.listCapabilityProposals).toHaveBeenCalledWith(100);
    expect(audit.listSkillImportHistory).toHaveBeenCalledWith(50);
    expect(improvement.listImprovementReports).toHaveBeenCalledWith(24);
  });
});

function fakeImprovement() {
  const methodNames = [
    "approveDecisionAutoTune",
    "createReplayOverrideDraft",
    "executeReplayOverride",
    "getDecisionReplayRun",
    "getImprovementActivation",
    "getImprovementCandidateDetail",
    "getImprovementReport",
    "getImprovementSignal",
    "getCuratorReviewItem",
    "getReplayDiffSummary",
    "listCapabilityGapEvents",
    "listCuratorReviewItems",
    "listDecisionReplayRuns",
    "listImprovementCandidates",
    "listImprovementReports",
    "listImprovementSignals",
    "listRepairCandidates",
    "activateImprovementCandidate",
    "approveImprovementCandidate",
    "pauseImprovementActivation",
    "promoteImprovementCandidate",
    "rejectImprovementCandidate",
    "requestImprovementActivation",
    "revertDecisionAutoTune",
    "rollbackImprovementActivation",
    "runImprovementReplayManually",
    "snoozeImprovementCandidate",
    "updateRepairCandidateValidation",
    "validateImprovementCandidate",
  ] as const;
  const improvement: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of methodNames) {
    improvement[method] = vi.fn(() => ({ method }));
  }
  improvement.listImprovementReports = vi.fn(() => [{ id: "report-1" }, { id: "report-2" }]);
  return improvement as Record<(typeof methodNames)[number], ReturnType<typeof vi.fn>>;
}

function fakeAudit(): ImprovementAuditPort {
  return {
    getSkillActivationPolicy: vi.fn(() => ({ requireFirstUseConfirmation: true, guardedAutoThreshold: 0.75 }) as never),
    listCapabilityCatalog: vi.fn(() => [{ kind: "candidate_skill" }, { kind: "proposal" }] as never),
    listCapabilityProposals: vi.fn(() => [{ id: "proposal-1" }] as never),
    listSkillImportHistory: vi.fn(() => [{ outcome: "rejected" }] as never),
    listSkills: vi.fn(
      () =>
        [
          {
            skillId: "planning",
            name: "Planning",
            state: "enabled",
            lifecycleState: "trusted",
            source: "native",
            tags: ["planning"],
            keywords: [],
          },
          {
            skillId: "research",
            name: "Research",
            state: "sleep",
            lifecycleState: "trusted",
            source: "extra",
            tags: ["research"],
            keywords: [],
          },
          {
            skillId: "qa",
            name: "QA",
            state: "enabled",
            lifecycleState: "draft",
            source: "native",
            tags: ["qa"],
            keywords: ["documentation"],
          },
        ] as never,
    ),
  };
}
