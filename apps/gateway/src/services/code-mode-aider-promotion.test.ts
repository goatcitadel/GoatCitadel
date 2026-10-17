import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  CapabilityArtifactRecord,
  ChatSessionWorkbenchPatchApplyResponse,
  CodeModeAiderPromotionRecord,
  CodeModeRunRecord,
} from "@goatcitadel/contracts";
import { ConflictError } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { ChatWorkbenchPatchRefusedError, type ChatSessionWorkbenchPatchApplyInput } from "./chat-workbench-service.js";
import { persistCodeModeAiderArtifactBundle } from "./code-mode-aider-artifacts.js";
import type { CodeModeAiderAdapterInvocationPlan } from "./code-mode-aider-adapter-plan.js";
import {
  CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
  executeApprovedCodeModeAiderPromotion,
  isCodeModePendingActionType,
  listPatchChangedPaths,
  requestCodeModeAiderPromotion,
  type CodeModeAiderPromotionDeps,
} from "./code-mode-aider-promotion.js";
import { parseCodeModeAiderAdapterResultEnvelope } from "./code-mode-aider-result-contract.js";
import { captureCodeModeAiderWorkspacePin } from "./code-mode-aider-workspace-pin.js";
import { captureCodeModeGitWorktreeState } from "./code-mode-worktree-capture.js";

const roots: string[] = [];
const INPUT_HASH = "a".repeat(64);
const ORIGINAL = "export const value = 1;\n";
const PROMOTED = "export const value = 2;\n";
const GIT_TIMEOUT_MS = 60_000;
const OVERSIZED_PATCH = "+".repeat(4 * 1024 * 1024 + 1);
let fixtureCount = 0;
// One migrated in-memory database for the file; every fixture uses its own session, project, run and temp root.
let shared: { storage: Storage; asyncStorage: ReturnType<typeof createSqliteAsyncStorage>; dir: string } | undefined;

function sharedStorage() {
  if (!shared) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-aider-promote-db-"));
    const storage = new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(dir, "transcripts"),
      auditDir: path.join(dir, "audit"),
    });
    shared = { storage, asyncStorage: createSqliteAsyncStorage(storage), dir };
  }
  return shared;
}

// Migrating the schema dominates wall time on a contended host; pay it once, outside the per-test budget.
beforeAll(() => {
  sharedStorage();
}, 300_000);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (shared) {
    await shared.asyncStorage.close();
    fs.rmSync(shared.dir, { recursive: true, force: true });
    shared = undefined;
  }
});

