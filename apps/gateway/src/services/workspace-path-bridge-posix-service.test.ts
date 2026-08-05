import { posix as POSIX } from "node:path";
import {
  canonicalJsonString,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import { WorkspacePathBridgeUnsupportedFlavorError } from "./workspace-path-bridge-errors.js";
import { WorkspacePathBridgePosixService } from "./workspace-path-bridge-posix-service.js";

const ROOT = "/srv/work space";
const PROJECT = `${ROOT}/project`;
const GIT_DIR = `${PROJECT}/.git`;

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

/**
 * A POSIX filesystem the service can be pointed at from any host, so the POSIX
 * branch is exercised on Windows developer machines as well as Linux CI.
 */
class VirtualPosixFs {
  private readonly realpaths = new Map<string, string>();
  private readonly entries = new Map<string, "directory" | "file" | "symlink">();

  public directory(input: string, canonical = input): this {
    this.realpaths.set(POSIX.normalize(input), POSIX.normalize(canonical));
    this.entries.set(POSIX.normalize(input), "directory");
    this.entries.set(POSIX.normalize(canonical), "directory");
    return this;
  }

  public file(input: string): this {
    this.entries.set(POSIX.normalize(input), "file");
    return this;
  }

  public symlink(input: string, canonical: string): this {
    this.realpaths.set(POSIX.normalize(input), POSIX.normalize(canonical));
    this.entries.set(POSIX.normalize(input), "symlink");
    this.entries.set(POSIX.normalize(canonical), "directory");
    return this;
  }

  public realpath = async (input: string): Promise<string> => {
    const value = this.realpaths.get(POSIX.normalize(input));
    if (!value) throw enoent();
    return value;
  };

  public stat = async (input: string): Promise<{ isDirectory(): boolean }> => {
    const entry = this.entries.get(POSIX.normalize(input));
    if (!entry) throw enoent();
    return { isDirectory: () => entry === "directory" };
  };

  public lstat = async (input: string): Promise<{ isSymbolicLink(): boolean }> => {
    const entry = this.entries.get(POSIX.normalize(input));
    if (!entry) throw enoent();
    return { isSymbolicLink: () => entry === "symlink" };
  };
}

function enoent(): NodeJS.ErrnoException {
  const error = new Error("ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

/** Ancestors must exist and be symlink-free for canonicalization to succeed. */
function createFs(): VirtualPosixFs {
  return new VirtualPosixFs().directory("/srv").directory(ROOT).directory(PROJECT);
}

function request(overrides: Partial<WorkspacePathBridgeResolveRequest> = {}): WorkspacePathBridgeResolveRequest {
  return {
    verificationId: "bridge-1",
    workspaceId: "workspace-1",
    inputPath: PROJECT,
    inputFlavor: "posix",
    targetFlavor: "posix",
    requireGitIdentity: false,
    ...overrides,
  };
}

function gitRunner(handler?: (args: readonly string[]) => { stdout: string }) {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    if (handler) return handler(args);
    if (args.includes("--show-toplevel")) return { stdout: `${PROJECT}\n` };
    if (args.includes("--git-common-dir")) return { stdout: `${GIT_DIR}\n` };
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
  return { calls, run };
}

function createService(input: {
  fs?: VirtualPosixFs;
  repository?: MemoryRepository;
  roots?: readonly string[];
  runGit?: (args: readonly string[]) => Promise<{ stdout: string }> | { stdout: string };
}) {
  const fs = input.fs ?? createFs();
  const repository = input.repository ?? new MemoryRepository();
  const service = new WorkspacePathBridgePosixService({
    repository,
    allowedRootsForWorkspace: () => input.roots ?? [ROOT],
    realpath: fs.realpath,
    stat: fs.stat,
    lstat: fs.lstat,
    runGit: async (args) => (input.runGit ? input.runGit(args) : { stdout: "" }),
    now: () => new Date("2026-07-25T00:00:00.000Z"),
  });
  return { service, repository, fs };
}

describe("WorkspacePathBridgePosixService", () => {
  it("verifies a canonical POSIX root and records an identity round trip", async () => {
    const { service } = createService({});

    const snapshot = await service.resolve(request());

    expect(snapshot).toMatchObject({
      snapshotId: "bridge-1",
      workspaceId: "workspace-1",
      inputFlavor: "posix",
      targetFlavor: "posix",
      status: "verified",
      callable: true,
      canonicalHostPath: PROJECT,
      canonicalTargetPath: PROJECT,
    });
    // The identity conversion must still be *recorded* as a real round trip.
    expect(snapshot.roundTrip.attempted).toBe(true);
    expect(snapshot.roundTrip.equal).toBe(true);
    expect(snapshot.roundTrip.converter).toBe("native");
    expect(snapshot.roundTrip.inputHostPathSha256).toBe(snapshot.roundTrip.roundTripHostPathSha256);
    expect(snapshot.distro).toBeUndefined();
  });

  it("blocks a path outside the allowed roots", async () => {
    const fs = createFs().directory("/srv/elsewhere");
    const { service } = createService({ fs });

    const snapshot = await service.resolve(request({ inputPath: "/srv/elsewhere" }));

    expect(snapshot).toMatchObject({ status: "blocked", callable: false, reasonCode: "outside_jail" });
  });

  it("blocks a symlinked component that resolves back inside the jail", async () => {
    const fs = createFs().symlink(`${ROOT}/linked`, PROJECT);
    const { service } = createService({ fs });

    const snapshot = await service.resolve(request({ inputPath: `${ROOT}/linked` }));

    expect(snapshot).toMatchObject({ status: "blocked", callable: false, reasonCode: "symlink_escape" });
  });

  it("blocks a canonicalization that escapes the jail", async () => {
    const fs = createFs().directory(`${ROOT}/escape`, "/srv/outside");
    fs.directory("/srv/outside");
    const { service } = createService({ fs });

    const snapshot = await service.resolve(request({ inputPath: `${ROOT}/escape` }));

    expect(snapshot.status).toBe("blocked");
    expect(snapshot.callable).toBe(false);
  });

  it.each([
    ["a relative path", "project"],
    ["a traversal segment", `${ROOT}/../project`],
    ["a Windows path", "C:\\Work\\project"],
    ["a backslash", `${ROOT}/pro\\ject`],
    ["the filesystem root", "/"],
    ["a UNC-style prefix", "//server/share"],
  ])("blocks %s as an invalid path", async (_label, inputPath) => {
    const { service } = createService({});

    const snapshot = await service.resolve(request({ inputPath }));

    expect(snapshot).toMatchObject({ status: "blocked", callable: false, reasonCode: "invalid_path" });
  });

  it("verifies Git identity and binds it to the canonical top level", async () => {
    const fs = createFs().directory(GIT_DIR);
    const runner = gitRunner();
    const { service } = createService({ fs, runGit: runner.run });

    const snapshot = await service.resolve(request({ requireGitIdentity: true }));

    expect(snapshot.status).toBe("verified");
    expect(snapshot.gitIdentity).toMatchObject({
      status: "verified",
      topLevelPath: PROJECT,
      commonDirPath: GIT_DIR,
    });
    expect(snapshot.gitIdentity.identitySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("blocks when a required Git identity is absent", async () => {
    const { service } = createService({});

    const snapshot = await service.resolve(request({ requireGitIdentity: true }));

    expect(snapshot).toMatchObject({
      status: "blocked",
      callable: false,
      reasonCode: "git_not_repository",
    });
  });

  it("blocks when the expected Git identity does not match", async () => {
    const fs = createFs().directory(GIT_DIR);
    const runner = gitRunner();
    const { service } = createService({ fs, runGit: runner.run });
    const verified = await service.resolve(request({ requireGitIdentity: true }));

    const drifted = await service.resolve(
      request({
        verificationId: "bridge-2",
        requireGitIdentity: true,
        expectedGitIdentitySha256: `${"0".repeat(63)}1`,
      }),
    );

    expect(verified.status).toBe("verified");
    expect(drifted).toMatchObject({
      status: "blocked",
      callable: false,
      reasonCode: "git_identity_mismatch",
    });
  });

  it("refuses a .git marker that is a symlink", async () => {
    const fs = createFs().symlink(GIT_DIR, "/srv/outside/.git");
    const { service } = createService({ fs, runGit: gitRunner().run });

    const snapshot = await service.resolve(request({ requireGitIdentity: true }));

    expect(snapshot).toMatchObject({ status: "blocked", callable: false });
    expect(snapshot.gitIdentity.status).not.toBe("verified");
  });

  it("returns the identical sealed record for a replayed verification id", async () => {
    const { service, repository } = createService({});

    const first = await service.resolve(request());
    const second = await service.resolve(request());

    expect(canonicalJsonString(second)).toBe(canonicalJsonString(first));
    expect(repository.records.size).toBe(1);
  });

  it("fails closed when replayed evidence no longer matches the filesystem", async () => {
    const fs = createFs();
    const { service } = createService({ fs });
    await service.resolve(request());

    // The same verification id now describes a different canonical path.
    fs.directory(PROJECT, `${ROOT}/moved`);
    fs.directory(`${ROOT}/moved`);

    await expect(service.resolve(request())).rejects.toThrow(/conflicts with current filesystem evidence/u);
  });

  it("rejects a Windows flavor with a typed error rather than an opaque failure", async () => {
    const { service } = createService({});

    await expect(service.resolve(request({ inputFlavor: "windows_native" }))).rejects.toBeInstanceOf(
      WorkspacePathBridgeUnsupportedFlavorError,
    );
    await expect(service.resolve(request({ targetFlavor: "msys" }))).rejects.toBeInstanceOf(
      WorkspacePathBridgeUnsupportedFlavorError,
    );
  });

  it("rejects a distro, which has no meaning on a POSIX host", async () => {
    const { service } = createService({});

    await expect(service.resolve(request({ distro: "Ubuntu" }))).rejects.toThrow(/distro is invalid/u);
  });

  it("scopes inspect and list to the owning workspace", async () => {
    const { service } = createService({});
    await service.resolve(request());

    expect((await service.inspect("workspace-1", "bridge-1")).snapshotId).toBe("bridge-1");
    expect(await service.list("workspace-1")).toHaveLength(1);
    expect(await service.list("workspace-2")).toHaveLength(0);
    await expect(service.inspect("workspace-2", "bridge-1")).rejects.toThrow(/outside the requested workspace/u);
  });

  it("refuses to resolve without configured allowed roots", async () => {
    const { service } = createService({ roots: [] });

    await expect(service.resolve(request())).rejects.toThrow(/no configured allowed roots/u);
  });
});
