import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  CapabilityArtifactRecord,
  ChatSessionWorkbenchRecord,
  CodeModeAiderPromotionRecord,
  CodeModeRunRecord,
} from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { applyChatSessionWorkbenchPatch, type ChatWorkbenchDependencies } from "./chat-workbench-service.js";
import { persistCodeModeAiderArtifactBundle } from "./code-mode-aider-artifacts.js";
import type { CodeModeAiderAdapterInvocationPlan } from "./code-mode-aider-adapter-plan.js";
import {
  executeApprovedCodeModeAiderPromotion,
  requestCodeModeAiderPromotion,
  type CodeModeAiderPromotionDeps,
} from "./code-mode-aider-promotion.js";
import { captureCodeModeAiderWorkspacePin } from "./code-mode-aider-workspace-pin.js";

/**
 * Drives the promotion executor against the REAL guarded Chat workbench patch path on a sub-scoped project
 * (repository root above `workspace/demo`), as a pinned Aider run's repository-relative patch would reach it.
 */

const roots: string[] = [];
const INPUT_HASH = "a".repeat(64);
const ORIGINAL = "export const demo = true;\n";
const PROMOTED = "export const demo = false;\n";
const GIT_TIMEOUT_MS = 60_000;
const SESSION_ID = "sess-1";
let fixtureCount = 0;
let shared: { storage: Storage; asyncStorage: ReturnType<typeof createSqliteAsyncStorage>; dir: string } | undefined;

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-aider-promote-wb-db-"));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(dir, "transcripts"),
    auditDir: path.join(dir, "audit"),
  });
  shared = { storage, asyncStorage: createSqliteAsyncStorage(storage), dir };
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

describe("Aider promotion through the real Chat workbench", { timeout: 120_000 }, () => {
  it("applies a repository-relative in-scope patch on a sub-scoped project", async () => {
    const fx = await createFixture({ patchTarget: "workspace/demo/index.ts" });
    const approvalId = await fx.requestAndApprove();

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "executed", result: { status: "promoted" } });
    expect(fx.read("workspace/demo/index.ts")).toBe(PROMOTED);
    expect(await fx.promotion()).toMatchObject({ status: "promoted", approvalId, changedFiles: ["index.ts"] });
    expect(fx.workbenchRealtime).toHaveBeenCalledWith(
      "chat_workbench_updated",
      "chat",
      expect.objectContaining({ type: "chat_workbench_patch_applied", applied: true }),
      expect.anything(),
    );
  });

  it("refuses a patch outside the project scope and clears the intent", async () => {
    // The seeded container sees the whole repository, so a pinned patch can name a file above the project scope.
    const fx = await createFixture({ patchTarget: "README.md" });
    const approvalId = await fx.requestAndApprove();

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "patch_out_of_scope" } });
    expect(fx.read("README.md")).toBe("# repo\n");
    expect(fx.read("workspace/demo/index.ts")).toBe(ORIGINAL);
    expect(await fx.promotion()).toBeUndefined();
    expect(fx.workbenchRealtime).not.toHaveBeenCalled();
  });

  it("refuses a missing chat session as a precondition failure and allows a later request", async () => {
    const fx = await createFixture({ patchTarget: "workspace/demo/index.ts" });
    const approvalId = await fx.requestAndApprove();
    fx.requireChatSession.mockRejectedValueOnce(new Error(`Chat session ${SESSION_ID} was not found.`));

    const result = await fx.execute(approvalId);

    expect(result).toMatchObject({ outcome: "blocked", result: { reason: "workbench_precondition_failed" } });
    expect(await fx.promotion()).toBeUndefined();
    expect(fx.read("workspace/demo/index.ts")).toBe(ORIGINAL);
    const retryApproval = await fx.requestAndApprove();
    expect(await fx.execute(retryApproval)).toMatchObject({ outcome: "executed", result: { status: "promoted" } });
    expect(fx.read("workspace/demo/index.ts")).toBe(PROMOTED);
  });
});

