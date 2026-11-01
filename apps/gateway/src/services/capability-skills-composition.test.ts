import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalListResponse,
  ApprovalRequest,
  SkillListItem,
  SkillSourceListResponse,
} from "@goatcitadel/contracts";
import type { SkillUseCount } from "@goatcitadel/storage";
import {
  composeCapabilitySkills,
  SHIPPED_EXTRA_SKILL_FOLDERS,
  type CapabilitySkillsOwners,
} from "./capability-skills-composition.js";
import { hubApproval, hubItem } from "./capability-skill-install.test-support.js";
import {
  buildSkillLifecycleApprovalBinding,
  buildSkillLifecycleApprovalPayload,
} from "./skill-governance-journey-producer.js";
import type { SkillStateMutationOutcome } from "./skill-state-service.js";

const RESEARCH: SkillListItem = {
  skillId: "bundled:research",
  name: "research",
  description: "Research with citations.",
  source: "bundled",
  dir: "skills/bundled/research",
  declaredTools: [],
  requires: [],
  keywords: [],
  instructionBody: "# Research",
  mtime: "2026-10-01T00:00:00.000Z",
  revision: 1,
  state: "enabled",
  callable: true,
};

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
        mutation: { skillId, state: "sleep" },
        expectedState: { skillId, revision: 1 },
      }),
      requesterId: "operator",
      mutation: { skillId, state: "sleep" },
    }),
    preview: {},
    createdAt: "2026-10-28T00:00:00.000Z",
    explanationStatus: "not_requested",
  };
}

const WAITING: SkillStateMutationOutcome = {
  pendingApproval: {
    approvalId: "approval-research",
    status: "pending",
    kind: "skill.lifecycle",
    action: "skill_state_set",
    subjectKind: "skill",
    subjectId: "bundled:research",
    requestSha256: "a".repeat(64),
    expectedStateSha256: "b".repeat(64),
    createdAt: "2026-10-28T00:00:00.000Z",
    replayed: false,
    skillIds: ["bundled:research"],
  },
};

function owners(overrides: Partial<CapabilitySkillsOwners> = {}): CapabilitySkillsOwners {
  return {
    chatTurnCapabilityProfiles: { countSkillUsesSince: vi.fn(async (): Promise<SkillUseCount[]> => []) },
    skills: {
      listSkills: vi.fn(async () => [RESEARCH]),
      setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => WAITING),
    },
    loadedSkills: vi.fn(() => [{ skillId: "bundled:research" }]),
    // A workspace that chose nothing: its turns may load every skill.
    listWorkspaceTurnSkills: vi.fn(async () => [RESEARCH]),
    capabilities: { listCapabilityCatalog: vi.fn(async () => []) },
    approvals: {
      listApprovalsPage: vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [] })),
      getApproval: vi.fn(async () => stateApproval("approval-research", "bundled:research")),
      resolveApproval: vi.fn(async () => ({})),
    },
    audit: { append: vi.fn(async () => undefined) },
    features: { isFeatureEnabled: vi.fn(async () => false) },
    deploymentProfile: () => "trusted_local",
    rootDir: ROOT_DIR,
    skillHub: {
      reviewSkillHubSource: vi.fn(async () => ({ snapshot: { snapshotId: "skill-hub-review-1" }, replayed: false })),
      listSkillHub: vi.fn(async () => ({ items: [hubItem()] })),
      createSkillHubApproval: vi.fn(async () => ({ approval: hubApproval("install_inactive", "pending") })),
    },
    skillHubSnapshots: { find: vi.fn(async () => undefined) },
    pluginRecords: { list: vi.fn(async () => []), listRemoved: vi.fn(async () => []) },
    skillSources: {
      readSourceCatalog: vi.fn(async () => ({ providers: [], items: [] })),
      presentSourceCatalog: vi.fn(
        (): SkillSourceListResponse => ({ generatedAt: "2026-10-29T00:00:00.000Z", providers: [], items: [] }),
      ),
      listInstalledSources: vi.fn(() => []),
    },
    ...overrides,
  };
}

const ROOT_DIR = path.resolve("goatcitadel-root");

