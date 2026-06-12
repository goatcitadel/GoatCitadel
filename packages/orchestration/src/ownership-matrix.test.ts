import { describe, expect, it } from "vitest";
import type { OrchestrationWave } from "@goatcitadel/contracts";
import { findOwnershipConflicts } from "./ownership-matrix.js";

describe("findOwnershipConflicts", () => {
  it("finds overlaps in a wave", () => {
    const wave: OrchestrationWave = {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [
        { agentId: "a", paths: ["apps/web/**"] },
        { agentId: "b", paths: ["apps/web/components/**"] },
      ],
      phases: [
        {
          phaseId: "p1",
          ownerAgentId: "a",
          specPath: "phases/p1.md",
          loopMode: "fresh-context",
          requiresApproval: false,
        },
      ],
    };

    const conflicts = findOwnershipConflicts(wave);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("allows the same agent to own overlapping paths", () => {
    const wave: OrchestrationWave = {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [
        { agentId: "a", paths: ["apps/web/**"] },
        { agentId: "a", paths: ["apps/web/components/**"] },
      ],
      phases: [],
    };

    expect(findOwnershipConflicts(wave)).toEqual([]);
  });

  it("allows different agents to own non-overlapping paths", () => {
    const wave: OrchestrationWave = {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [
        { agentId: "a", paths: ["apps/web/**"] },
        { agentId: "b", paths: ["packages/api/**"] },
      ],
      phases: [],
    };

    expect(findOwnershipConflicts(wave)).toEqual([]);
  });

  it("treats root-equivalent paths as overlapping everything", () => {
    const wave: OrchestrationWave = {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [
        { agentId: "a", paths: ["**"] },
        { agentId: "b", paths: ["packages/api/**"] },
      ],
      phases: [],
    };

    expect(findOwnershipConflicts(wave).length).toBeGreaterThan(0);

    const slashRoot: OrchestrationWave = {
      ...wave,
      ownership: [
        { agentId: "a", paths: ["apps/web/**"] },
        { agentId: "b", paths: ["/"] },
      ],
    };
    expect(findOwnershipConflicts(slashRoot).length).toBeGreaterThan(0);
  });

  it("allows empty ownership", () => {
    const wave: OrchestrationWave = {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [],
      phases: [],
    };

    expect(findOwnershipConflicts(wave)).toEqual([]);
  });
});
