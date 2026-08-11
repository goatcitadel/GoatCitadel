import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type GovernedRemediationScope } from "@goatcitadel/contracts";
import { GovernedRemediationRepository, createDatabase, type DatabaseClient } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderConfigMirrorBytes } from "../config-sync-lib.js";
import { ConfigGenerationService, type CompleteUnifiedConfigPayload } from "./config-generation-service.js";
import {
  GovernedFileHandlePortRefusalError,
  GovernedFileHandlePortUncertainError,
  type GovernedFileCaptureEvidence,
  type GovernedFileHandleObservation,
} from "./governed-file-windows-handle-port.js";
import {
  GOVERNED_BUDGETS_MIRROR_PROBE_ID,
  GOVERNED_BUDGETS_MIRROR_RECIPE,
  GovernedBudgetsMirrorJournalStore,
  GovernedBudgetsMirrorRecipeOwner,
  governedBudgetsMirrorRecipeRegistration,
  governedBudgetsMirrorScope,
  readJournalEntrySync,
  type GovernedFileMutationPort,
} from "./governed-remediation-budgets-mirror-recipe.js";
import {
  GovernedRemediationCoordinator,
  type GovernedRemediationAuthorityPhase,
  type GovernedRemediationAuthorityPort,
  type GovernedRemediationAuthorityRequest,
  type GovernedRemediationDurableParentPort,
  type GovernedRemediationDurableResumeRequest,
  type GovernedRemediationParentReservationRequest,
  type StartGovernedRemediationInput,
} from "./governed-remediation-coordinator.js";
import {
  GovernedRemediationRecipeRegistry,
  GovernedRemediationRegistryError,
  type GovernedRemediationOwnerContext,
} from "./governed-remediation-registry.js";

const cleanupRoots: string[] = [];
const openedDatabases: DatabaseClient[] = [];
const databaseFiles: string[] = [];

afterEach(async () => {
  for (const db of openedDatabases.splice(0)) db.close();
  for (const file of databaseFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fsSync.rmSync(candidate, { force: true });
      } catch {
        // Best-effort test cleanup.
      }
    }
  }
  await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Deterministic cross-platform stand-in for the native handle port. It honors
 * the same CAS/refusal semantics over the real filesystem so coordinator and
 * owner logic can be proved everywhere; handle-bound refusal authority stays
 * with the native port's own Windows tests.
 */
class FakeGovernedFilePort implements GovernedFileMutationPort {
  public availableFlag = true;
  public failPublish: "refuse_drift" | "refuse_posix" | "uncertain_no_write" | "uncertain_after_write" | null = null;
  public beforePublish: (() => Promise<void> | void) | null = null;
  public publishCalls = 0;
  public removeCalls = 0;

  public available(): boolean {
    return this.availableFlag;
  }

  public async capture(rootPath: string, relativePath: string): Promise<GovernedFileCaptureEvidence> {
    const filePath = path.join(rootPath, relativePath);
    let content: Buffer | null = null;
    try {
      content = await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = this.observationFor(path.dirname(filePath), true, 0);
    if (content === null) {
      return Object.freeze({
        rootPath,
        relativePath,
        parent,
        present: false,
        entry: null,
        content: null,
        sha256: null,
      });
    }
    return Object.freeze({
      rootPath,
      relativePath,
      parent,
      present: true,
      entry: this.observationFor(filePath, false, content.byteLength),
      content,
      sha256: sha256(content),
    });
  }

  public async publish(input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: { readonly volumeSerial: string; readonly fileId: string };
    readonly expectedPrior: { readonly present: true; readonly sha256: string } | { readonly present: false };
    readonly content: Buffer;
  }) {
    this.publishCalls += 1;
    await this.beforePublish?.();
    if (this.failPublish === "refuse_drift") throw new GovernedFileHandlePortRefusalError("precondition_drift");
    if (this.failPublish === "refuse_posix")
      throw new GovernedFileHandlePortRefusalError("posix_semantics_unsupported");
    if (this.failPublish === "uncertain_no_write") throw new GovernedFileHandlePortUncertainError("helper_lost");
    const filePath = path.join(input.rootPath, input.relativePath);
    const parent = this.observationFor(path.dirname(filePath), true, 0);
    this.assertParent(parent, input.expectedParent);
    const current = await this.readOptional(filePath);
    if (input.expectedPrior.present) {
      if (current === null) throw new GovernedFileHandlePortRefusalError("presence_conflict");
      if (sha256(current) !== input.expectedPrior.sha256) {
        throw new GovernedFileHandlePortRefusalError("precondition_drift");
      }
    } else if (current !== null) {
      throw new GovernedFileHandlePortRefusalError("presence_conflict");
    }
    const tempPath = `${filePath}.fake-${randomUUID()}`;
    await fs.writeFile(tempPath, input.content);
    await fs.rename(tempPath, filePath);
    if (this.failPublish === "uncertain_after_write") {
      throw new GovernedFileHandlePortUncertainError("response_lost_after_effect");
    }
    return Object.freeze({
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      parent,
      priorPresent: input.expectedPrior.present,
      priorSha256: input.expectedPrior.present ? input.expectedPrior.sha256 : null,
      published: this.observationFor(filePath, false, input.content.byteLength),
      publishedSha256: sha256(input.content),
      renameMechanism: "posix_handle_rename" as const,
    });
  }

