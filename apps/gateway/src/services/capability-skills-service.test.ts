import { describe, expect, it, vi } from "vitest";
import {
  NotFoundError,
  ServiceUnavailableError,
  type ApprovalRequest,
  type CapabilityCatalogEntry,
  type SkillListItem,
} from "@goatcitadel/contracts";
import { hubApproval, hubItem } from "./capability-skill-install.test-support.js";
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
    // A workspace that chose nothing: its turns may load every skill listed.
    listWorkspaceTurnSkills: vi.fn(async () => SKILLS),
    shippedSkillDirs: vi.fn(() => ({ folders: new Set<string>(), packs: new Set<string>() })),
    deploymentProfile: vi.fn(() => "trusted_local" as const),
    readApprovalSkipSetting: vi.fn(async () => false),
    listSkillHub: vi.fn(async () => ({ items: [] })),
    findSkillHubSnapshot: vi.fn(async () => undefined),
    listPluginSkills: vi.fn(async () => new Map()),
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
    // The workspace's turns may load every one of them, so no row is left out.
    expect(response.items.map((item) => item.leftOutOfWorkspace)).toEqual([false, false, false]);
    expect(Number.isNaN(Date.parse(response.generatedAt))).toBe(false);
  });

  it("marks a skill the workspace's choices leave out", async () => {
    const reads = sources({
      // The turn list keeps the chosen skill and the workspace's own self-authored one, not pdf-tools.
      listWorkspaceTurnSkills: vi.fn(async () => [SKILLS[0]!, SKILLS[2]!]),
    });

    const response = await new CapabilitySkillsService(reads).list(WORKSPACE_ID);

    expect(reads.listWorkspaceTurnSkills).toHaveBeenCalledExactlyOnceWith(WORKSPACE_ID);
    // The tab still lists every skill, whatever the choices; it only says which ones Chat can't use here.
    expect(response.items.map((item) => [item.skillId, item.leftOutOfWorkspace])).toEqual([
      ["extra:reviewed-0123456789ab", false],
      ["extra:pdf-tools", true],
      ["bundled:research", false],
    ]);
    expect(response.issues).toEqual([]);
  });

  it("marks nothing when the workspace chooses all skills", async () => {
    const response = await new CapabilitySkillsService(sources()).list(WORKSPACE_ID);

    expect(response.items.every((item) => item.leftOutOfWorkspace === false)).toBe(true);
    expect(response.issues).toEqual([]);
  });

  it("never marks the workspace's own self-authored skills", async () => {
    // A choice of one skill: the turn list is that skill plus the workspace's self-authored ones.
    const response = await new CapabilitySkillsService(
      sources({ listWorkspaceTurnSkills: vi.fn(async () => [SKILLS[2]!]) }),
    ).list(WORKSPACE_ID);

    expect(response.items.find((item) => item.origin === "self_authored")?.leftOutOfWorkspace).toBe(false);
    expect(response.items.filter((item) => item.leftOutOfWorkspace)).toHaveLength(2);
  });

  it("leaves the mark out, with an issue line, when the workspace's skills can't be read", async () => {
    const reportFailure = vi.fn();
    const response = await new CapabilitySkillsService(
      sources({ listWorkspaceTurnSkills: failing("choices unreadable") }),
      reportFailure,
    ).list(WORKSPACE_ID);

    // A guess either way would be wrong: the rows stay, without the claim.
    expect(response.items).toHaveLength(3);
    expect(response.items.some((item) => "leftOutOfWorkspace" in item)).toBe(false);
    expect(response.issues).toEqual(["Which skills this workspace's chats can use couldn't be read right now."]);
    expect(reportFailure).toHaveBeenCalledWith(
      "turn_skills",
      expect.objectContaining({ message: "choices unreadable" }),
    );
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
        listWorkspaceTurnSkills: failing("choices unreadable"),
        listSwitchableSkillIds: failing("skills not loaded"),
        listPendingApprovals: failing("approvals unreadable"),
        listPluginSkills: failing("plugin records unreadable"),
      }),
    ).list(WORKSPACE_ID);

    expect(response.issues).toEqual([
      "Waiting approvals couldn't be read right now.",
      "Which skills can be switched couldn't be read right now.",
      "Which skills this workspace's chats can use couldn't be read right now.",
      "Which skills came with a plugin couldn't be read right now.",
    ]);
  });

  it("marks a skill switched on from a plugin's check, and says so when the plugins can't be read", async () => {
    const fromCheck: SkillListItem = {
      ...SKILLS[0]!,
      skillId: "extra:browser-qa",
      name: "browser-qa",
      source: "extra",
      lifecycle: {
        skillId: "extra:browser-qa",
        category: "community_imported",
        lifecycleState: "approved",
        trustLabel: "Approved upstream snapshot",
        provenance: { source: "extra", sourceRef: "check-plugin" },
        createdAt: "2026-10-31T00:00:00.000Z",
        updatedAt: "2026-10-31T00:00:00.000Z",
      },
    };
    const listPluginSkills = vi.fn(
      async () => new Map([["check-plugin", { pluginId: "browser-checks", name: "Browser checks" }]]),
    );
    const marked = await new CapabilitySkillsService(
      sources({ listSkills: vi.fn(async () => [...SKILLS, fromCheck]), listPluginSkills }),
    ).list(WORKSPACE_ID);

    expect(marked.items.filter((item) => item.fromPlugin).map((item) => [item.skillId, item.fromPlugin])).toEqual([
      ["extra:browser-qa", { pluginId: "browser-checks", name: "Browser checks" }],
    ]);
    expect(marked.issues).toEqual([]);

    const reportFailure = vi.fn();
    const unread = await new CapabilitySkillsService(
      sources({ listSkills: vi.fn(async () => [...SKILLS, fromCheck]), listPluginSkills: failing("locked") }),
      reportFailure,
    ).list(WORKSPACE_ID);

    // The list is still answered; no skill is marked, and the issue says why.
    expect(unread.items).toHaveLength(SKILLS.length + 1);
    expect(unread.items.some((item) => "fromPlugin" in item)).toBe(false);
    expect(unread.issues).toEqual(["Which skills came with a plugin couldn't be read right now."]);
    expect(reportFailure).toHaveBeenCalledWith("plugins", expect.objectContaining({ message: "locked" }));
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

describe("CapabilitySkillsService.list, for a pack switched on through Skill Hub", () => {
  const PACK_FOLDER = "/srv/goatcitadel/skills/import-packs/himalaya";
  /** A Hub activation records the check it came from as the skill's source, not the pack folder. */
  const hubInstalled = skill({
    skillId: "extra:himalaya",
    name: "himalaya",
    dir: "/srv/goatcitadel/skills/extra/himalaya",
    callable: true,
    lifecycle: {
      skillId: "extra:himalaya",
      category: "community_imported",
      lifecycleState: "approved",
      trustLabel: "Approved upstream snapshot",
      provenance: { source: "extra", sourceRef: "skill-hub-review-pack" },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  });
  const shipped = { folders: new Set<string>(), packs: new Set([PACK_FOLDER]) };

  it.each([
    ["a check of this install's pack folder", { sourceType: "local_path", sourceRef: PACK_FOLDER }, "built_in"],
    [
      "a check of a Git repository",
      { sourceType: "git_url", sourceRef: "https://github.com/someone/himalaya" },
      "imported",
    ],
    ["a check it can't find", undefined, "imported"],
  ] as const)("reads it as GoatCitadel's own only after %s", async (_label, check, origin) => {
    const reads = sources({
      listSkills: vi.fn(async () => [hubInstalled, ...SKILLS]),
      shippedSkillDirs: vi.fn(() => shipped),
      findSkillHubSnapshot: vi.fn(async () => check),
    });

    const response = await new CapabilitySkillsService(reads).list(WORKSPACE_ID);

    expect(response.items.find((item) => item.skillId === "extra:himalaya")?.origin).toBe(origin);
    // Only the shipped skill's own check is read, once.
    expect(reads.findSkillHubSnapshot).toHaveBeenCalledExactlyOnceWith("skill-hub-review-pack");
  });

  it("reads it as imported, and logs why, when its check can't be read", async () => {
    const reportFailure = vi.fn();
    const reads = sources({
      listSkills: vi.fn(async () => [hubInstalled]),
      shippedSkillDirs: vi.fn(() => shipped),
      findSkillHubSnapshot: failing("database is locked"),
    });

    const response = await new CapabilitySkillsService(reads, reportFailure).list(WORKSPACE_ID);

    expect(response.items[0]?.origin).toBe("imported");
    expect(response.issues).toEqual([]);
    expect(reportFailure).toHaveBeenCalledWith("skill_hub_check", expect.any(Error));
  });
});

describe("CapabilitySkillsService.installs", () => {
  const installed = hubItem({
    snapshotId: "check-installed",
    runtime: { inactiveCandidate: true },
    approvals: { install_inactive: hubApproval("install_inactive", "approved", "applied") },
    actions: { install_inactive: { allowed: false, blockers: ["SOURCE_ALREADY_INSTALLED"] } },
  });
  const waiting = hubItem({
    snapshotId: "check-waiting",
    approvals: { install_inactive: hubApproval("install_inactive", "pending") },
  });

  it("lists an install left between its two steps", async () => {
    const reads = sources({
      listSkillHub: vi.fn(async () => ({
        items: [
          installed,
          hubItem({ snapshotId: "check-passed" }),
          hubItem({ snapshotId: "check-done", runtime: { activeVersion: true, callable: true } }),
          hubItem({ snapshotId: "check-blocked", snapshot: { blockerCodes: ["AUDIT_MISSING"] } }),
          waiting,
          // A legacy check of a folder that isn't a pack: it can't be named without its server path.
          hubItem({
            snapshotId: "check-local-folder",
            snapshot: { sourceRef: "/srv/skills/my-skill" },
            approvals: { install_inactive: hubApproval("install_inactive", "pending") },
          }),
        ],
      })),
    });

    const response = await new CapabilitySkillsService(reads).installs(WORKSPACE_ID);

    expect(reads.listSkillHub).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, limit: 100 });
    expect(response.workspaceId).toBe(WORKSPACE_ID);
    // Newest first, as the checks are listed; finished, passed and blocked checks aren't installs in progress.
    expect(response.installs.map((install) => [install.snapshotId, install.step])).toEqual([
      ["check-installed", "installed_off"],
      ["check-waiting", "waiting_install"],
    ]);
    expect(response.installs[1]).toMatchObject({ approvalId: "approval-install_inactive" });
    expect(response.operatorApprovalSkip).toBe(false);
    expect(Number.isNaN(Date.parse(response.generatedAt))).toBe(false);
  });

  it.each([
    ["trusted_local", true, true],
    ["trusted_local", false, false],
    ["remote_hardened", true, false],
  ] as const)("on %s with the setting %s, says the skip applies: %s", async (profile, setting, expected) => {
    const reads = sources({
      deploymentProfile: vi.fn(() => profile),
      readApprovalSkipSetting: vi.fn(async () => setting),
    });

    const response = await new CapabilitySkillsService(reads).installs(WORKSPACE_ID);

    expect(response.operatorApprovalSkip).toBe(expected);
    expect(reads.readApprovalSkipSetting).toHaveBeenCalledTimes(profile === "remote_hardened" ? 0 : 1);
  });

  it("reads one install at any step by its snapshot", async () => {
    // Done and declined both leave the in-progress list; read by its snapshot, a finished install still shows (R55).
    const done = hubItem({ snapshotId: "check-done", runtime: { activeVersion: true, callable: true } });
    const declined = hubItem({
      snapshotId: "check-declined",
      approvals: { install_inactive: hubApproval("install_inactive", "rejected") },
    });
    const blocked = hubItem({ snapshotId: "check-blocked", snapshot: { blockerCodes: ["AUDIT_MISSING"] } });
    const reads = sources({ listSkillHub: vi.fn(async () => ({ items: [installed, done, declined, blocked] })) });
    const service = new CapabilitySkillsService(reads);

    const read = async (snapshotId: string) =>
      (await service.installs(WORKSPACE_ID, snapshotId)).installs.map((install) => [install.snapshotId, install.step]);

    expect(await read("check-done")).toEqual([["check-done", "done"]]);
    expect(await read("check-declined")).toEqual([["check-declined", "check_passed"]]);
    expect(await read("check-blocked")).toEqual([["check-blocked", "blocked"]]);
    expect(await read("check-installed")).toEqual([["check-installed", "installed_off"]]);
    expect(await read("check-elsewhere")).toEqual([]);
    expect(reads.listSkillHub).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, limit: 100 });
  });

  it("answers a plain 503 when the checks can't be read, and logs why", async () => {
    const reportFailure = vi.fn();
    const reads = sources({ listSkillHub: failing("database is locked at C:\\data\\goatcitadel.sqlite") });

    const failure = await new CapabilitySkillsService(reads, reportFailure)
      .installs(WORKSPACE_ID)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServiceUnavailableError);
    expect((failure as Error).message).toBe("Skill installs can't be read right now.");
    expect(reportFailure).toHaveBeenCalledWith("skill_hub", expect.any(Error));
  });
});