describe("Aider promotion", { timeout: 60_000 }, () => {
  it("classifies Code Mode pending action types", () => {
    expect(isCodeModePendingActionType("code_mode.run")).toBe(true);
    expect(isCodeModePendingActionType(CODE_MODE_AIDER_PROMOTE_ACTION_TYPE)).toBe(true);
    expect(isCodeModePendingActionType("tool.invoke")).toBe(false);
  });

  it("refuses promote when the patch artifact hash no longer matches", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();
    fs.appendFileSync(path.resolve(fx.root, fx.patchArtifact.relPath), "# tampered\n");

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "patch_hash_mismatch" } });
    expect(fx.readWorktreeFile()).toBe(ORIGINAL);
    expect(fx.apply).not.toHaveBeenCalled();
    expect(await fx.promotion()).toBeUndefined();
    expect(fx.storage.pendingApprovalActions.get(approvalId)).toMatchObject({ resolutionStatus: "failed" });
  });

  it("refuses promote when the workbench HEAD moved since plan time", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();
    fs.writeFileSync(path.join(fx.worktree, "next.ts"), "export const next = 1;\n");
    git(fx.worktree, ["add", "next.ts"]);
    git(fx.worktree, ["commit", "-q", "-m", "next"]);

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "worktree_head_moved" } });
    expect(fx.apply).not.toHaveBeenCalled();
    expect(await fx.promotion()).toBeUndefined();
  });

  it("applies the patch through the workbench and records the promotion in the ledger", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "executed", result: { status: "promoted" } });
    expect(fx.readWorktreeFile()).toBe(PROMOTED);
    expect(fx.apply).toHaveBeenCalledOnce();
    expect(fx.apply.mock.calls[0]![1]).toEqual({
      patch: fx.patchContent,
      expectedWorktreeHead: fx.pin.worktreeHead,
      expectedWorktreeStateHash: fx.pin.worktreeStateHash,
    });
    expect(fx.apply.mock.calls[0]![1]).not.toHaveProperty("checkOnly");
    const run = await fx.asyncStorage.codeModeRuns.get(fx.runId);
    const adapter = (run.result as { aiderAdapter: Record<string, unknown> }).aiderAdapter;
    expect(adapter.promotion).toMatchObject({
      status: "promoted",
      approvalId,
      patchSha256: fx.patchArtifact.sha256,
      resolvedBy: "operator-1",
      changedFiles: ["index.ts"],
    });
    const envelope = parseCodeModeAiderAdapterResultEnvelope(adapter.envelope, { promotion: adapter.promotion });
    expect(envelope.replay).toMatchObject({ policy: "promoted", replaySafe: false });
    // F4: the on-disk envelope stays audit_only.
    const diskEnvelope = JSON.parse(
      fs.readFileSync(
        path.resolve(fx.root, (adapter.resultEnvelopeArtifact as CapabilityArtifactRecord).relPath),
        "utf8",
      ),
    );
    expect(diskEnvelope.replay.policy).toBe("audit_only");
    expect(fx.storage.pendingApprovalActions.get(approvalId)).toMatchObject({ resolutionStatus: "executed" });
    expect(fx.storage.approvalEvents.listByApprovalId(approvalId).map((event) => event.eventType)).toContain(
      "approved_action_executed",
    );
    expect(fx.publishRealtime).toHaveBeenCalledWith(
      "code_mode_aider_patch_promoted",
      "capabilities",
      expect.objectContaining({ runId: fx.runId, approvalId }),
    );
  });

  it("refuses promote for an unpinned run", async () => {
    const fx = await createFixture({ pinned: false });

    const error = await requestCodeModeAiderPromotion(fx.deps, await fx.run()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toMatchObject({ reason: "not_pinned" });
    expect(fx.createApproval).not.toHaveBeenCalled();
  });

  it("refuses promote when the workbench has uncommitted drift since plan time", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();
    fs.writeFileSync(path.join(fx.worktree, "scratch.txt"), "drift\n");

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "worktree_state_drift" } });
    expect(fx.apply).not.toHaveBeenCalled();
    expect(fx.readWorktreeFile()).toBe(ORIGINAL);
  });

  it("refuses promote without mutating when git apply --check fails", async () => {
    const fx = await createFixture({ patch: "non_applying" });
    const approvalId = await fx.requestAndApprove();

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "patch_check_failed" } });
    expect(fx.apply).toHaveBeenCalledOnce();
    expect(fx.readWorktreeFile()).toBe(ORIGINAL);
    expect(await fx.promotion()).toBeUndefined();
  });

  it("a second approval of the same promotion applies the patch once", async () => {
    const fx = await createFixture();
    const first = await fx.requestAndApprove();
    const second = await fx.requestAndApprove();
    expect(second).not.toBe(first);

    expect(await fx.execute(first)).toMatchObject({ outcome: "executed" });
    const again = await fx.execute(second);

    expect(again).toMatchObject({ outcome: "executed", result: { alreadyPromoted: true } });
    expect(fx.apply).toHaveBeenCalledOnce();
    expect(fx.readWorktreeFile()).toBe(PROMOTED);
    expect(fx.storage.pendingApprovalActions.get(second)).toMatchObject({
      resolutionStatus: "executed",
      result: expect.objectContaining({ alreadyPromoted: true }),
    });
    expect((await fx.promotion())?.approvalId).toBe(first);
  });

  it("request returns already_promoted without a new approval", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();
    await fx.execute(approvalId);

    const response = await requestCodeModeAiderPromotion(fx.deps, await fx.run(), "operator-1");

    expect(response).toMatchObject({ runId: fx.runId, status: "already_promoted", promotion: { approvalId } });
    expect(fx.createApproval).toHaveBeenCalledOnce();
  });

  it("a promotion interrupted after apply never re-applies", async () => {
    const fx = await createFixture({ crashAfterApply: true });
    const approvalId = await fx.requestAndApprove();
    const other = await fx.requestAndApprove();

    const first = await fx.execute(approvalId);
    const retry = await executeApprovedCodeModeAiderPromotion(fx.deps, approvalId, {
      ...fx.storage.pendingApprovalActions.get(approvalId),
      resolutionStatus: "pending",
    });
    const competing = await fx.execute(other);

    expect(first).toMatchObject({ outcome: "blocked", result: { reason: "promotion_outcome_unknown" } });
    expect(retry).toMatchObject({ outcome: "blocked", result: { reason: "promotion_outcome_unknown" } });
    expect(competing).toMatchObject({ outcome: "blocked", result: { reason: "promotion_in_progress" } });
    expect(fx.apply).toHaveBeenCalledOnce();
    expect(fx.readWorktreeFile()).toBe(PROMOTED);
    expect(await fx.promotion()).toMatchObject({ status: "applying", approvalId });
    expect(fx.storage.pendingApprovalActions.get(approvalId).result).toMatchObject({
      manualReconciliationRequired: true,
    });
  });

  it("clears the intent when the workbench refuses a precondition, so a later request is allowed", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();
    fx.apply.mockImplementationOnce(async () => {
      throw new ChatWorkbenchPatchRefusedError(
        "precondition_failed",
        "Workbench patch precondition failed before any file was written: Chat session was not found.",
      );
    });

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "workbench_precondition_failed" } });
    expect(fx.storage.pendingApprovalActions.get(approvalId).result).not.toHaveProperty("manualReconciliationRequired");
    expect(await fx.promotion()).toBeUndefined();
    expect(fx.readWorktreeFile()).toBe(ORIGINAL);
    const next = await requestCodeModeAiderPromotion(fx.deps, await fx.run(), "operator-1");
    expect(next).toMatchObject({ status: "approval_pending" });
    fx.storage.approvals.resolve(next.approvalId!, { decision: "approve", resolvedBy: "operator-1" });
    expect(await fx.execute(next.approvalId!)).toMatchObject({ outcome: "executed", result: { status: "promoted" } });
    expect(fx.readWorktreeFile()).toBe(PROMOTED);
  });

  it("refuses a tampered oversized patch artifact by hash with a bounded error before recording an intent", async () => {
    const fx = await createFixture();
    const approvalId = await fx.requestAndApprove();
    fs.writeFileSync(path.resolve(fx.root, fx.patchArtifact.relPath), "+".repeat(4 * 1024 * 1024 + 1));

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "patch_hash_mismatch" } });
    expect(fx.apply).not.toHaveBeenCalled();
    expect(await fx.promotion()).toBeUndefined();
    const stored = fx.storage.pendingApprovalActions.get(approvalId).result as { error: string };
    expect(stored.error.length).toBeLessThanOrEqual(243);
    const refused = fx.publishRealtime.mock.calls.find((call) => call[0] === "code_mode_aider_promotion_refused");
    expect(refused?.[2]).toEqual({ runId: fx.runId, approvalId, reason: "patch_hash_mismatch" });
  });

  it("refuses to request promotion of a hash-consistent patch above the workbench patch limit", async () => {
    const fx = await createFixture({ patchContent: OVERSIZED_PATCH });
    expect(fx.patchArtifact.bytes).toBe(Buffer.byteLength(OVERSIZED_PATCH));
    expect(fx.patchArtifact.sha256).toBe(sha256(OVERSIZED_PATCH));

    const refusal = await requestCodeModeAiderPromotion(fx.deps, await fx.run(), "operator-1").then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(refusal).toBeInstanceOf(ConflictError);
    expect((refusal as ConflictError).details).toMatchObject({ reason: "patch_too_large", runId: fx.runId });
    expect(fx.createApproval).not.toHaveBeenCalled();
  });

  it("refuses to execute an approved hash-consistent patch above the workbench patch limit", async () => {
    const fx = await createFixture({ patchContent: OVERSIZED_PATCH });
    const approvalId = await fx.approveWithoutReading();

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "patch_too_large" } });
    expect(fx.apply).not.toHaveBeenCalled();
    expect(await fx.promotion()).toBeUndefined();
    const refused = fx.publishRealtime.mock.calls.find((call) => call[0] === "code_mode_aider_promotion_refused");
    expect(refused?.[2]).toEqual({ runId: fx.runId, approvalId, reason: "patch_too_large" });
  });

  it("refuses when the approval is not an approved promote approval for the same patch hash", async () => {
    const fx = await createFixture();
    const pendingOnly = await requestCodeModeAiderPromotion(fx.deps, await fx.run(), "operator-1");
    const notApproved = await fx.execute(pendingOnly.approvalId!);
    expect(notApproved).toMatchObject({ outcome: "blocked", result: { reason: "approval_binding_mismatch" } });

    const approvalId = await fx.requestAndApprove();
    const rebound = await executeApprovedCodeModeAiderPromotion(fx.deps, approvalId, {
      ...fx.storage.pendingApprovalActions.get(approvalId),
      request: { ...fx.storage.pendingApprovalActions.get(approvalId).request, patchSha256: "f".repeat(64) },
    });
    expect(rebound).toMatchObject({ outcome: "blocked", result: { reason: "approval_binding_mismatch" } });
    expect(fx.apply).not.toHaveBeenCalled();
    expect(await fx.promotion()).toBeUndefined();
  });

  it("lists bounded changed paths from diff --git headers", () => {
    const headers = Array.from({ length: 60 }, (_, index) => `diff --git a/src/f${index}.ts b/src/f${index}.ts`);
    const listed = listPatchChangedPaths([...headers, "diff --git a/old.ts b/new.ts"].join("\n"));
    expect(listed.paths).toHaveLength(50);
    expect(listed.paths[0]).toBe("src/f0.ts");
    expect(listed.truncated).toBe(true);
    expect(listPatchChangedPaths("diff --git a/old.ts b/new.ts\r\n")).toEqual({
      paths: ["old.ts", "new.ts"],
      truncated: false,
    });
  });

  it("registers a caution approval without session linkage or code hashes", async () => {
    const fx = await createFixture();

    const response = await requestCodeModeAiderPromotion(fx.deps, await fx.run(), "operator-1");

    expect(response).toMatchObject({ runId: fx.runId, status: "approval_pending", approvalId: expect.any(String) });
    const input = fx.createApproval.mock.calls[0]![0];
    expect(input).toMatchObject({
      kind: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
      riskLevel: "caution",
      payload: {
        runId: fx.runId,
        workspaceId: "workspace-a",
        patchSha256: fx.patchArtifact.sha256,
        patchArtifactId: fx.patchArtifact.artifactId,
        fileCount: 1,
        pinnedHead: fx.pin.worktreeHead,
        changedPaths: ["index.ts"],
        changedPathsTruncated: false,
      },
      linkage: {
        workspaceId: "workspace-a",
        runId: fx.runId,
        toolName: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
        actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
      },
    });
    expect(input.linkage).not.toHaveProperty("sessionId");
    expect(input.linkage).not.toHaveProperty("turnId");
    expect(input.payload).not.toHaveProperty("codeHash");
    expect(fx.storage.pendingApprovalActions.get(response.approvalId!)).toMatchObject({
      actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
      resolutionStatus: "pending",
      request: { runId: fx.runId, patchSha256: fx.patchArtifact.sha256, patchArtifactId: fx.patchArtifact.artifactId },
    });
  });
});

