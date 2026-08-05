import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
import type { ImprovementCandidateRevisionRecord, ImprovementRef } from "@goatcitadel/contracts";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
} from "./improvement-service.js";
import { SkillMutationService } from "./skill-mutation-service.js";
import { __internal } from "./capability-system-service.js";

const { isSkillCallable } = __internal;

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  mutation: SkillMutationService;
  callbacks: ImprovementServiceCallbacks;
  setAutonomyDisabled: (value: boolean) => void;
  /** Audit entries appended via the gateway-faithful recorder (after a successful apply). */
  auditEntries: Array<{ kind: string; targetKey: string }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function createHarness(): Promise<Harness> {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-skill-revision-act-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({ dbPath: path.join(rootDir, "gateway.sqlite"), transcriptsDir, auditDir });
  const mutation = new SkillMutationService({
    rootDir,
    skillLifecycle: {
      find: async (skillId) => storage.skillLifecycle.find(skillId),
      upsert: async (input) => storage.skillLifecycle.upsert(input),
    },
  });

  let autonomyDisabled = false;
  // Mirror the gateway's unified autonomy-audit append: it happens ONLY inside
  // applySkillRevisionCandidate AFTER a successful write — never at capture time.
  const auditEntries: Array<{ kind: string; targetKey: string }> = [];

  // Mirror the gateway-service wiring of the S2 skill_revision callbacks so the
  // test exercises the same delegate logic (read content from revision ref,
  // write non-callable candidate, autonomy-gated promote, reversible snapshot).
  const readRef = (targetKey: string, ref: ImprovementRef) => {
    const metadata = isRecord(ref.metadata) ? ref.metadata : {};
    const proposed = isRecord(metadata.proposedChange) ? metadata.proposedChange : {};
    const read = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
    return {
      skillId:
        read(metadata.skillId) ??
        read(proposed.skillId) ??
        read(targetKey.startsWith("skill:") ? targetKey.slice("skill:".length) : undefined),
      skillMarkdown: read(metadata.skillMarkdown) ?? read(proposed.skillMarkdown),
      evaluationRunId: read(metadata.evaluationRunId) ?? read(proposed.evaluationRunId),
    };
  };

  const callbacks: ImprovementServiceCallbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    captureSkillRevisionSnapshot: vi.fn(async (targetKey: string, ref: ImprovementRef): Promise<ImprovementRef> => {
      const { skillId, skillMarkdown } = readRef(targetKey, ref);
      const snapshot = await mutation.captureSnapshotFor({ skillId, skillMarkdown });
      return {
        refType: "skill_revision_snapshot",
        refId: snapshot.skillId,
        hash: createHash("sha1").update(JSON.stringify(snapshot)).digest("hex"),
        metadata: { targetKey, skillId: snapshot.skillId, snapshot: snapshot as unknown as Record<string, unknown> },
      };
    }),
    applySkillRevisionCandidate: vi.fn(async (targetKey: string, ref: ImprovementRef): Promise<ImprovementRef> => {
      const { skillId, skillMarkdown, evaluationRunId } = readRef(targetKey, ref);
      if (!skillMarkdown) {
        throw new Error("missing skill content");
      }
      const result = await mutation.applySkillMutationSync({ skillMarkdown, skillId, evaluationRunId });
      const autonomyEnabled = !autonomyDisabled;
      const lifecycle = autonomyEnabled ? await mutation.promoteSelfAuthoredSkill(result.skillId) : result.lifecycle;
      // Gateway-faithful: audit append happens AFTER the successful write/promote,
      // so a throwing apply (above) can never leave a phantom ledger entry.
      auditEntries.push({ kind: "skill_revision", targetKey: result.skillId });
      return {
        refType: "skill_revision_config",
        refId: result.skillId,
        hash: result.changeHash,
        metadata: {
          targetKey,
          skillId: result.skillId,
          lifecycleState: lifecycle.lifecycleState,
          autoPromoted: autonomyEnabled,
        },
      };
    }),
    restoreSkillRevisionSnapshot: vi.fn(async (ref: ImprovementRef): Promise<void> => {
      const metadata = isRecord(ref.metadata) ? ref.metadata : {};
      const snapshot = metadata.snapshot;
      if (!isRecord(snapshot)) {
        throw new Error("missing snapshot");
      }
      await mutation.restoreSnapshotSync(snapshot as never);
    }),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;

  const ctx: ImprovementServiceContext = {
    storage: createLocalAsyncStorage(storage),
    gatewaySql: storage.gatewaySql,
    publishRealtime: async () => undefined,
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };

  const service = new ImprovementService(ctx, callbacks);
  await service.initialize();
  const harness: Harness = {
    rootDir,
    storage,
    service,
    mutation,
    callbacks,
    auditEntries,
    setAutonomyDisabled: (value) => {
      autonomyDisabled = value;
    },
  };
  harnesses.push(harness);
  return harness;
}

