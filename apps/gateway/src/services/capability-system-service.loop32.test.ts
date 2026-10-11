import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedSkill, SkillLifecycleRecord, SkillStateRecord, ToolInvokeResult } from "@goatcitadel/contracts";
import type { BundledSkillLockEntry } from "@goatcitadel/skills";
import { resolveBundledSkillLockEntry } from "@goatcitadel/skills";
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
  resolveBundledSkillLockEntry?: (skillId: string) => BundledSkillLockEntry | undefined;
}) {
  const skillLifecycle = new Map<string, SkillLifecycleRecord>(
    (input.skillLifecycleRecords ?? []).map((record) => [record.skillId, record]),
  );
  const audit = { append: vi.fn(async () => undefined) };
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
      audit,
      runImmediateTransaction: vi.fn(async <T>(callback: () => T | Promise<T>) => await callback()),
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
  const publishRealtime = vi.fn(async () => undefined);

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
      readFeatureFlags: async () => ({ codeModeV1Enabled: input.featureEnabled ?? true }),
      listToolCatalog: () => [],
      listLoadedSkills: () => input.skills ?? [],
      readSkillStates: async () => input.skillStates ?? new Map(),
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
      publishRealtime,
      readPolicySnapshot: async () => ({ mode: "test" }),
      ...(input.resolveBundledSkillLockEntry
        ? { resolveBundledSkillLockEntry: input.resolveBundledSkillLockEntry }
        : {}),
    }),
    storage,
    createApproval,
    publishRealtime,
    audit,
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

    const listed = await harness.service.listSkills();

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
    expect(await harness.service.listCatalog("inspectable")).toEqual(
      expect.arrayContaining([expect.objectContaining({ capabilityId: "skill:skill-extra", callable: false })]),
    );
    expect(await harness.service.listCatalog("callable")).not.toEqual(
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

      expect((await first.service.listSkills())[0]).toMatchObject({
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
      expect(await restarted.service.listCatalog("callable")).toEqual([
        expect.objectContaining({ capabilityId: `skill:${source}:exact-skill`, callable: true }),
      ]);

      await fs.writeFile(skillPath, "Drifted version one.\n");
      expect((await restarted.service.listSkills())[0]).toMatchObject({
        lifecycleState: "candidate",
        callable: false,
        trustLabel: "Exact-byte review required",
        reviewWarning: expect.stringContaining("changed after its trusted exact-byte lifecycle binding"),
      });
      expect(await restarted.service.listCatalog("callable")).toEqual([]);
    },
  );

  describe("release-bound re-trust of shipped skill trees", () => {
    function buildShippedSkill(source: "bundled" | "managed", skillDir: string): LoadedSkill {
      return {
        skillId: `${source}:release-skill`,
        name: `${source} release skill`,
        dir: skillDir,
        instructionBody: "Release one.",
        source,
        declaredTools: [],
        requires: [],
        keywords: [],
        mtime: "2026-07-13T00:00:00.000Z",
      };
    }

    async function captureLockEntry(skillId: string, skillDir: string): Promise<BundledSkillLockEntry> {
      const integrity = await captureSkillContentIntegrity(skillDir);
      return {
        skillId,
        manifestVersion: integrity.manifestVersion,
        treeSha256: integrity.treeSha256,
        fileCount: integrity.fileCount,
        totalBytes: integrity.totalBytes,
      };
    }

    function trustedRowAt(skill: LoadedSkill, lock: BundledSkillLockEntry, trustLabel: string): SkillLifecycleRecord {
      return {
        skillId: skill.skillId,
        category: skill.source === "bundled" ? "built_in" : "optional",
        lifecycleState: "trusted",
        trustLabel,
        provenance: {
          source: skill.source,
          contentIntegrity: {
            manifestVersion: lock.manifestVersion,
            treeSha256: lock.treeSha256,
            fileCount: lock.fileCount,
            totalBytes: lock.totalBytes,
            verified: true,
          },
        },
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      };
    }

    it.each(["bundled", "managed"] as const)(
      "re-trusts a release-shipped %s tree on the upgraded lineage and keeps tamper demotion",
      async (source) => {
        const rootDir = await createRoot();
        const skillDir = path.join(rootDir, `${source}-release-skill`);
        await fs.mkdir(skillDir, { recursive: true });
        const skillPath = path.join(skillDir, "SKILL.md");
        const skill = buildShippedSkill(source, skillDir);
        const trustLabel = source === "bundled" ? "Built-in" : "Managed optional";

        // Fresh install at release one binds the row to release-one bytes.
        await fs.writeFile(skillPath, "Release one.\n");
        const releaseOne = await captureLockEntry(skill.skillId, skillDir);
        const first = createService({ rootDir, skills: [skill] });
        expect((await first.service.listSkills())[0]).toMatchObject({ lifecycleState: "trusted", callable: true });
        const persisted = [...first.skillLifecycle.values()];

        // Release two ships new bytes and the compiled lock vouches for exactly that tree.
        await fs.writeFile(skillPath, "Release two.\n");
        const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
        const resolveLock = vi.fn((skillId: string) => (skillId === skill.skillId ? releaseTwo : undefined));

        // Upgraded lineage: the stored row still carries release one.
        const upgraded = createService({
          rootDir,
          skills: [skill],
          skillLifecycleRecords: persisted,
          resolveBundledSkillLockEntry: resolveLock,
        });
        expect((await upgraded.service.listSkills())[0]).toMatchObject({
          lifecycleState: "trusted",
          callable: true,
          trustLabel,
          reviewWarning: undefined,
          lifecycle: {
            createdAt: persisted[0]!.createdAt,
            provenance: { source, contentIntegrity: { treeSha256: releaseTwo.treeSha256, verified: true } },
          },
        });
        expect(await upgraded.service.listCatalog("callable")).toEqual([
          expect.objectContaining({ capabilityId: `skill:${skill.skillId}`, callable: true }),
        ]);
        expect(upgraded.audit.append).toHaveBeenCalledTimes(1);
        expect(upgraded.audit.append).toHaveBeenCalledWith(
          "approvals",
          expect.objectContaining({
            event: "skill_lifecycle.release_retrusted",
            skillId: skill.skillId,
            source,
            actorId: "system:bundled-skill-release-lock",
            previousLifecycleState: "trusted",
            lifecycleState: "trusted",
            previousContentIntegrity: expect.objectContaining({ treeSha256: releaseOne.treeSha256 }),
            contentIntegrity: expect.objectContaining({ treeSha256: releaseTwo.treeSha256 }),
            lockEntry: expect.objectContaining({ treeSha256: releaseTwo.treeSha256 }),
          }),
          expect.objectContaining({ deliveryId: expect.stringContaining(releaseTwo.treeSha256) }),
        );
        // Write-ahead receipt, then re-read + commit inside one immediate transaction, then the
        // live signal: never announce uncommitted state, never overwrite a concurrent writer.
        const storage = upgraded.storage as {
          skillLifecycle: { find: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
          runImmediateTransaction: ReturnType<typeof vi.fn>;
        };
        const upsert = storage.skillLifecycle.upsert;
        const transaction = storage.runImmediateTransaction;
        expect(transaction).toHaveBeenCalledTimes(1);
        const transactionOrder = transaction.mock.invocationCallOrder[0]!;
        const upsertOrder = upsert.mock.invocationCallOrder[0]!;
        expect(upgraded.audit.append.mock.invocationCallOrder[0]).toBeLessThan(transactionOrder);
        expect(transactionOrder).toBeLessThan(upsertOrder);
        // The compare-and-swap re-read happens inside the transaction, right before the upsert.
        expect(
          storage.skillLifecycle.find.mock.invocationCallOrder.some(
            (order) => order > transactionOrder && order < upsertOrder,
          ),
        ).toBe(true);
        expect(upsertOrder).toBeLessThan(upgraded.publishRealtime.mock.invocationCallOrder[0]!);
        expect(upgraded.publishRealtime).toHaveBeenCalledWith(
          "skill_lifecycle_retrusted",
          "capabilities",
          expect.objectContaining({
            skillId: skill.skillId,
            previousTreeSha256: releaseOne.treeSha256,
            treeSha256: releaseTwo.treeSha256,
          }),
        );

        // Fresh lineage at release two stays trusted with no re-trust evidence.
        const fresh = createService({ rootDir, skills: [skill], resolveBundledSkillLockEntry: resolveLock });
        expect((await fresh.service.listSkills())[0]).toMatchObject({ lifecycleState: "trusted", callable: true });
        expect(fresh.audit.append).not.toHaveBeenCalled();

        // Unexpected on-disk drift away from the release lock still demotes the re-trusted row.
        await fs.writeFile(skillPath, "Tampered two.\n");
        expect((await upgraded.service.listSkills())[0]).toMatchObject({
          lifecycleState: "candidate",
          callable: false,
          trustLabel: "Exact-byte review required",
        });
        expect(await upgraded.service.listCatalog("callable")).toEqual([]);
        expect(upgraded.audit.append).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["bundled", "managed"] as const)(
      "keeps the tamper demotion when the loaded %s tree matches neither the stored row nor the lock",
      async (source) => {
        const rootDir = await createRoot();
        const skillDir = path.join(rootDir, `${source}-release-skill`);
        await fs.mkdir(skillDir, { recursive: true });
        const skillPath = path.join(skillDir, "SKILL.md");
        const skill = buildShippedSkill(source, skillDir);
        await fs.writeFile(skillPath, "Release one.\n");
        const releaseOne = await captureLockEntry(skill.skillId, skillDir);
        await fs.writeFile(skillPath, "Release two.\n");
        const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
        await fs.writeFile(skillPath, "Unknown three.\n");

        const harness = createService({
          rootDir,
          skills: [skill],
          skillLifecycleRecords: [trustedRowAt(skill, releaseOne, "Built-in")],
          resolveBundledSkillLockEntry: () => releaseTwo,
        });
        expect((await harness.service.listSkills())[0]).toMatchObject({
          lifecycleState: "candidate",
          callable: false,
          trustLabel: "Exact-byte review required",
        });
        expect(harness.audit.append).not.toHaveBeenCalled();
        expect(harness.publishRealtime).not.toHaveBeenCalled();
      },
    );

    it.each(["bundled", "managed"] as const)(
      "recovers a %s row already demoted by exact-byte drift once the tree matches the release lock",
      async (source) => {
        const rootDir = await createRoot();
        const skillDir = path.join(rootDir, `${source}-release-skill`);
        await fs.mkdir(skillDir, { recursive: true });
        const skill = buildShippedSkill(source, skillDir);
        await fs.writeFile(path.join(skillDir, "SKILL.md"), "Release two.\n");
        const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
        // The pre-fix demotion rewrote the row with the new hashes and the review label.
        const demoted: SkillLifecycleRecord = {
          ...trustedRowAt(skill, releaseTwo, "Exact-byte review required"),
          lifecycleState: "candidate",
          reviewWarning:
            "Skill content changed after its trusted exact-byte lifecycle binding; review and reactivate this version before use.",
        };

        const harness = createService({
          rootDir,
          skills: [skill],
          skillLifecycleRecords: [demoted],
          resolveBundledSkillLockEntry: () => releaseTwo,
        });
        expect((await harness.service.listSkills())[0]).toMatchObject({
          lifecycleState: "trusted",
          callable: true,
          trustLabel: source === "bundled" ? "Built-in" : "Managed optional",
          reviewWarning: undefined,
        });
        expect(harness.audit.append).toHaveBeenCalledWith(
          "approvals",
          expect.objectContaining({ skillId: skill.skillId, previousLifecycleState: "candidate" }),
          expect.anything(),
        );
      },
    );

    it.each(["bundled", "managed"] as const)(
      "never re-trusts a revoked %s row, even across the drift demotion, when the tree matches the lock",
      async (source) => {
        const rootDir = await createRoot();
        const skillDir = path.join(rootDir, `${source}-release-skill`);
        await fs.mkdir(skillDir, { recursive: true });
        const skillPath = path.join(skillDir, "SKILL.md");
        const skill = buildShippedSkill(source, skillDir);
        await fs.writeFile(skillPath, "Release one.\n");
        const releaseOne = await captureLockEntry(skill.skillId, skillDir);
        await fs.writeFile(skillPath, "Release two.\n");
        const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
        // Revoked while bound to release one; release two then ships and the lock vouches for it.
        const revoked: SkillLifecycleRecord = {
          ...trustedRowAt(skill, releaseOne, "Revoked"),
          lifecycleState: "revoked",
          reviewWarning: "Revoked by operator.",
        };

        const harness = createService({
          rootDir,
          skills: [skill],
          skillLifecycleRecords: [revoked],
          resolveBundledSkillLockEntry: () => releaseTwo,
        });
        // Two passes: a drift demotion must not launder the revocation into a re-trustable candidate.
        for (let pass = 0; pass < 2; pass += 1) {
          expect((await harness.service.listSkills())[0]).toMatchObject({
            lifecycleState: "revoked",
            callable: false,
            reviewWarning: "Revoked by operator.",
          });
          expect(await harness.service.listCatalog("callable")).toEqual([]);
        }
        expect(harness.skillLifecycle.get(skill.skillId)).toEqual(revoked);
        expect(harness.audit.append).not.toHaveBeenCalled();
        expect(harness.publishRealtime).not.toHaveBeenCalled();
      },
    );

    it("re-trusts a legacy trusted bundled row without exact-byte provenance against the lock", async () => {
      const rootDir = await createRoot();
      const skillDir = path.join(rootDir, "bundled-release-skill");
      await fs.mkdir(skillDir, { recursive: true });
      const skill = buildShippedSkill("bundled", skillDir);
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "Release two.\n");
      const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
      const legacy: SkillLifecycleRecord = {
        ...trustedRowAt(skill, releaseTwo, "Built-in"),
        provenance: { source: "bundled" },
      };

      const harness = createService({
        rootDir,
        skills: [skill],
        skillLifecycleRecords: [legacy],
        resolveBundledSkillLockEntry: () => releaseTwo,
      });
      expect((await harness.service.listSkills())[0]).toMatchObject({
        lifecycleState: "trusted",
        callable: true,
        lifecycle: { provenance: { contentIntegrity: { treeSha256: releaseTwo.treeSha256, verified: true } } },
      });
      expect(harness.audit.append).toHaveBeenCalledWith(
        "approvals",
        expect.objectContaining({ skillId: skill.skillId, previousContentIntegrity: null }),
        expect.anything(),
      );
    });

    it("keeps the row non-callable with a visible reason when the re-trust receipt cannot be written", async () => {
      const rootDir = await createRoot();
      const skillDir = path.join(rootDir, "bundled-release-skill");
      await fs.mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      const skill = buildShippedSkill("bundled", skillDir);
      await fs.writeFile(skillPath, "Release one.\n");
      const releaseOne = await captureLockEntry(skill.skillId, skillDir);
      await fs.writeFile(skillPath, "Release two.\n");
      const releaseTwo = await captureLockEntry(skill.skillId, skillDir);

      const harness = createService({
        rootDir,
        skills: [skill],
        skillLifecycleRecords: [trustedRowAt(skill, releaseOne, "Built-in")],
        resolveBundledSkillLockEntry: () => releaseTwo,
      });
      harness.audit.append.mockRejectedValueOnce(new Error("audit disk unavailable token=sk-live-abcdef"));

      // The read still answers for every skill; this one stays fail-closed and says why.
      const failedRead = (await harness.service.listSkills())[0]!;
      expect(failedRead).toMatchObject({
        lifecycleState: "candidate",
        callable: false,
        trustLabel: "Exact-byte review required",
        reviewWarning: expect.stringContaining("re-trust audit receipt could not be written"),
      });
      expect(failedRead.reviewWarning).not.toContain("sk-live-abcdef");
      expect(harness.skillLifecycle.get(skill.skillId)).toMatchObject({ lifecycleState: "candidate" });
      expect(harness.publishRealtime).not.toHaveBeenCalled();

      // Once the receipt can be written the next read completes the re-trust.
      expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "trusted", callable: true });
      expect(harness.publishRealtime).toHaveBeenCalledTimes(1);
    });

    it("abandons the re-trust when the stored row changes while the receipt is being written", async () => {
      const rootDir = await createRoot();
      const skillDir = path.join(rootDir, "bundled-release-skill");
      await fs.mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      const skill = buildShippedSkill("bundled", skillDir);
      await fs.writeFile(skillPath, "Release one.\n");
      const releaseOne = await captureLockEntry(skill.skillId, skillDir);
      await fs.writeFile(skillPath, "Release two.\n");
      const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
      const stale = trustedRowAt(skill, releaseOne, "Built-in");

      const harness = createService({
        rootDir,
        skills: [skill],
        skillLifecycleRecords: [stale],
        resolveBundledSkillLockEntry: () => releaseTwo,
      });
      const concurrentlyRevoked: SkillLifecycleRecord = {
        ...stale,
        lifecycleState: "revoked",
        trustLabel: "Revoked",
        updatedAt: "2026-07-14T00:00:00.000Z",
      };
      harness.audit.append.mockImplementationOnce(async () => {
        harness.skillLifecycle.set(skill.skillId, concurrentlyRevoked);
      });

      expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "revoked", callable: false });
      expect(harness.skillLifecycle.get(skill.skillId)).toEqual(concurrentlyRevoked);
      expect(harness.publishRealtime).not.toHaveBeenCalled();
    });

    it("never lets the receipt-failure fallback overwrite a row revoked while the receipt was being written", async () => {
      const rootDir = await createRoot();
      const skillDir = path.join(rootDir, "bundled-release-skill");
      await fs.mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      const skill = buildShippedSkill("bundled", skillDir);
      await fs.writeFile(skillPath, "Release one.\n");
      const releaseOne = await captureLockEntry(skill.skillId, skillDir);
      await fs.writeFile(skillPath, "Release two.\n");
      const releaseTwo = await captureLockEntry(skill.skillId, skillDir);
      const stale = trustedRowAt(skill, releaseOne, "Built-in");

      const harness = createService({
        rootDir,
        skills: [skill],
        skillLifecycleRecords: [stale],
        resolveBundledSkillLockEntry: () => releaseTwo,
      });
      const concurrentlyRevoked: SkillLifecycleRecord = {
        ...stale,
        lifecycleState: "revoked",
        trustLabel: "Revoked",
        updatedAt: "2026-07-14T00:00:00.000Z",
      };
      harness.audit.append.mockImplementationOnce(async () => {
        harness.skillLifecycle.set(skill.skillId, concurrentlyRevoked);
        throw new Error("audit disk unavailable");
      });

      expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "revoked", callable: false });
      expect(harness.skillLifecycle.get(skill.skillId)).toEqual(concurrentlyRevoked);
      expect(harness.publishRealtime).not.toHaveBeenCalled();
    });

    it("keeps the committed re-trust and the catalog read when the realtime publication fails", async () => {
      const rootDir = await createRoot();
      const skillDir = path.join(rootDir, "bundled-release-skill");
      await fs.mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      const skill = buildShippedSkill("bundled", skillDir);
      await fs.writeFile(skillPath, "Release one.\n");
      const releaseOne = await captureLockEntry(skill.skillId, skillDir);
      await fs.writeFile(skillPath, "Release two.\n");
      const releaseTwo = await captureLockEntry(skill.skillId, skillDir);

      const harness = createService({
        rootDir,
        skills: [skill],
        skillLifecycleRecords: [trustedRowAt(skill, releaseOne, "Built-in")],
        resolveBundledSkillLockEntry: () => releaseTwo,
      });
      harness.publishRealtime.mockRejectedValueOnce(new Error("realtime retention unavailable"));

      expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "trusted", callable: true });
      expect(harness.skillLifecycle.get(skill.skillId)).toMatchObject({
        lifecycleState: "trusted",
        provenance: { contentIntegrity: { treeSha256: releaseTwo.treeSha256 } },
      });
      expect(harness.audit.append).toHaveBeenCalledTimes(1);
      expect(await harness.service.listCatalog("callable")).toEqual([
        expect.objectContaining({ capabilityId: `skill:${skill.skillId}`, callable: true }),
      ]);
    });

    it("re-trusts the shipped design-intelligence tree through the compiled lock on an upgraded install", async () => {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
      const skillDir = path.join(repoRoot, "skills", "bundled", "design-intelligence");
      const lockEntry = resolveBundledSkillLockEntry("bundled:design-intelligence");
      expect(lockEntry).toBeDefined();
      const skill: LoadedSkill = { ...buildShippedSkill("bundled", skillDir), skillId: "bundled:design-intelligence" };
      // Row created by an earlier release (the pre-presentation.md tree had 9 files).
      const staleRow = trustedRowAt(
        skill,
        {
          skillId: skill.skillId,
          manifestVersion: "goatcitadel.skill-tree.v1",
          treeSha256: "c29670f1a6fdba47820556db51bb93abafb092ea5feebe3cda7429100d64eccf",
          fileCount: 9,
          totalBytes: 124237,
        },
        "Built-in",
      );

      const harness = createService({ rootDir: repoRoot, skills: [skill], skillLifecycleRecords: [staleRow] });
      expect((await harness.service.listSkills())[0]).toMatchObject({
        lifecycleState: "trusted",
        callable: true,
        trustLabel: "Built-in",
        lifecycle: { provenance: { contentIntegrity: { treeSha256: lockEntry!.treeSha256, verified: true } } },
      });
      expect(await harness.service.listCatalog("callable")).toEqual([
        expect.objectContaining({ capabilityId: "skill:bundled:design-intelligence", callable: true }),
      ]);
      expect(harness.audit.append).toHaveBeenCalledWith(
        "approvals",
        expect.objectContaining({ skillId: "bundled:design-intelligence", lockEntry: { ...lockEntry } }),
        expect.anything(),
      );
    });
  });

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

    const listed = await harness.service.listSkills();

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
    expect(await harness.service.listCatalog("callable")).toEqual([]);
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

    expect(await harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-governed-extra",
        lifecycleState: "approved",
        callable: true,
        trustLabel: "Operator approved import",
        reviewWarning: undefined,
      }),
    ]);
    expect(await harness.service.listCatalog("callable")).toEqual([
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
    expect(await harness.service.listSkills()).toEqual([
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

    expect(await harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-revoked-extra",
        lifecycleState: "revoked",
        callable: false,
        reviewWarning: "Revoked upstream skill is not callable.",
      }),
    ]);
    expect(await harness.service.listCatalog("inspectable")).toEqual([
      expect.objectContaining({ capabilityId: "skill:skill-revoked-extra", callable: false }),
    ]);
    expect(await harness.service.listCatalog("callable")).toEqual([]);

    await fs.writeFile(path.join(extraSkillDir, "SKILL.md"), "Changed after revocation\n");
    expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "revoked", callable: false });
    expect(harness.skillLifecycle.get("skill-revoked-extra")?.lifecycleState).toBe("revoked");
    expect(await harness.service.listCatalog("callable")).toEqual([]);
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

    expect(await harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-legacy-extra",
        lifecycleState: "candidate",
        callable: false,
        reviewWarning: expect.stringContaining("missing exact-byte provenance"),
      }),
    ]);
    expect(await harness.service.listCatalog("callable")).toEqual([]);
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

    expect(await harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-drifted-extra",
        lifecycleState: "approved",
        callable: true,
      }),
    ]);
    await fs.truncate(path.join(extraSkillDir, "SKILL.md"), SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes + 1);

    expect(await harness.service.listSkills()).toEqual([
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
    expect(await harness.service.listCatalog("callable")).toEqual([]);
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

    expect(await harness.service.listSkills()).toEqual([
      expect.objectContaining({
        skillId: "skill-oversized-manifest",
        lifecycleState: "candidate",
        callable: false,
        reviewWarning: expect.stringContaining("does not match its validated exact-byte provenance"),
      }),
    ]);
    expect(await harness.service.listCatalog("callable")).toEqual([]);
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
    expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "approved", callable: true });
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
    const warmResult = await harness.service.listSkills();
    const warmVerificationMs = performance.now() - verificationStartedAt;
    expect(warmResult[0]).toMatchObject({ lifecycleState: "approved", callable: true });
    expect(timerObserved).toBe(false);
    await timer;

    await fs.writeFile(path.join(extraSkillDir, "payload-001.bin"), Buffer.alloc(bytesPerFile, 0x62));
    expect((await harness.service.listSkills())[0]).toMatchObject({ lifecycleState: "candidate", callable: false });
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
