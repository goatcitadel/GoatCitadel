import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ToolInvokeRequest,
  WorkspacePathBridgeResolveRequest,
  WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import {
  WorkspacePathBridgeExecutionResolver,
  detectServerOwnedPathFlavor,
  type WorkspacePathBridgeResolveService,
  type WorkspacePathBridgeSessionBinding,
} from "./workspace-path-bridge-integration.js";

const tempRoots: string[] = [];
const EXPECTED_GIT_IDENTITY = "a".repeat(64);

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("WorkspacePathBridgeExecutionResolver", () => {
  it("derives project, write-jail, flavor, distro, and Git authority only from server bindings", async () => {
    const fixture = await createFixture();
    const service = createService((request) => snapshot(request, fixture.projectRoot, EXPECTED_GIT_IDENTITY));
    const resolver = createResolver(fixture, service, {
      workspaceId: "workspace-1",
      project: projectBinding(),
      gitIdentity: { expectedIdentitySha256: EXPECTED_GIT_IDENTITY },
    });
    const request = toolRequest(".");
    request.args.inputFlavor = "wsl";
    request.args.distro = "Attacker-Distro";
    request.args.allowedRoots = ["C:\\"];
    request.args.requireGitIdentity = false;
    const attackerSignal = new AbortController().signal;
    const trustedSignal = new AbortController().signal;
    request.signal = attackerSignal;

    const decision = await resolver.resolve(request, {
      invocationId: "invoke-1",
      phase: "policy",
      signal: trustedSignal,
    });

    expect(decision).toMatchObject({
      status: "verified",
      snapshotId: "invoke-1:policy",
      canonicalCwd: fixture.projectRoot,
      snapshotFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      gitIdentitySha256: EXPECTED_GIT_IDENTITY,
    });
    expect(service.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationId: "invoke-1:policy",
        workspaceId: "workspace-1",
        inputPath: fixture.projectRoot,
        inputFlavor: "windows_native",
        targetFlavor: "windows_native",
        requireGitIdentity: true,
        expectedGitIdentitySha256: EXPECTED_GIT_IDENTITY,
      }),
      expect.objectContaining({ allowedRoots: [fixture.projectRoot], signal: trustedSignal }),
    );
    expect(service.resolve.mock.calls[0]?.[1]?.signal).not.toBe(attackerSignal);
  });

  it("uses trusted runtime provenance for MSYS and WSL while blocking ambiguous POSIX paths", async () => {
    const fixture = await createFixture();
    const service = createService((request) => snapshot(request, fixture.projectRoot));
    const msys = createResolver(fixture, service, {
      workspaceId: "workspace-1",
      pathSource: { flavor: "msys" },
    });
    const wsl = createResolver(fixture, service, {
      workspaceId: "workspace-1",
      pathSource: { flavor: "wsl", distro: "Ubuntu-24.04" },
    });
    const ambiguous = createResolver(fixture, service, { workspaceId: "workspace-1" });

    await expect(msys.resolve(toolRequest("/f/Work Space\\Project"), executionContext("msys"))).resolves.toMatchObject({
      status: "verified",
    });
    expect(service.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputPath: "/f/Work Space\\Project", inputFlavor: "msys" }),
      expect.any(Object),
    );
    await expect(
      wsl.resolve(toolRequest("/custom/f/Work Space/Project"), executionContext("wsl")),
    ).resolves.toMatchObject({
      status: "verified",
    });
    expect(service.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        inputPath: "/custom/f/Work Space/Project",
        inputFlavor: "wsl",
        distro: "Ubuntu-24.04",
      }),
      expect.any(Object),
    );
    const callCount = service.resolve.mock.calls.length;
    await expect(
      ambiguous.resolve(toolRequest("/f/Work Space/Project"), executionContext("ambiguous")),
    ).resolves.toEqual({ status: "blocked", reasonCode: "invalid_path" });
    expect(service.resolve).toHaveBeenCalledTimes(callCount);
  });

  it.each([
    "F:drive-relative",
    "F:\\Work Space\\Project:stream",
    "\\\\?\\F:\\Work Space\\Project",
    "\\\\server\\share\\Project",
    "F:\\Work Space\\..\\Other",
    "F:\\Work Space\\Project\u0000suffix",
  ])("preserves unsafe absolute-like input %j for service rejection", async (cwd) => {
    const fixture = await createFixture();
    const service = createService((request) => snapshot(request, undefined, undefined, "invalid_path"));
    const resolver = createResolver(fixture, service, { workspaceId: "workspace-1" });

    await expect(resolver.resolve(toolRequest(cwd), executionContext("unsafe"))).resolves.toMatchObject({
      status: "blocked",
      reasonCode: "invalid_path",
    });
    expect(service.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ inputPath: cwd }),
      expect.objectContaining({ allowedRoots: [fixture.workspaceRoot] }),
    );
  });

  it("fails closed on workspace/project mismatch, archived or absolute projects, and missing write-jail intersection", async () => {
    const fixture = await createFixture();
    const service = createService((request) => snapshot(request, fixture.projectRoot));
    const cases: Array<{ binding: WorkspacePathBridgeSessionBinding; request?: ToolInvokeRequest; roots?: string[] }> =
      [
        { binding: { workspaceId: "workspace-1" }, request: { ...toolRequest("."), workspaceId: "workspace-2" } },
        {
          binding: {
            workspaceId: "workspace-1",
            project: { ...projectBinding(), workspaceId: "workspace-2" },
          },
        },
        {
          binding: {
            workspaceId: "workspace-1",
            project: { ...projectBinding(), lifecycleStatus: "archived" },
          },
        },
        {
          binding: {
            workspaceId: "workspace-1",
            project: { ...projectBinding(), revision: 0 },
          },
        },
        {
          binding: {
            workspaceId: "workspace-1",
            project: { ...projectBinding(), workspacePath: "C:/foreign" },
          },
        },
        { binding: { workspaceId: "workspace-1" }, roots: [fixture.outsideRoot] },
      ];

    for (const [index, item] of cases.entries()) {
      const resolver = createResolver(fixture, service, item.binding, item.roots);
      await expect(
        resolver.resolve(item.request ?? toolRequest("."), executionContext(`scope-${index}`)),
      ).resolves.toEqual({ status: "blocked", reasonCode: "outside_jail" });
    }
    expect(service.resolve).not.toHaveBeenCalled();
  });

  it("uses only the narrow project/write-jail intersection and rejects authority returned outside it", async () => {
    const fixture = await createFixture();
    const nestedWriteRoot = path.join(fixture.projectRoot, "safe");
    await fs.mkdir(nestedWriteRoot);
    const service = createService((request) => snapshot(request, fixture.workspaceRoot));
    const resolver = createResolver(
      fixture,
      service,
      {
        workspaceId: "workspace-1",
        project: projectBinding(),
        gitIdentity: { expectedIdentitySha256: EXPECTED_GIT_IDENTITY },
      },
      [nestedWriteRoot],
    );

    await expect(resolver.resolve(toolRequest("safe"), executionContext("narrow"))).resolves.toEqual({
      status: "blocked",
      reasonCode: "canonicalization_failed",
    });
    expect(service.resolve).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ allowedRoots: [nestedWriteRoot] }),
    );
  });

  it("resolves trusted relative write-jail roots against rootDir before canonicalization", async () => {
    const fixture = await createFixture();
    const service = createService((request) => snapshot(request, fixture.projectRoot, EXPECTED_GIT_IDENTITY));
    const relativeProjectRoot = path.relative(fixture.rootDir, fixture.projectRoot);
    const resolver = createResolver(
      fixture,
      service,
      {
        workspaceId: "workspace-1",
        project: projectBinding(),
        gitIdentity: { expectedIdentitySha256: EXPECTED_GIT_IDENTITY },
      },
      [relativeProjectRoot],
    );

    await expect(resolver.resolve(toolRequest("."), executionContext("relative-jail"))).resolves.toMatchObject({
      status: "verified",
      canonicalCwd: fixture.projectRoot,
    });
    expect(service.resolve).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ allowedRoots: [fixture.projectRoot] }),
    );
  });

  it("requires a server-derived project Git identity and blocks a nested foreign repository swap", async () => {
    const fixture = await createFixture();
    const service = createService((request) => snapshot(request, fixture.projectRoot, EXPECTED_GIT_IDENTITY));
    const missingIdentity = createResolver(fixture, service, {
      workspaceId: "workspace-1",
      project: projectBinding(),
    });

    await expect(missingIdentity.resolve(toolRequest("."), executionContext("missing-identity"))).resolves.toEqual({
      status: "blocked",
      reasonCode: "git_identity_mismatch",
    });
    expect(service.resolve).not.toHaveBeenCalled();

    const foreignRoot = path.join(fixture.projectRoot, "nested-foreign-repo");
    await fs.mkdir(foreignRoot);
    const foreignIdentity = "b".repeat(64);
    const swappedService = createService((request) => ({
      ...snapshot(request, foreignRoot, foreignIdentity),
      gitIdentity: {
        status: "verified",
        topLevelPath: foreignRoot,
        commonDirPath: path.join(foreignRoot, ".git"),
        identitySha256: foreignIdentity,
      },
    }));
    const expectedProject = createResolver(fixture, swappedService, {
      workspaceId: "workspace-1",
      project: projectBinding(),
      gitIdentity: { expectedIdentitySha256: EXPECTED_GIT_IDENTITY },
    });

    await expect(
      expectedProject.resolve(toolRequest("nested-foreign-repo"), executionContext("foreign-swap")),
    ).resolves.toEqual({ status: "blocked", reasonCode: "git_identity_mismatch" });
  });

  it("accepts an external Git common-dir only as matching identity evidence and blocks identity drift", async () => {
    const fixture = await createFixture();
    const commonDir = path.join(fixture.outsideRoot, ".git");
    const service = createService((request) => ({
      ...snapshot(request, fixture.projectRoot, EXPECTED_GIT_IDENTITY),
      gitIdentity: {
        status: "verified",
        topLevelPath: fixture.projectRoot,
        commonDirPath: commonDir,
        identitySha256: EXPECTED_GIT_IDENTITY,
      },
    }));
    const resolver = createResolver(fixture, service, {
      workspaceId: "workspace-1",
      project: projectBinding(),
      gitIdentity: { expectedIdentitySha256: EXPECTED_GIT_IDENTITY },
    });

    await expect(resolver.resolve(toolRequest("."), executionContext("git-ok"))).resolves.toMatchObject({
      status: "verified",
    });

    service.resolve.mockImplementationOnce(async (request) => ({
      ...snapshot(request, fixture.projectRoot, "b".repeat(64)),
      gitIdentity: {
        status: "verified",
        topLevelPath: fixture.projectRoot,
        commonDirPath: path.join(fixture.outsideRoot, "swapped.git"),
        identitySha256: "b".repeat(64),
      },
    }));
    await expect(resolver.resolve(toolRequest("."), executionContext("git-drift"))).resolves.toEqual({
      status: "blocked",
      reasonCode: "git_identity_mismatch",
    });
  });

  it("provides distinct fresh policy and pre-execute snapshots for TOCTOU revalidation", async () => {
    const fixture = await createFixture();
    const service = createService((request) =>
      request.verificationId.endsWith(":policy")
        ? snapshot(request, fixture.workspaceRoot)
        : snapshot(request, undefined, undefined, "symlink_escape"),
    );
    const resolver = createResolver(fixture, service, { workspaceId: "workspace-1" });
    const request = toolRequest(".");

    await expect(resolver.resolve(request, { invocationId: "invoke-toctou", phase: "policy" })).resolves.toMatchObject({
      status: "verified",
      snapshotId: "invoke-toctou:policy",
    });
    await expect(
      resolver.resolve(request, { invocationId: "invoke-toctou", phase: "pre_execute" }),
    ).resolves.toMatchObject({ status: "blocked", reasonCode: "symlink_escape" });
  });
});

