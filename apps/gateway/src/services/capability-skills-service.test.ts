import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  ServiceUnavailableError,
  type ApprovalRequest,
  type CapabilityCatalogEntry,
  type SkillListItem,
} from "@goatcitadel/contracts";
import { CATALOG_CANDIDATE_VERSION_LIMIT } from "./capability-skills-projection.js";
import { CapabilitySkillsService, type CapabilitySkillsSources } from "./capability-skills-service.js";
import {
  buildSkillLifecycleApprovalBinding,
  buildSkillLifecycleApprovalPayload,
} from "./skill-governance-journey-producer.js";

const WORKSPACE_ID = "workspace-a";

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

const SKILLS = [
  skill({ skillId: "bundled:research", source: "bundled", name: "research", callable: true }),
  skill({ skillId: "extra:pdf-tools", name: "pdf-tools", callable: true }),
  skill({
    skillId: "extra:reviewed-0123456789ab",
    name: "inspect-work-item-0123456789ab",
    capabilityCategory: "self_generated",
    callable: true,
  }),
];

function stateApproval(approvalId: string, skillId: string): ApprovalRequest {
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
  };
}

function candidate(candidateId: string, versionId: string): CapabilityCatalogEntry {
  return {
    capabilityId: `candidate:${candidateId}:${versionId}`,
    kind: "candidate_skill",
    category: "self_generated",
    title: candidateId,
    summary: "Generated candidate skill",
    callable: false,
    lifecycleState: "candidate",
    candidateId,
  };
}

function sources(overrides: Partial<CapabilitySkillsSources> = {}): CapabilitySkillsSources {
  return {
    listSkills: vi.fn(async () => SKILLS),
    listInspectableCatalog: vi.fn(async () => []),
    listPendingApprovals: vi.fn(async () => []),
    // The skill state owner's lookup: the loaded skills, without the workspace's self-authored one.
    listSwitchableSkillIds: vi.fn(async () => ["bundled:research", "extra:pdf-tools"]),
    shippedSkillDirs: vi.fn(() => ({ folders: new Set<string>(), packs: new Set<string>() })),
    deploymentProfile: vi.fn(() => "trusted_local" as const),
    readApprovalSkipSetting: vi.fn(async () => false),
    ...overrides,
  };
}

const failing = (message: string) =>
  vi.fn(async (): Promise<never> => {
    throw new Error(message);
  });

