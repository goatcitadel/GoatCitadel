import path from "node:path";
import {
  canonicalJsonString,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  WorkspacePathBridgeExecutableUnavailableError,
  WorkspacePathBridgeService,
  type WorkspacePathBridgeExecutable,
  type WorkspacePathBridgeProcessRunner,
} from "./workspace-path-bridge-service.js";

const WIN = path.win32;
const ROOT = "F:\\Work Space";
const PROJECT = `${ROOT}\\Project`;
const GIT_DIR = `${PROJECT}\\.git`;

class MemoryRepository {
  public readonly records = new Map<string, WorkspacePathBridgeSnapshotRecord>();

  public create(input: WorkspacePathBridgeSnapshotRecord): WorkspacePathBridgeSnapshotRecord {
    const existing = this.records.get(input.snapshotId);
    if (existing && canonicalJsonString(existing) !== canonicalJsonString(input)) {
      throw new Error("immutable conflict");
    }
    this.records.set(input.snapshotId, input);
    return input;
  }

  public find(snapshotId: string) {
    return this.records.get(snapshotId);
  }

  public get(snapshotId: string) {
    const record = this.records.get(snapshotId);
    if (!record) throw new Error("not found");
    return record;
  }

  public listByWorkspace(workspaceId: string, limit: number) {
    return [...this.records.values()].filter((record) => record.workspaceId === workspaceId).slice(0, limit);
  }
}

class VirtualWindowsFs {
  private readonly realpaths = new Map<string, string>();
  private readonly entries = new Map<string, "directory" | "file" | "symlink">();

  public directory(input: string, canonical = input): this {
    this.realpaths.set(key(input), WIN.normalize(canonical));
    this.entries.set(key(input), "directory");
    this.entries.set(key(canonical), "directory");
    return this;
  }

  public file(input: string): this {
    this.entries.set(key(input), "file");
    return this;
  }

  public symlink(input: string, canonical: string): this {
    this.realpaths.set(key(input), WIN.normalize(canonical));
    this.entries.set(key(input), "symlink");
    this.entries.set(key(canonical), "directory");
    return this;
  }

  public retarget(input: string, canonical: string): this {
    this.realpaths.set(key(input), WIN.normalize(canonical));
    this.entries.set(key(canonical), "directory");
    return this;
  }

  public realpath = async (input: string): Promise<string> => {
    const value = this.realpaths.get(key(input));
    if (!value) throw enoent();
    return value;
  };

  public stat = async (input: string): Promise<{ isDirectory(): boolean }> => {
    const entry = this.entries.get(key(input));
    if (!entry) throw enoent();
    return { isDirectory: () => entry === "directory" };
  };

  public lstat = async (input: string): Promise<{ isSymbolicLink(): boolean }> => {
    const entry = this.entries.get(key(input));
    if (!entry) throw enoent();
    return { isSymbolicLink: () => entry === "symlink" };
  };
}

interface RunnerCall {
  executable: WorkspacePathBridgeExecutable;
  args: readonly string[];
  options?: { cwd?: string; signal?: AbortSignal };
}

class CapturingRunner implements WorkspacePathBridgeProcessRunner {
  public readonly calls: RunnerCall[] = [];

  public constructor(
    private readonly handler: (call: RunnerCall) => Promise<{ stdout: string }> | { stdout: string },
  ) {}