function buildSkillMarkdown(body: string, name = "self-authored-helper"): string {
  return [
    "---",
    `name: ${name}`,
    "description: A self-authored helper that summarizes operator notes into clear bullet points.",
    "---",
    "",
    body,
  ].join("\n");
}

function buildRevision(skillMarkdown: string): ImprovementCandidateRevisionRecord {
  const candidateRef: ImprovementRef = {
    refType: "skill_evaluation_run",
    refId: "skill_revision:skill:self-authored-helper",
    metadata: {
      proposedChange: { strategy: "skill_instruction_revision", skillId: "self-authored-helper" },
      skillMarkdown,
      evaluationRunId: "eval-run-9",
    },
  };
  return {
    revisionId: "rev-1",
    candidateId: "cand-1",
    candidateRef,
    changeHash: createHash("sha256").update(skillMarkdown, "utf8").digest("hex"),
    createdAt: new Date().toISOString(),
    createdByActorId: "system",
    createdByActorType: "system",
  };
}

// Reach the private activation-change dispatch to assert the skill_revision
// branch routes to the new callbacks (the dispatch itself is otherwise only
// reachable through the capability-proposal approval path).
interface ActivationInternals {
  captureActivationSnapshot(
    kind: "skill_revision",
    targetKey: string,
    revision: ImprovementCandidateRevisionRecord,
  ): Promise<ImprovementRef>;
  applyActivationChange(
    kind: "skill_revision",
    targetKey: string,
    revision: ImprovementCandidateRevisionRecord,
  ): Promise<ImprovementRef>;
}

function internals(service: ImprovementService): ActivationInternals {
  return service as unknown as ActivationInternals;
}

