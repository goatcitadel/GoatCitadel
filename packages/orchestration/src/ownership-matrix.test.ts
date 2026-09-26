import { describe, expect, it } from "vitest";
import type { OrchestrationWave } from "@goatcitadel/contracts";
import { findOwnershipConflicts, ownershipPathEscapesRoot } from "./ownership-matrix.js";

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

  function waveOf(pathA: string, pathB: string): OrchestrationWave {
    return {
      waveId: "wave-1",
      verify: [],
      budgetUsd: 10,
      ownership: [
        { agentId: "a", paths: [pathA] },
        { agentId: "b", paths: [pathB] },
      ],
      phases: [],
    };
  }

  it.each([
    ["./apps/web", "apps/web/src"],
    ["apps//web/", "apps/web"],
    ["apps/./web", "apps\\web\\src"],
    ["apps/api/../web", "apps/web/components/**"],
    ["Apps/Web", "apps/web/index.ts"],
    ["apps/web*", "apps/website"],
    ["apps/*/src", "apps/web/src/index.ts"],
    ["apps/web/**", "apps/web"],
    ["*.md", "docs/readme.md"],
  ])("reports %s and %s as overlapping after normalization", (pathA, pathB) => {
    expect(findOwnershipConflicts(waveOf(pathA, pathB))).toHaveLength(1);
  });

  it.each([
    ["apps/web", "apps/webapp/**"],
    ["apps/web/**", "apps/webapp/**"],
    ["apps/web", "apps/website"],
    ["apps/web/src/*.ts", "apps/web/lib/**"],
  ])("keeps %s and %s separate", (pathA, pathB) => {
    expect(findOwnershipConflicts(waveOf(pathA, pathB))).toEqual([]);
  });

  it("reports normalized paths without trailing globs", () => {
    expect(findOwnershipConflicts(waveOf("./apps/web/**", "apps/web/src"))).toEqual([
      { waveId: "wave-1", agentA: "a", pathA: "apps/web", agentB: "b", pathB: "apps/web/src" },
    ]);
  });

  it("identifies ownership paths that do not stay inside the repository root", () => {
    expect(ownershipPathEscapesRoot("../outside")).toBe(true);
    expect(ownershipPathEscapesRoot("apps/../../outside")).toBe(true);
    expect(ownershipPathEscapesRoot("..\\outside")).toBe(true);
    expect(ownershipPathEscapesRoot("C:\\outside")).toBe(true);
    expect(ownershipPathEscapesRoot("c:/outside")).toBe(true);
    expect(ownershipPathEscapesRoot("C:outside")).toBe(true);
    expect(ownershipPathEscapesRoot("\\\\server\\share")).toBe(true);
    expect(ownershipPathEscapesRoot("//server/share")).toBe(true);
    expect(ownershipPathEscapesRoot("apps/../web")).toBe(false);
    expect(ownershipPathEscapesRoot("/apps/web")).toBe(false);
    expect(ownershipPathEscapesRoot("..foo/bar")).toBe(false);
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