interface FixtureOptions {
  pinned?: boolean;
  patch?: "applying" | "non_applying";
  crashAfterApply?: boolean;
  /** Overrides the recorded patch bytes (persisted hash-consistently). */
  patchContent?: string;
}

async function createFixture(options: FixtureOptions = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-aider-promote-")));
  roots.push(root);
  const worktree = path.join(root, "repo");
  fs.mkdirSync(worktree);
  git(worktree, ["init", "-q"]);
  git(worktree, ["config", "user.name", "Promote Test"]);
  git(worktree, ["config", "user.email", "promote-test@example.invalid"]);
  git(worktree, ["config", "commit.gpgsign", "false"]);
  git(worktree, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(worktree, "index.ts"), ORIGINAL);
  git(worktree, ["add", "index.ts"]);
  git(worktree, ["commit", "-q", "-m", "initial"]);
  const patchContent =
    options.patchContent ??
    (options.patch === "non_applying" ? buildPatch(worktree, "export const missing = 0;\n") : buildPatch(worktree));

  const { storage, asyncStorage } = sharedStorage();
  fixtureCount += 1;
  const SESSION_ID = `session-${fixtureCount}`;
  const project = storage.chatProjects.create({ name: "Promote", workspacePath: "repo" });
  storage.chatSessionWorkbench.patch(SESSION_ID, {
    projectId: project.projectId,
    worktreePath: "repo",
    worktreeStatus: "ready",
    baseRef: "main",
  });

  const runId = `run-promote-${fixtureCount}`;
  const artifactRoot = path.join(root, "data", "code-mode-artifacts");
  const persister = createPersister(root, artifactRoot);
  const pin = await captureCodeModeAiderWorkspacePin(
    { storage: asyncStorage, rootDir: root },
    { sessionId: SESSION_ID, runId },
    { gitCaptureTimeoutMs: GIT_TIMEOUT_MS },
  );
  if (!pin) throw new Error("fixture workbench did not pin");
  const policySnapshot = {
    mode: "test",
    codeModeInputHash: INPUT_HASH,
    ...(options.pinned === false ? {} : { codeModeAiderWorkspacePin: pin }),
  };
  const policySnapshotArtifact = await persister.persistJson({
    segments: [runId],
    filename: "policy-snapshot.json",
    value: policySnapshot,
  });
  const codeArtifact = await persister.persistText({
    segments: [runId],
    filename: "source.ts",
    content: "return 1;",
    mimeType: "text/typescript",
  });
  const bundle = await persistCodeModeAiderArtifactBundle(persister, {
    runId,
    requestMarkdown: "Bump the value.",
    invocationPlan: {
      contractVersion: 1,
      adapterId: "aider-cli-adapter",
      runId,
      repository: { rootRelPath: "." },
      command: {
        executable: "aider",
        argv: ["aider"],
        argvRedacted: ["aider"],
        cwdRelPath: ".",
        messageFileRelPath: "aider-request.md",
      },
      replay: { replaySafe: false, policy: "audit_only", reason: "Aider runs are audit-only." },
    } as unknown as CodeModeAiderAdapterInvocationPlan,
    outcome: "patch_produced",
    patch: { kind: "unified_diff", content: patchContent, fileCount: 1 },
  });
  const record: CodeModeRunRecord = {
    runId,
    status: "completed",
    language: "typescript",
    workspaceId: "workspace-a",
    sessionId: SESSION_ID,
    capabilitySnapshotId: "snapshot-1",
    codeModeInputHash: INPUT_HASH,
    wrapperManifestHash: "b".repeat(64),
    policySnapshotHash: sha256(JSON.stringify(policySnapshot)),
    codeHash: codeArtifact.sha256,
    codeArtifact,
    wrapperManifestArtifact: codeArtifact,
    policySnapshotArtifact,
    stdoutTruncated: false,
    stderrTruncated: false,
    result: bundle.result,
    createdAt: "2026-10-16T12:00:00.000Z",
  };
  await asyncStorage.codeModeRuns.upsert(record);

  const apply = vi.fn(
    async (
      sessionId: string,
      input: ChatSessionWorkbenchPatchApplyInput,
    ): Promise<ChatSessionWorkbenchPatchApplyResponse> => {
      expect(sessionId).toBe(SESSION_ID);
      const current = captureCodeModeGitWorktreeState(worktree, GIT_TIMEOUT_MS);
      if (current.headHash !== input.expectedWorktreeHead) {
        throw new ChatWorkbenchPatchRefusedError("head_moved", "Workbench HEAD moved since the patch was pinned.");
      }
      if (current.stateHash !== input.expectedWorktreeStateHash) {
        throw new ChatWorkbenchPatchRefusedError("state_drift", "Workbench files changed since the patch was pinned.");
      }
      try {
        gitWithInput(worktree, ["apply", "--check", "-"], input.patch);
      } catch {
        throw new ChatWorkbenchPatchRefusedError("check_failed", "git apply --check refused the patch.");
      }
      gitWithInput(worktree, ["apply", "-"], input.patch);
      if (options.crashAfterApply) {
        throw new Error("gateway stopped after writing the patch");
      }
      return {
        state: { sessionId, validationStatus: "passed" },
        applied: true,
        checkOnly: false,
        changedFiles: ["index.ts"],
      } as unknown as ChatSessionWorkbenchPatchApplyResponse;
    },
  );
  const createApproval = vi.fn(async (input: ApprovalCreateInput) => storage.approvals.create(input));
  const publishRealtime = vi.fn(async () => undefined);
  const deps: CodeModeAiderPromotionDeps = {
    storage: asyncStorage,
    rootDir: root,
    artifactRoot,
    createApproval,
    publishRealtime,
    applyChatSessionWorkbenchPatch: apply,
    gitCaptureTimeoutMs: GIT_TIMEOUT_MS,
  };

  const run = async () => await asyncStorage.codeModeRuns.get(runId);
  return {
    root,
    worktree,
    storage,
    asyncStorage,
    deps,
    runId,
    pin,
    apply,
    createApproval,
    publishRealtime,
    patchContent,
    patchArtifact: bundle.patchArtifact!,
    run,
    readWorktreeFile: () => fs.readFileSync(path.join(worktree, "index.ts"), "utf8"),
    async promotion(): Promise<CodeModeAiderPromotionRecord | undefined> {
      const current = await run();
      return (current.result as { aiderAdapter: { promotion?: CodeModeAiderPromotionRecord } }).aiderAdapter.promotion;
    },
    async requestAndApprove(): Promise<string> {
      const response = await requestCodeModeAiderPromotion(deps, await run(), "operator-1");
      storage.approvals.resolve(response.approvalId!, { decision: "approve", resolvedBy: "operator-1" });
      return response.approvalId!;
    },
    /** Registers an approved promote approval bound to the recorded patch hash without reading the patch bytes. */
    async approveWithoutReading(): Promise<string> {
      const patchArtifact = bundle.patchArtifact!;
      const payload = { runId, workspaceId: "workspace-a", patchSha256: patchArtifact.sha256 };
      const approval = storage.approvals.create({
        kind: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
        riskLevel: "caution",
        payload,
        preview: payload,
        linkage: { workspaceId: "workspace-a", runId, actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE },
      });
      storage.pendingApprovalActions.upsertPending({
        approvalId: approval.approvalId,
        actionType: CODE_MODE_AIDER_PROMOTE_ACTION_TYPE,
        request: { runId, patchSha256: patchArtifact.sha256, patchArtifactId: patchArtifact.artifactId },
        createdAt: "2026-10-16T12:00:00.000Z",
      });
      storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator-1" });
      return approval.approvalId;
    },
    async execute(approvalId: string) {
      return await executeApprovedCodeModeAiderPromotion(
        deps,
        approvalId,
        storage.pendingApprovalActions.get(approvalId),
      );
    },
  };
}

