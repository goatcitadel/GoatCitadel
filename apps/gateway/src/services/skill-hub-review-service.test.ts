import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { SkillImportValidationResult } from "@goatcitadel/contracts";
import { SkillHubArtifactStore } from "./skill-hub-artifact-store.js";
import { captureSkillContentIntegrity } from "./skill-content-integrity.js";
import {
  SKILL_HUB_REVIEW_SCHEMA_VERSION,
  SkillHubReviewService,
  type SkillHubReviewServiceOptions,
} from "./skill-hub-review-service.js";
import type { MaterializedSkillReviewContext } from "./skill-import-service.js";

interface Harness {
  rootDir: string;
  sourceDir: string;
  storage: Storage;
  artifactStore: SkillHubArtifactStore;
  context: () => Promise<MaterializedSkillReviewContext>;
  service: SkillHubReviewService;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.storage.close();
    await fs.rm(harness.rootDir, { recursive: true, force: true });
  }
});

// Each case builds a real harness over Storage, the CAS artifact store, and a
// temporary filesystem root. Under v8 coverage the suite measured between 42 and
// 138 seconds across runs on the same host, and several cases exceed the
// 15-second default on their own. The budget below covers that observed spread so
// a loaded host cannot turn instrumentation cost into a false coverage-lane
// failure, while still bounding a genuine hang.
describe("SkillHubReviewService", { timeout: 120_000 }, () => {
  it("admits exact validated bytes as an inactive candidate snapshot and replays or conflicts canonically", async () => {
    const harness = await createHarness();
    const input = sourceReviewInput();

    const created = await harness.service.reviewSource(input);

    expect(created).toMatchObject({
      schemaVersion: SKILL_HUB_REVIEW_SCHEMA_VERSION,
      replayed: false,
      snapshot: {
        workspaceId: "workspace-1",
        operation: "review",
        sourceProvider: "github",
        sourceType: "git_url",
        declaredVersion: "1.0.0",
        resolvedVersion: "a".repeat(40),
        trustDisposition: "candidate",
        blockerCodes: [],
      },
      journeyEvent: {
        actorId: "operator:alice",
        actorType: "operator",
        action: "upstream_review_captured",
        provenance: { sourceRequired: true, approvalRequired: false },
      },
    });
    expect(created.snapshot.permissionEnvelope).toMatchObject({
      toolIds: ["tool:memory.read"],
      networkOrigins: [],
      scripts: [],
    });
    expect(created.artifact.contentTreeSha256).toBe(created.snapshot.contentTreeSha256);
    expect(databaseCount(harness.storage, "candidate_skill_versions")).toBe(0);
    expect(databaseCount(harness.storage, "skill_lifecycle")).toBe(0);

    const replay = await harness.service.reviewSource({ ...input, actorId: "operator:bob" });
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot).toEqual(created.snapshot);
    expect(replay.artifact).toEqual(created.artifact);
    expect(replay.journeyEvent).toEqual(created.journeyEvent);

    await fs.appendFile(path.join(harness.sourceDir, "SKILL.md"), "\nChanged bytes.\n", "utf8");
    await expect(harness.service.reviewSource(input)).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(1);
  });

  it("serializes concurrent same-workspace idempotency into one immutable review", async () => {
    const harness = await createHarness();
    const input = sourceReviewInput({ idempotencyKey: "review-concurrent" });

    const results = await Promise.all([harness.service.reviewSource(input), harness.service.reviewSource(input)]);

    expect(results.map((entry) => entry.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.snapshot).toEqual(results[1]?.snapshot);
    expect(results[0]?.artifact).toEqual(results[1]?.artifact);
    expect(results[0]?.journeyEvent).toEqual(results[1]?.journeyEvent);
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(1);
    expect(databaseCount(harness.storage, "skill_hub_snapshot_artifacts")).toBe(1);
    expect(databaseCount(harness.storage, "governance_journey_events")).toBe(1);
  });

  it("fails closed for invalid validation, incomplete scans, unmapped tools, and unknown bundle dimensions", async () => {
    const cases: Array<{
      name: string;
      mutate: (validation: SkillImportValidationResult, harness: Harness) => Promise<void> | void;
      expectedField: string;
    }> = [
      {
        name: "invalid validation",
        mutate: (validation) => {
          validation.valid = false;
          validation.errors = ["fixture-only invalid content"];
        },
        expectedField: "VALIDATION_FAILED",
      },
      {
        name: "incomplete scan",
        mutate: (validation) => {
          validation.warnings.push(
            "Security scan reached the file inspection limit; review the remaining files manually.",
          );
        },
        expectedField: "SCAN_INCOMPLETE",
      },
      {
        name: "unmapped tool",
        mutate: (validation) => {
          validation.declaredTools = ["unknown.exec"];
          validation.externalToolMappings = [
            {
              declaredTool: "unknown.exec",
              disposition: "unmapped",
              reason: "fixture",
            },
          ];
        },
        expectedField: "UNMAPPED_TOOL",
      },
      {
        name: "unknown permission dimension",
        mutate: async (validation, harness) => {
          await fs.writeFile(
            path.join(harness.sourceDir, "goatcitadel.skill-bundle.json"),
            JSON.stringify({
              manifestVersion: "goatcitadel.skill-bundle.v1",
              scriptDisposition: "review_only_non_callable",
              assets: [],
              networkAccess: ["https://unexpected.example"],
            }),
            "utf8",
          );
          validation.bundleManifest = {
            status: "valid",
            manifestPath: "goatcitadel.skill-bundle.json",
            assetsVerified: 0,
            assetPaths: [],
            warnings: [],
            errors: [],
          };
        },
        expectedField: "UNKNOWN_BUNDLE_DIMENSION",
      },
      {
        name: "unknown frontmatter permission dimension",
        mutate: async (_validation, harness) => {
          const skillPath = path.join(harness.sourceDir, "SKILL.md");
          const raw = await fs.readFile(skillPath, "utf8");
          await fs.writeFile(
            skillPath,
            raw.replace("  tools: [memory.read]", "  tools: [memory.read]\n  network: any"),
          );
        },
        expectedField: "UNKNOWN_FRONTMATTER_DIMENSION",
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const harness = await createHarness(async (context, activeHarness) => {
        await testCase.mutate(context.validation, activeHarness);
        if (testCase.name.includes("permission dimension")) {
          context.validation.provenance!.contentIntegrity = await captureSkillContentIntegrity(activeHarness.sourceDir);
        }
        return context;
      });
      await expect(
        harness.service.reviewSource(sourceReviewInput({ idempotencyKey: `review-invalid-${index}` })),
      ).rejects.toMatchObject({
        code: "FIELD_INVALID",
        details: { field: testCase.expectedField },
      });
      expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(0);
      expect(databaseCount(harness.storage, "candidate_skill_versions")).toBe(0);
      expect(databaseCount(harness.storage, "skill_lifecycle")).toBe(0);
    }
  }, 45_000);

  it("rejects credentialed, fragmented, local, and marketplace source URLs before materialization", async () => {
    const harness = await createHarness();
    const refs = [
      "https://user:secret@github.com/example/review-skill.git",
      "https://github.com/example/review-skill.git#main",
      "file:///tmp/review-skill",
      "https://clawhub.ai/example/review-skill",
      "https://127.0.0.1/example/review-skill.git",
      "https://attacker-controlled.example/example/review-skill.git",
    ];
    for (const [index, sourceRef] of refs.entries()) {
      await expect(
        harness.service.reviewSource(sourceReviewInput({ sourceRef, idempotencyKey: `unsafe-${index}` })),
      ).rejects.toMatchObject({ code: "FIELD_INVALID" });
    }
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(0);
  });

  it("requires exact literal network origins and records known origins in the canonical envelope", async () => {
    const exactHarness = await createHarness(async (context, harness) => {
      await fs.appendFile(
        path.join(harness.sourceDir, "SKILL.md"),
        '\nCall fetch("https://api.example.com/v1/status").\n',
        "utf8",
      );
      context.validation.networkSignals = ["SKILL.md"];
      context.validation.checks.networkIndicators = true;
      context.validation.provenance!.contentIntegrity = await captureSkillContentIntegrity(harness.sourceDir);
      return context;
    });
    const exact = await exactHarness.service.reviewSource(sourceReviewInput({ idempotencyKey: "network-exact" }));
    expect((exact.snapshot.permissionEnvelope as { networkOrigins: string[] }).networkOrigins).toEqual([
      "https://api.example.com",
    ]);

    const dynamicHarness = await createHarness(async (context, harness) => {
      await fs.appendFile(path.join(harness.sourceDir, "SKILL.md"), "\nCall fetch(endpoint).\n", "utf8");
      context.validation.networkSignals = ["SKILL.md"];
      context.validation.checks.networkIndicators = true;
      context.validation.provenance!.contentIntegrity = await captureSkillContentIntegrity(harness.sourceDir);
      return context;
    });
    await expect(
      dynamicHarness.service.reviewSource(sourceReviewInput({ idempotencyKey: "network-dynamic" })),
    ).rejects.toMatchObject({ details: { field: "NETWORK_ORIGIN_UNKNOWN" } });
  });

  it("retains but blocks same-version byte drift and permission widening from production review", async () => {
    const harness = await createHarness(async (context, activeHarness) => {
      const raw = await fs.readFile(path.join(activeHarness.sourceDir, "SKILL.md"), "utf8");
      if (raw.includes("web_search")) {
        const widenedMapping = {
          declaredTool: "web_search",
          mappedCapabilityId: "tool:web.search",
          mappedCapabilityLabel: "web_search",
          disposition: "mapped" as const,
          reason: "Exact governed mapping.",
        };
        context.validation.declaredTools = ["memory.read", "web_search"];
        context.validation.externalToolMappings = [...(context.validation.externalToolMappings ?? []), widenedMapping];
      }
      return context;
    });
    await harness.service.reviewSource(sourceReviewInput({ idempotencyKey: "review-baseline" }));
    const skillPath = path.join(harness.sourceDir, "SKILL.md");
    const baseline = await fs.readFile(skillPath, "utf8");
    await fs.writeFile(skillPath, baseline.replace("tools: [memory.read]", "tools: [memory.read, web_search]"));

    const widened = await harness.service.reviewSource(sourceReviewInput({ idempotencyKey: "review-widened" }));

    expect(widened.snapshot.trustDisposition).toBe("blocked");
    expect(widened.snapshot.blockerCodes).toEqual(
      expect.arrayContaining(["PERMISSION_WIDENED", "UPSTREAM_VERSION_BYTE_DRIFT"]),
    );
    expect(widened.snapshot.permissionDiff).toMatchObject({ disposition: "widened" });
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(2);
  });

  it("includes validated bundle script assets even when their paths have no executable extension", async () => {
    const harness = await createHarness(async (context, activeHarness) => {
      await fs.mkdir(path.join(activeHarness.sourceDir, "scripts"), { recursive: true });
      await fs.writeFile(path.join(activeHarness.sourceDir, "scripts", "runner"), "review-only script\n", "utf8");
      await fs.writeFile(
        path.join(activeHarness.sourceDir, "goatcitadel.skill-bundle.json"),
        JSON.stringify({
          manifestVersion: "goatcitadel.skill-bundle.v1",
          scriptDisposition: "review_only_non_callable",
          assets: [
            {
              path: "scripts/runner",
              sha256: "a".repeat(64),
              kind: "script",
              callable: false,
            },
          ],
        }),
        "utf8",
      );
      context.validation.bundleManifest = {
        status: "valid",
        manifestPath: "goatcitadel.skill-bundle.json",
        assetsVerified: 1,
        assetPaths: ["scripts/runner"],
        scriptDisposition: "review_only_non_callable",
        warnings: [],
        errors: [],
      };
      context.validation.provenance!.contentIntegrity = await captureSkillContentIntegrity(activeHarness.sourceDir);
      return context;
    });

    const reviewed = await harness.service.reviewSource(sourceReviewInput({ idempotencyKey: "bundle-script-path" }));
    expect((reviewed.snapshot.permissionEnvelope as { scripts: string[] }).scripts).toEqual(["scripts/runner"]);
  });

  it("prepares rollback review only from verified same-workspace CAS bytes and never activates", async () => {
    const harness = await createHarness();
    const original = await harness.service.reviewSource(sourceReviewInput());

    await expect(
      harness.service.prepareRollbackReview({
        workspaceId: "workspace-foreign",
        snapshotId: original.snapshot.snapshotId,
        idempotencyKey: "rollback-foreign",
        actorId: "operator:alice",
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });

    const rollback = await harness.service.prepareRollbackReview({
      workspaceId: "workspace-1",
      snapshotId: original.snapshot.snapshotId,
      idempotencyKey: "rollback-1",
      actorId: "operator:alice",
    });
    expect(rollback).toMatchObject({
      replayed: false,
      snapshot: {
        operation: "rollback_check",
        contentTreeSha256: original.snapshot.contentTreeSha256,
        auditSha256: original.snapshot.auditSha256,
        permissionEnvelopeSha256: original.snapshot.permissionEnvelopeSha256,
        declaredVersion: original.snapshot.declaredVersion,
        resolvedVersion: original.snapshot.resolvedVersion,
      },
      journeyEvent: { action: "rollback_review_prepared" },
    });
    expect(rollback.artifact.manifest).toEqual(original.artifact.manifest);
    expect(databaseCount(harness.storage, "candidate_skill_versions")).toBe(0);
    expect(databaseCount(harness.storage, "skill_lifecycle")).toBe(0);

    const replay = await harness.service.prepareRollbackReview({
      workspaceId: "workspace-1",
      snapshotId: original.snapshot.snapshotId,
      idempotencyKey: "rollback-1",
      actorId: "operator:bob",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.snapshot).toEqual(rollback.snapshot);
  });

  it("blocks rollback when retained CAS bytes are tampered", async () => {
    const harness = await createHarness();
    const original = await harness.service.reviewSource(sourceReviewInput());
    const bundleDir = harness.artifactStore.resolveBundlePath(original.artifact.bundleRelPath);
    await fs.appendFile(path.join(bundleDir, "SKILL.md"), "\ntampered\n", "utf8");

    await expect(
      harness.service.prepareRollbackReview({
        workspaceId: "workspace-1",
        snapshotId: original.snapshot.snapshotId,
        idempotencyKey: "rollback-tampered",
        actorId: "operator:alice",
      }),
    ).rejects.toMatchObject({ code: "STATE_CONFLICT" });
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(1);
  });

  it("rolls snapshot, artifact linkage, and Journey evidence back as one immediate transaction", async () => {
    const harness = await createHarness();
    const service = serviceFor(harness, {
      beforeJourneyPersistence: () => {
        throw new Error("injected transaction failure");
      },
    });

    await expect(service.reviewSource(sourceReviewInput({ idempotencyKey: "transaction-rollback" }))).rejects.toThrow(
      "injected transaction failure",
    );
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(0);
    expect(databaseCount(harness.storage, "skill_hub_snapshot_artifacts")).toBe(0);
    expect(databaseCount(harness.storage, "skill_hub_audit_floors")).toBe(0);
    expect(databaseCount(harness.storage, "skill_hub_version_claims")).toBe(0);
    expect(databaseCount(harness.storage, "governance_journey_events")).toBe(0);
    expect(databaseCount(harness.storage, "candidate_skill_versions")).toBe(0);
    expect(databaseCount(harness.storage, "skill_lifecycle")).toBe(0);

    const recovered = await harness.service.reviewSource(sourceReviewInput({ idempotencyKey: "transaction-rollback" }));
    expect(recovered.replayed).toBe(false);
    expect(databaseCount(harness.storage, "skill_hub_snapshots")).toBe(1);
    expect(databaseCount(harness.storage, "skill_hub_snapshot_artifacts")).toBe(1);
    expect(databaseCount(harness.storage, "governance_journey_events")).toBe(1);
  });
});

async function createHarness(
  mutateContext?: (
    context: MaterializedSkillReviewContext,
    harness: Harness,
  ) => Promise<MaterializedSkillReviewContext>,
): Promise<Harness> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-skill-hub-review-"));
  const sourceDir = path.join(rootDir, "source");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceDir, "SKILL.md"),
    [
      "---",
      "name: review-skill",
      "description: A production review admission fixture skill.",
      "metadata:",
      "  version: 1.0.0",
      "  tools: [memory.read]",
      "---",
      "",
      "Review exact immutable bytes safely.",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.writeFile(path.join(sourceDir, "LICENSE"), "MIT\n", "utf8");
  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir: path.join(rootDir, "transcripts"),
    auditDir: path.join(rootDir, "audit"),
  });
  const artifactStore = new SkillHubArtifactStore(path.join(rootDir, "data", "skill-hub", "artifacts"));
  const context = async (): Promise<MaterializedSkillReviewContext> => {
    const integrity = await captureSkillContentIntegrity(sourceDir);
    const validation = validationFixture(integrity);
    const base: MaterializedSkillReviewContext = {
      skillDir: sourceDir,
      validation,
      declaredVersion: "1.0.0",
      resolvedGitCommit: "a".repeat(40),
      validateExactDirectory: async (skillDir) => {
        const exactIntegrity = await captureSkillContentIntegrity(skillDir);
        const exactProvenance = { ...validation.provenance!, contentIntegrity: exactIntegrity };
        return {
          ...validation,
          provenance: exactProvenance,
          candidate: { ...validation.candidate, provenance: exactProvenance },
        };
      },
    };
    return mutateContext ? mutateContext(base, harness) : base;
  };
  const harness: Harness = {
    rootDir,
    sourceDir,
    storage,
    artifactStore,
    context,
    service: undefined as unknown as SkillHubReviewService,
  };
  harness.service = serviceFor(harness);
  harnesses.push(harness);
  return harness;
}

