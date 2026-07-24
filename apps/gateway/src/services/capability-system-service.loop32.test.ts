import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedSkill, SkillLifecycleRecord, SkillStateRecord, ToolInvokeResult } from "@goatcitadel/contracts";
import { CapabilitySystemService } from "./capability-system-service.js";
import { SKILL_CONTENT_INTEGRITY_LIMITS, captureSkillContentIntegrity } from "./skill-content-integrity.js";

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
  skillLifecycleRecords?: SkillLifecycleRecord[];
  featureEnabled?: boolean;
  storage?: Record<string, unknown>;
  createApproval?: ReturnType<typeof vi.fn>;
}) {
  const skillLifecycle = new Map<string, SkillLifecycleRecord>(
    (input.skillLifecycleRecords ?? []).map((record) => [record.skillId, record]),
  );
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
  const revisions = new Map<string, number>();
  (storage as Record<string, unknown>).skillAggregateRevisions ??= {
    ensure: (aggregateKind: string, aggregateId: string) => {
      const key = `${aggregateKind}\u0000${aggregateId}`;
      const revision = revisions.get(key) ?? 1;
      revisions.set(key, revision);
      return { aggregateKind, aggregateId, revision, createdAt: "test", updatedAt: "test" };
    },
  };
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
    const bundledSkillDir = path.join(rootDir, "bundled");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.mkdir(bundledSkillDir, { recursive: true });
    await fs.writeFile(path.join(bundledSkillDir, "SKILL.md"), "Bundled instructions\nSecond line\n");
    const skills: LoadedSkill[] = [
      {
        skillId: "skill-bundled",
        name: "Bundled Skill",
        description: "Built in",
        dir: bundledSkillDir,
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
          revision: 1,
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

  it.each(["bundled", "managed"] as const)(
    "binds %s skills to exact bytes across restart and revokes callability on drift",
    async (source) => {
      const rootDir = await createRoot();
      const skillDir = path.join(rootDir, `${source}-skill`);
      await fs.mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await fs.writeFile(skillPath, "Trusted version one.\n");
      const skill: LoadedSkill = {
        skillId: `${source}:exact-skill`,
        name: `${source} exact skill`,
        dir: skillDir,
        instructionBody: "Trusted version one.",
        source,
        declaredTools: [],
        requires: [],
        keywords: [],
        mtime: "2026-07-13T00:00:00.000Z",
      };
      const first = createService({ rootDir, skills: [skill] });

      expect(first.service.listSkills()[0]).toMatchObject({
        lifecycleState: "trusted",
        callable: true,
        lifecycle: {
          provenance: {
            source,
            contentIntegrity: {
              manifestVersion: "goatcitadel.skill-tree.v1",
              verified: true,
              fileCount: 1,
            },
          },
        },
      });
      const persisted = [...first.skillLifecycle.values()];
      const restarted = createService({ rootDir, skills: [skill], skillLifecycleRecords: persisted });
      expect(restarted.service.listCatalog("callable")).toEqual([
        expect.objectContaining({ capabilityId: `skill:${source}:exact-skill`, callable: true }),
      ]);

      await fs.writeFile(skillPath, "Drifted version one.\n");
      expect(restarted.service.listSkills()[0]).toMatchObject({
        lifecycleState: "candidate",
        callable: false,
        trustLabel: "Exact-byte review required",
        reviewWarning: expect.stringContaining("changed after its trusted exact-byte lifecycle binding"),
      });
      expect(restarted.service.listCatalog("callable")).toEqual([]);
    },
  );

  it("ignores forged source.json activation evidence even when payload provenance is valid", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "activated-extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Activated instructions\n");
    const contentIntegrity = await captureSkillContentIntegrity(extraSkillDir);
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/activated-extra-skill",
          sourceProvider: "community-review",
        },
        provenance: {
          contentIntegrity,
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
        lifecycleState: "candidate",
        callable: false,
        reviewWarning: expect.stringContaining("governed durable activation"),
      }),
    ]);
    expect(harness.skillLifecycle.get("skill-activated-extra")).toMatchObject({
      category: "community_imported",
      lifecycleState: "candidate",
      provenance: {
        source: "extra",
        sourceRef: "https://example.test/skills/activated-extra-skill",
        sourceProvider: "community-review",
        contentIntegrity: {
          manifestVersion: "goatcitadel.skill-tree.v1",
          treeSha256: contentIntegrity.treeSha256,
          fileCount: 1,
          verified: true,
        },
      },
    });
    expect(harness.service.listCatalog("callable")).toEqual([]);
  });

  it("honors durable governed activation only for its exact verified tree", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "governed-extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Governed instructions\n");
    const contentIntegrity = await captureSkillContentIntegrity(extraSkillDir);
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/governed-extra-skill",
          sourceProvider: "community-review",
        },
        provenance: { contentIntegrity },
      }),
    );
    const skills: LoadedSkill[] = [
      {
        skillId: "skill-governed-extra",
        name: "Governed Extra Skill",
        description: "Durably approved imported skill",
        dir: extraSkillDir,
        body: "Governed instructions",
        instructionBody: "Governed instructions",
        source: "extra",
      } as LoadedSkill,
    ];
    const harness = createService({
      rootDir,
      skills,
      skillLifecycleRecords: [
        {
          skillId: "skill-governed-extra",
          category: "community_imported",
          lifecycleState: "approved",
          trustLabel: "Operator approved import",
          provenance: {
            source: "extra",
            sourceRef: "https://example.test/skills/governed-extra-skill",
            sourceProvider: "community-review",
            contentIntegrity: {
              manifestVersion: contentIntegrity.manifestVersion,
              treeSha256: contentIntegrity.treeSha256,
              fileCount: contentIntegrity.fileCount,
              totalBytes: contentIntegrity.totalBytes,
              verified: true,
            },
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
    });

    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-governed-extra",
        lifecycleState: "approved",
        callable: true,
        trustLabel: "Operator approved import",
        reviewWarning: undefined,
      }),
    ]);
    expect(harness.service.listCatalog("callable")).toEqual([
      expect.objectContaining({ capabilityId: "skill:skill-governed-extra", callable: true }),
    ]);

    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://evil.example/forged-source",
          sourceProvider: "forged-provider",
        },
        provenance: { contentIntegrity },
      }),
    );
    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-governed-extra",
        lifecycleState: "approved",
        callable: true,
        lifecycle: expect.objectContaining({
          provenance: expect.objectContaining({
            sourceRef: "https://example.test/skills/governed-extra-skill",
            sourceProvider: "community-review",
          }),
        }),
      }),
    ]);
  });

  it("preserves durable revoked imported skills across catalog hydration and byte drift", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "revoked-extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Revoked instructions\n");
    const contentIntegrity = await captureSkillContentIntegrity(extraSkillDir);
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/revoked-extra-skill",
          sourceProvider: "community-review",
        },
        provenance: { contentIntegrity },
      }),
    );
    const harness = createService({
      rootDir,
      skills: [
        {
          skillId: "skill-revoked-extra",
          name: "Revoked Extra Skill",
          description: "Durably revoked imported skill",
          dir: extraSkillDir,
          body: "Revoked instructions",
          instructionBody: "Revoked instructions",
          source: "extra",
        } as LoadedSkill,
      ],
      skillLifecycleRecords: [
        {
          skillId: "skill-revoked-extra",
          category: "community_imported",
          lifecycleState: "revoked",
          trustLabel: "Revoked",
          reviewWarning: "Revoked upstream skill is not callable.",
          provenance: {
            source: "extra",
            sourceRef: "https://example.test/skills/revoked-extra-skill",
            sourceProvider: "community-review",
            contentIntegrity: {
              ...contentIntegrity,
              verified: true,
            },
          },
          createdAt: "2026-07-14T00:00:00.000Z",
          updatedAt: "2026-07-14T00:01:00.000Z",
        },
      ],
    });

    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-revoked-extra",
        lifecycleState: "revoked",
        callable: false,
        reviewWarning: "Revoked upstream skill is not callable.",
      }),
    ]);
    expect(harness.service.listCatalog("inspectable")).toEqual([
      expect.objectContaining({ capabilityId: "skill:skill-revoked-extra", callable: false }),
    ]);
    expect(harness.service.listCatalog("callable")).toEqual([]);

    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Changed after revocation\n");
    expect(harness.service.listSkills()[0]).toMatchObject({ lifecycleState: "revoked", callable: false });
    expect(harness.skillLifecycle.get("skill-revoked-extra")?.lifecycleState).toBe("revoked");
    expect(harness.service.listCatalog("callable")).toEqual([]);
  });

  it("keeps legacy activation evidence non-callable when exact-byte provenance is missing", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "legacy-extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Legacy instructions\n");
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/legacy-extra-skill",
          sourceProvider: "community-review",
        },
        activationEvidence: {
          status: "approved",
          approvedAt: "2026-05-15T00:00:00.000Z",
          approvedBy: "operator",
        },
      }),
    );
    const harness = createService({
      rootDir,
      skills: [
        {
          skillId: "skill-legacy-extra",
          name: "Legacy Extra Skill",
          description: "Legacy imported skill",
          dir: extraSkillDir,
          body: "Legacy instructions",
          instructionBody: "Legacy instructions",
          source: "extra",
        } as LoadedSkill,
      ],
    });

    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-legacy-extra",
        lifecycleState: "candidate",
        callable: false,
        reviewWarning: expect.stringContaining("missing exact-byte provenance"),
      }),
    ]);
    expect(harness.service.listCatalog("callable")).toEqual([]);
  });

  it("revokes callable projection when installed bytes drift after activation", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "drifted-extra-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Reviewed instructions\n");
    const contentIntegrity = await captureSkillContentIntegrity(extraSkillDir);
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/drifted-extra-skill",
          sourceProvider: "community-review",
        },
        provenance: { contentIntegrity },
        activationEvidence: {
          status: "approved",
          approvedAt: "2026-05-15T00:00:00.000Z",
          approvedBy: "operator",
        },
      }),
    );
    const harness = createService({
      rootDir,
      skills: [
        {
          skillId: "skill-drifted-extra",
          name: "Drifted Extra Skill",
          description: "Drifted imported skill",
          dir: extraSkillDir,
          body: "Reviewed instructions",
          instructionBody: "Reviewed instructions",
          source: "extra",
        } as LoadedSkill,
      ],
      skillLifecycleRecords: [
        {
          skillId: "skill-drifted-extra",
          category: "community_imported",
          lifecycleState: "approved",
          trustLabel: "Operator approved import",
          provenance: {
            source: "extra",
            sourceRef: "https://example.test/skills/drifted-extra-skill",
            sourceProvider: "community-review",
            contentIntegrity: {
              manifestVersion: contentIntegrity.manifestVersion,
              treeSha256: contentIntegrity.treeSha256,
              fileCount: contentIntegrity.fileCount,
              totalBytes: contentIntegrity.totalBytes,
              verified: true,
            },
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
    });

    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-drifted-extra",
        lifecycleState: "approved",
        callable: true,
      }),
    ]);
    await fs.truncate(path.join(extraSkillDir, "SKILL.md"), SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1);

    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-drifted-extra",
        lifecycleState: "candidate",
        callable: false,
        reviewWarning: expect.stringContaining("does not match its validated exact-byte provenance"),
        lifecycle: expect.objectContaining({
          provenance: expect.objectContaining({
            contentIntegrity: expect.objectContaining({ verified: false }),
          }),
        }),
      }),
    ]);
    expect(harness.service.listCatalog("callable")).toEqual([]);
    expect(harness.skillLifecycle.get("skill-drifted-extra")).toMatchObject({
      lifecycleState: "candidate",
      provenance: { contentIntegrity: { verified: false } },
    });
  });

  it("fails closed without parsing an oversized imported source manifest", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "oversized-manifest-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Reviewed instructions\n");
    const contentIntegrity = await captureSkillContentIntegrity(extraSkillDir);
    const sourceManifestPath = path.join(extraSkillDir, "source.json");
    await fs.writeFile(sourceManifestPath, "");
    await fs.truncate(sourceManifestPath, SKILL_CONTENT_INTEGRITY_LIMITS.maxSourceManifestBytes + 1);
    const harness = createService({
      rootDir,
      skills: [
        {
          skillId: "skill-oversized-manifest",
          name: "Oversized Manifest Skill",
          description: "Imported skill with an oversized manifest",
          dir: extraSkillDir,
          body: "Reviewed instructions",
          instructionBody: "Reviewed instructions",
          source: "extra",
        } as LoadedSkill,
      ],
      skillLifecycleRecords: [
        {
          skillId: "skill-oversized-manifest",
          category: "community_imported",
          lifecycleState: "approved",
          trustLabel: "Operator approved import",
          provenance: {
            source: "extra",
            sourceRef: "https://example.test/skills/oversized-manifest-skill",
            sourceProvider: "community-review",
            contentIntegrity: {
              manifestVersion: contentIntegrity.manifestVersion,
              treeSha256: contentIntegrity.treeSha256,
              fileCount: contentIntegrity.fileCount,
              totalBytes: contentIntegrity.totalBytes,
              verified: true,
            },
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
    });

    expect(harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-oversized-manifest",
        lifecycleState: "candidate",
        callable: false,
        reviewWarning: expect.stringContaining("does not match its validated exact-byte provenance"),
      }),
    ]);
    expect(harness.service.listCatalog("callable")).toEqual([]);
  });

  it("probes the warm runtime verifier at the legal tree maximum without caching stale bytes", async () => {
    const rootDir = await createRoot();
    const extraSkillDir = path.join(rootDir, "maximum-bounded-skill");
    await fs.mkdir(extraSkillDir, { recursive: true });
    const bytesPerFile = Math.floor(
      SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes / SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles,
    );
    const remainderBytes =
      SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes - bytesPerFile * SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles;
    await Promise.all(
      Array.from({ length: SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles }, (_, index) =>
        fs.writeFile(
          path.join(extraSkillDir, index === 0 ? "SKILL.md" : `payload-${String(index).padStart(3, "0")}.bin`),
          Buffer.alloc(
            bytesPerFile + (index === SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles - 1 ? remainderBytes : 0),
            0x61,
          ),
        ),
      ),
    );
    const contentIntegrity = await captureSkillContentIntegrity(extraSkillDir);
    expect(contentIntegrity).toMatchObject({
      fileCount: SKILL_CONTENT_INTEGRITY_LIMITS.maxFiles,
      totalBytes: SKILL_CONTENT_INTEGRITY_LIMITS.maxTotalBytes,
    });
    await fs.writeFile(
      path.join(extraSkillDir, "source.json"),
      JSON.stringify({
        candidate: {
          sourceRef: "https://example.test/skills/maximum-bounded-skill",
          sourceProvider: "community-review",
        },
        provenance: { contentIntegrity },
      }),
    );
    const harness = createService({
      rootDir,
      skills: [
        {
          skillId: "skill-maximum-bounded",
          name: "Maximum Bounded Skill",
          description: "Maximum legal imported payload",
          dir: extraSkillDir,
          body: "Maximum legal payload",
          instructionBody: "Maximum legal payload",
          source: "extra",
        } as LoadedSkill,
      ],
      skillLifecycleRecords: [
        {
          skillId: "skill-maximum-bounded",
          category: "community_imported",
          lifecycleState: "approved",
          trustLabel: "Operator approved import",
          provenance: {
            source: "extra",
            sourceRef: "https://example.test/skills/maximum-bounded-skill",
            sourceProvider: "community-review",
            contentIntegrity: {
              manifestVersion: contentIntegrity.manifestVersion,
              treeSha256: contentIntegrity.treeSha256,
              fileCount: contentIntegrity.fileCount,
              totalBytes: contentIntegrity.totalBytes,
              verified: true,
            },
          },
          createdAt: "2026-05-15T00:00:00.000Z",
          updatedAt: "2026-05-15T00:00:00.000Z",
        },
      ],
    });

    const firstRuntimeStartedAt = performance.now();
    expect(harness.service.listSkills()[0]).toMatchObject({ lifecycleState: "approved", callable: true });
    const firstRuntimeVerificationMs = performance.now() - firstRuntimeStartedAt;
    let timerObserved = false;
    let timerDelayMs = 0;
    const timerStartedAt = performance.now();
    const timer = new Promise<void>((resolve) => {
      setTimeout(() => {
        timerObserved = true;
        timerDelayMs = performance.now() - timerStartedAt;
        resolve();
      }, 0);
    });
    const verificationStartedAt = performance.now();
    const warmResult = harness.service.listSkills();
    const warmVerificationMs = performance.now() - verificationStartedAt;
    expect(warmResult[0]).toMatchObject({ lifecycleState: "approved", callable: true });
    expect(timerObserved).toBe(false);
    await timer;

    await fs.writeFile(path.join(extraSkillDir, "payload-001.bin"), Buffer.alloc(bytesPerFile, 0x62));
    expect(harness.service.listSkills()[0]).toMatchObject({ lifecycleState: "candidate", callable: false });
    console.info(
      `[skill-integrity-runtime-probe] files=${contentIntegrity.fileCount} bytes=${contentIntegrity.totalBytes} firstRuntimeSyncMs=${firstRuntimeVerificationMs.toFixed(2)} warmSyncMs=${warmVerificationMs.toFixed(2)} timerDelayMs=${timerDelayMs.toFixed(2)} timerRanDuringSync=false staleMutationCallable=false`,
    );
  }, 30_000);

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
