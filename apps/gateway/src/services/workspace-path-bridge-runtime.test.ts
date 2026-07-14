import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJsonString,
  type ToolInvokeRequest,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import {
  derivePosixProjectBindingVerificationId,
  type PosixProjectGitBindingEvidence,
} from "./workspace-path-bridge-integration.js";
import type { WorkspacePathBridgeService } from "./workspace-path-bridge-service.js";
import {
  deriveProjectBindingVerificationId,
  FilePosixProjectGitBindingStore,
  type FilePosixProjectGitBindingStoreOptions,
  WorkspacePathBridgeRuntime,
} from "./workspace-path-bridge-runtime.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WorkspacePathBridgeRuntime", () => {
  it("establishes an immutable server-derived Git binding per positive project revision", async () => {
    const fixture = createFixture();
    const runtime = fixture.runtime();

    const first = await runtime.resolveSessionBinding("session-1");
    const second = await runtime.resolveSessionBinding("session-1");

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      workspaceId: "workspace-1",
      project: {
        projectId: "project-1",
        workspaceId: "workspace-1",
        workspacePath: "repos/project-1",
      },
      gitIdentity: { required: true, expectedIdentitySha256: "a".repeat(64) },
    });
    const calls = fixture.resolve.mock.calls.map(([request]) => request as WorkspacePathBridgeResolveRequest);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((request) => request.verificationId))).toEqual(
      new Set([deriveProjectBindingVerificationId("project-1", 7)]),
    );
    expect(calls[0]).toMatchObject({
      inputPath: "F:\\goat\\workspace\\repos\\project-1",
      inputFlavor: "windows_native",
      targetFlavor: "windows_native",
      requireGitIdentity: true,
    });
    expect(calls[0]?.expectedGitIdentitySha256).toBeUndefined();

    fixture.project.revision = 8;
    await expect(runtime.resolveSessionBinding("session-1")).resolves.toBeDefined();
    expect((fixture.resolve.mock.calls.at(-1)?.[0] as WorkspacePathBridgeResolveRequest).verificationId).toBe(
      deriveProjectBindingVerificationId("project-1", 8),
    );
  });

  it("fails closed when session or project CAS state changes while Git identity is inspected", async () => {
    const fixture = createFixture();
    fixture.resolve.mockImplementationOnce(async (request: WorkspacePathBridgeResolveRequest) => {
      fixture.project.revision += 1;
      return verifiedSnapshot(request, "a".repeat(64));
    });

    await expect(fixture.runtime().resolveSessionBinding("session-1")).resolves.toBeUndefined();
  });

  it("rejects archived, cross-workspace, non-positive, and unjailed project bindings", async () => {
    const fixture = createFixture();
    const runtime = fixture.runtime();

    fixture.project.lifecycleStatus = "archived";
    await expect(runtime.resolveSessionBinding("session-1")).resolves.toBeUndefined();
    fixture.project.lifecycleStatus = "active";
    fixture.project.workspaceId = "workspace-2";
    await expect(runtime.resolveSessionBinding("session-1")).resolves.toBeUndefined();
    fixture.project.workspaceId = "workspace-1";
    fixture.project.revision = 0;
    await expect(runtime.resolveSessionBinding("session-1")).resolves.toBeUndefined();
    fixture.project.revision = 7;
    fixture.project.workspacePath = "../escape";
    await expect(runtime.resolveSessionBinding("session-1")).resolves.toBeUndefined();

    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("uses only startup path-source config for unbound session provenance", async () => {
    const fixture = createFixture();
    fixture.assignment = undefined;
    const runtime = fixture.runtime({
      GOATCITADEL_WORKSPACE_PATH_SOURCE: "wsl",
      GOATCITADEL_WORKSPACE_PATH_WSL_DISTRO: "Ubuntu-24.04",
    });

    await expect(runtime.resolveSessionBinding("session-1")).resolves.toEqual({
      workspaceId: "workspace-1",
      pathSource: { flavor: "wsl", distro: "Ubuntu-24.04" },
    });
    expect(fixture.resolve).not.toHaveBeenCalled();
  });

  it("starts at /app and enforces native POSIX jail, symlink, and restart-safe Git identity", async () => {
    const symlinks = new Set<string>();
    let commonDir = "/app/workspace/repos/project-1/.git";
    expect(() => createPosixRuntime({ symlinks, getCommonDir: () => commonDir })).not.toThrow();

    const evidenceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-posix-project-binding-"));
    tempRoots.push(evidenceRoot);
    const runtime = createPosixRuntime({ evidenceRoot, symlinks, getCommonDir: () => commonDir });
    const request = posixToolRequest(".");

    await expect(runtime.resolveSessionBinding("session-1")).resolves.toMatchObject({
      workspaceId: "workspace-1",
      project: { projectId: "project-1", revision: 7, workspacePath: "repos/project-1" },
    });
    const policy = await runtime.executionResolver.resolve(request, {
      invocationId: "posix-invocation",
      phase: "policy",
    });
    const preExecute = await runtime.executionResolver.resolve(request, {
      invocationId: "posix-invocation",
      phase: "pre_execute",
    });

    expect(policy).toMatchObject({
      status: "verified",
      snapshotId: "posix-invocation:policy",
      canonicalCwd: "/app/workspace/repos/project-1",
      snapshotFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      gitIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(preExecute).toMatchObject({
      status: "verified",
      snapshotId: "posix-invocation:pre_execute",
      snapshotFingerprintSha256: policy.status === "verified" ? policy.snapshotFingerprintSha256 : "unreachable",
    });
    await expect(
      runtime.executionResolver.resolve(posixToolRequest("../../escape"), {
        invocationId: "posix-traversal",
        phase: "policy",
      }),
    ).resolves.toEqual({ status: "blocked", reasonCode: "outside_jail" });

    symlinks.add("/app/workspace/repos/project-1/link");
    await expect(
      runtime.executionResolver.resolve(posixToolRequest("link"), {
        invocationId: "posix-symlink",
        phase: "policy",
      }),
    ).resolves.toEqual({ status: "blocked", reasonCode: "canonicalization_failed" });
    symlinks.clear();

    const restarted = createPosixRuntime({ evidenceRoot, symlinks, getCommonDir: () => commonDir });
    await expect(
      restarted.executionResolver.resolve(request, { invocationId: "posix-restart", phase: "policy" }),
    ).resolves.toMatchObject({ status: "verified" });

    commonDir = "/app/workspace/repos/project-1/.git-swapped";
    const driftedAfterRestart = createPosixRuntime({ evidenceRoot, symlinks, getCommonDir: () => commonDir });
    await expect(
      driftedAfterRestart.executionResolver.resolve(request, {
        invocationId: "posix-restart-drift",
        phase: "policy",
      }),
    ).resolves.toEqual({ status: "blocked", reasonCode: "git_identity_mismatch" });
    await expect(fs.readdir(evidenceRoot)).resolves.toHaveLength(1);
  });

  it.each(["before_stage", "before_stage_write", "before_publish", "before_read", "after_read"] as const)(
    "fails closed with no outside bytes when the evidence root becomes a symlink at %s",
    async (swapPhase) => {
      const root = await createTempRoot("goatcitadel-posix-binding-root-swap-");
      const evidenceRoot = path.join(root, "evidence");
      const parkedRoot = path.join(root, "parked-evidence");
      const outsideRoot = path.join(root, "outside");
      await fs.mkdir(evidenceRoot, { mode: 0o700 });
      await fs.mkdir(outsideRoot, { mode: 0o700 });
      await fs.writeFile(path.join(outsideRoot, "sentinel.txt"), "outside-sentinel", "utf8");

      let swapped = false;
      const store = createTestPosixBindingStore(evidenceRoot, {
        beforeCriticalPhase(phase) {
          if (phase !== swapPhase || swapped) return;
          fsSync.renameSync(evidenceRoot, parkedRoot);
          fsSync.symlinkSync(outsideRoot, evidenceRoot, process.platform === "win32" ? "junction" : "dir");
          swapped = true;
        },
        // Production Linux uses /proc/self/fd/<directory-fd>. This projection
        // gives the Windows proof lane the same handle-relative identity after
        // the lexical evidence root is replaced.
        resolveStableDirectoryReference: () => (swapped ? parkedRoot : evidenceRoot),
      });

      await expect(store.verifyOrEstablish(posixBindingEvidence())).resolves.toBe(false);
      expect(swapped).toBe(true);
      await expect(fs.readdir(outsideRoot)).resolves.toEqual(["sentinel.txt"]);
      await expect(fs.readFile(path.join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside-sentinel");
      await expect(fs.readdir(parkedRoot)).resolves.toEqual([]);
    },
  );

  it("fails closed when neither evidence directory-handle projection is usable", async () => {
    const root = await createTempRoot("goatcitadel-posix-binding-no-handle-projection-");
    const evidenceRoot = path.join(root, "evidence");
    const outsideRoot = path.join(root, "outside");
    const missingProjection = path.join(root, "missing-proc-projection");
    await fs.mkdir(evidenceRoot, { mode: 0o700 });
    await fs.mkdir(outsideRoot, { mode: 0o700 });
    await fs.writeFile(path.join(outsideRoot, "sentinel.txt"), "outside-sentinel", "utf8");
    let candidateReads = 0;
    const store = createTestPosixBindingStore(evidenceRoot, {
      resolveStableDirectoryReferenceCandidates: () => {
        candidateReads += 1;
        return [missingProjection, outsideRoot];
      },
    });

    await expect(store.verifyOrEstablish(posixBindingEvidence())).resolves.toBe(false);
    expect(candidateReads).toBeGreaterThan(0);
    await expect(fs.readdir(evidenceRoot)).resolves.toEqual([]);
    await expect(fs.readdir(outsideRoot)).resolves.toEqual(["sentinel.txt"]);
    await expect(fs.readFile(path.join(outsideRoot, "sentinel.txt"), "utf8")).resolves.toBe("outside-sentinel");
  });

  it("atomically converges interleaved exact writers and rejects a same-id different-byte loser", async () => {
    const exactRoot = await createTempRoot("goatcitadel-posix-binding-exact-writers-");
    const exactEvidence = posixBindingEvidence();
    const exactSecond = createTestPosixBindingStore(exactRoot);
    let exactNested: Promise<boolean> | undefined;
    const exactFirst = createTestPosixBindingStore(exactRoot, {
      beforeCriticalPhase(phase) {
        if (phase === "before_publish" && !exactNested) {
          exactNested = exactSecond.verifyOrEstablish(exactEvidence);
        }
      },
    });

    await expect(exactFirst.verifyOrEstablish(exactEvidence)).resolves.toBe(true);
    await expect(exactNested).resolves.toBe(true);
    await expect(fs.readFile(posixBindingEvidencePath(exactRoot, exactEvidence), "utf8")).resolves.toBe(
      `${canonicalJsonString(exactEvidence)}\n`,
    );
    await expect(fs.readdir(exactRoot)).resolves.toHaveLength(1);

    const differentRoot = await createTempRoot("goatcitadel-posix-binding-different-writers-");
    const losingEvidence = posixBindingEvidence();
    const winningEvidence = { ...losingEvidence, identitySha256: "b".repeat(64) };
    const winningStore = createTestPosixBindingStore(differentRoot);
    let winningNested: Promise<boolean> | undefined;
    const losingStore = createTestPosixBindingStore(differentRoot, {
      beforeCriticalPhase(phase) {
        if (phase === "before_publish" && !winningNested) {
          winningNested = winningStore.verifyOrEstablish(winningEvidence);
        }
      },
    });

    await expect(losingStore.verifyOrEstablish(losingEvidence)).resolves.toBe(false);
    await expect(winningNested).resolves.toBe(true);
    await expect(fs.readFile(posixBindingEvidencePath(differentRoot, losingEvidence), "utf8")).resolves.toBe(
      `${canonicalJsonString(winningEvidence)}\n`,
    );
    await expect(fs.readdir(differentRoot)).resolves.toHaveLength(1);
  });

  it("rejects a same-path evidence-directory replacement with a different filesystem identity", async () => {
    const root = await createTempRoot("goatcitadel-posix-binding-identity-swap-");
    const evidenceRoot = path.join(root, "evidence");
    const parkedRoot = path.join(root, "parked-evidence");
    await fs.mkdir(evidenceRoot, { mode: 0o700 });
    let swapped = false;
    const store = createTestPosixBindingStore(evidenceRoot, {
      beforeCriticalPhase(phase) {
        if (phase !== "before_publish" || swapped) return;
        fsSync.renameSync(evidenceRoot, parkedRoot);
        fsSync.mkdirSync(evidenceRoot, { mode: 0o700 });
        swapped = true;
      },
      resolveStableDirectoryReference: () => (swapped ? parkedRoot : evidenceRoot),
    });

    await expect(store.verifyOrEstablish(posixBindingEvidence())).resolves.toBe(false);
    await expect(fs.readdir(evidenceRoot)).resolves.toEqual([]);
    await expect(fs.readdir(parkedRoot)).resolves.toEqual([]);
  });

  it("never rewrites tampered, symlinked, or hard-linked immutable evidence", async () => {
    const evidence = posixBindingEvidence();

    const tamperRoot = await createTempRoot("goatcitadel-posix-binding-tamper-");
    const tamperStore = createTestPosixBindingStore(tamperRoot);
    await expect(tamperStore.verifyOrEstablish(evidence)).resolves.toBe(true);
    const tamperPath = posixBindingEvidencePath(tamperRoot, evidence);
    await fs.writeFile(tamperPath, "tampered-bytes\n", { encoding: "utf8", mode: 0o600 });
    await expect(tamperStore.verifyOrEstablish(evidence)).resolves.toBe(false);
    await expect(fs.readFile(tamperPath, "utf8")).resolves.toBe("tampered-bytes\n");

    const symlinkRoot = await createTempRoot("goatcitadel-posix-binding-symlink-");
    const symlinkOutside = path.join(symlinkRoot, "outside.json");
    const symlinkPath = posixBindingEvidencePath(symlinkRoot, evidence);
    await fs.writeFile(symlinkOutside, `${canonicalJsonString(evidence)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.symlink(symlinkOutside, symlinkPath, "file");
      await expect(createTestPosixBindingStore(symlinkRoot).verifyOrEstablish(evidence)).resolves.toBe(false);
      await expect(fs.readFile(symlinkOutside, "utf8")).resolves.toBe(`${canonicalJsonString(evidence)}\n`);
    } catch (error) {
      if (!isUnsupportedLinkError(error)) throw error;
    }

    const hardlinkRoot = await createTempRoot("goatcitadel-posix-binding-hardlink-");
    const hardlinkStore = createTestPosixBindingStore(hardlinkRoot);
    await expect(hardlinkStore.verifyOrEstablish(evidence)).resolves.toBe(true);
    const hardlinkPath = posixBindingEvidencePath(hardlinkRoot, evidence);
    try {
      await fs.link(hardlinkPath, path.join(hardlinkRoot, "second-link.json"));
      await expect(hardlinkStore.verifyOrEstablish(evidence)).resolves.toBe(false);
    } catch (error) {
      if (!isUnsupportedLinkError(error)) throw error;
    }
  });
});

async function createTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function createTestPosixBindingStore(
  evidenceRoot: string,
  options: FilePosixProjectGitBindingStoreOptions = {},
): FilePosixProjectGitBindingStore {
  return new FilePosixProjectGitBindingStore(evidenceRoot, {
    resolveStableDirectoryReference: (root) => root,
    ...options,
  });
}

function posixBindingEvidence(): PosixProjectGitBindingEvidence {
  return {
    verificationId: derivePosixProjectBindingVerificationId("project-1", 7),
    workspaceId: "workspace-1",
    projectId: "project-1",
    projectRevision: 7,
    canonicalProjectRoot: "/app/workspace/repos/project-1",
    topLevelPath: "/app/workspace/repos/project-1",
    commonDirPath: "/app/workspace/repos/project-1/.git",
    identitySha256: "a".repeat(64),
  };
}

function posixBindingEvidencePath(root: string, evidence: PosixProjectGitBindingEvidence): string {
  return path.join(root, `${createHash("sha256").update(evidence.verificationId, "utf8").digest("hex")}.json`);
}

function isUnsupportedLinkError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}

function createFixture() {
  const meta = {
    sessionId: "session-1",
    revision: 4,
    workspaceId: "workspace-1",
    lifecycleStatus: "active" as const,
  };
  const project = {
    projectId: "project-1",
    revision: 7,
    workspaceId: "workspace-1",
    workspacePath: "repos/project-1",
    lifecycleStatus: "active" as "active" | "archived",
  };
  const fixture: {
    project: typeof project;
    assignment: { projectId: string } | undefined;
    resolve: ReturnType<typeof vi.fn>;
    runtime(environment?: Readonly<Record<string, string | undefined>>): WorkspacePathBridgeRuntime;
  } = {
    project,
    assignment: { projectId: "project-1" },
    resolve: vi.fn(async (request: WorkspacePathBridgeResolveRequest) => verifiedSnapshot(request, "a".repeat(64))),
    runtime(environment = {}) {
      const service = { resolve: fixture.resolve } as unknown as WorkspacePathBridgeService;
      return new WorkspacePathBridgeRuntime({
        storage: {
          chatSessionMeta: { get: vi.fn(() => meta) },
          chatSessionProjects: { get: vi.fn(() => fixture.assignment) },
          chatProjects: { find: vi.fn(() => fixture.project) },
          workspaces: { find: vi.fn(() => ({ workspaceId: "workspace-1", lifecycleStatus: "active" })) },
          workspacePathBridgeSnapshots: {},
        } as never,
        rootDir: "F:\\goat",
        workspaceDir: "workspace",
        writeJailRoots: ["F:\\goat\\workspace"],
        environment,
        service,
      });
    },
  };
  return fixture;
}

function createPosixRuntime(input: {
  evidenceRoot?: string;
  symlinks: ReadonlySet<string>;
  getCommonDir(): string;
}): WorkspacePathBridgeRuntime {
  const service = { resolve: vi.fn() } as unknown as WorkspacePathBridgeService;
  return new WorkspacePathBridgeRuntime({
    storage: {
      chatSessionMeta: {
        get: vi.fn(() => ({
          sessionId: "session-1",
          revision: 4,
          workspaceId: "workspace-1",
          lifecycleStatus: "active",
        })),
      },
      chatSessionProjects: { get: vi.fn(() => ({ projectId: "project-1" })) },
      chatProjects: {
        find: vi.fn(() => ({
          projectId: "project-1",
          revision: 7,
          workspaceId: "workspace-1",
          workspacePath: "repos/project-1",
          lifecycleStatus: "active",
        })),
      },
      workspaces: { find: vi.fn(() => ({ workspaceId: "workspace-1", lifecycleStatus: "active" })) },
      workspacePathBridgeSnapshots: {},
    } as never,
    rootDir: "/app",
    workspaceDir: "./workspace",
    dataDir: "./data",
    writeJailRoots: ["/app/workspace"],
    hostPlatform: "posix",
    environment: {},
    service,
    realpath: async (value) => value,
    stat: async () => ({ isDirectory: () => true }),
    lstat: async (value) => ({ isSymbolicLink: () => input.symlinks.has(value) }),
    runGit: async (args) => {
      if (args.includes("--show-toplevel")) return { stdout: "/app/workspace/repos/project-1\n" };
      if (args.includes("--git-common-dir")) return { stdout: `${input.getCommonDir()}\n` };
      throw new Error("Unexpected Git command.");
    },
    ...(input.evidenceRoot ? { posixProjectGitBindingStore: createTestPosixBindingStore(input.evidenceRoot) } : {}),
  });
}

function posixToolRequest(cwd: string): ToolInvokeRequest {
  return {
    toolName: "shell.exec",
    args: { command: "git status --short", cwd },
    agentId: "agent-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
  };
}

function verifiedSnapshot(
  request: WorkspacePathBridgeResolveRequest,
  identitySha256: string,
): WorkspacePathBridgeSnapshotRecord {
  return {
    snapshotId: request.verificationId,
    workspaceId: request.workspaceId,
    status: "verified",
    callable: true,
    inputFlavor: request.inputFlavor,
    targetFlavor: request.targetFlavor,
    gitIdentityRequired: request.requireGitIdentity,
    canonicalHostPath: request.inputPath,
    gitIdentity: {
      status: "verified",
      topLevelPath: request.inputPath,
      commonDirPath: `${request.inputPath}\\.git`,
      identitySha256,
    },
  } as WorkspacePathBridgeSnapshotRecord;
}