  public async run(
    executable: WorkspacePathBridgeExecutable,
    args: readonly string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<{ stdout: string }> {
    const call = { executable, args: [...args], options };
    this.calls.push(call);
    return this.handler(call);
  }
}

function createFs(): VirtualWindowsFs {
  return new VirtualWindowsFs().directory(ROOT).directory(PROJECT);
}

function request(overrides: Partial<WorkspacePathBridgeResolveRequest> = {}): WorkspacePathBridgeResolveRequest {
  return {
    verificationId: "bridge-1",
    workspaceId: "workspace-1",
    inputPath: PROJECT,
    inputFlavor: "windows_native",
    targetFlavor: "msys",
    requireGitIdentity: false,
    ...overrides,
  };
}

function createService(input: {
  fs?: VirtualWindowsFs;
  runner?: WorkspacePathBridgeProcessRunner;
  repository?: MemoryRepository;
  roots?: readonly string[];
}) {
  const virtualFs = input.fs ?? createFs();
  const repository = input.repository ?? new MemoryRepository();
  const runner =
    input.runner ??
    new CapturingRunner(() => {
      throw new Error("unexpected process invocation");
    });
  const service = new WorkspacePathBridgeService({
    repository,
    allowedRootsForWorkspace: () => input.roots ?? [ROOT],
    runner,
    realpath: virtualFs.realpath,
    stat: virtualFs.stat,
    lstat: virtualFs.lstat,
    now: () => new Date("2026-07-13T00:00:00.000Z"),
  });
  return { service, repository, runner, virtualFs };
}

describe("WorkspacePathBridgeService", () => {
  it("canonicalizes native, forward/mixed, and MSYS aliases with spaces and case", async () => {
    const { service, runner } = createService({});
    const cases: WorkspacePathBridgeResolveRequest[] = [
      request({ verificationId: "native", targetFlavor: "windows_forward" }),
      request({
        verificationId: "forward",
        inputPath: "f:/work space\\project",
        inputFlavor: "windows_forward",
        targetFlavor: "msys",
      }),
      request({
        verificationId: "msys",
        inputPath: "/f/WORK SPACE\\PROJECT",
        inputFlavor: "msys",
        targetFlavor: "windows_native",
      }),
    ];
    for (const item of cases) {
      const snapshot = await service.resolve(item);
      expect(snapshot.status).toBe("verified");
      expect(snapshot.callable).toBe(true);
      expect(snapshot.canonicalHostPath).toBe(PROJECT);
      expect(snapshot.roundTrip.equal).toBe(true);
      expect(snapshot.gitIdentity).toEqual({ status: "not_repository" });
    }
    expect((runner as CapturingRunner).calls).toEqual([]);
  });

  it.each([
    ["device", "\\\\?\\F:\\Work Space\\Project", "windows_native"],
    ["drive-relative", "F:Project", "windows_native"],
    ["ads", "F:\\Work Space\\Project:secret", "windows_native"],
    ["control", "F:\\Work Space\\Project\u0000x", "windows_native"],
    ["traversal", "F:\\Work Space\\..\\Other", "windows_native"],
    ["unc", "\\\\server\\share\\Project", "windows_native"],
    ["root", "F:\\", "windows_native"],
    ["reserved", "F:\\Work Space\\CON", "windows_native"],
    ["malformed-msys", "/mnt/f/Work Space/Project", "msys"],
  ] as const)("rejects %s paths before any subprocess", async (_label, inputPath, inputFlavor) => {
    const { service, runner } = createService({});
    const snapshot = await service.resolve(request({ verificationId: `bad-${_label}`, inputPath, inputFlavor }));
    expect(snapshot).toMatchObject({ status: "blocked", reasonCode: "invalid_path", callable: false });
    expect((runner as CapturingRunner).calls).toEqual([]);
  });

  it("blocks foreign roots, host symlink escapes, and nonexistent execution roots", async () => {
    const fs = createFs()
      .directory("G:\\Outside")
      .symlink(`${ROOT}\\Link`, "G:\\Outside")
      .symlink(`${ROOT}\\Inside-Link`, PROJECT);
    const { service } = createService({ fs });
    await expect(
      service.resolve(request({ verificationId: "outside", inputPath: "G:\\Outside" })),
    ).resolves.toMatchObject({
      status: "blocked",
      reasonCode: "outside_jail",
      callable: false,
    });
    await expect(
      service.resolve(request({ verificationId: "link", inputPath: `${ROOT}\\Link` })),
    ).resolves.toMatchObject({
      status: "blocked",
      reasonCode: "symlink_escape",
      callable: false,
    });
    await expect(
      service.resolve(request({ verificationId: "inside-link", inputPath: `${ROOT}\\Inside-Link` })),
    ).resolves.toMatchObject({ status: "blocked", reasonCode: "symlink_escape", callable: false });
    await expect(
      service.resolve(request({ verificationId: "missing", inputPath: `${ROOT}\\Missing` })),
    ).resolves.toMatchObject({
      status: "blocked",
      reasonCode: "canonicalization_failed",
      callable: false,
    });
  });

  it("rejects configured-root and WSL symlink inputs before they become callable", async () => {
    const aliasRoot = "F:\\Alias Root";
    const configuredFs = createFs().symlink(aliasRoot, ROOT);
    const configured = createService({ fs: configuredFs, roots: [aliasRoot] });
    await expect(configured.service.resolve(request({ verificationId: "configured-link" }))).rejects.toMatchObject({
      reasonCode: "symlink_escape",
    });

    const runner = new CapturingRunner(({ args }) => {
      if (args[3] === "true") return { stdout: "" };
      if (args[3] === "readlink") return { stdout: "/mnt/f/Work Space/Project\n" };
      throw new Error("must stop after symlink resolution");
    });
    const wsl = createService({ runner });
    await expect(
      wsl.service.resolve(
        request({
          verificationId: "wsl-link",
          inputPath: "/mnt/f/Work Space/Link",
          inputFlavor: "wsl",
          distro: "Ubuntu",
        }),
      ),
    ).resolves.toMatchObject({ status: "blocked", reasonCode: "symlink_escape", callable: false });
  });

  it("uses an explicit distro and fixed WSL argv for dynamic mounts and injection-shaped path bytes", async () => {
    const inputPath = "/custom/f/Work Space/Project;touch-marker";
    const hostPath = `${PROJECT};touch-marker`;
    const fs = createFs().directory(hostPath);
    const runner = new CapturingRunner(({ executable, args }) => {
      expect(executable).toBe("wsl.exe");
      expect(args.slice(0, 3)).toEqual(["--distribution", "Ubuntu-24.04", "--exec"]);
      if (args[3] === "true") return { stdout: "" };
      if (args[3] === "readlink" || args[3] === "realpath") return { stdout: `${args.at(-1)}\n` };
      if (args[3] === "wslpath" && args[4] === "-w") return { stdout: `${hostPath}\n` };
      if (args[3] === "wslpath" && args[4] === "-u") return { stdout: `${inputPath}\n` };
      throw new Error("unexpected argv");
    });
    const { service } = createService({ fs, runner });
    const snapshot = await service.resolve(
      request({
        verificationId: "wsl-dynamic",
        inputPath,
        inputFlavor: "wsl",
        targetFlavor: "wsl",
        distro: "Ubuntu-24.04",
      }),
    );
    expect(snapshot).toMatchObject({ status: "verified", canonicalHostPath: hostPath, canonicalTargetPath: inputPath });
    const wslpathCalls = runner.calls.filter((call) => call.args[3] === "wslpath");
    expect(wslpathCalls.length).toBeGreaterThanOrEqual(3);
    expect(wslpathCalls.some((call) => call.args.at(-1) === inputPath)).toBe(true);
    expect(wslpathCalls.every((call) => call.executable === "wsl.exe")).toBe(true);
  });

  it("reports WSL unavailability without guessing a mapping", async () => {
    const runner = new CapturingRunner(() => {
      throw new WorkspacePathBridgeExecutableUnavailableError("wsl.exe");
    });
    const { service } = createService({ runner });
    const snapshot = await service.resolve(
      request({
        verificationId: "wsl-unavailable",
        inputPath: "/mnt/f/Work Space/Project",
        inputFlavor: "wsl",
        distro: "Ubuntu",
      }),
    );
    expect(snapshot).toMatchObject({ status: "unavailable", reasonCode: "wsl_unavailable", callable: false });
    expect(snapshot.canonicalHostPath).toBeUndefined();
  });

  it("preserves Git top-level plus common-dir identity across aliases and rejects a common-dir swap", async () => {
    const otherCommon = "F:\\Other Repo\\.git";
    const fs = createFs()
      .directory(GIT_DIR)
      .file(GIT_DIR)
      .directory("F:\\Other Repo")
      .directory(otherCommon)
      .file(`${PROJECT}\\.git`);
    let commonDir = GIT_DIR;
    const runner = new CapturingRunner(({ executable, args }) => {
      expect(executable).toBe("git");
      if (args.at(-1) === "--show-toplevel") return { stdout: `${PROJECT}\n` };
      if (args.at(-1) === "--git-common-dir") return { stdout: `${commonDir}\n` };
      throw new Error("unexpected git argv");
    });
    const { service } = createService({ fs, runner, roots: [ROOT] });
    const first = await service.resolve(
      request({ verificationId: "git-native", requireGitIdentity: true, targetFlavor: "windows_forward" }),
    );
    const alias = await service.resolve(
      request({
        verificationId: "git-alias",
        inputPath: "f:/work space/project",
        inputFlavor: "windows_forward",
        requireGitIdentity: true,
        targetFlavor: "windows_forward",
      }),
    );
    expect(first.gitIdentity.status).toBe("verified");
    expect(alias.gitIdentity.identitySha256).toBe(first.gitIdentity.identitySha256);

    commonDir = otherCommon;
    const swapped = await service.resolve(
      request({
        verificationId: "git-swap",
        requireGitIdentity: true,
        expectedGitIdentitySha256: first.gitIdentity.identitySha256,
      }),
    );
    expect(swapped).toMatchObject({ status: "blocked", reasonCode: "git_identity_mismatch", callable: false });
  });

  it("distinguishes a definite non-repository from Git failure/unavailability", async () => {
    const optional = createService({});
    await expect(optional.service.resolve(request({ verificationId: "nonrepo" }))).resolves.toMatchObject({
      status: "verified",
      gitIdentity: { status: "not_repository" },
    });

    const fs = createFs().file(`${PROJECT}\\.git`);
    const failedRunner = new CapturingRunner(() => {
      throw new Error("timeout-or-corrupt");
    });
    const failed = createService({ fs, runner: failedRunner });
    await expect(
      failed.service.resolve(request({ verificationId: "git-failed", requireGitIdentity: true })),
    ).resolves.toMatchObject({ status: "blocked", reasonCode: "git_verification_failed", callable: false });

    const unavailableRunner = new CapturingRunner(() => {
      throw new WorkspacePathBridgeExecutableUnavailableError("git");
    });
    const unavailable = createService({ fs, runner: unavailableRunner });
    await expect(
      unavailable.service.resolve(request({ verificationId: "git-unavailable", requireGitIdentity: true })),
    ).resolves.toMatchObject({ status: "unavailable", reasonCode: "git_unavailable", callable: false });
  });

  it("never persists an aborted request", async () => {
    const fs = createFs().file(`${PROJECT}\\.git`);
    const repository = new MemoryRepository();
    const controller = new AbortController();
    const runner = new CapturingRunner(() => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const { service } = createService({ fs, repository, runner });
    await expect(
      service.resolve(request({ verificationId: "aborted", requireGitIdentity: true }), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(repository.records.size).toBe(0);
  });

  it("revalidates exact replay and rejects stale root, target, or Git evidence", async () => {
    const fs = createFs().directory(GIT_DIR).file(`${PROJECT}\\.git`);
    let commonDir = GIT_DIR;
    const runner = new CapturingRunner(({ args }) => {
      if (args.at(-1) === "--show-toplevel") return { stdout: `${PROJECT}\n` };
      if (args.at(-1) === "--git-common-dir") return { stdout: `${commonDir}\n` };
      throw new Error("unexpected git argv");
    });
    const { service } = createService({ fs, runner });
    const replayRequest = request({ verificationId: "replay", requireGitIdentity: true });
    const first = await service.resolve(replayRequest);
    await expect(service.resolve(replayRequest)).resolves.toEqual(first);

    commonDir = "F:\\Swapped\\.git";
    fs.directory("F:\\Swapped").directory(commonDir);
    await expect(service.resolve(replayRequest)).rejects.toThrow(/conflicts with current filesystem evidence/u);

    const targetReplay = request({ verificationId: "target-replay" });
    const historical = await service.resolve(targetReplay);
    fs.directory("G:\\Escaped").symlink(PROJECT, "G:\\Escaped");
    await expect(service.inspect("workspace-1", targetReplay.verificationId)).resolves.toEqual(historical);
    await expect(service.resolve(targetReplay)).rejects.toThrow(/conflicts with current filesystem evidence/u);
  });

  it("rejects unknown request fields and caps trusted roots before process execution", async () => {
    const runner = new CapturingRunner(() => {
      throw new Error("must not run");
    });
    const normal = createService({ runner });
    await expect(normal.service.resolve({ ...request(), executable: "cmd.exe" } as never)).rejects.toThrow(
      /unsupported or missing fields/u,
    );
    expect(runner.calls).toEqual([]);

    const tooManyRoots = Array.from({ length: 17 }, (_, index) => `F:\\Root-${index}`);
    const bounded = createService({ runner, roots: tooManyRoots });
    await expect(bounded.service.resolve(request({ verificationId: "too-many-roots" }))).rejects.toThrow(
      /count exceeds/u,
    );
    expect(runner.calls).toEqual([]);

    const oversizedRoots = Array.from({ length: 16 }, (_, index) => `F:\\${index}-${"界".repeat(1_900)}`);
    const byteBounded = createService({ runner, roots: oversizedRoots });
    await expect(byteBounded.service.resolve(request({ verificationId: "oversized-roots" }))).rejects.toThrow(
      /bytes exceed/u,
    );
    expect(runner.calls).toEqual([]);
  });

  it("keeps inspection and lists workspace-scoped", async () => {
    const { service } = createService({});
    const snapshot = await service.resolve(request());
    await expect(service.inspect("workspace-1", snapshot.snapshotId)).resolves.toEqual(snapshot);
    await expect(service.list("workspace-1", 10)).resolves.toEqual([snapshot]);
    await expect(service.inspect("workspace-2", snapshot.snapshotId)).rejects.toThrow(
      /outside the requested workspace/u,
    );
  });
});

function key(input: string): string {
  return WIN.normalize(input).toLocaleLowerCase("en-US");
}

function enoent(): Error & { code: string } {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}
