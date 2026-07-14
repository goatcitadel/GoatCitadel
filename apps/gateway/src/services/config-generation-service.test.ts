import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import {
  ConfigGenerationApplyError,
  ConfigGenerationCommitDecisionError,
  ConfigGenerationService,
  RuntimeOwnerApplyAlreadyRestoredError,
  recoverLastGoodConfigGeneration,
  type CompleteUnifiedConfigPayload,
} from "./config-generation-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ConfigGenerationService", () => {
  it("serializes concurrent mutations and rejects the stale revision without applying it", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);
    const apply = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);

    const results = await Promise.allSettled([
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "saver"), runtime: "saver" }),
        apply,
        restore,
      }),
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply,
        restore,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({ status: "rejected", reason: expect.any(ConflictError) });
    expect((rejection as PromiseRejectedResult).reason.details).toEqual({
      expectedRevision: 1,
      currentRevision: 2,
    });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(restore).not.toHaveBeenCalled();
    expect((await readActive(root)).generation?.revision).toBe(2);
  });

  it("fences mixed-generation reads and a queued stale write while owner apply is in flight", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);
    let ownerApplyStarted!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      ownerApplyStarted = resolve;
    });
    let releaseOwnerApply!: () => void;
    const ownerGate = new Promise<void>((resolve) => {
      releaseOwnerApply = resolve;
    });
    const firstApply = vi.fn(async () => {
      ownerApplyStarted();
      await ownerGate;
    });
    const staleApply = vi.fn(async () => undefined);

    const first = service.commit({
      expectedRevision: 1,
      requireExpectedRevision: true,
      previousRuntime: "balanced",
      buildCandidate: () => ({ payload: withBudgetMode(payload, "saver"), runtime: "saver" }),
      apply: firstApply,
      restore: async () => undefined,
    });
    await ownerStarted;

    expect(() => service.assertRuntimeReadsReady()).toThrow(ConflictError);
    const queuedStale = service.commit({
      expectedRevision: 1,
      requireExpectedRevision: true,
      previousRuntime: "balanced",
      buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
      apply: staleApply,
      restore: async () => undefined,
    });
    releaseOwnerApply();

    await expect(first).resolves.toMatchObject({ revision: 2 });
    await expect(queuedStale).rejects.toMatchObject({
      name: ConflictError.name,
      details: { expectedRevision: 1, currentRevision: 2 },
    });
    expect(firstApply).toHaveBeenCalledOnce();
    expect(staleApply).not.toHaveBeenCalled();
    expect(() => service.assertRuntimeReadsReady()).not.toThrow();
  });

  it("validates the complete candidate before publishing or invoking runtime owners", async () => {
    const { root, payload, activeRaw } = await createConfigRoot();
    const service = new ConfigGenerationService(root);
    const apply = vi.fn(async () => undefined);
    const invalid = structuredClone(payload) as Record<string, unknown>;
    delete invalid.budgets;

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: invalid as CompleteUnifiedConfigPayload, runtime: "saver" }),
        apply,
        restore: vi.fn(async () => undefined),
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(apply).not.toHaveBeenCalled();
    expect(await fs.readFile(activePath(root), "utf8")).toBe(activeRaw);
  });

  it("leaves the prior generation active when canonical publication fails", async () => {
    const { root, payload, activeRaw } = await createConfigRoot();
    const apply = vi.fn(async () => undefined);
    const service = new ConfigGenerationService(root, undefined, {
      beforePublish: () => {
        throw new Error("injected publish failure");
      },
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "saver"), runtime: "saver" }),
        apply,
        restore: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow("injected publish failure");

    expect(apply).not.toHaveBeenCalled();
    expect(await fs.readFile(activePath(root), "utf8")).toBe(activeRaw);
    expect(service.getRevision()).toBe(1);
  });

  it("recovers last-good after a crash window that published but never confirmed owner apply", async () => {
    const { root, payload } = await createConfigRoot();
    const apply = vi.fn(async () => undefined);
    const service = new ConfigGenerationService(root, undefined, {
      afterPublish: () => {
        throw new Error("simulated process death after publish");
      },
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply,
        restore: async () => undefined,
      }),
    ).rejects.toThrow("simulated process death after publish");
    expect((await readActive(root)).generation?.revision).toBe(2);
    expect(apply).not.toHaveBeenCalled();
    expect(service.getHealthSnapshot().transactionState).toBe("pending");

    const recovery = await recoverLastGoodConfigGeneration(root);

    expect(recovery).toMatchObject({ recovered: true, revision: 1 });
    expect((await readActive(root)).budgets).toEqual(payload.budgets);
    await expect(fs.stat(transactionPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    expect(new ConfigGenerationService(root).getHealthSnapshot().lastRecovery).toEqual({
      outcome: "recovered_unconfirmed",
      recovered: true,
      revision: 1,
    });
  });

  it("keeps a durable forward decision across two restarts until owners reconcile", async () => {
    const { root, payload } = await createConfigRoot();
    const apply = vi.fn(async () => undefined);
    const service = new ConfigGenerationService(root, undefined, {
      afterCommitMarker: () => {
        throw new Error("simulated process death after confirmation");
      },
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "saver"), runtime: "saver" }),
        apply,
        restore: async () => undefined,
      }),
    ).rejects.toThrow("simulated process death after confirmation");
    expect(apply).not.toHaveBeenCalled();
    expect(service.getHealthSnapshot().transactionState).toBe("committed");

    const recovery = await recoverLastGoodConfigGeneration(root);

    expect(recovery).toMatchObject({ recovered: false, revision: 2 });
    expect(((await readActive(root)).budgets as { mode: string }).mode).toBe("saver");
    await expect(fs.stat(transactionPath(root))).resolves.toBeDefined();
    const firstRestart = new ConfigGenerationService(root);
    expect(firstRestart.isRuntimeOwnerReconciliationPending()).toBe(true);
    expect(firstRestart.getHealthSnapshot().lastRecovery).toEqual({
      outcome: "confirmed_generation",
      recovered: false,
      revision: 2,
    });

    // A second process death before owner reconciliation must preserve the
    // forward decision instead of silently losing it during config recovery.
    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({ recovered: false, revision: 2 });
    const secondRestart = new ConfigGenerationService(root);
    expect(secondRestart.isRuntimeOwnerReconciliationPending()).toBe(true);
    const fencedBuild = vi.fn(() => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }));
    const fencedApply = vi.fn(async () => undefined);
    await expect(
      secondRestart.commit({
        expectedRevision: 2,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: fencedBuild,
        apply: fencedApply,
        restore: async () => undefined,
      }),
    ).rejects.toMatchObject({
      name: ConflictError.name,
      details: { currentRevision: 2, transactionState: "committed" },
    });
    expect(fencedBuild).not.toHaveBeenCalled();
    expect(fencedApply).not.toHaveBeenCalled();
    expect(() => secondRestart.adoptAlreadyAppliedProjectionSync(withBudgetMode(payload, "power"))).toThrow(
      ConflictError,
    );
    await secondRestart.completeRuntimeOwnerReconciliation();
    await expect(fs.stat(transactionPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the candidate canonical and owner state after a crash following owner apply", async () => {
    const { root, payload } = await createConfigRoot();
    let runtime = "balanced";
    const service = new ConfigGenerationService(root, undefined, {
      afterOwnerApply: () => {
        throw new Error("simulated process death after owner apply");
      },
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply: async (candidate) => {
          runtime = candidate;
        },
        restore: async (previous) => {
          runtime = previous;
        },
      }),
    ).rejects.toThrow("simulated process death after owner apply");

    expect(runtime).toBe("power");
    expect(service.getHealthSnapshot().transactionState).toBe("committed");
    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({ recovered: false, revision: 2 });
    expect(((await readActive(root)).budgets as { mode: string }).mode).toBe("power");
    const restarted = new ConfigGenerationService(root);
    expect(restarted.isRuntimeOwnerReconciliationPending()).toBe(true);
    // Models idempotent startup owner reconciliation from the canonical value.
    runtime = (restarted.getActivePayload().budgets as { mode: string }).mode;
    await restarted.completeRuntimeOwnerReconciliation();
    expect(runtime).toBe("power");
  });

  it("restores the runtime owner and publishes a monotonic rollback generation when apply fails", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);
    let runtime = "balanced";
    const restore = vi.fn(async (previous: string) => {
      const rollbackCanonical = await readActive(root);
      const rollbackMarker = JSON.parse(await fs.readFile(transactionPath(root), "utf8")) as Record<string, unknown>;
      expect(rollbackCanonical.generation?.revision).toBe(3);
      expect(rollbackMarker).toMatchObject({ state: "committed", revision: 3 });
      runtime = previous;
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply: async (candidate) => {
          runtime = candidate;
          throw new Error("owner rejected candidate");
        },
        restore,
      }),
    ).rejects.toMatchObject({
      name: ConfigGenerationApplyError.name,
      currentRevision: 3,
    });

    const active = await readActive(root);
    expect(runtime).toBe("balanced");
    expect(restore).toHaveBeenCalledWith("balanced");
    expect(active.generation?.revision).toBe(3);
    expect((active.budgets as { mode: string }).mode).toBe((payload.budgets as { mode: string }).mode);
  });

  it("retains the rollback decision across process death after exact owner compensation", async () => {
    const { root, payload } = await createConfigRoot();
    let runtime = "balanced";
    const service = new ConfigGenerationService(root, undefined, {
      afterRollbackOwnerRestore: () => {
        throw new Error("simulated process death after rollback owner restore");
      },
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply: async (candidate) => {
          runtime = candidate;
          throw new Error("owner rejected candidate");
        },
        restore: async (previous) => {
          runtime = previous;
        },
      }),
    ).rejects.toMatchObject({ name: "ConfigGenerationRollbackError" });

    expect(runtime).toBe("balanced");
    expect(((await readActive(root)).budgets as { mode: string }).mode).toBe("balanced");
    expect(service.getHealthSnapshot()).toMatchObject({ revision: 3, transactionState: "committed" });
    expect(JSON.parse(await fs.readFile(transactionPath(root), "utf8"))).toMatchObject({
      state: "committed",
      revision: 3,
    });

    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({ recovered: false, revision: 3 });
    const restarted = new ConfigGenerationService(root);
    expect(restarted.isRuntimeOwnerReconciliationPending()).toBe(true);
    await restarted.completeRuntimeOwnerReconciliation();
    await expect(fs.stat(transactionPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a committed rollback marker when exact owner compensation fails", async () => {
    const { root, payload } = await createConfigRoot();
    let runtime = "balanced";
    const recoveryIntent = {
      version: 1 as const,
      meshArtifact: { nodeId: "candidate-node" },
    };
    const service = new ConfigGenerationService(root);

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        captureRuntimeOwnerRecoveryIntent: () => recoveryIntent,
        apply: async (candidate) => {
          runtime = candidate;
          throw new Error("owner rejected candidate");
        },
        restore: async () => {
          throw new Error("exact compensation failed");
        },
      }),
    ).rejects.toMatchObject({ name: "ConfigGenerationRollbackError" });

    expect(runtime).toBe("power");
    expect(((await readActive(root)).budgets as { mode: string }).mode).toBe("balanced");
    expect(service.getHealthSnapshot()).toMatchObject({ revision: 3, transactionState: "committed" });
    expect(service.getRollbackRuntimeOwnerRecoveryIntent()).toEqual(recoveryIntent);
    const restarted = new ConfigGenerationService(root);
    expect(restarted.isRuntimeOwnerReconciliationPending()).toBe(true);
    expect(restarted.getRollbackRuntimeOwnerRecoveryIntent()).toEqual(recoveryIntent);
  });

  it("rewrites a stale candidate marker after rollback publication and retains exact owner undo intent", async () => {
    const { root, payload } = await createConfigRoot();
    const candidateTokenHash = "a".repeat(64);
    const recoveryIntent = {
      version: 1 as const,
      meshArtifact: {
        nodeId: "candidate-node",
        tokenHash: candidateTokenHash,
      },
    };
    const previousFeatures = structuredClone((payload.assistant as { features: Record<string, boolean> }).features);
    const candidateFeatures = {
      ...previousFeatures,
      autonomyV1Disabled: previousFeatures.autonomyV1Disabled !== true,
    };
    const candidatePayload = withBudgetMode(payload, "power");
    (candidatePayload.assistant as { features: Record<string, boolean> }).features = candidateFeatures;
    const meshNodes = new Set<string>();
    const meshTokens = new Set<string>();
    let failRollbackMarker = true;
    const service = new ConfigGenerationService(root, undefined, {
      beforeTransactionMarkerWrite: (state, markerPayload) => {
        if (state === "committed" && markerPayload.generation?.revision === 3 && failRollbackMarker) {
          failRollbackMarker = false;
          throw new Error("simulated process death after rollback canonical publish");
        }
      },
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: candidatePayload, runtime: "power" }),
        captureRuntimeOwnerRecoveryIntent: () => recoveryIntent,
        apply: async () => {
          meshNodes.add("candidate-node");
          meshTokens.add(candidateTokenHash);
          throw new Error("later owner rejected candidate");
        },
        // This must not run until the rollback canonical and marker exist.
        restore: async () => undefined,
      }),
    ).rejects.toMatchObject({ name: "ConfigGenerationRollbackError" });

    const rolledBack = await readActive(root);
    expect(rolledBack.generation?.revision).toBe(3);
    expect((rolledBack.budgets as { mode: string }).mode).toBe("balanced");
    expect(meshNodes.has("candidate-node")).toBe(true);
    expect(meshTokens.has(candidateTokenHash)).toBe(true);
    // A late durable projection write is possible around a real external
    // process death; startup must replace it from the rollback canonical.
    // Recovery must replace the stale candidate marker with a committed marker
    // for the rollback canonical while carrying the exact pre-candidate receipt.
    await expect(recoverLastGoodConfigGeneration(root)).resolves.toMatchObject({
      recovered: false,
      revision: 3,
    });
    const restarted = new ConfigGenerationService(root);
    expect(restarted.isRuntimeOwnerReconciliationPending()).toBe(true);
    expect(restarted.getRollbackRuntimeOwnerRecoveryIntent()).toEqual(recoveryIntent);

    // Models Gateway's idempotent startup reconciliation: canonical features
    // replace system_settings and the exact mesh receipt deletes rows that did
    // not exist before the candidate.
    const featureSystemSettings = structuredClone(
      (restarted.getActivePayload().assistant as { features: Record<string, boolean> }).features,
    );
    const intent = restarted.getRollbackRuntimeOwnerRecoveryIntent();
    if (intent?.meshArtifact) {
      if (!intent.meshArtifact.node) meshNodes.delete(intent.meshArtifact.nodeId);
      if (intent.meshArtifact.tokenHash && !intent.meshArtifact.joinToken) {
        meshTokens.delete(intent.meshArtifact.tokenHash);
      }
    }
    await restarted.completeRuntimeOwnerReconciliation();

    expect(featureSystemSettings).toEqual(previousFeatures);
    expect(meshNodes.has("candidate-node")).toBe(false);
    expect(meshTokens.has(candidateTokenHash)).toBe(false);
    await expect(fs.stat(transactionPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke restore for an atomic owner abort with no visible effect", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);
    const originalTokenRow = {
      tokenHash: "previous-token-hash",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      usedAt: undefined,
      usedByNodeId: undefined,
    };
    let durableTokenRow = structuredClone(originalTokenRow);
    const restore = vi.fn(async () => {
      // A legacy second replace would refresh timestamps; this makes any
      // accidental outer restore observable instead of accepting semantic-only parity.
      durableTokenRow = {
        ...originalTokenRow,
        createdAt: "2026-02-01T00:00:00.000Z",
        expiresAt: "2026-02-02T00:00:00.000Z",
      };
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply: async () => {
          durableTokenRow = {
            tokenHash: "candidate-token-hash",
            createdAt: "2026-03-01T00:00:00.000Z",
            expiresAt: "2026-03-02T00:00:00.000Z",
            usedAt: undefined,
            usedByNodeId: undefined,
          };
          // Models an outer database transaction abort: no candidate value is
          // ever externally visible, so no reverse owner operation is needed.
          durableTokenRow = structuredClone(originalTokenRow);
          throw new RuntimeOwnerApplyAlreadyRestoredError(new Error("LLM owner failed after mesh apply"));
        },
        restore,
      }),
    ).rejects.toMatchObject({
      name: ConfigGenerationApplyError.name,
      currentRevision: 3,
    });

    expect(restore).not.toHaveBeenCalled();
    expect(durableTokenRow).toEqual(originalTokenRow);
  });

  it("does not enter runtime owners when the durable commit-decision write fails", async () => {
    const { root, payload } = await createConfigRoot();
    let injected = false;
    const service = new ConfigGenerationService(root, undefined, {
      beforeTransactionMarkerWrite: (state, markerPayload) => {
        if (state === "committed" && markerPayload.generation?.revision === 2 && !injected) {
          injected = true;
          throw new Error("injected committed marker failure");
        }
      },
    });
    let runtime = "balanced";
    const restore = vi.fn(async (previous: string) => {
      runtime = previous;
    });

    await expect(
      service.commit({
        expectedRevision: 1,
        requireExpectedRevision: true,
        previousRuntime: "balanced",
        buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
        apply: async (candidate) => {
          runtime = candidate;
        },
        restore,
      }),
    ).rejects.toMatchObject({
      name: ConfigGenerationCommitDecisionError.name,
      currentRevision: 3,
    });

    expect(restore).not.toHaveBeenCalled();
    expect(runtime).toBe("balanced");
    expect((await readActive(root)).generation?.revision).toBe(3);
  });

  it("treats split files as repairable mirrors after the canonical commit succeeds", async () => {
    const { root, payload } = await createConfigRoot();
    let failMirror = true;
    const service = new ConfigGenerationService(root, undefined, {
      beforeMirrorWrite: () => {
        if (failMirror) {
          failMirror = false;
          throw new Error("injected mirror failure");
        }
      },
    });

    const result = await service.commit({
      expectedRevision: 1,
      requireExpectedRevision: true,
      previousRuntime: "balanced",
      buildCandidate: () => ({ payload: withBudgetMode(payload, "saver"), runtime: "saver" }),
      apply: async () => undefined,
      restore: async () => undefined,
    });

    expect(result).toMatchObject({ revision: 2, mirrorRepairPending: true });
    expect((await readActive(root)).generation?.revision).toBe(2);

    await service.repairSplitMirrors();

    expect(service.isMirrorRepairPending()).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(root, "config", "budgets.json"), "utf8"))).toMatchObject({
      mode: "saver",
    });
  });

  it("recovers a corrupt active config from the fully validated last-good generation", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);

    await service.commit({
      expectedRevision: 1,
      requireExpectedRevision: true,
      previousRuntime: "balanced",
      buildCandidate: () => ({ payload: withBudgetMode(payload, "power"), runtime: "power" }),
      apply: async () => undefined,
      restore: async () => undefined,
    });
    await fs.writeFile(activePath(root), "{ definitely-not-json", "utf8");

    const recovery = await recoverLastGoodConfigGeneration(root);

    expect(recovery).toMatchObject({ recovered: true, revision: 2 });
    const recovered = await readActive(root);
    expect(recovered.generation?.revision).toBe(2);
    expect((recovered.budgets as { mode: string }).mode).toBe("power");
  });

  it("adopts legacy runtime projections without erasing generation metadata across two restarts", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);

    await service.commit({
      expectedRevision: 1,
      requireExpectedRevision: true,
      previousRuntime: "balanced",
      buildCandidate: () => ({ payload: withBudgetMode(payload, "saver"), runtime: "saver" }),
      apply: async () => undefined,
      restore: async () => undefined,
    });
    const committed = await readActive(root);
    expect(committed.generation?.revision).toBe(2);

    const adopted = service.adoptAlreadyAppliedProjectionSync(withBudgetMode(committed, "power"));
    expect(adopted.revision).toBe(3);
    const afterAdoption = await readActive(root);
    expect(afterAdoption.generation).toMatchObject({ revision: 3 });
    expect(afterAdoption.generation?.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(afterAdoption.generation?.digest).not.toBe(committed.generation?.digest);

    const firstRestart = new ConfigGenerationService(root);
    expect(firstRestart.getRevision()).toBe(3);
    const noOp = firstRestart.adoptAlreadyAppliedProjectionSync(afterAdoption);
    expect(noOp.revision).toBe(3);
    expect((await readActive(root)).generation).toEqual(afterAdoption.generation);

    const secondRestart = new ConfigGenerationService(root);
    expect(secondRestart.getRevision()).toBe(3);
    expect(secondRestart.getGenerationId()).toBe(afterAdoption.generation?.generationId);
  });

  it("fences a legacy projection while an async generation mutation is queued", async () => {
    const { root, payload } = await createConfigRoot();
    const service = new ConfigGenerationService(root);
    let releaseCandidate!: () => void;
    const candidateGate = new Promise<void>((resolve) => {
      releaseCandidate = resolve;
    });
    const pending = service.commit({
      expectedRevision: 1,
      requireExpectedRevision: true,
      previousRuntime: "balanced",
      buildCandidate: async () => {
        await candidateGate;
        return { payload: withBudgetMode(payload, "saver"), runtime: "saver" };
      },
      apply: async () => undefined,
      restore: async () => undefined,
    });

    expect(() => service.adoptAlreadyAppliedProjectionSync(withBudgetMode(payload, "power"))).toThrow(ConflictError);
    releaseCandidate();
    await pending;
    expect(service.getRevision()).toBe(2);
  });
});

async function createConfigRoot(): Promise<{
  root: string;
  payload: CompleteUnifiedConfigPayload;
  activeRaw: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-config-generation-"));
  roots.push(root);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  const activeRaw = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(activePath(root), activeRaw, "utf8");
  return { root, payload, activeRaw };
}

function withBudgetMode(
  payload: CompleteUnifiedConfigPayload,
  mode: "saver" | "balanced" | "power",
): CompleteUnifiedConfigPayload {
  const candidate = structuredClone(payload);
  (candidate.budgets as { mode: string }).mode = mode;
  return candidate;
}

function activePath(root: string): string {
  return path.join(root, "config", "goatcitadel.json");
}

function transactionPath(root: string): string {
  return path.join(root, "config", ".generations", "transaction.json");
}

async function readActive(root: string): Promise<CompleteUnifiedConfigPayload> {
  return JSON.parse(await fs.readFile(activePath(root), "utf8")) as CompleteUnifiedConfigPayload;
}
