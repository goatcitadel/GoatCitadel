import { describe, it, expect } from "vitest";
import type { SkillListItem, SkillLifecycleRecord } from "@goatcitadel/contracts";
import {
  planCuratorIdleSweep,
  isSelfGeneratedSkill,
  nameTitleSimilarity,
  type CuratorIdleSweepDeps,
} from "./curator-idle-sweep.js";

function makeLifecycle(overrides: Partial<SkillLifecycleRecord> = {}): SkillLifecycleRecord {
  return {
    skillId: overrides.skillId ?? "skill-x",
    category: overrides.category ?? "self_generated",
    lifecycleState: overrides.lifecycleState ?? "approved",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  const name = String(overrides.name ?? "x");
  const skillId = overrides.skillId ?? `skill-${name}`;
  return {
    skillId,
    name,
    source: "managed",
    dir: `/tmp/skills/${name}`,
    declaredTools: [],
    requires: [],
    keywords: [],
    instructionBody: "",
    mtime: new Date().toISOString(),
    state: "enabled",
    pinned: false,
    lifecycle: makeLifecycle({ skillId }),
    capabilityCategory: "self_generated",
    ...overrides,
  } as SkillListItem;
}

const NOW = new Date("2026-06-15T12:00:00Z");

interface HarnessOverrides {
  autoApply?: boolean;
  similarity?: CuratorIdleSweepDeps["similarity"];
  duplicateThreshold?: number;
}

async function runSweep(skills: SkillListItem[], overrides: HarnessOverrides = {}) {
  const snapshots: string[] = [];
  const archived: Array<{ skillId: string; reason: string }> = [];
  const result = await planCuratorIdleSweep({
    listSkills: () => skills,
    now: () => NOW,
    runId: "curator-idle-test",
    autoApply: overrides.autoApply ?? true,
    snapshotSkill: (skillId) => snapshots.push(skillId),
    archiveSkill: (skillId, reason) => archived.push({ skillId, reason }),
    similarity: overrides.similarity,
    duplicateThreshold: overrides.duplicateThreshold,
  });
  return { result, snapshots, archived };
}

describe("isSelfGeneratedSkill", () => {
  it("matches on lifecycle.category or capabilityCategory", () => {
    expect(isSelfGeneratedSkill(makeSkill())).toBe(true);
    expect(
      isSelfGeneratedSkill(
        makeSkill({ lifecycle: makeLifecycle({ category: "built_in" }), capabilityCategory: "self_generated" }),
      ),
    ).toBe(true);
  });

  it("rejects non-self-generated skills", () => {
    expect(
      isSelfGeneratedSkill(
        makeSkill({ lifecycle: makeLifecycle({ category: "built_in" }), capabilityCategory: "built_in" }),
      ),
    ).toBe(false);
  });
});

describe("nameTitleSimilarity", () => {
  it("scores identical labels as 1", () => {
    expect(nameTitleSimilarity(makeSkill({ name: "deploy helper" }), makeSkill({ name: "deploy helper" }))).toBe(1);
  });

  it("scores disjoint labels as 0", () => {
    expect(
      nameTitleSimilarity(
        makeSkill({ skillId: "aaa", name: "alpha bravo" }),
        makeSkill({ skillId: "bbb", name: "charlie delta" }),
      ),
    ).toBe(0);
  });

  it("scores partial overlap between 0 and 1", () => {
    const score = nameTitleSimilarity(
      makeSkill({ skillId: "s1", name: "weekly report builder" }),
      makeSkill({ skillId: "s2", name: "weekly report writer" }),
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });
});

describe("planCuratorIdleSweep — scope", () => {
  it("only considers self_generated skills (ignores built-in/optional)", async () => {
    const skills = [
      makeSkill({ name: "stale-self", usageCount: 0, lastUsedAt: undefined }),
      makeSkill({
        name: "stale-builtin",
        usageCount: 0,
        lastUsedAt: undefined,
        lifecycle: makeLifecycle({ category: "built_in" }),
        capabilityCategory: "built_in",
      }),
      makeSkill({
        name: "stale-optional",
        usageCount: 0,
        lastUsedAt: undefined,
        lifecycle: makeLifecycle({ category: "optional" }),
        capabilityCategory: "optional",
      }),
    ];
    const { result, archived } = await runSweep(skills);
    expect(result.scannedSelfGenerated).toBe(1);
    expect(archived.map((a) => a.skillId)).toEqual(["skill-stale-self"]);
  });
});

describe("planCuratorIdleSweep — immunity", () => {
  it("never archives pinned self-generated skills", async () => {
    const skills = [makeSkill({ name: "pinned-self", usageCount: 0, lastUsedAt: undefined, pinned: true })];
    const { result, archived, snapshots } = await runSweep(skills);
    expect(result.immuneCount).toBe(1);
    expect(archived).toEqual([]);
    expect(snapshots).toEqual([]);
    expect(result.archives).toEqual([]);
  });

  it("never archives bundled-source skills even if tagged self_generated", async () => {
    const skills = [makeSkill({ name: "bundled-self", usageCount: 0, lastUsedAt: undefined, source: "bundled" })];
    const { result, archived } = await runSweep(skills);
    expect(result.immuneCount).toBe(1);
    expect(archived).toEqual([]);
  });
});

describe("planCuratorIdleSweep — stale archive (reuses curator rubric)", () => {
  it("archives an unused (never-used) self-generated skill under autonomy, snapshotting first", async () => {
    const skills = [makeSkill({ name: "ghost", usageCount: 0, lastUsedAt: undefined })];
    const { result, archived, snapshots } = await runSweep(skills, { autoApply: true });
    expect(snapshots).toEqual(["skill-ghost"]);
    expect(archived).toEqual([{ skillId: "skill-ghost", reason: "curator:archived idle_self_generated_stale" }]);
    expect(result.archives).toHaveLength(1);
    expect(result.archives[0]).toMatchObject({ skillId: "skill-ghost", applied: true });
  });

  it("keeps a healthy, recently-used self-generated skill", async () => {
    const skills = [makeSkill({ name: "active", usageCount: 80, lastUsedAt: "2026-06-14T00:00:00Z" })];
    const { result, archived } = await runSweep(skills);
    expect(archived).toEqual([]);
    expect(result.archives).toEqual([]);
  });

  it("does not re-archive an already curator-archived skill", async () => {
    const skills = [
      makeSkill({
        name: "ghost",
        usageCount: 0,
        lastUsedAt: undefined,
        state: "disabled",
        note: "curator:archived idle_self_generated_stale",
      }),
    ];
    const { archived } = await runSweep(skills);
    expect(archived).toEqual([]);
  });
});

describe("planCuratorIdleSweep — autonomy gating", () => {
  it("flag-off (autoApply=false) ⇒ proposals only, no snapshot/archive callbacks fire", async () => {
    const skills = [makeSkill({ name: "ghost", usageCount: 0, lastUsedAt: undefined })];
    const { result, archived, snapshots } = await runSweep(skills, { autoApply: false });
    expect(snapshots).toEqual([]);
    expect(archived).toEqual([]);
    expect(result.autoApplied).toBe(false);
    expect(result.archives).toHaveLength(1);
    expect(result.archives[0]).toMatchObject({ skillId: "skill-ghost", applied: false });
  });
});

describe("planCuratorIdleSweep — near-duplicate detection", () => {
  it("proposes a merge for near-duplicate self-generated skills (never hard-deletes)", async () => {
    const skills = [
      makeSkill({
        skillId: "s-keep",
        name: "weekly status report",
        usageCount: 40,
        lastUsedAt: "2026-06-14T00:00:00Z",
      }),
      makeSkill({ skillId: "s-dup", name: "weekly status report", usageCount: 3, lastUsedAt: "2026-06-10T00:00:00Z" }),
    ];
    const { result, archived } = await runSweep(skills, { autoApply: true });
    expect(result.merges).toHaveLength(1);
    // Higher-usage survives; lower-usage duplicate is the one archived (disabled).
    expect(result.merges[0]).toMatchObject({ keepSkillId: "s-keep", archiveSkillId: "s-dup", applied: true });
    expect(archived).toEqual([
      { skillId: "s-dup", reason: "curator:archived idle_self_generated_duplicate of s-keep" },
    ]);
  });

  it("flag-off ⇒ merge proposed but not applied", async () => {
    const skills = [
      makeSkill({ skillId: "s-keep", name: "deploy helper", usageCount: 40, lastUsedAt: "2026-06-14T00:00:00Z" }),
      makeSkill({ skillId: "s-dup", name: "deploy helper", usageCount: 30, lastUsedAt: "2026-06-14T00:00:00Z" }),
    ];
    const { result, archived } = await runSweep(skills, { autoApply: false, similarity: () => 0.9 });
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]?.applied).toBe(false);
    expect(archived).toEqual([]);
  });

  it("does not double-archive: a stale duplicate is archived once (in pass 1)", async () => {
    const skills = [
      makeSkill({ skillId: "s-keep", name: "deploy helper", usageCount: 40, lastUsedAt: "2026-06-14T00:00:00Z" }),
      // identical name but unused/stale ⇒ archived as stale in pass 1, excluded from merges
      makeSkill({ skillId: "s-dup", name: "deploy helper", usageCount: 0, lastUsedAt: undefined }),
    ];
    const { archived, result } = await runSweep(skills);
    expect(archived).toEqual([{ skillId: "s-dup", reason: "curator:archived idle_self_generated_stale" }]);
    expect(result.merges).toEqual([]);
  });

  it("does not propose a merge for a pinned duplicate (immune skills excluded)", async () => {
    const skills = [
      makeSkill({ skillId: "s-keep", name: "deploy helper", usageCount: 40, lastUsedAt: "2026-06-14T00:00:00Z" }),
      makeSkill({
        skillId: "s-dup",
        name: "deploy helper",
        usageCount: 30,
        lastUsedAt: "2026-06-14T00:00:00Z",
        pinned: true,
      }),
    ];
    const { result, archived } = await runSweep(skills);
    expect(result.merges).toEqual([]);
    expect(archived).toEqual([]);
  });

  it("respects an injected similarity override (e.g. pseudo-embedding cosine)", async () => {
    const skills = [
      makeSkill({ skillId: "s-a", name: "alpha", usageCount: 40, lastUsedAt: "2026-06-14T00:00:00Z" }),
      makeSkill({ skillId: "s-b", name: "completely-different", usageCount: 30, lastUsedAt: "2026-06-14T00:00:00Z" }),
    ];
    // Name overlap is 0, but the injected similarity forces a duplicate.
    const { result } = await runSweep(skills, { autoApply: false, similarity: () => 0.95 });
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toMatchObject({ keepSkillId: "s-a", archiveSkillId: "s-b" });
  });
});

describe("planCuratorIdleSweep — empty/degenerate", () => {
  it("returns an empty result when there are no self-generated skills", async () => {
    const { result, archived, snapshots } = await runSweep([
      makeSkill({
        name: "builtin",
        lifecycle: makeLifecycle({ category: "built_in" }),
        capabilityCategory: "built_in",
      }),
    ]);
    expect(result.scannedSelfGenerated).toBe(0);
    expect(result.archives).toEqual([]);
    expect(result.merges).toEqual([]);
    expect(archived).toEqual([]);
    expect(snapshots).toEqual([]);
  });
});