describe("CapabilitySkillsService.list", () => {
  it("lists every skill the workspace loaded, with no issues", async () => {
    const reads = sources();
    const response = await new CapabilitySkillsService(reads).list(WORKSPACE_ID);

    expect(reads.listSkills).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(reads.listInspectableCatalog).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(response).toMatchObject({ workspaceId: WORKSPACE_ID, candidatesWaiting: 0, issues: [] });
    expect(response.items.map((item) => [item.skillId, item.origin])).toEqual([
      ["extra:reviewed-0123456789ab", "self_authored"],
      ["extra:pdf-tools", "imported"],
      ["bundled:research", "built_in"],
    ]);
    // Chat doesn't filter by the workspace's skill choices, so no row claims a skill is hidden there.
    expect(response.items.some((item) => "hiddenInWorkspace" in item)).toBe(false);
    expect(Number.isNaN(Date.parse(response.generatedAt))).toBe(false);
  });

  it("counts each waiting candidate once across its versions", async () => {
    const response = await new CapabilitySkillsService(
      sources({
        listInspectableCatalog: vi.fn(async () => [
          candidate("workflow-a", "v1"),
          candidate("workflow-a", "v2"),
          candidate("workflow-b", "v1"),
        ]),
      }),
    ).list(WORKSPACE_ID);

    expect(response.candidatesWaiting).toBe(2);
  });

  it("leaves candidatesWaiting out when the catalog cut its candidate list off", async () => {
    const versions = Array.from({ length: CATALOG_CANDIDATE_VERSION_LIMIT }, (_, index) =>
      candidate(`workflow-${index}`, "v1"),
    );

    const response = await new CapabilitySkillsService(
      sources({ listInspectableCatalog: vi.fn(async () => versions) }),
    ).list(WORKSPACE_ID);

    expect(response).not.toHaveProperty("candidatesWaiting");
    expect(response.issues).toEqual([]);
  });

  it("leaves candidatesWaiting out when the catalog can't be read", async () => {
    const reportFailure = vi.fn();
    const response = await new CapabilitySkillsService(
      sources({ listInspectableCatalog: failing("catalog build failed") }),
      reportFailure,
    ).list(WORKSPACE_ID);

    expect(response).not.toHaveProperty("candidatesWaiting");
    expect(response.items).toHaveLength(3);
    expect(reportFailure).toHaveBeenCalledWith("catalog", expect.objectContaining({ message: "catalog build failed" }));
  });

  it("reports a waiting approval for its skill", async () => {
    const response = await new CapabilitySkillsService(
      sources({ listPendingApprovals: vi.fn(async () => [stateApproval("approval-1", "extra:pdf-tools")]) }),
    ).list(WORKSPACE_ID);

    expect(response.items.find((item) => item.skillId === "extra:pdf-tools")?.pendingApprovalId).toBe("approval-1");
    expect(response.items.filter((item) => item.pendingApprovalId)).toHaveLength(1);
    expect(response.issues).toEqual([]);
  });

  it("says so when waiting approvals can't be read, and claims none", async () => {
    const response = await new CapabilitySkillsService(
      sources({ listPendingApprovals: failing("approvals unreadable") }),
    ).list(WORKSPACE_ID);

    expect(response.items.some((item) => item.pendingApprovalId)).toBe(false);
    expect(response.issues).toEqual(["Waiting approvals couldn't be read right now."]);
  });

  it("offers the switch only on skills the skill state owner can find", async () => {
    const reads = sources();

    const response = await new CapabilitySkillsService(reads).list(WORKSPACE_ID);

    expect(response.items.map((item) => [item.skillId, item.switchable])).toEqual([
      // The workspace's self-authored skill: the owner looks skills up without a workspace, so it would refuse.
      ["extra:reviewed-0123456789ab", false],
      ["extra:pdf-tools", true],
      ["bundled:research", true],
    ]);
    expect(reads.listSwitchableSkillIds).toHaveBeenCalledTimes(1);
  });

  it("offers no switch, and says so, when that lookup can't be read", async () => {
    const reportFailure = vi.fn();
    const response = await new CapabilitySkillsService(
      sources({ listSwitchableSkillIds: failing("skills not loaded") }),
      reportFailure,
    ).list(WORKSPACE_ID);

    expect(response.items.some((item) => item.switchable)).toBe(false);
    expect(response.items).toHaveLength(3);
    expect(response.issues).toEqual(["Which skills can be switched couldn't be read right now."]);
    expect(reportFailure).toHaveBeenCalledWith("switchable", expect.objectContaining({ message: "skills not loaded" }));
  });

  it("lists the issues in a fixed order", async () => {
    const response = await new CapabilitySkillsService(
      sources({
        listSwitchableSkillIds: failing("skills not loaded"),
        listPendingApprovals: failing("approvals unreadable"),
      }),
    ).list(WORKSPACE_ID);

    expect(response.issues).toEqual([
      "Waiting approvals couldn't be read right now.",
      "Which skills can be switched couldn't be read right now.",
    ]);
  });

  it("reports the operator skip, and false under remote_hardened", async () => {
    const on = sources({ readApprovalSkipSetting: vi.fn(async () => true) });
    expect((await new CapabilitySkillsService(on).list(WORKSPACE_ID)).operatorApprovalSkip).toBe(true);

    const off = sources({ readApprovalSkipSetting: vi.fn(async () => false) });
    expect((await new CapabilitySkillsService(off).list(WORKSPACE_ID)).operatorApprovalSkip).toBe(false);

    // remote_hardened always asks, and the setting isn't even read (Ruling R3).
    const hardened = sources({
      deploymentProfile: vi.fn(() => "remote_hardened" as const),
      readApprovalSkipSetting: vi.fn(async () => true),
    });
    expect((await new CapabilitySkillsService(hardened).list(WORKSPACE_ID)).operatorApprovalSkip).toBe(false);
    expect(hardened.readApprovalSkipSetting).not.toHaveBeenCalled();

    // A setting that can't be read means the operator's clicks ask.
    const reportFailure = vi.fn();
    const unreadable = await new CapabilitySkillsService(
      sources({ readApprovalSkipSetting: failing("settings unreadable") }),
      reportFailure,
    ).list(WORKSPACE_ID);
    expect(unreadable.operatorApprovalSkip).toBe(false);
    expect(reportFailure).toHaveBeenCalledWith("approval_skip", expect.any(Error));
  });

  it("fails plainly when the skills themselves can't be read, rather than listing none", async () => {
    const reportFailure = vi.fn();
    const service = new CapabilitySkillsService(
      sources({ listSkills: failing("skill folder is unreadable at C:\\skills") }),
      reportFailure,
    );

    const failure = await service.list(WORKSPACE_ID).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as Error).message).toBe("Skills can't be read right now.");
    expect(reportFailure).toHaveBeenCalledWith("skills", expect.any(Error));
  });
});

