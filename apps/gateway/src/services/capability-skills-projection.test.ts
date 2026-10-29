import { describe, expect, it } from "vitest";
import type {
  ApprovalRequest,
  CapabilityCatalogEntry,
  SkillLifecycleState,
  SkillListItem,
} from "@goatcitadel/contracts";
import {
  buildCapabilitySkillDetail,
  buildCapabilitySkillItems,
  countWaitingCandidates,
  hiddenSkillIds,
  pendingSkillApprovalIds,
  skillOriginFor,
} from "./capability-skills-projection.js";
import {
  buildSkillLifecycleApprovalBinding,
  buildSkillLifecycleApprovalPayload,
} from "./skill-governance-journey-producer.js";

function skill(overrides: Partial<SkillListItem> & Pick<SkillListItem, "skillId">): SkillListItem {
  return {
    name: overrides.skillId.split(":")[1] ?? overrides.skillId,
    description: "Does one thing well.",
    source: "extra",
    dir: "skills/extra/example",
    declaredTools: [],
    requires: [],
    keywords: [],
    instructionBody: "# Example",
    mtime: "2026-10-01T00:00:00.000Z",
    revision: 1,
    state: "enabled",
    ...overrides,
  };
}

function skillApproval(approvalId: string, skillId: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId,
    kind: "skill.lifecycle",
    riskLevel: "danger",
    status: "pending",
    payload: buildSkillLifecycleApprovalPayload({
      binding: buildSkillLifecycleApprovalBinding({
        subjectKind: "skill",
        subjectId: skillId,
        action: "skill_state_set",
        mutation: { skillId, state: "disabled" },
        expectedState: { skillId, revision: 1 },
      }),
      requesterId: "operator",
      mutation: { skillId, state: "disabled" },
    }),
    preview: {},
    createdAt: "2026-10-28T00:00:00.000Z",
    explanationStatus: "not_requested",
    ...overrides,
  };
}

function candidateEntry(
  candidateId: string,
  versionId: string,
  lifecycleState: SkillLifecycleState,
): CapabilityCatalogEntry {
  return {
    capabilityId: `candidate:${candidateId}:${versionId}`,
    kind: "candidate_skill",
    category: "self_generated",
    title: candidateId,
    summary: "Generated candidate skill",
    callable: false,
    lifecycleState,
    candidateId,
  };
}

const ITEMS_INPUT = { hiddenSkillIds: new Set<string>(), pendingApprovalIds: new Map<string, string>() };

describe("skillOriginFor", () => {
  it.each([
    ["a bundled skill", { skillId: "bundled:research", source: "bundled" as const }, "built_in"],
    ["a shipped extra skill", { skillId: "extra:himalaya", source: "extra" as const }, "built_in"],
    [
      "an approved self-authored skill",
      {
        skillId: "extra:reviewed-0123456789ab",
        source: "extra" as const,
        capabilityCategory: "self_generated" as const,
      },
      "self_authored",
    ],
    ["a workspace folder skill", { skillId: "workspace:notes", source: "workspace" as const }, "workspace"],
    ["a managed folder skill", { skillId: "managed:helper", source: "managed" as const }, "imported"],
    ["a Skill Hub import", { skillId: "extra:pdf-tools", source: "extra" as const }, "imported"],
  ])("places %s", (_label, input, origin) => {
    expect(skillOriginFor(input)).toBe(origin);
  });
});