function serviceFor(
  harness: Harness,
  overrides: Partial<Pick<SkillHubReviewServiceOptions, "beforeJourneyPersistence">> = {},
): SkillHubReviewService {
  let clock = Date.parse("2026-07-14T01:00:00.000Z");
  return new SkillHubReviewService({
    storage: harness.storage,
    artifactStore: harness.artifactStore,
    skillImport: {
      withMaterializedValidation: async (_input, callback) => callback(await harness.context()),
    },
    now: () => new Date(clock++).toISOString(),
    ...overrides,
  });
}

function validationFixture(
  integrity: Awaited<ReturnType<typeof captureSkillContentIntegrity>>,
): SkillImportValidationResult {
  const provenance = {
    sourceProvider: "github" as const,
    sourceRef: "https://github.com/example/review-skill.git",
    sourceType: "git_url" as const,
    capturedAt: "2026-07-14T00:00:00.000Z",
    repositoryUrl: "https://github.com/example/review-skill.git",
    contentIntegrity: integrity,
    nonCallableUntilActivated: true as const,
  };
  const externalToolMappings = [
    {
      declaredTool: "memory.read",
      mappedCapabilityId: "tool:memory.read",
      mappedCapabilityLabel: "memory.read",
      disposition: "mapped" as const,
      reason: "Exact governed mapping.",
    },
  ];
  const scriptDisposition = {
    action: "none" as const,
    scriptFiles: [],
    notes: ["No scripts."],
  };
  const bundleManifest = {
    status: "absent" as const,
    assetsVerified: 0,
    assetPaths: [],
    warnings: [],
    errors: [],
  };
  const compatibility = {
    sources: ["skill_md" as const],
    warnings: [],
    callability: "governed_candidate" as const,
  };
  return {
    valid: true,
    riskLevel: "low",
    errors: [],
    warnings: [],
    checks: {
      frontmatterValid: true,
      descriptionQuality: true,
      suspiciousScripts: false,
      networkIndicators: false,
      licenseDetected: true,
    },
    candidate: {
      sourceProvider: "github",
      sourceType: "git_url",
      sourceRef: "https://github.com/example/review-skill.git",
      repositoryUrl: "https://github.com/example/review-skill.git",
      canonicalKey: "github.com/example/review-skill",
      provenance,
      externalToolMappings,
      scriptDisposition,
      bundleManifest,
      compatibility,
    },
    inferredSkillName: "review-skill",
    inferredSkillId: "review-skill",
    declaredTools: ["memory.read"],
    requires: [],
    networkSignals: [],
    suspiciousSignals: [],
    licenseFiles: ["LICENSE"],
    externalToolMappings,
    scriptDisposition,
    provenance,
    bundleManifest,
    compatibility,
  };
}

function sourceReviewInput(overrides: Partial<Parameters<SkillHubReviewService["reviewSource"]>[0]> = {}) {
  return {
    workspaceId: "workspace-1",
    sourceRef: "https://github.com/example/review-skill.git",
    sourceType: "git_url" as const,
    idempotencyKey: "review-source-1",
    actorId: "operator:alice",
    ...overrides,
  };
}

function databaseCount(storage: Storage, table: string): number {
  const row = storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: number | string }>();
  return Number(row?.count ?? 0);
}