  public async remove(input: {
    readonly rootPath: string;
    readonly relativePath: string;
    readonly expectedParent: { readonly volumeSerial: string; readonly fileId: string };
    readonly expectedSha256: string;
  }) {
    this.removeCalls += 1;
    const filePath = path.join(input.rootPath, input.relativePath);
    const parent = this.observationFor(path.dirname(filePath), true, 0);
    this.assertParent(parent, input.expectedParent);
    const current = await this.readOptional(filePath);
    if (current === null) throw new GovernedFileHandlePortRefusalError("presence_conflict");
    if (sha256(current) !== input.expectedSha256) throw new GovernedFileHandlePortRefusalError("precondition_drift");
    await fs.rm(filePath);
    return Object.freeze({
      rootPath: input.rootPath,
      relativePath: input.relativePath,
      parent,
      priorSha256: input.expectedSha256,
      removed: true as const,
    });
  }

  private async readOptional(filePath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private assertParent(
    parent: GovernedFileHandleObservation,
    expected: { readonly volumeSerial: string; readonly fileId: string },
  ): void {
    if (parent.volumeSerial !== expected.volumeSerial || parent.fileId !== expected.fileId) {
      throw new GovernedFileHandlePortRefusalError("parent_identity_changed");
    }
  }

  private observationFor(targetPath: string, directory: boolean, sizeBytes: number): GovernedFileHandleObservation {
    const digest = sha256(targetPath.toLowerCase());
    return Object.freeze({
      volumeSerial: digest.slice(0, 16),
      fileId: digest.slice(16, 48),
      sizeBytes,
      linkCount: 1,
      attributes: directory ? 0x10 : 0x20,
      reparseTag: 0,
      lastWriteTime: "133969248000000001",
      changeTime: "133969248000000002",
    });
  }
}

class ScriptedAuthority implements GovernedRemediationAuthorityPort {
  public readonly requests: GovernedRemediationAuthorityRequest[] = [];
  public requirePreEffectApproval = true;
  public readonly denyPhases = new Set<GovernedRemediationAuthorityPhase>();

  public async authorize(request: GovernedRemediationAuthorityRequest) {
    this.requests.push(request);
    if (this.denyPhases.has(request.phase)) {
      return { status: "denied" as const, reason: "policy_denied" as const };
    }
    if (
      this.requirePreEffectApproval &&
      (request.phase === "preflight" || request.phase === "apply") &&
      (request.approvalPurpose !== "pre_effect" || request.approvalId !== "approval-pre")
    ) {
      return { status: "denied" as const, reason: "approval_missing_or_expired" as const };
    }
    return { status: "authorized" as const };
  }
}

class FakeDurableParent implements GovernedRemediationDurableParentPort {
  public reserveCalls = 0;
  public resumeCalls = 0;
  public readonly reserveRequests: GovernedRemediationParentReservationRequest[] = [];
  private readonly reservations = new Map<string, string>();
  private readonly resumes = new Map<string, number>();