describe("detectServerOwnedPathFlavor", () => {
  it("detects unambiguous Windows forms and requires trusted provenance for POSIX forms", () => {
    expect(detectServerOwnedPathFlavor("F:\\Work\\Project")).toEqual({ flavor: "windows_native" });
    expect(detectServerOwnedPathFlavor("F:/Work\\Project")).toEqual({ flavor: "windows_forward" });
    expect(detectServerOwnedPathFlavor("/f/Work/Project")).toBeUndefined();
    expect(detectServerOwnedPathFlavor("/f/Work/Project", { flavor: "msys" })).toEqual({ flavor: "msys" });
    expect(detectServerOwnedPathFlavor("/mnt/f/Work/Project", { flavor: "wsl", distro: "Ubuntu" })).toEqual({
      flavor: "wsl",
      distro: "Ubuntu",
    });
  });
});

interface Fixture {
  rootDir: string;
  workspaceRoot: string;
  projectRoot: string;
  outsideRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goat-path-bridge-integration-"));
  tempRoots.push(rootDir);
  const workspaceRoot = path.join(rootDir, "workspace");
  const projectRoot = path.join(workspaceRoot, "project");
  const outsideRoot = path.join(rootDir, "outside");
  await Promise.all([fs.mkdir(projectRoot, { recursive: true }), fs.mkdir(outsideRoot, { recursive: true })]);
  return {
    rootDir: await fs.realpath(rootDir),
    workspaceRoot: await fs.realpath(workspaceRoot),
    projectRoot: await fs.realpath(projectRoot),
    outsideRoot: await fs.realpath(outsideRoot),
  };
}

