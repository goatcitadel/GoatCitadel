import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedSkill, SkillLifecycleRecord, SkillStateRecord, ToolInvokeResult } from "@goatcitadel/contracts";
import { CapabilitySystemService } from "./capability-system-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-capability-loop32-"));
  tempRoots.push(root);
  return root;
}

function createService(input: {
  rootDir: string;
  skills?: LoadedSkill[];
  skillStates?: Map<string, SkillStateRecord>;
  featureEnabled?: boolean;
  storage?: Record<string, unknown>;
  createApproval?: ReturnType<typeof vi.fn>;
}) {
  const skillLifecycle = new Map<string, SkillLifecycleRecord>();
  const storage =
    input.storage ??
    ({
      skillLifecycle: {
        find: vi.fn((skillId: string) => skillLifecycle.get(skillId)),
        upsert: vi.fn((record: SkillLifecycleRecord) => {
          skillLifecycle.set(record.skillId, record);
          return record;
        }),
      },
      capabilityCatalogSnapshots: {
        create: vi.fn((snapshot) => snapshot),
      },
      candidateSkillVersions: {
        list: vi.fn(() => []),
      },
      capabilityProposals: {
        list: vi.fn(() => []),
      },
    } as never);
  const createApproval = input.createApproval ?? vi.fn();

  return {
    service: new CapabilitySystemService({
      rootDir: input.rootDir,
      runtimeConfig: {
        candidateRoot: "candidates",
        codeModeArtifactRoot: "artifacts",
        tempRoot: "tmp",
        codeModeSandbox: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: false,
        },
      },
      storage: storage as never,
      readFeatureFlags: () => ({ codeModeV1Enabled: input.featureEnabled ?? true }),
      listToolCatalog: () => [],
      listLoadedSkills: () => input.skills ?? [],
      readSkillStates: () => input.skillStates ?? new Map(),
      invokeTool: vi.fn(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "executed",
          auditEventId: "audit-1",
          result: { ok: true },
        }),
      ),
      createApproval,
      resolveApproval: vi.fn(),
      publishRealtime: vi.fn(),
      readPolicySnapshot: () => ({ mode: "test" }),
    }),
    storage,
    createApproval,
    skillLifecycle,
  };
}

describe("CapabilitySystemService loop32 defaults and diagnostics", () => {
  it("backfills imported skill lifecycle metadata as inspectable but not callable without activation", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    const skills: LoadedSkill[] = [
      {
        skillId: "skill-bundled",
        name: "Bundled Skill",
        description: "Built in",
        dir: path.join(rootDir, "bundled"),
        body: "\n\nBundled instructions\nSecond line",
        instructionBody: "\n\nBundled instructions\nSecond line",
        source: "bundled",
      } as LoadedSkill,
      {
        skillId: "skill-extra",
        name: "Extra Skill",
        description: "Imported",
        dir: extraSkillDir,
        body: "",
        instructionBody: "",
        source: "extra",
      } as LoadedSkill,
    ];
    const states = new Map<string, SkillStateRecord>([
      [
        "skill-extra",
        {
          skillId: "skill-extra",
          state: "disabled",
          note: "operator disabled",
          updatedAt: "2026-05-15T00:00:00.000Z",
          pinned: true,
          usageCount: 2,
          lastUsedAt: "2026-05-15T00:01:00.000Z",
        },
      ],
    ]);
    const harness = createService({ rootDir, skills, skillStates: states });

    const listed = harness.service.listSkills();

    expect(listed).toEqual([
      expect.objectContaining({
        skillId: "skill-bundled",
        capabilityCategory: "built_in",
        lifecycleState: "trusted",
        callable: true,
        trustLabel: "Built-in",
      }),
      expect.objectContaining({
        skillId: "skill-extra",
        capabilityCategory: "community_imported",
        lifecycleState: "candidate",
        callable: false,
        note: "operator disabled",
        pinned: true,
        reviewWarning: "Missing provenance manifest; imported skill remains non-callable until governed activation.",
      }),
    ]);
    expect(harness.skillLifecycle.get("skill-extra")).toMatchObject({
      category: "community_imported",
      lifecycleState: "candidate",
      provenance: { source: "extra" },
    });
    expect(harness.service.listCatalog("inspectable")).toEqual(
      expect.arrayContaining([expect.objectContaining({ capabilityId: "skill:skill-extra", callable: false })]),
    );
    expect(harness.service.listCatalog("callable")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ capabilityId: "skill:skill-extra" })]),
    );
  });

  it("keeps imported skills callable only after governed activation evidence is recorded", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "activated-extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/activated-extra-skill",
          sourceProvider: "community-review",
        },
        activationEvidence: {
          status: "approved",
          approvedAt: "2026-05-15T00:00:00.000Z",
          approvedBy: "operator",
          approvalId: "approval-skill-1",
        },
      }),
    );
    const skills: LoadedSkill[] = [
      {
        skillId: "skill-activated-extra",
        name: "Activated Extra Skill",
        description: "Imported and activated",
        dir: extraSkillDir,
        body: "Activated instructions",
        instructionBody: "Activated instructions",
        source: "extra",
      } as LoadedSkill,
    ];
    const harness = createService({ rootDir, skills });

    const listed = harness.service.listSkills();

    expect(listed).toEqual([
      expect.objectContaining({
        skillId: "skill-activated-extra",
        capabilityCategory: "community_imported",
        lifecycleState: "approved",
        callable: true,
        reviewWarning: undefined,
      }),
    ]);
    expect(harness.skillLifecycle.get("skill-activated-extra")).toMatchObject({
      category: "community_imported",
      lifecycleState: "approved",
      provenance: {
        source: "extra",
        sourceRef: "https://example.test/skills/activated-extra-skill",
        sourceProvider: "community-review",
      },
    });
    expect(harness.service.listCatalog("callable")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capabilityId: "skill:skill-activated-extra", callable: true }),
      ]),
    );
  });

  it("fails closed before creating Code Mode approvals when the feature flag is disabled", async () => {
    const rootDir = await createRoot();
    const createApproval = vi.fn();
    const harness = createService({ rootDir, featureEnabled: false, createApproval });

    await expect(
      harness.service.createCodeModeRun({
        language: "typescript",
        source: "return { ok: true };",
        requestedOutputIntent: "Should not start",
        saveCandidateOnSuccess: false,
      }),
    ).rejects.toThrow("Code Mode v1 is disabled");
    expect(createApproval).not.toHaveBeenCalled();
  });
});