/** An `extra` skill whose recorded source is this local folder, as a Skill Hub install's source.json leaves it. */
function installedFrom(name: string, dir: string, sourceRef: string): SkillListItem {
  return {
    ...RESEARCH,
    skillId: `extra:${name}`,
    name,
    source: "extra",
    dir,
    lifecycle: {
      skillId: `extra:${name}`,
      category: "community_imported",
      lifecycleState: "approved",
      trustLabel: "Imported/community",
      provenance: { source: "extra", sourceProvider: "local", sourceRef },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

describe("composeCapabilitySkills", () => {
  it("reads the use counts from the chat turn capability profiles", async () => {
    const countSkillUsesSince = vi.fn(
      async (): Promise<SkillUseCount[]> => [{ skillId: "research", uses: 2, lastUsedAt: "2026-10-20T00:00:00.000Z" }],
    );

    const { usage } = composeCapabilitySkills(owners({ chatTurnCapabilityProfiles: { countSkillUsesSince } }));
    const response = await usage.read({ refresh: false });

    expect(countSkillUsesSince).toHaveBeenCalledTimes(1);
    expect(countSkillUsesSince).toHaveBeenCalledWith(response.since);
    expect(response.skills).toEqual([{ skillId: "research", uses: 2, lastUsedAt: "2026-10-20T00:00:00.000Z" }]);
  });

  it("turns a failure in the profile history into a failed read, never an empty list", async () => {
    // The history query throws on a profile it can't parse; the Gateway's storage hands that back as a rejection.
    const countSkillUsesSince = vi.fn(async (): Promise<SkillUseCount[]> => {
      throw new Error("malformed JSON");
    });

    const { usage } = composeCapabilitySkills(owners({ chatTurnCapabilityProfiles: { countSkillUsesSince } }));

    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
    expect(countSkillUsesSince).toHaveBeenCalledTimes(2);
  });

  it("also fails the read when the history throws before it returns a promise", async () => {
    const countSkillUsesSince = vi.fn((): Promise<SkillUseCount[]> => {
      throw new Error("malformed JSON");
    });

    const { usage } = composeCapabilitySkills(owners({ chatTurnCapabilityProfiles: { countSkillUsesSince } }));

    await expect(usage.read({ refresh: false })).rejects.toThrow("malformed JSON");
  });

  it("reads the workspace's skills and the whole inspectable catalog through their owners", async () => {
    const parts = owners();

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    // Every skill whatever the workspace's choices, with that workspace's approved self-authored skills.
    expect(parts.skills.listSkills).toHaveBeenCalledWith("ALL", "workspace-a");
    // Every skill whatever the workspace's choices, so each skill's details have their catalog entry.
    expect(parts.capabilities.listCapabilityCatalog).toHaveBeenCalledWith("inspectable", "ALL", "workspace-a");
    expect(parts.features.isFeatureEnabled).toHaveBeenCalledWith("settingsApprovalSkipEnabled");
    expect(response.items.map((item) => item.skillId)).toEqual(["bundled:research"]);
  });

  it("offers the switch only on the loaded skills, the list the skill state owner looks a skill up in", async () => {
    const selfAuthored: SkillListItem = {
      ...RESEARCH,
      skillId: "extra:reviewed-0123456789ab",
      name: "inspect-work-item",
      source: "extra",
      capabilityCategory: "self_generated",
    };
    const parts = owners({
      skills: {
        listSkills: vi.fn(async () => [RESEARCH, selfAuthored]),
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => WAITING),
      },
    });

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    expect(response.items.map((item) => [item.skillId, item.switchable])).toEqual([
      ["extra:reviewed-0123456789ab", false],
      ["bundled:research", true],
    ]);
    expect(parts.loadedSkills).toHaveBeenCalledTimes(1);
  });

  it("marks the skills the workspace's turns may not load, from the reader Chat itself uses", async () => {
    const pdfTools: SkillListItem = { ...RESEARCH, skillId: "extra:pdf-tools", name: "pdf-tools", source: "extra" };
    const parts = owners({
      skills: {
        listSkills: vi.fn(async () => [RESEARCH, pdfTools]),
        setSkillState: vi.fn(async (): Promise<SkillStateMutationOutcome> => WAITING),
      },
      listWorkspaceTurnSkills: vi.fn(async () => [RESEARCH]),
    });

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    expect(parts.listWorkspaceTurnSkills).toHaveBeenCalledExactlyOnceWith("workspace-a");
    expect(response.items.map((item) => [item.skillId, item.leftOutOfWorkspace])).toEqual([
      ["extra:pdf-tools", true],
      ["bundled:research", false],
    ]);
    expect(response.issues).toEqual([]);
  });

  it("writes a failed read of the workspace's turn skills to the log, and shows only plain wording", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const listWorkspaceTurnSkills = vi.fn(async (): Promise<SkillListItem[]> => {
        throw new Error("choices store rejected Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      });

      const response = await composeCapabilitySkills(owners({ listWorkspaceTurnSkills })).skills.list("workspace-a");

      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ level: "error", source: "turn_skills" });
      expect(logged[0]).toContain("choices store rejected");
      expect(logged[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(JSON.stringify(response)).not.toContain("choices store rejected");
      expect(response.items.some((item) => "leftOutOfWorkspace" in item)).toBe(false);
      expect(response.issues).toEqual(["Which skills this workspace's chats can use couldn't be read right now."]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("is wired to the reader Chat's turns use, so a left-out skill is exactly one they can't load", () => {
    const source = readFileSync(new URL("./gateway-service.ts", import.meta.url), "utf8");

    expect(source).toContain(
      "listWorkspaceTurnSkills: (workspaceId) => this.workspaceTurnSkills.listSkills(workspaceId),",
    );
  });

  it("is wired to the same skill lookup GatewayService gives the skill state owner", () => {
    const source = readFileSync(new URL("./gateway-service.ts", import.meta.url), "utf8");

    // The state owner's host looks skills up here, and so does the Skills tab's switchable flag.
    expect(source).toContain("listSkills: async () => this.skillsService.list(),");
    expect(source).toContain("loadedSkills: () => this.skillsService.list(),");
  });

  it("reads a shipped skill as built in only when it came from this install's own folders", async () => {
    const skills = [
      // Installed through Skill Hub from GoatCitadel's own pack, which records the pack's folder as its source.
      installedFrom(
        "github-cli",
        path.join(ROOT_DIR, "skills", "extra", "github-cli"),
        path.join(ROOT_DIR, "skills", "import-packs", "github-cli"),
      ),
      // The same name from somewhere else.
      installedFrom(
        "himalaya",
        path.join(ROOT_DIR, "skills", "extra", "himalaya"),
        path.join(path.resolve("elsewhere"), "import-packs", "himalaya"),
      ),
      {
        ...RESEARCH,
        skillId: "extra:genie-npu-ir20",
        name: "genie-npu-ir20",
        source: "extra" as const,
        dir: path.join(ROOT_DIR, "skills", "genie-npu-ir20"),
      },
    ];
    const parts = owners({
      skills: { listSkills: vi.fn(async () => skills), setSkillState: vi.fn() },
    });

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    expect(Object.fromEntries(response.items.map((item) => [item.skillId, item.origin]))).toEqual({
      "extra:github-cli": "built_in",
      "extra:himalaya": "imported",
      "extra:genie-npu-ir20": "built_in",
    });
  });

  it("knows the folders GatewayService loads GoatCitadel's own skills and packs from", () => {
    const source = readFileSync(new URL("./gateway-service.ts", import.meta.url), "utf8");
    const extraFolders = [
      ...source.matchAll(/\{ source: "extra", dir: path\.join\(config\.rootDir, "skills", "([^"]+)"\) \}/gu),
    ].map((match) => match[1]);

    // Every extra source but skills/extra itself, where imports land, is one of GoatCitadel's own folders.
    expect(extraFolders.filter((folder) => folder !== "extra")).toEqual([...SHIPPED_EXTRA_SKILL_FOLDERS]);
    expect(source).toContain('shippedSkillPackRoot: path.join(config.rootDir, "skills", "import-packs"),');
    expect(source).toContain("rootDir: this.config.rootDir,");
  });

  it("reads every page of waiting approvals, so no skill's wait is cut off", async () => {
    const listApprovalsPage = vi.fn(
      async (input: { cursor?: string }): Promise<ApprovalListResponse> =>
        input.cursor === undefined
          ? { items: [stateApproval("approval-other", "extra:pdf-tools")], nextCursor: "page-2" }
          : { items: [stateApproval("approval-research", "bundled:research")] },
    );

    const response = await composeCapabilitySkills(
      owners({ approvals: { listApprovalsPage, getApproval: vi.fn(), resolveApproval: vi.fn() } }),
    ).skills.list("workspace-a");

    expect(listApprovalsPage.mock.calls.map(([input]) => input)).toEqual([
      { status: "pending", limit: 200 },
      { status: "pending", limit: 200, cursor: "page-2" },
    ]);
    expect(response.items[0]?.pendingApprovalId).toBe("approval-research");
    expect(response.issues).toEqual([]);
  });

  it("says waiting approvals couldn't be read rather than reading a part of an endless list", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const listApprovalsPage = vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [], nextCursor: "more" }));

      const response = await composeCapabilitySkills(
        owners({ approvals: { listApprovalsPage, getApproval: vi.fn(), resolveApproval: vi.fn() } }),
      ).skills.list("workspace-a");

      expect(listApprovalsPage).toHaveBeenCalledTimes(25);
      expect(response.issues).toEqual(["Waiting approvals couldn't be read right now."]);
      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ level: "error", source: "approvals" });
    } finally {
      stderr.mockRestore();
    }
  });

  it("writes a failed read to the server log with secrets redacted, and shows only plain wording", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const loadedSkills = vi.fn((): readonly Pick<SkillListItem, "skillId">[] => {
        throw new Error("upstream rejected Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      });

      const response = await composeCapabilitySkills(owners({ loadedSkills })).skills.list("workspace-a");

      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain("upstream rejected");
      expect(logged[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      expect(JSON.stringify(response)).not.toContain("upstream rejected");
      expect(response.issues).toEqual(["Which skills can be switched couldn't be read right now."]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("never reads the skip setting on a remote_hardened install", async () => {
    const parts = owners({ deploymentProfile: () => "remote_hardened" });

    const response = await composeCapabilitySkills(parts).skills.list("workspace-a");

    expect(response.operatorApprovalSkip).toBe(false);
    expect(parts.features.isFeatureEnabled).not.toHaveBeenCalled();
  });

  it("switches a skill through its owners: the skill state owner asks, the Inbox's resolve approves", async () => {
    const parts = owners({ features: { isFeatureEnabled: vi.fn(async () => true) } });

    const outcome = await composeCapabilitySkills(parts).actions.setState({
      workspaceId: "workspace-a",
      skillId: "bundled:research",
      state: "enabled",
      expectedRevision: 4,
      actorId: "operator-1",
    });

    expect(outcome).toEqual({ status: "approved", approvalId: "approval-research" });
    // No note: the switch has none, and the owner's own approval is the one resolved.
    expect(parts.skills.setSkillState).toHaveBeenCalledExactlyOnceWith("bundled:research", "enabled", undefined, {
      expectedRevision: 4,
      requesterId: "operator-1",
    });
    expect(parts.features.isFeatureEnabled).toHaveBeenCalledWith("settingsApprovalSkipEnabled");
    expect(parts.approvals.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-research", {
      decision: "approve",
      resolvedBy: "operator-1",
      resolutionNote: "Applied without asking: your setting to skip approvals for your own changes is on.",
    });
    // The approvals audit stream, as the Change Plan skip writes it.
    expect(parts.audit.append).toHaveBeenCalledExactlyOnceWith("approvals", {
      event: "operator_approval_skipped",
      approvalId: "approval-research",
      kind: "skill.lifecycle",
      reason: "setting",
      actorId: "operator-1",
    });
  });

  it("never reads the skip setting for a switch on a remote_hardened install", async () => {
    const parts = owners({ deploymentProfile: () => "remote_hardened" });

    const outcome = await composeCapabilitySkills(parts).actions.setState({
      workspaceId: "workspace-a",
      skillId: "bundled:research",
      state: "disabled",
      expectedRevision: 4,
      actorId: "operator-1",
    });

    expect(outcome).toEqual({ status: "waiting", approvalId: "approval-research" });
    expect(parts.features.isFeatureEnabled).not.toHaveBeenCalled();
    expect(parts.approvals.resolveApproval).not.toHaveBeenCalled();
  });

  it("writes a failed resolve to the server log with secrets redacted", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const resolveApproval = vi.fn(async () => {
        throw new Error("approval store rejected Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
      });
      const parts = owners({
        approvals: {
          listApprovalsPage: vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [] })),
          getApproval: vi.fn(),
          resolveApproval,
        },
      });

      const outcome = await composeCapabilitySkills(parts).actions.setState({
        workspaceId: "workspace-a",
        skillId: "bundled:research",
        state: "disabled",
        expectedRevision: 4,
        actorId: "operator-1",
      });

      expect(outcome).toEqual({ status: "waiting", approvalId: "approval-research" });
      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skill switch step failed"));
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({ level: "error", step: "resolve" });
      expect(logged[0]).toContain("approval store rejected");
      expect(logged[0]).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123456789");
    } finally {
      stderr.mockRestore();
    }
  });

  it("reads the state a pause starts from on the approval, through the Inbox's owner", async () => {
    const fromOff: ApprovalRequest = {
      ...stateApproval("approval-research", "bundled:research"),
      preview: { title: "Approve skill state change", currentState: "disabled" },
    };
    const parts = owners({
      approvals: {
        listApprovalsPage: vi.fn(async (): Promise<ApprovalListResponse> => ({ items: [] })),
        getApproval: vi.fn(async () => fromOff),
        resolveApproval: vi.fn(),
      },
    });

    const outcome = await composeCapabilitySkills(parts).actions.setState({
      workspaceId: "workspace-a",
      skillId: "bundled:research",
      state: "sleep",
      expectedRevision: 4,
      actorId: "operator-1",
    });

    // Pausing an off skill gives power back, so with the setting off it waits.
    expect(outcome).toEqual({ status: "waiting", approvalId: "approval-research" });
    expect(parts.approvals.getApproval).toHaveBeenCalledExactlyOnceWith("approval-research");
    expect(parts.approvals.resolveApproval).not.toHaveBeenCalled();
  });
});

describe("composeCapabilitySkills install steps", () => {
  it("checks a pack through Skill Hub's own review and reads the check back from its list", async () => {
    const parts = owners();

    const checked = await composeCapabilitySkills(parts).actions.checkSource({
      workspaceId: "workspace-a",
      source: { kind: "pack", packId: "himalaya" },
      idempotencyKey: "check-1",
      actorId: "operator-1",
    });

    expect(parts.skillHub.reviewSkillHubSource).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      packId: "himalaya",
      idempotencyKey: "check-1",
      actorId: "operator-1",
    });
    expect(parts.skillHub.listSkillHub).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", limit: 100 });
    expect(checked.install).toMatchObject({ step: "check_passed", source: { kind: "pack", packId: "himalaya" } });
  });

  it("asks Skill Hub's approval owner for a step, and the Inbox's resolve approves it with the setting on", async () => {
    const parts = owners({ features: { isFeatureEnabled: vi.fn(async () => true) } });

    const outcome = await composeCapabilitySkills(parts).actions.requestStep({
      workspaceId: "workspace-a",
      snapshotId: "skill-hub-review-1",
      operationKind: "install_inactive",
      actorId: "operator-1",
    });

    expect(outcome).toEqual({ status: "approved", approvalId: "approval-install_inactive" });
    expect(parts.skillHub.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "workspace-a",
      snapshotId: "skill-hub-review-1",
      operationKind: "install_inactive",
      actorId: "operator-1",
    });
    expect(parts.approvals.resolveApproval).toHaveBeenCalledExactlyOnceWith("approval-install_inactive", {
      decision: "approve",
      resolvedBy: "operator-1",
      resolutionNote: "Applied without asking: your setting to skip approvals for your own changes is on.",
    });
    expect(parts.audit.append).toHaveBeenCalledExactlyOnceWith("approvals", {
      event: "operator_approval_skipped",
      approvalId: "approval-install_inactive",
      kind: "skill_hub.lifecycle",
      reason: "setting",
      actorId: "operator-1",
    });
  });

  it("hands a plugin's skill step to Skill Hub's owner with the plugin's pass once its record lists the check", async () => {
    const plugin = {
      pluginId: "browser-checks",
      name: "Browser checks",
      workspaceId: "workspace-a",
      state: "installed" as const,
      pieces: [{ pieceId: "browser-qa", kind: "skill" as const, owned: true, skillSnapshotId: "skill-hub-review-1" }],
    };
    const parts = owners({
      skillHubSnapshots: {
        find: vi.fn(async () => ({
          sourceType: "local_path",
          sourceRef: `plugin:browser-checks/browser-qa@commit:${"c".repeat(40)}`,
          sourceProvider: "goatcitadel_plugin",
          workspaceId: "workspace-a",
        })),
      },
      pluginRecords: { list: vi.fn(async () => [plugin as never]), listRemoved: vi.fn(async () => []) },
    });
    const step = {
      workspaceId: "workspace-a",
      snapshotId: "skill-hub-review-1",
      operationKind: "install_inactive" as const,
      actorId: "operator-1",
    };

    await composeCapabilitySkills(parts).actions.requestStep(step);

    expect(parts.skillHub.createSkillHubApproval).toHaveBeenCalledExactlyOnceWith(step, {
      pluginPass: { pluginId: "browser-checks" },
    });
    // The Skills list marks the skill switched on from that check with the plugin's name.
    const listed = await composeCapabilitySkills(
      owners({
        skills: {
          listSkills: vi.fn(async () => [
            installedFrom("browser-qa", path.join(ROOT_DIR, "skills", "extra", "browser-qa"), "skill-hub-review-1"),
          ]),
          setSkillState: vi.fn(),
        },
        pluginRecords: { list: vi.fn(async () => [plugin as never]), listRemoved: vi.fn(async () => []) },
      }),
    ).skills.list("workspace-a");
    expect(listed.items[0]).toMatchObject({ skillId: "extra:browser-qa", fromPlugin: { pluginId: "browser-checks" } });
  });

  it("lists the workspace's installs in progress from Skill Hub's list", async () => {
    const parts = owners({
      skillHub: {
        reviewSkillHubSource: vi.fn(),
        listSkillHub: vi.fn(async () => ({
          items: [hubItem({ approvals: { install_inactive: hubApproval("install_inactive", "pending") } })],
        })),
        createSkillHubApproval: vi.fn(),
      },
    });

    const response = await composeCapabilitySkills(parts).skills.installs("workspace-a");

    expect(parts.skillHub.listSkillHub).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", limit: 100 });
    expect(response.installs.map((install) => install.step)).toEqual(["waiting_install"]);
    expect(response.operatorApprovalSkip).toBe(false);
  });
});