function createResolver(
  fixture: Fixture,
  service: ReturnType<typeof createService>,
  binding: WorkspacePathBridgeSessionBinding,
  writeJailRoots = [fixture.workspaceRoot],
): WorkspacePathBridgeExecutionResolver {
  return new WorkspacePathBridgeExecutionResolver({
    service,
    rootDir: fixture.rootDir,
    workspaceDir: "workspace",
    writeJailRoots,
    resolveSessionBinding: () => binding,
  });
}

function createService(
  handler: (
    request: WorkspacePathBridgeResolveRequest,
    options?: { signal?: AbortSignal; allowedRoots?: readonly string[] },
  ) => WorkspacePathBridgeSnapshotRecord,
) {
  return {
    resolve: vi.fn(async (request, options) => handler(request, options)),
  } satisfies WorkspacePathBridgeResolveService & { resolve: ReturnType<typeof vi.fn> };
}

function toolRequest(cwd: string): ToolInvokeRequest {
  return {
    toolName: "shell.exec",
    args: { command: "git status --short", cwd },
    agentId: "agent-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
  };
}

function executionContext(suffix: string) {
  return { invocationId: `invoke-${suffix}`, phase: "policy" as const };
}

function projectBinding() {
  return {
    projectId: "project-1",
    revision: 7,
    workspaceId: "workspace-1",
    workspacePath: "project",
    lifecycleStatus: "active" as const,
  };
}