describe("skill_revision activation wiring", () => {
  const targetKey = "skill:self-authored-helper";

  it("applyActivationChange routes skill_revision to the governed write and stays non-callable when autonomy is off", async () => {
    const harness = await createHarness();
    harness.setAutonomyDisabled(true);
    const revision = buildRevision(buildSkillMarkdown("Summarize the notes."));

    const target = await internals(harness.service).applyActivationChange("skill_revision", targetKey, revision);

    expect(harness.callbacks.applySkillRevisionCandidate).toHaveBeenCalledTimes(1);
    expect(target.refType).toBe("skill_revision_config");

    const lifecycle = harness.storage.skillLifecycle.find("self-authored-helper");
    expect(lifecycle?.category).toBe("self_generated");
    expect(lifecycle?.lifecycleState).toBe("candidate");
    // SAFETY INVARIANT: with autonomy off, the authored skill is a non-callable proposal.
    expect(lifecycle ? isSkillCallable(lifecycle, "enabled") : true).toBe(false);
  });

  it("auto-promotes to a callable approved state only under master autonomy", async () => {
    const harness = await createHarness();
    harness.setAutonomyDisabled(false);
    const revision = buildRevision(buildSkillMarkdown("Summarize the notes."));

    await internals(harness.service).applyActivationChange("skill_revision", targetKey, revision);

    const lifecycle = harness.storage.skillLifecycle.find("self-authored-helper");
    expect(lifecycle?.lifecycleState).toBe("approved");
    // SAFETY INVARIANT: auto-promotion sets approved through the recorded
    // activation, so the chokepoint now reports callable — never bypassed.
    expect(lifecycle ? isSkillCallable(lifecycle, "enabled") : false).toBe(true);
  });

  it("captureActivationSnapshot + restore reverts the authored file and lifecycle", async () => {
    const harness = await createHarness();
    harness.setAutonomyDisabled(false);
    const revision = buildRevision(buildSkillMarkdown("Summarize the notes."));

    const snapshotRef = await internals(harness.service).captureActivationSnapshot(
      "skill_revision",
      targetKey,
      revision,
    );
    expect(harness.callbacks.captureSkillRevisionSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshotRef.refType).toBe("skill_revision_snapshot");

    await internals(harness.service).applyActivationChange("skill_revision", targetKey, revision);
    const skillFile = path.join(harness.mutation.selfSkillsRoot, "self-authored-helper", "SKILL.md");
    expect(fsSync.existsSync(skillFile)).toBe(true);
    expect(harness.storage.skillLifecycle.find("self-authored-helper")?.lifecycleState).toBe("approved");

    // Restore through the same snapshot ref refType the restore branch matches on.
    await harness.callbacks.restoreSkillRevisionSnapshot(snapshotRef);

    expect(fsSync.existsSync(skillFile)).toBe(false);
    const reverted = harness.storage.skillLifecycle.find("self-authored-helper");
    expect(reverted?.lifecycleState).toBe("revoked");
    // SAFETY INVARIANT: the reverted skill is not callable.
    expect(reverted ? isSkillCallable(reverted, "enabled") : false).toBe(false);
  });

  it("fails closed when the revision carries no skill content", async () => {
    const harness = await createHarness();
    const candidateRef: ImprovementRef = {
      refType: "skill_evaluation_run",
      refId: "skill_revision:skill:self-authored-helper",
      metadata: { proposedChange: { strategy: "skill_instruction_revision", skillId: "self-authored-helper" } },
    };
    const revision: ImprovementCandidateRevisionRecord = {
      revisionId: "rev-2",
      candidateId: "cand-2",
      candidateRef,
      changeHash: "deadbeef",
      createdAt: new Date().toISOString(),
      createdByActorId: "system",
      createdByActorType: "system",
    };
    await expect(
      internals(harness.service).applyActivationChange("skill_revision", targetKey, revision),
    ).rejects.toThrow(/missing skill content/i);
  });

  // Finding 3: the autonomy-audit entry must be appended only AFTER the apply
  // writes, never at capture/proposal time, so a never-applied or throwing
  // activation cannot leave a phantom entry that revertAutonomousChangesSince
  // would later "restore".
  it("does NOT record an autonomy-audit entry at capture (proposal) time", async () => {
    const harness = await createHarness();
    harness.setAutonomyDisabled(false);
    const revision = buildRevision(buildSkillMarkdown("Summarize the notes."));

    await internals(harness.service).captureActivationSnapshot("skill_revision", targetKey, revision);

    // Snapshot captured, but nothing applied yet → no ledger entry.
    expect(harness.callbacks.captureSkillRevisionSnapshot).toHaveBeenCalledTimes(1);
    expect(harness.auditEntries).toHaveLength(0);
  });

  it("does NOT record an autonomy-audit entry when the apply throws (no phantom entry)", async () => {
    const harness = await createHarness();
    const candidateRef: ImprovementRef = {
      refType: "skill_evaluation_run",
      refId: "skill_revision:skill:self-authored-helper",
      metadata: { proposedChange: { strategy: "skill_instruction_revision", skillId: "self-authored-helper" } },
    };
    const revision: ImprovementCandidateRevisionRecord = {
      revisionId: "rev-3",
      candidateId: "cand-3",
      candidateRef,
      changeHash: "deadbeef",
      createdAt: new Date().toISOString(),
      createdByActorId: "system",
      createdByActorType: "system",
    };

    // Capture first (as the activation flow does), then a throwing apply.
    await internals(harness.service).captureActivationSnapshot("skill_revision", targetKey, revision);
    await expect(
      internals(harness.service).applyActivationChange("skill_revision", targetKey, revision),
    ).rejects.toThrow(/missing skill content/i);

    expect(harness.auditEntries).toHaveLength(0);
  });

  it("records exactly one autonomy-audit entry after a successful apply", async () => {
    const harness = await createHarness();
    harness.setAutonomyDisabled(false);
    const revision = buildRevision(buildSkillMarkdown("Summarize the notes."));

    await internals(harness.service).captureActivationSnapshot("skill_revision", targetKey, revision);
    expect(harness.auditEntries).toHaveLength(0);

    await internals(harness.service).applyActivationChange("skill_revision", targetKey, revision);

    expect(harness.auditEntries).toEqual([{ kind: "skill_revision", targetKey: "self-authored-helper" }]);
  });
});