async function createFixture(options: { patchTarget: string }) {
  const { storage, asyncStorage } = shared!;
  fixtureCount += 1;
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-aider-promote-wb-")));
  const artifactBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-aider-promote-art-")));
  roots.push(rootDir, artifactBase);
  fs.mkdirSync(path.join(rootDir, "workspace", "demo"), { recursive: true });
  git(rootDir, ["init", "-q"]);
  git(rootDir, ["config", "user.name", "Promote Test"]);
  git(rootDir, ["config", "user.email", "promote-test@example.invalid"]);
  git(rootDir, ["config", "commit.gpgsign", "false"]);
  git(rootDir, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(rootDir, "workspace", "demo", "index.ts"), ORIGINAL);
  fs.writeFileSync(path.join(rootDir, "README.md"), "# repo\n");
  git(rootDir, ["add", "."]);
  git(rootDir, ["commit", "-q", "-m", "initial"]);
  const worktreePath = path.join(rootDir, ".worktrees", SESSION_ID);
  git(rootDir, ["worktree", "add", "-q", worktreePath, "HEAD"]);

  // The patch a pinned run records is repository-relative (the seed checks out the whole repository).
  const target = path.join(worktreePath, options.patchTarget);
  const before = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, options.patchTarget === "README.md" ? "# changed\n" : PROMOTED);
  const patchContent = git(worktreePath, ["diff", "--", options.patchTarget]);
  fs.writeFileSync(target, before);

  let workbench: ChatSessionWorkbenchRecord = {
    sessionId: SESSION_ID,
    projectId: "proj-1",
    baseRef: "HEAD",
    worktreePath,
    worktreeStatus: "ready",
    validationStatus: "idle",
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  } as ChatSessionWorkbenchRecord;
  const chatSessionWorkbench = {
    get: async () => workbench,
    ensure: async () => workbench,
    patch: async (_sessionId: string, input: Partial<ChatSessionWorkbenchRecord>) => {
      workbench = {
        ...workbench,
        ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
      };
      return workbench;
    },
  };
  const requireChatSession = vi.fn(async () => undefined);
  const workbenchRealtime = vi.fn(async () => undefined);
  const workbenchDeps: ChatWorkbenchDependencies = {
    config: {
      rootDir,
      assistant: { workspaceDir: "workspace", worktreesDir: ".worktrees" },
      toolPolicy: { sandbox: { writeJailRoots: [rootDir], readOnlyRoots: [] } },
    } as ChatWorkbenchDependencies["config"],
    storage: {
      chatProjects: { get: async () => ({ projectId: "proj-1", workspacePath: "demo" }) },
      chatSessionProjects: {
        get: async () => ({
          sessionId: SESSION_ID,
          projectId: "proj-1",
          createdAt: "2026-10-16T12:00:00.000Z",
          updatedAt: "2026-10-16T12:00:00.000Z",
        }),
      },
      chatSessionWorkbench,
      codeModeRuns: { list: async () => [] },
    } as unknown as ChatWorkbenchDependencies["storage"],
    requireChatSession,
    publishRealtime: workbenchRealtime,
  };

  const runId = `run-promote-wb-${fixtureCount}`;
  const artifactRoot = path.join(artifactBase, "data", "code-mode-artifacts");
  const persister = createPersister(artifactBase, artifactRoot);
  const promotionStorage = {
    approvals: asyncStorage.approvals,
    approvalEvents: asyncStorage.approvalEvents,
    codeModeRuns: asyncStorage.codeModeRuns,
    pendingApprovalActions: asyncStorage.pendingApprovalActions,
    runImmediateTransaction: <T>(action: () => Promise<T>) => asyncStorage.runImmediateTransaction(action),
    chatSessionWorkbench,
  } as unknown as CodeModeAiderPromotionDeps["storage"];
  const pin = await captureCodeModeAiderWorkspacePin(
    { storage: promotionStorage, rootDir: artifactBase },
    { sessionId: SESSION_ID, runId },
    { gitCaptureTimeoutMs: GIT_TIMEOUT_MS },
  );
  if (!pin) throw new Error("fixture workbench did not pin");
  const policySnapshot = { mode: "test", codeModeInputHash: INPUT_HASH, codeModeAiderWorkspacePin: pin };
  const policySnapshotArtifact = await persister.persistText({
    segments: [runId],
    filename: "policy-snapshot.json",
    content: JSON.stringify(policySnapshot, null, 2),
    mimeType: "application/json",
  });
  const codeArtifact = await persister.persistText({
    segments: [runId],
    filename: "source.ts",
    content: "return 1;",
    mimeType: "text/typescript",
  });
  const bundle = await persistCodeModeAiderArtifactBundle(persister, {
    runId,
    requestMarkdown: "Flip the flag.",
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
    patch: { kind: "git_patch", content: patchContent, fileCount: 1 },
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

  const deps: CodeModeAiderPromotionDeps = {
    storage: promotionStorage,
    rootDir: artifactBase,
    artifactRoot,
    createApproval: async (input: ApprovalCreateInput) => storage.approvals.create(input),
    publishRealtime: async () => undefined,
    applyChatSessionWorkbenchPatch: async (sessionId, input) =>
      await applyChatSessionWorkbenchPatch(workbenchDeps, sessionId, input),
    gitCaptureTimeoutMs: GIT_TIMEOUT_MS,
  };
  const run = async () => await asyncStorage.codeModeRuns.get(runId);
  return {
    requireChatSession,
    workbenchRealtime,
    read: (relativePath: string) => fs.readFileSync(path.join(worktreePath, relativePath), "utf8"),
    async promotion(): Promise<CodeModeAiderPromotionRecord | undefined> {
      const current = await run();
      return (current.result as { aiderAdapter: { promotion?: CodeModeAiderPromotionRecord } }).aiderAdapter.promotion;
    },
    async requestAndApprove(): Promise<string> {
      const response = await requestCodeModeAiderPromotion(deps, await run(), "operator-1");
      storage.approvals.resolve(response.approvalId!, { decision: "approve", resolvedBy: "operator-1" });
      return response.approvalId!;
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