function snapshot(
  request: WorkspacePathBridgeResolveRequest,
  canonicalHostPath?: string,
  identitySha256?: string,
  reasonCode?: "invalid_path" | "symlink_escape",
): WorkspacePathBridgeSnapshotRecord {
  const verified = canonicalHostPath !== undefined && reasonCode === undefined;
  return {
    schemaVersion: "goatcitadel.workspace-path-bridge-snapshot.v1",
    snapshotId: request.verificationId,
    requestHash: "1".repeat(64),
    workspaceId: request.workspaceId,
    inputFlavor: request.inputFlavor,
    targetFlavor: request.targetFlavor,
    gitIdentityRequired: request.requireGitIdentity,
    inputPathHash: "2".repeat(64),
    allowedRootsHash: "3".repeat(64),
    canonicalHostPath,
    canonicalTargetPath: canonicalHostPath,
    distro: request.distro,
    roundTrip: {
      attempted: verified,
      converter: request.inputFlavor === "wsl" ? "wslpath" : "native",
      equal: verified,
    },
    gitIdentity: request.requireGitIdentity
      ? {
          status: verified ? "verified" : "failed",
          ...(verified
            ? {
                topLevelPath: canonicalHostPath,
                commonDirPath: `${canonicalHostPath}\\.git`,
                identitySha256: identitySha256 ?? EXPECTED_GIT_IDENTITY,
              }
            : {}),
        }
      : { status: "not_repository" },
    status: verified ? "verified" : "blocked",
    reasonCode,
    callable: verified,
    snapshotSha256: "4".repeat(64),
    createdAt: "2026-07-13T00:00:00.000Z",
  };
}