describe("composeCapabilitySkills discover", () => {
  it("lists the packs with no network call, through the source owner's offline read", async () => {
    const parts = owners();

    const response = await composeCapabilitySkills(parts).discover.list("workspace-a");

    expect(parts.skillSources.readSourceCatalog).toHaveBeenCalledExactlyOnceWith({ network: false });
    expect(parts.skillSources.presentSourceCatalog).toHaveBeenCalledExactlyOnceWith(
      { providers: [], items: [] },
      undefined,
      100,
    );
    expect(response.items.map((item) => item.id)).toEqual(["pack:himalaya", "pack:github-cli"]);
  });

  it("marks a source installing from the same installs the Skills tab lists", async () => {
    const parts = owners({
      skillHub: {
        reviewSkillHubSource: vi.fn(),
        listSkillHub: vi.fn(async () => ({
          items: [hubItem({ approvals: { install_inactive: hubApproval("install_inactive", "pending") } })],
        })),
        createSkillHubApproval: vi.fn(),
      },
    });

    const response = await composeCapabilitySkills(parts).discover.list("workspace-a");

    expect(parts.skillHub.listSkillHub).toHaveBeenCalledExactlyOnceWith({ workspaceId: "workspace-a", limit: 100 });
    expect(response.items.find((item) => item.id === "pack:himalaya")).toMatchObject({ state: "installing" });
  });

  it("still lists when the installs can't be read, and writes the failure to the log", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const parts = owners({
        skillHub: {
          reviewSkillHubSource: vi.fn(),
          listSkillHub: vi.fn(async () => {
            throw new Error("storage is locked");
          }),
          createSkillHubApproval: vi.fn(),
        },
      });

      const response = await composeCapabilitySkills(parts).discover.list("workspace-a");

      expect(response.items.find((item) => item.id === "pack:himalaya")).toMatchObject({ state: "available" });
      expect(JSON.stringify(response)).not.toContain("storage is locked");
      // One line, from the read that failed; Discover adds none of its own.
      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('"source":"skill_hub"');
      expect(logged[0]).toContain("storage is locked");
    } finally {
      stderr.mockRestore();
    }
  });

  it("logs once an installs read that failed without logging itself", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const parts = owners({
        skillHub: {
          reviewSkillHubSource: vi.fn(),
          // A check the installs can't be built from: it throws past the Hub read's own error handling.
          listSkillHub: vi.fn(async () => ({ items: [{ snapshotId: "skill-hub-review-1" } as never] })),
          createSkillHubApproval: vi.fn(),
        },
      });

      const response = await composeCapabilitySkills(parts).discover.list("workspace-a");

      expect(response.items.find((item) => item.id === "pack:himalaya")).toMatchObject({ state: "available" });
      const logged = stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes("a Capabilities skills source could not be read"));
      expect(logged).toHaveLength(1);
      expect(logged[0]).toContain('"source":"skill_hub"');
      expect(logged[0]).toContain("TypeError");
    } finally {
      stderr.mockRestore();
    }
  });
});