describe("buildCapabilitySkillItems", () => {
  it("maps enabled, sleep and disabled to on, paused and off", () => {
    const items = buildCapabilitySkillItems({
      ...ITEMS_INPUT,
      skills: [
        skill({ skillId: "extra:a", name: "a", state: "enabled" }),
        skill({ skillId: "extra:b", name: "b", state: "sleep" }),
        skill({ skillId: "extra:c", name: "c", state: "disabled" }),
      ],
    });

    expect(items.map((item) => item.state)).toEqual(["on", "paused", "off"]);
  });

  it("keeps callable false for an enabled skill that isn't reviewed", () => {
    const items = buildCapabilitySkillItems({
      ...ITEMS_INPUT,
      skills: [
        skill({ skillId: "extra:unreviewed", state: "enabled", lifecycleState: "candidate", callable: false }),
        skill({ skillId: "extra:unknown", state: "enabled" }),
        skill({ skillId: "bundled:research", source: "bundled", lifecycleState: "trusted", callable: true }),
      ],
    });

    expect(items.map((item) => [item.skillId, item.state, item.callable])).toEqual([
      ["bundled:research", "on", true],
      ["extra:unknown", "on", false],
      ["extra:unreviewed", "on", false],
    ]);
  });

  it("projects every field the tab shows, sorted by name in a locale-independent order", () => {
    const items = buildCapabilitySkillItems({
      hiddenSkillIds: new Set(["extra:pdf-tools"]),
      pendingApprovalIds: new Map([["bundled:research", "approval-1"]]),
      skills: [
        skill({
          skillId: "extra:pdf-tools",
          name: "pdf-tools",
          description: undefined,
          tags: ["docs"],
          pinned: true,
          revision: 4,
          lifecycleState: "approved",
          callable: true,
        }),
        skill({ skillId: "bundled:research", source: "bundled", name: "Research", callable: true }),
        skill({ skillId: "workspace:alpha", source: "workspace", name: "alpha", keywords: ["email"] }),
      ],
    });

    // Code-unit order puts upper case first; localeCompare would not.
    expect(items.map((item) => item.name)).toEqual(["Research", "alpha", "pdf-tools"]);
    expect(items[0]).toEqual({
      skillId: "bundled:research",
      name: "Research",
      description: "Does one thing well.",
      category: "research",
      origin: "built_in",
      state: "on",
      callable: true,
      revision: 1,
      pinned: false,
      tags: [],
      hiddenInWorkspace: false,
      pendingApprovalId: "approval-1",
    });
    expect(items[1]).toMatchObject({ category: "email", origin: "workspace", hiddenInWorkspace: false });
    expect(items[1]).not.toHaveProperty("pendingApprovalId");
    expect(items[2]).toMatchObject({
      description: "",
      category: "writing",
      origin: "imported",
      pinned: true,
      revision: 4,
      lifecycleState: "approved",
      tags: ["docs"],
      hiddenInWorkspace: true,
    });
  });
});

describe("hiddenSkillIds", () => {
  it("hides a skill the workspace left out, and hides nothing when the choices can't be read", () => {
    const known = ["bundled:research", "extra:pdf-tools", "extra:reviewed-0123456789ab"];

    expect([...hiddenSkillIds(known, new Set(["bundled:research"]))]).toEqual([
      "extra:pdf-tools",
      "extra:reviewed-0123456789ab",
    ]);
    // A workspace that keeps its Citadel's full set hides nothing, self-authored skills included.
    expect([...hiddenSkillIds(known, "ALL")]).toEqual([]);
    expect([...hiddenSkillIds(known, undefined)]).toEqual([]);
  });
});

describe("countWaitingCandidates", () => {
  it("counts each waiting candidate once across its versions", () => {
    expect(
      countWaitingCandidates([
        candidateEntry("workflow-a", "v1", "candidate"),
        candidateEntry("workflow-a", "v2", "candidate"),
        candidateEntry("workflow-b", "v1", "candidate"),
        candidateEntry("workflow-c", "v1", "approved"),
        candidateEntry("workflow-d", "v1", "revoked"),
        {
          capabilityId: "skill:bundled:research",
          kind: "skill",
          category: "built_in",
          title: "research",
          summary: "",
          callable: true,
          lifecycleState: "candidate",
          skillId: "bundled:research",
        },
      ]),
    ).toBe(2);
  });

  it("reads the candidate id from the entry id when the entry doesn't carry one", () => {
    const { candidateId: _omitted, ...withoutId } = candidateEntry("workflow-a", "v2", "candidate");

    expect(countWaitingCandidates([candidateEntry("workflow-a", "v1", "candidate"), withoutId])).toBe(1);
  });
});

