import { readFileSync } from "node:fs";
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
  CATALOG_CANDIDATE_VERSION_LIMIT,
  countWaitingCandidates,
  pendingSkillApprovalIds,
  skillOriginFor,
  type ShippedSkillDirs,
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

/** GoatCitadel's own folders on an install rooted at /srv/goatcitadel. */
const SHIPPED: ShippedSkillDirs = {
  folders: new Set(["/srv/goatcitadel/skills/genie-npu-ir20"]),
  packs: new Set(["/srv/goatcitadel/skills/import-packs/github-cli", "/srv/goatcitadel/skills/import-packs/himalaya"]),
};

const ITEMS_INPUT = {
  pendingApprovalIds: new Map<string, string>(),
  switchableSkillIds: new Set<string>(),
  shippedSkillDirs: SHIPPED,
};

/** A Skill Hub install of `extra:<name>` whose source.json records this source (as the lifecycle row reads it). */
function installed(name: string, sourceProvider: string, sourceRef: string) {
  return {
    skillId: `extra:${name}`,
    source: "extra" as const,
    dir: `/srv/goatcitadel/skills/extra/${name}`,
    lifecycle: {
      skillId: `extra:${name}`,
      category: "community_imported" as const,
      lifecycleState: "approved" as const,
      trustLabel: "Imported/community",
      provenance: { source: "extra", sourceProvider, sourceRef },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

describe("skillOriginFor", () => {
  it.each([
    [
      "a bundled skill",
      { skillId: "bundled:research", source: "bundled", dir: "/x/skills/bundled/research" },
      "built_in",
    ],
    [
      "GoatCitadel's own pack, installed through Skill Hub",
      installed("github-cli", "local", "/srv/goatcitadel/skills/import-packs/github-cli"),
      "built_in",
    ],
    [
      "a Git import named like a shipped skill",
      installed("github-cli", "github", "https://github.com/someone/skills/tree/main/github-cli"),
      "imported",
    ],
    [
      "a remote bundle named like a shipped skill",
      installed("himalaya", "external", "https://skills.example.com/himalaya.zip"),
      "imported",
    ],
    [
      "a local folder that only looks like a shipped pack",
      installed("github-cli", "local", "/home/someone/import-packs/github-cli"),
      "imported",
    ],
    [
      "GoatCitadel's own pack folder from another install, which can't be told apart",
      installed("github-cli", "local", "/opt/old-goatcitadel/skills/import-packs/github-cli"),
      "imported",
    ],
    [
      "a shipped name with no provenance recorded",
      { skillId: "extra:himalaya", source: "extra", dir: "/srv/goatcitadel/skills/extra/himalaya" },
      "imported",
    ],
    [
      "a skill that isn't shipped, from a pack folder",
      installed("pdf-tools", "local", "/srv/goatcitadel/skills/import-packs/github-cli"),
      "imported",
    ],
    [
      "GoatCitadel's own skill folder",
      { skillId: "extra:genie-npu-ir20", source: "extra", dir: "/srv/goatcitadel/skills/genie-npu-ir20" },
      "built_in",
    ],
    [
      "an import named like GoatCitadel's own skill folder",
      { skillId: "extra:genie-npu-ir20", source: "extra", dir: "/srv/goatcitadel/skills/extra/genie-npu-ir20" },
      "imported",
    ],
    [
      "an approved self-authored skill",
      {
        skillId: "extra:reviewed-0123456789ab",
        source: "extra",
        dir: "/srv/goatcitadel/candidates/reviewed",
        capabilityCategory: "self_generated",
      },
      "self_authored",
    ],
    ["a workspace folder skill", { skillId: "workspace:notes", source: "workspace", dir: "/w/notes" }, "workspace"],
    ["a managed folder skill", { skillId: "managed:helper", source: "managed", dir: "/m/helper" }, "imported"],
    ["a Skill Hub import", installed("pdf-tools", "github", "https://github.com/someone/pdf-tools"), "imported"],
  ] as const)("places %s", (_label, input, origin) => {
    expect(skillOriginFor(input, SHIPPED)).toBe(origin);
  });

  // A pack switched on through Skill Hub records the Hub check it came from (its snapshot id), not the pack folder.
  // It is GoatCitadel's own only when that check read one of this install's pack folders (Ruling R43).
  describe("a pack switched on through Skill Hub", () => {
    const hubInstalled = (name: string, snapshotId: string) => ({
      skillId: `extra:${name}`,
      source: "extra" as const,
      dir: `/srv/goatcitadel/skills/extra/${name}`,
      lifecycle: {
        skillId: `extra:${name}`,
        category: "community_imported" as const,
        lifecycleState: "approved" as const,
        trustLabel: "Approved upstream snapshot",
        provenance: { source: "extra", sourceRef: snapshotId },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    const packChecks = new Set(["skill-hub-review-pack"]);

    it.each([
      ["from a check of GoatCitadel's own pack folder", hubInstalled("himalaya", "skill-hub-review-pack"), "built_in"],
      ["from any other check, such as a Git repository", hubInstalled("himalaya", "skill-hub-review-git"), "imported"],
      ["with a skill that isn't shipped", hubInstalled("pdf-tools", "skill-hub-review-pack"), "imported"],
    ] as const)("reads %s", (_label, input, origin) => {
      expect(skillOriginFor(input, SHIPPED, packChecks)).toBe(origin);
    });

    it("reads as imported when its check can't be told", () => {
      expect(skillOriginFor(hubInstalled("himalaya", "skill-hub-review-pack"), SHIPPED)).toBe("imported");
    });
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

  it("marks a skill switched on from a plugin's check with the plugin's name, and no other", () => {
    const lifecycle = (sourceRef: string, source = "extra") => ({
      skillId: "extra:browser-qa",
      category: "community_imported" as const,
      lifecycleState: "approved" as const,
      trustLabel: "Approved upstream snapshot",
      provenance: { source, sourceRef },
      createdAt: "2026-10-31T00:00:00.000Z",
      updatedAt: "2026-10-31T00:00:00.000Z",
    });
    const items = buildCapabilitySkillItems({
      ...ITEMS_INPUT,
      skills: [
        skill({ skillId: "extra:browser-qa", name: "browser-qa", lifecycle: lifecycle("check-plugin") }),
        skill({ skillId: "extra:other", name: "other", lifecycle: lifecycle("check-other") }),
        // A recorded source that names the same id but isn't a Skill Hub check's is not the plugin's.
        skill({ skillId: "extra:local", name: "local", lifecycle: lifecycle("check-plugin", "local") }),
        skill({ skillId: "extra:none", name: "none" }),
      ],
      pluginSkills: new Map([["check-plugin", { pluginId: "browser-checks", name: "Browser checks" }]]),
    });

    expect(items.map((item) => [item.skillId, item.fromPlugin])).toEqual([
      ["extra:browser-qa", { pluginId: "browser-checks", name: "Browser checks" }],
      ["extra:local", undefined],
      ["extra:none", undefined],
      ["extra:other", undefined],
    ]);
    expect(items.filter((item) => "fromPlugin" in item)).toHaveLength(1);
  });

  it("reads a skill an uninstall removed as removed with its plugin, once the AI can't use it", () => {
    const items = buildCapabilitySkillItems({
      ...ITEMS_INPUT,
      skills: [
        // Revoked by the uninstall: the AI can't use it, and it stays until skills can be removed.
        skill({ skillId: "extra:notes", name: "notes", callable: false, lifecycleState: "revoked" }),
        // Its revoke hasn't applied yet: the AI can still use it, so it isn't marked.
        skill({ skillId: "extra:digest", name: "digest", callable: true }),
        skill({ skillId: "extra:other", name: "other", callable: false }),
      ],
      removedPluginSkills: new Map([
        ["extra:notes", { name: "Meeting tools" }],
        ["extra:digest", { name: "Meeting tools" }],
      ]),
    });

    expect(items.map((item) => [item.skillId, item.removedWithPlugin])).toEqual([
      ["extra:digest", undefined],
      ["extra:notes", { name: "Meeting tools" }],
      ["extra:other", undefined],
    ]);
    expect(items.filter((item) => "removedWithPlugin" in item)).toHaveLength(1);
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
      pendingApprovalIds: new Map([["bundled:research", "approval-1"]]),
      switchableSkillIds: new Set(["bundled:research", "extra:pdf-tools"]),
      shippedSkillDirs: SHIPPED,
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
      switchable: true,
      pinned: false,
      tags: [],
      pendingApprovalId: "approval-1",
    });
    // Not in the skill state owner's lookup, so the switch would refuse it.
    expect(items[1]).toMatchObject({
      category: "email",
      origin: "workspace",
      switchable: false,
    });
    expect(items[1]).not.toHaveProperty("pendingApprovalId");
    expect(items[2]).toMatchObject({
      description: "",
      category: "writing",
      origin: "imported",
      switchable: true,
      pinned: true,
      revision: 4,
      lifecycleState: "approved",
      tags: ["docs"],
    });
  });

  describe("leftOutOfWorkspace", () => {
    const SKILLS = [
      skill({ skillId: "bundled:research", source: "bundled", name: "research" }),
      skill({ skillId: "extra:pdf-tools", name: "pdf-tools" }),
      skill({
        skillId: "extra:reviewed-0123456789ab",
        name: "inspect-work-item",
        capabilityCategory: "self_generated",
      }),
    ];
    const leftOut = (turnSkillIds: ReadonlySet<string> | undefined) =>
      Object.fromEntries(
        buildCapabilitySkillItems({ ...ITEMS_INPUT, skills: SKILLS, turnSkillIds }).map((item) => [
          item.skillId,
          item.leftOutOfWorkspace,
        ]),
      );

    it("marks a skill the workspace's choices leave out", () => {
      expect(leftOut(new Set(["bundled:research", "extra:reviewed-0123456789ab"]))).toEqual({
        "bundled:research": false,
        "extra:pdf-tools": true,
        "extra:reviewed-0123456789ab": false,
      });
    });

    it("marks nothing when the workspace chooses all skills", () => {
      expect(leftOut(new Set(SKILLS.map((item) => item.skillId)))).toEqual({
        "bundled:research": false,
        "extra:pdf-tools": false,
        "extra:reviewed-0123456789ab": false,
      });
    });

    it("never marks the workspace's own self-authored skills", () => {
      // No choice can name a self-authored skill, so the turn list always carries it.
      const marks = leftOut(new Set(["extra:reviewed-0123456789ab"]));

      expect(marks["extra:reviewed-0123456789ab"]).toBe(false);
      expect(marks["bundled:research"]).toBe(true);
    });

    it("marks a skill when the workspace chose no skill at all", () => {
      expect(leftOut(new Set<string>())).toEqual({
        "bundled:research": true,
        "extra:pdf-tools": true,
        "extra:reviewed-0123456789ab": true,
      });
    });

    it("leaves the mark out of every row when the workspace's skills weren't read", () => {
      const items = buildCapabilitySkillItems({ ...ITEMS_INPUT, skills: SKILLS });

      expect(items).toHaveLength(3);
      expect(items.some((item) => "leftOutOfWorkspace" in item)).toBe(false);
    });
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

  it("gives no count once the catalog's candidate list reaches its limit, since older ones may be cut off", () => {
    // Mostly decided versions: the waiting ones the catalog shows are fewer than the ones that may wait.
    const versions = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        candidateEntry(`workflow-${index}`, "v1", index < 3 ? "candidate" : "approved"),
      );

    expect(countWaitingCandidates(versions(CATALOG_CANDIDATE_VERSION_LIMIT - 1))).toBe(3);
    expect(countWaitingCandidates(versions(CATALOG_CANDIDATE_VERSION_LIMIT))).toBeUndefined();
  });

  it("uses the same limit as the catalog's candidate list", () => {
    const catalog = readFileSync(new URL("./capability-system-service.ts", import.meta.url), "utf8");

    expect(catalog).toContain(`storage.candidateSkillVersions.list(${CATALOG_CANDIDATE_VERSION_LIMIT})`);
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