describe("CapabilitySkillsService.detail", () => {
  it("returns one skill's details with its public catalog entry", async () => {
    const entry: CapabilityCatalogEntry = {
      capabilityId: "skill:extra:pdf-tools",
      kind: "skill",
      category: "community_imported",
      title: "pdf-tools",
      summary: "",
      callable: true,
      skillId: "extra:pdf-tools",
      sourceRef: "https://user:hunter2@example.com/pdf-tools.git",
    };
    const instructionBody = "# PDF tools\n\nSet `PDF_API_KEY=your-key-here` in the workspace `.env` first.";
    const imported = skill({
      skillId: "extra:pdf-tools",
      instructionBody,
      lifecycle: {
        skillId: "extra:pdf-tools",
        category: "community_imported",
        lifecycleState: "approved",
        trustLabel: "Approved upstream snapshot",
        provenance: { source: "skill_hub", sourceRef: "https://user:hunter2@example.com/pdf-tools.git" },
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    });
    const reads = sources({
      listSkills: vi.fn(async () => [imported]),
      listInspectableCatalog: vi.fn(async () => [candidate("workflow-a", "v1"), entry]),
    });

    const detail = await new CapabilitySkillsService(reads).detail(WORKSPACE_ID, "extra:pdf-tools");

    expect(reads.listSkills).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(reads.listInspectableCatalog).toHaveBeenCalledWith(WORKSPACE_ID);
    expect(detail.catalogEntry).toMatchObject({ capabilityId: "skill:extra:pdf-tools", kind: "skill" });
    expect(detail.provenance).toMatchObject({ source: "skill_hub", sourceRef: expect.stringContaining("example.com") });
    // The same public projection as the catalog route: a credential in a source URL never leaves the Gateway.
    expect(JSON.stringify(detail)).not.toContain("hunter2");
    // The skill's own text is sent as written, as GET /api/v1/skills sends it.
    expect(detail.instructionBody).toBe(instructionBody);
  });

  it("throws NotFoundError for an unknown skill", async () => {
    await expect(new CapabilitySkillsService(sources()).detail(WORKSPACE_ID, "extra:missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("leaves the catalog entry out when the catalog can't be read", async () => {
    const detail = await new CapabilitySkillsService(
      sources({ listInspectableCatalog: failing("catalog build failed") }),
    ).detail(WORKSPACE_ID, "bundled:research");

    expect(detail.skillId).toBe("bundled:research");
    expect(detail).not.toHaveProperty("catalogEntry");
  });

  it("fails plainly when the skills can't be read", async () => {
    await expect(
      new CapabilitySkillsService(sources({ listSkills: failing("unreadable") })).detail(
        WORKSPACE_ID,
        "bundled:research",
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