function buildPatch(worktree: string, staleLine?: string): string {
  const file = path.join(worktree, "index.ts");
  if (staleLine) {
    fs.writeFileSync(file, staleLine);
    git(worktree, ["add", "index.ts"]);
    git(worktree, ["commit", "-q", "-m", "stale base"]);
    fs.writeFileSync(file, PROMOTED);
    const patch = git(worktree, ["diff", "--", "index.ts"]);
    git(worktree, ["checkout", "--", "index.ts"]);
    git(worktree, ["reset", "-q", "--hard", "HEAD~1"]);
    return patch;
  }
  fs.writeFileSync(file, PROMOTED);
  const patch = git(worktree, ["diff", "--", "index.ts"]);
  git(worktree, ["checkout", "--", "index.ts"]);
  return patch;
}

function createPersister(root: string, artifactRoot: string) {
  const persistText = async (input: { segments: string[]; filename: string; content: string; mimeType: string }) => {
    const target = path.join(artifactRoot, ...input.segments, input.filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, input.content, "utf8");
    return {
      artifactId: `artifact-${input.segments.join("-")}-${input.filename}`,
      relPath: path.relative(root, target).replaceAll("\\", "/"),
      sha256: sha256(input.content),
      bytes: Buffer.byteLength(input.content, "utf8"),
      mimeType: input.mimeType,
      createdAt: "2026-10-16T12:00:00.000Z",
    } satisfies CapabilityArtifactRecord;
  };
  return {
    persistText,
    persistJson: async (input: { segments: string[]; filename: string; value: unknown }) =>
      await persistText({ ...input, content: JSON.stringify(input.value, null, 2), mimeType: "application/json" }),
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function gitWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, input, stdio: "pipe" });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
