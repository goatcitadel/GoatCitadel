import { describe, expect, it } from "vitest";
import { buildHarnessAuditReport } from "./harness-audit.js";

describe("buildHarnessAuditReport", () => {
  it("scores native harness pillars from current operator evidence", () => {
    const report = buildHarnessAuditReport({
      skills: [
        {
          skillId: "planning",
          name: "Planning",
          source: "bundled",
          dir: "skills/bundled/planning",
          declaredTools: [],
          requires: [],
          keywords: ["plan"],
          instructionBody: "",
          mtime: new Date().toISOString(),
          state: "enabled",
          lifecycleState: "trusted",
        },
        {
          skillId: "research",
          name: "Research",
          source: "bundled",
          dir: "skills/bundled/research",
          declaredTools: [],
          requires: [],
          keywords: ["research"],
          instructionBody: "",
          mtime: new Date().toISOString(),
          state: "sleep",
          lifecycleState: "trusted",
        },
        {
          skillId: "documentation",
          name: "Documentation",
          source: "extra",
          dir: "skills/extra/documentation",
          declaredTools: [],
          requires: [],
          keywords: ["docs"],
          instructionBody: "",
          mtime: new Date().toISOString(),
          state: "disabled",
          lifecycleState: "approved",
        },
      ],
      policy: {
        revision: 1,
        guardedAutoThreshold: 0.72,
        requireFirstUseConfirmation: true,
      },
      inspectableCatalog: [
        {
          capabilityId: "proposal:1",
          kind: "proposal",
          category: "community_imported",
          title: "Proposal",
          summary: "Inspectable proposal",
          callable: false,
        },
        {
          capabilityId: "candidate:1",
          kind: "candidate_skill",
          category: "self_generated",
          title: "Candidate",
          summary: "Dormant candidate",
          callable: false,
        },
      ],
      proposals: [
        {
          proposalId: "proposal-1",
          proposalKind: "skill",
          status: "proposed",
          title: "Routing proposal",
          summary: "Tighten routing",
          payload: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      importHistory: [
        {
          importId: "imp-1",
          action: "validate",
          outcome: "rejected",
          sourceProvider: "clawhub",
          sourceRef: "https://clawhub.ai/kennyzir/capability-evolver-pro",
          sourceType: "git_url",
          canonicalKey: "clawhub:capability-evolver",
          createdAt: new Date().toISOString(),
        },
      ],
      improvementReportCount: 4,
    });

    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.pillars).toHaveLength(7);
    expect(report.pillars.find((pillar) => pillar.pillarId === "permissions_safety")).toMatchObject({
      status: "strong",
    });
    expect(report.strategyGlossary.map((item) => item.tag)).toEqual(["repair", "harden", "stabilize"]);
  });
});