  public async reserve(request: GovernedRemediationParentReservationRequest) {
    this.reserveCalls += 1;
    this.reserveRequests.push(request);
    const existing = this.reservations.get(request.idempotencyKey);
    if (existing) return { status: "reserved" as const, reservationId: existing, replayed: true };
    const reservationId = `reservation-${request.remediationId}`;
    this.reservations.set(request.idempotencyKey, reservationId);
    return { status: "reserved" as const, reservationId, replayed: false };
  }

  public async resume(request: GovernedRemediationDurableResumeRequest) {
    this.resumeCalls += 1;
    const existing = this.resumes.get(request.idempotencyKey);
    if (existing !== undefined) return { status: "resumed" as const, resumedRunVersion: existing, replayed: true };
    const resumedRunVersion = request.expectedWaitingRunVersion + 1;
    this.resumes.set(request.idempotencyKey, resumedRunVersion);
    return { status: "resumed" as const, resumedRunVersion, replayed: false };
  }

  public async observeResume(request: GovernedRemediationDurableResumeRequest) {
    const resumedRunVersion = this.resumes.get(request.idempotencyKey);
    return resumedRunVersion === undefined
      ? ({ observation: "resume_not_completed" } as const)
      : ({ observation: "resume_completed", resumedRunVersion } as const);
  }
}

const DRIFTED_MIRROR = '{"mode":"balanced","drifted":true}\n';

interface Harness {
  readonly root: string;
  readonly mirrorPath: string;
  readonly service: ConfigGenerationService;
  readonly owner: GovernedBudgetsMirrorRecipeOwner;
  readonly port: FakeGovernedFilePort;
  readonly journal: GovernedBudgetsMirrorJournalStore;
  readonly repository: GovernedRemediationRepository;
  readonly coordinator: GovernedRemediationCoordinator;
  readonly authority: ScriptedAuthority;
  readonly parent: FakeDurableParent;
  readonly scope: GovernedRemediationScope;
  readonly expectedOwnerRevision: string;
  makeCoordinator(claimantId: string, withCompletionPort: boolean): GovernedRemediationCoordinator;
}

async function createHarness(
  options: {
    driftMirror?: boolean;
    registerCompletionPort?: boolean;
    llmCanary?: string;
    port?: FakeGovernedFilePort;
  } = {},
): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-budgets-mirror-recipe-"));
  cleanupRoots.push(root);
  const payload = JSON.parse(
    await fs.readFile(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
  ) as CompleteUnifiedConfigPayload;
  delete payload.generation;
  if (options.llmCanary) {
    const llm = payload.llm as { providers: Array<Record<string, unknown>> };
    llm.providers[0] = { ...llm.providers[0], apiKey: options.llmCanary };
  }
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, "goatcitadel.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const service = new ConfigGenerationService(root);
  await service.commit({
    expectedRevision: service.getRevision(),
    requireExpectedRevision: true,
    previousRuntime: undefined,
    buildCandidate: () => {
      const candidate = service.getActivePayload();
      candidate.budgets = { ...candidate.budgets, mode: "power" };
      return { payload: candidate, runtime: undefined };
    },
    apply: () => undefined,
    restore: () => undefined,
  });
  const mirrorPath = path.join(configDir, "budgets.json");
  if (options.driftMirror ?? true) {
    await fs.writeFile(mirrorPath, DRIFTED_MIRROR, "utf8");
  }
  const port = options.port ?? new FakeGovernedFilePort();
  const journal = new GovernedBudgetsMirrorJournalStore(root);
  const owner = new GovernedBudgetsMirrorRecipeOwner({ rootDir: root, configGeneration: service, port, journal });
  const registry = new GovernedRemediationRecipeRegistry([governedBudgetsMirrorRecipeRegistration(owner)]);
  const dbPath = path.join(os.tmpdir(), `goat-budgets-mirror-${randomUUID()}.db`);
  databaseFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  openedDatabases.push(db);
  const repository = new GovernedRemediationRepository(db);
  const authority = new ScriptedAuthority();
  const parent = new FakeDurableParent();
  const makeCoordinator = (claimantId: string, withCompletionPort: boolean) =>
    new GovernedRemediationCoordinator({
      repository,
      registry,
      authority,
      durableParent: parent,
      deploymentProfile: "trusted_local",
      claimantId,
      completionPorts: withCompletionPort ? [{ ownerId: owner.ownerId, port: owner }] : undefined,
    });
  const coordinator = makeCoordinator("gateway-worker-a", options.registerCompletionPort ?? true);
  const expectedOwnerRevision = await owner.currentOwnerRevision();
  if (!expectedOwnerRevision) throw new Error("test harness could not compute the initial owner revision");
  return {
    root,
    mirrorPath,
    service,
    owner,
    port,
    journal,
    repository,
    coordinator,
    authority,
    parent,
    scope: governedBudgetsMirrorScope({ deploymentId: "deployment-test", installationId: "installation-test" }),
    expectedOwnerRevision,
    makeCoordinator,
  };
}

function startInput(
  harness: Harness,
  overrides: Partial<StartGovernedRemediationInput> = {},
): StartGovernedRemediationInput {
  return {
    remediationId: "remediation-mirror-1",
    requesterActorId: "actor-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceTurnId: "turn-1",
    durableRunId: "durable-run-1",
    blockedCheckpointId: "checkpoint-1",
    expectedWaitingRunVersion: 7,
    expectedOwnerRevision: harness.expectedOwnerRevision,
    recipeId: GOVERNED_BUDGETS_MIRROR_RECIPE.recipeId,
    recipeVersion: GOVERNED_BUDGETS_MIRROR_RECIPE.recipeVersion,
    targetId: GOVERNED_BUDGETS_MIRROR_RECIPE.targetId,
    requestedCapabilityId: GOVERNED_BUDGETS_MIRROR_RECIPE.requestedCapabilityId,
    scope: harness.scope,
    creationIdempotencyKey: "create-remediation-mirror-1",
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function continueRemediation(
  harness: Harness,
  action: Parameters<GovernedRemediationCoordinator["continue"]>[0]["action"],
  key: string,
  remediationId = "remediation-mirror-1",
) {
  const current = harness.repository.getState(remediationId);
  return harness.coordinator.continue({
    remediationId,
    requesterActorId: current.record.requesterActorId,
    workspaceId: current.record.workspaceId,
    expectedStateRevision: current.record.revision,
    commandIdempotencyKey: key,
    action,
  });
}

function ownerContext(
  harness: Harness,
  overrides: Partial<GovernedRemediationOwnerContext> = {},
): GovernedRemediationOwnerContext {
  return Object.freeze({
    remediationId: "remediation-mirror-1",
    requesterActorId: "actor-1",
    workspaceId: "workspace-1",
    stateRevision: 4,
    recipe: GOVERNED_BUDGETS_MIRROR_RECIPE,
    recipeSha256: "0".repeat(64),
    scope: harness.scope,
    effectId: "gr_effect_test",
    operationId: "gr:apply:1:test",
    expectedOwnerRevision: harness.expectedOwnerRevision,
    parentReservationId: null,
    approvalPurpose: "pre_effect",
    approvalId: "approval-pre",
    promptId: null,
    ...overrides,
  });
}

function expectedRepairedBytes(harness: Harness, previous: string): string {
  return renderConfigMirrorBytes(previous, harness.service.getActivePayload().budgets);
}

describe("governed budgets mirror recipe", () => {
  it("registers the first callable governed recipe behind a purpose-specific approval", async () => {
    const harness = await createHarness();
    expect(GOVERNED_BUDGETS_MIRROR_RECIPE).toMatchObject({
      executionMode: "governed",
      repairClass: "declarative_configuration",
      inputKind: "none",
      preEffectApproval: "required_before_apply",
      rollbackStrategy: "restore_previous",
      verificationProbeId: GOVERNED_BUDGETS_MIRROR_PROBE_ID,
      allowedScopeKinds: ["installation"],
      allowedDeploymentProfiles: ["local_dev", "trusted_local"],
      maxApplyAttempts: 1,
    });
    const registry = new GovernedRemediationRecipeRegistry([governedBudgetsMirrorRecipeRegistration(harness.owner)]);
    const resolution = registry.resolve({
      recipeId: GOVERNED_BUDGETS_MIRROR_RECIPE.recipeId,
      recipeVersion: GOVERNED_BUDGETS_MIRROR_RECIPE.recipeVersion,
      targetId: GOVERNED_BUDGETS_MIRROR_RECIPE.targetId,
      requestedCapabilityId: GOVERNED_BUDGETS_MIRROR_RECIPE.requestedCapabilityId,
      deploymentProfile: "trusted_local",
      scope: harness.scope,
    });
    expect(resolution.owner).toBe(harness.owner);
    expect(() =>
      registry.resolve({
        recipeId: GOVERNED_BUDGETS_MIRROR_RECIPE.recipeId,
        recipeVersion: GOVERNED_BUDGETS_MIRROR_RECIPE.recipeVersion,
        targetId: GOVERNED_BUDGETS_MIRROR_RECIPE.targetId,
        requestedCapabilityId: GOVERNED_BUDGETS_MIRROR_RECIPE.requestedCapabilityId,
        deploymentProfile: "remote_hardened",
        scope: harness.scope,
      }),
    ).toThrow(GovernedRemediationRegistryError);
  });

  it("stays side-effect free until the explicit pre-effect approval arrives", async () => {
    const harness = await createHarness();
    harness.coordinator.start(startInput(harness));
    const awaiting = await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    expect(awaiting.record.state).toBe("awaiting_preapproval");
    expect(harness.port.publishCalls).toBe(0);
    expect(harness.parent.reserveCalls).toBe(0);
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(DRIFTED_MIRROR);
    await expect(harness.journal.list()).resolves.toEqual([]);
  });

  it("repairs the drifted mirror end to end with a journal strictly before the effect boundary", async () => {
    const harness = await createHarness();
    let journalAtPublish: ReturnType<typeof readJournalEntrySync> | null = null;
    harness.port.beforePublish = () => {
      const entries = fsSync.readdirSync(harness.journal.directory()).filter((name) => name.endsWith(".journal.json"));
      expect(entries).toHaveLength(1);
      journalAtPublish = readJournalEntrySync(path.join(harness.journal.directory(), entries[0] as string));
    };
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const completed = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(completed.record.state).toBe("completed");

    // Prior state was handle-captured and journaled before the publish.
    expect(journalAtPublish).not.toBeNull();
    const journaled = journalAtPublish as unknown as ReturnType<typeof readJournalEntrySync>;
    expect(journaled.phase).toBe("intent");
    expect(journaled.capturedPresent).toBe(true);
    expect(Buffer.from(journaled.capturedContentBase64 as string, "base64").toString("utf8")).toBe(DRIFTED_MIRROR);

    // Effect identity: the mirror now carries the exact canonical bytes.
    const repaired = await fs.readFile(harness.mirrorPath, "utf8");
    expect(repaired).toBe(expectedRepairedBytes(harness, DRIFTED_MIRROR));
    expect(JSON.parse(repaired)).toEqual(harness.service.getActivePayload().budgets);

    const receipts = harness.repository.listReceipts("remediation-mirror-1");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["application", "verification", "resume"]);
    expect(receipts[0]).toMatchObject({
      ownerRevisionBefore: harness.expectedOwnerRevision,
    });
    expect(harness.parent.reserveCalls).toBe(1);
    expect(harness.parent.resumeCalls).toBe(1);
    expect(
      harness.authority.requests.some((request) => request.phase === "apply" && request.approvalId === "approval-pre"),
    ).toBe(true);

    // Completion callback retired the journal boundedly. Delivery is
    // fire-and-forget in-process, so the assertion polls briefly.
    await vi.waitFor(async () => expect(await harness.journal.list()).toEqual([]), { timeout: 5_000, interval: 25 });
    expect(harness.coordinator.completionNoticeFor("remediation-mirror-1")).toMatchObject({
      terminalState: "completed",
      effectDisposition: "effect_applied",
    });
  });

  it("quarantines an uncertain publish and lets restart reconciliation decide commit", async () => {
    // No in-process completion callback: boot replay must retire on its own.
    const harness = await createHarness({ registerCompletionPort: false });
    harness.port.failPublish = "uncertain_after_write";
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const quarantined = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(quarantined.record.state).toBe("failed");
    await expect(harness.journal.list()).resolves.toEqual(["remediation-mirror-1"]);
    expect(harness.coordinator.completionNoticeFor("remediation-mirror-1")).toMatchObject({
      effectDisposition: "effect_unknown",
    });

    // The journal replay decides commit: the effect bytes are on disk.
    harness.port.failPublish = null;
    const recovered = await harness.coordinator.recoverReconciliations({ limit: 10, pageSize: 1 });
    expect(recovered.reconciliations[0]).toMatchObject({ state: "resolved_verified" });
    expect(harness.coordinator.completionNoticeFor("remediation-mirror-1")).toMatchObject({
      terminalState: "failed",
      effectDisposition: "effect_applied",
    });
    const bootOwner = new GovernedBudgetsMirrorRecipeOwner({
      rootDir: harness.root,
      configGeneration: harness.service,
      port: harness.port,
    });
    const summary = await bootOwner.replayJournalOnBoot(harness.coordinator);
    expect(summary).toMatchObject({ retired: ["remediation-mirror-1"], retained: [], corrupt: [] });
    await expect(harness.journal.list()).resolves.toEqual([]);
  });

  it("quarantines an uncertain publish and lets restart reconciliation decide no-effect", async () => {
    // No in-process completion callback: boot replay must retire on its own.
    const harness = await createHarness({ registerCompletionPort: false });
    harness.port.failPublish = "uncertain_no_write";
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const quarantined = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(quarantined.record.state).toBe("failed");
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(DRIFTED_MIRROR);

    harness.port.failPublish = null;
    const recovered = await harness.coordinator.recoverReconciliations({ limit: 10, pageSize: 1 });
    expect(recovered.reconciliations[0]).toMatchObject({ state: "resolved_no_effect" });
    expect(harness.coordinator.completionNoticeFor("remediation-mirror-1")).toMatchObject({
      effectDisposition: "no_effect",
    });
    const summary = await harness.owner.replayJournalOnBoot(harness.coordinator);
    expect(summary.retired).toEqual(["remediation-mirror-1"]);
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(DRIFTED_MIRROR);
  });

  it("resolves the intent crash window by committing an already-published effect on replayed apply", async () => {
    const harness = await createHarness();
    const context = ownerContext(harness);
    const applied = await harness.owner.apply(context);
    expect(applied.status).toBe("applied");
    // Simulate a crash between the publish and the journal phase mark.
    await harness.journal.setPhase("remediation-mirror-1", "intent", new Date().toISOString());
    const replayOwner = new GovernedBudgetsMirrorRecipeOwner({
      rootDir: harness.root,
      configGeneration: harness.service,
      port: harness.port,
      journal: harness.journal,
    });
    const replayed = await replayOwner.apply(context);
    expect(replayed).toEqual(applied);
    const read = await harness.journal.read("remediation-mirror-1");
    expect(read.status === "present" && read.entry.phase).toBe("published");

    // A different operation may not silently adopt the crossed effect.
    const foreign = await replayOwner.apply(ownerContext(harness, { operationId: "gr:apply:2:test" }));
    expect(foreign).toMatchObject({ status: "rejected", reason: "owner_revision_conflict" });
  });

  it("restarts a provably-uncrossed intent instead of quarantining it", async () => {
    const harness = await createHarness();
    harness.port.failPublish = "uncertain_no_write";
    const context = ownerContext(harness);
    const uncertain = await harness.owner.apply(context);
    expect(uncertain.status).toBe("uncertain");
    harness.port.failPublish = null;
    const replayed = await harness.owner.apply(context);
    expect(replayed).toMatchObject({ status: "applied", ownerRevisionBefore: harness.expectedOwnerRevision });
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(expectedRepairedBytes(harness, DRIFTED_MIRROR));
  });

  it("rolls the mirror back to the exact captured bytes when post-apply authority collapses", async () => {
    const harness = await createHarness();
    harness.authority.denyPhases.add("probe");
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const rolledBack = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(rolledBack.record.state).toBe("rolled_back");
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(DRIFTED_MIRROR);
    const receipts = harness.repository.listReceipts("remediation-mirror-1");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["application", "rollback"]);
    expect(harness.coordinator.completionNoticeFor("remediation-mirror-1")).toMatchObject({
      terminalState: "rolled_back",
      effectDisposition: "effect_rolled_back",
    });
    // The rollback settlement retired the journal custody (async delivery).
    await vi.waitFor(async () => expect(await harness.journal.list()).toEqual([]), { timeout: 5_000, interval: 25 });
  });

  it("replays an interrupted rollback to the rolled-back journal phase without redoing the restore", async () => {
    const harness = await createHarness();
    const context = ownerContext(harness);
    await harness.owner.apply(context);
    const first = await harness.owner.rollback(context);
    expect(first.status).toBe("rolled_back");
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(DRIFTED_MIRROR);
    // Crash before the phase mark: restore already happened on disk.
    await harness.journal.setPhase("remediation-mirror-1", "published", new Date().toISOString());
    const publishCallsBefore = harness.port.publishCalls;
    const replayed = await harness.owner.rollback(context);
    expect(replayed).toEqual(first);
    expect(harness.port.publishCalls).toBe(publishCallsBefore);
    const read = await harness.journal.read("remediation-mirror-1");
    expect(read.status === "present" && read.entry.phase).toBe("rolled_back");
  });

  it("creates an absent mirror and removes it again on rollback", async () => {
    const harness = await createHarness({ driftMirror: false });
    await fs.rm(harness.mirrorPath, { force: true });
    const revision = await harness.owner.currentOwnerRevision();
    const context = ownerContext(harness, { expectedOwnerRevision: revision });
    const applied = await harness.owner.apply(context);
    expect(applied.status).toBe("applied");
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(expectedRepairedBytes(harness, ""));
    const rolled = await harness.owner.rollback(context);
    expect(rolled.status).toBe("rolled_back");
    expect(harness.port.removeCalls).toBe(1);
    await expect(fs.access(harness.mirrorPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed with no effect when the native port is unavailable", async () => {
    const harness = await createHarness();
    harness.port.availableFlag = false;
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const failed = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(failed.record.state).toBe("failed");
    expect(harness.repository.listFailures("remediation-mirror-1")).toMatchObject([
      { phase: "preflight", reason: "owner_unavailable", effectBoundary: "not_crossed" },
    ]);
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.toBe(DRIFTED_MIRROR);
    await expect(harness.journal.list()).resolves.toEqual([]);
    expect(harness.coordinator.completionNoticeFor("remediation-mirror-1")).toMatchObject({
      effectDisposition: "no_effect",
    });
  });

  it("never lets foreign config sections reach the journal, receipts, or owner results", async () => {
    const canary = "test-only-llm-canary-sk-000000-do-not-store";
    const harness = await createHarness({ llmCanary: canary });
    let journalBytesAtPublish = "";
    harness.port.beforePublish = () => {
      const entries = fsSync.readdirSync(harness.journal.directory()).filter((name) => name.endsWith(".journal.json"));
      journalBytesAtPublish = fsSync.readFileSync(path.join(harness.journal.directory(), entries[0] as string), "utf8");
    };
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const completed = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(completed.record.state).toBe("completed");
    expect(journalBytesAtPublish.length).toBeGreaterThan(0);
    expect(journalBytesAtPublish).not.toContain(canary);
    expect(JSON.stringify(harness.repository.listReceipts("remediation-mirror-1"))).not.toContain(canary);
    expect(JSON.stringify(harness.coordinator.completionNoticeFor("remediation-mirror-1"))).not.toContain(canary);
    await expect(fs.readFile(harness.mirrorPath, "utf8")).resolves.not.toContain(canary);
  });

  it("retires settled journals on boot replay and retains active or corrupt custody", async () => {
    const harness = await createHarness({ registerCompletionPort: false });
    harness.coordinator.start(startInput(harness));
    await continueRemediation(harness, { kind: "proceed" }, "proceed-1");
    const completed = await continueRemediation(
      harness,
      { kind: "approve_pre_effect", approvalId: "approval-pre" },
      "approve-1",
    );
    expect(completed.record.state).toBe("completed");
    // Without the in-process callback, the journal survives until boot replay.
    await expect(harness.journal.list()).resolves.toEqual(["remediation-mirror-1"]);

    const activeEntry = await harness.journal.read("remediation-mirror-1");
    if (activeEntry.status !== "present") throw new Error("expected a settled journal entry");
    await harness.journal.write({ ...activeEntry.entry, remediationId: "remediation-active-99" });
    await fs.writeFile(
      path.join(harness.journal.directory(), "remediation-corrupt-1.journal.json"),
      "{not-json",
      "utf8",
    );

    const bootOwner = new GovernedBudgetsMirrorRecipeOwner({
      rootDir: harness.root,
      configGeneration: harness.service,
      port: harness.port,
    });
    const summary = await bootOwner.replayJournalOnBoot(harness.coordinator);
    expect(summary).toMatchObject({
      retired: ["remediation-mirror-1"],
      retained: ["remediation-active-99"],
      corrupt: ["remediation-corrupt-1"],
    });
    const secondPass = await bootOwner.replayJournalOnBoot(harness.coordinator);
    expect(secondPass.retired).toEqual([]);
  });

  it("keeps observation methods read-only and honest about foreign drift", async () => {
    const harness = await createHarness();
    const context = ownerContext(harness);
    expect(await harness.owner.reconcile(context)).toMatchObject({ observation: "effect_absent" });
    await harness.owner.apply(context);
    expect(await harness.owner.reconcile(context)).toMatchObject({ observation: "effect_verified" });
    await fs.writeFile(harness.mirrorPath, '{"mode":"tampered-by-someone-else"}\n', "utf8");
    expect(await harness.owner.reconcile(context)).toMatchObject({ observation: "unknown" });
    expect(await harness.owner.probe(context)).toMatchObject({ status: "rejected", reason: "verification_failed" });
  });
});

describe.runIf(process.platform === "win32")("governed budgets mirror recipe over the real native port", () => {
  it("repairs, verifies, and retires through real handle-relative capture and publish", async () => {
    const harness = await createHarness({ port: undefined });
    // Swap in the real native port for the same owner wiring.
    const nativeHarness = await (async () => {
      const { nativeGovernedFileMutationPort } = await import("./governed-remediation-budgets-mirror-recipe.js");
      const owner = new GovernedBudgetsMirrorRecipeOwner({
        rootDir: harness.root,
        configGeneration: harness.service,
        port: nativeGovernedFileMutationPort,
      });
      const registry = new GovernedRemediationRecipeRegistry([governedBudgetsMirrorRecipeRegistration(owner)]);
      const coordinator = new GovernedRemediationCoordinator({
        repository: harness.repository,
        registry,
        authority: harness.authority,
        durableParent: harness.parent,
        deploymentProfile: "trusted_local",
        claimantId: "gateway-worker-native",
        completionPorts: [{ ownerId: owner.ownerId, port: owner }],
      });
      const expectedOwnerRevision = await owner.currentOwnerRevision();
      if (!expectedOwnerRevision) throw new Error("native owner revision unavailable");
      return { owner, coordinator, expectedOwnerRevision };
    })();

    nativeHarness.coordinator.start(
      startInput(harness, {
        remediationId: "remediation-mirror-native",
        creationIdempotencyKey: "create-remediation-mirror-native",
        expectedOwnerRevision: nativeHarness.expectedOwnerRevision,
      }),
    );
    const current = harness.repository.getState("remediation-mirror-native");
    await nativeHarness.coordinator.continue({
      remediationId: "remediation-mirror-native",
      requesterActorId: current.record.requesterActorId,
      workspaceId: current.record.workspaceId,
      expectedStateRevision: current.record.revision,
      commandIdempotencyKey: "native-proceed",
      action: { kind: "proceed" },
    });
    const awaiting = harness.repository.getState("remediation-mirror-native");
    const completed = await nativeHarness.coordinator.continue({
      remediationId: "remediation-mirror-native",
      requesterActorId: awaiting.record.requesterActorId,
      workspaceId: awaiting.record.workspaceId,
      expectedStateRevision: awaiting.record.revision,
      commandIdempotencyKey: "native-approve",
      action: { kind: "approve_pre_effect", approvalId: "approval-pre" },
    });
    expect(completed.record.state).toBe("completed");
    const repaired = await fs.readFile(harness.mirrorPath, "utf8");
    expect(JSON.parse(repaired)).toEqual(harness.service.getActivePayload().budgets);
    expect(harness.repository.listReceipts("remediation-mirror-native").map((receipt) => receipt.kind)).toEqual([
      "application",
      "verification",
      "resume",
    ]);
    await vi.waitFor(async () => expect(await nativeHarness.owner.journalStore().list()).toEqual([]), {
      timeout: 10_000,
      interval: 50,
    });
  }, 300_000);
});