describe("pendingSkillApprovalIds", () => {
  it("reports a waiting approval for its skill", () => {
    const pending = pendingSkillApprovalIds([
      skillApproval("approval-research", "bundled:research"),
      skillApproval("approval-resolved", "extra:pdf-tools", { status: "approved" }),
      skillApproval("approval-other-kind", "extra:himalaya", { kind: "skill_hub.lifecycle" }),
      skillApproval("approval-malformed", "extra:notes", { payload: { skillLifecycle: { subjectId: "extra:notes" } } }),
      {
        ...skillApproval("approval-batch", "extra:batch"),
        payload: buildSkillLifecycleApprovalPayload({
          binding: buildSkillLifecycleApprovalBinding({
            subjectKind: "skill_batch",
            action: "skill_state_bulk_set",
            mutation: { skillIds: ["extra:batch"] },
            expectedState: {},
          }),
          requesterId: "operator",
          mutation: { skillIds: ["extra:batch"] },
        }),
      },
    ]);

    expect([...pending]).toEqual([["bundled:research", "approval-research"]]);
  });

  it("keeps the newest approval when one skill has two waiting", () => {
    const pending = pendingSkillApprovalIds([
      skillApproval("approval-newer", "bundled:research", { createdAt: "2026-10-28T00:05:00.000Z" }),
      skillApproval("approval-older", "bundled:research", { createdAt: "2026-10-28T00:00:00.000Z" }),
    ]);

    expect(pending.get("bundled:research")).toBe("approval-newer");
  });
});

describe("buildCapabilitySkillDetail", () => {
  it("returns the skill's text, lists and plain provenance with its catalog entry", () => {
    const catalogEntry: CapabilityCatalogEntry = {
      capabilityId: "skill:extra:pdf-tools",
      kind: "skill",
      category: "community_imported",
      title: "pdf-tools",
      summary: "",
      callable: true,
      skillId: "extra:pdf-tools",
    };
    const detail = buildCapabilitySkillDetail(
      skill({
        skillId: "extra:pdf-tools",
        instructionBody: "# PDF tools\n\nRead PDFs.",
        keywords: ["pdf"],
        declaredTools: ["fs.read"],
        requires: ["python"],
        note: "Kept on for reports",
        stateUpdatedAt: "2026-10-20T00:00:00.000Z",
        trustLabel: "Approved upstream snapshot",
        reviewWarning: "Check scripts before use.",
        lifecycle: {
          skillId: "extra:pdf-tools",
          category: "community_imported",
          lifecycleState: "approved",
          trustLabel: "Approved upstream snapshot",
          provenance: {
            source: "skill_hub",
            sourceRef: "https://github.com/example/pdf-tools",
            sourceProvider: "github",
            commitSha: "a".repeat(40),
            contentIntegrity: {
              manifestVersion: "goatcitadel.skill-tree.v1",
              treeSha256: "b".repeat(64),
              fileCount: 2,
              totalBytes: 300,
              verified: true,
            },
          },
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      }),
      catalogEntry,
    );

    expect(detail).toEqual({
      skillId: "extra:pdf-tools",
      instructionBody: "# PDF tools\n\nRead PDFs.",
      keywords: ["pdf"],
      declaredTools: ["fs.read"],
      requires: ["python"],
      provenance: {
        source: "skill_hub",
        sourceRef: "https://github.com/example/pdf-tools",
        sourceProvider: "github",
        commitSha: "a".repeat(40),
        treeSha256: "b".repeat(64),
      },
      trustLabel: "Approved upstream snapshot",
      reviewWarning: "Check scripts before use.",
      note: "Kept on for reports",
      stateUpdatedAt: "2026-10-20T00:00:00.000Z",
      catalogEntry,
    });
  });

  it("leaves out what the skill doesn't have", () => {
    expect(buildCapabilitySkillDetail(skill({ skillId: "extra:bare" }), undefined)).toEqual({
      skillId: "extra:bare",
      instructionBody: "# Example",
      keywords: [],
      declaredTools: [],
      requires: [],
    });
  });
});
