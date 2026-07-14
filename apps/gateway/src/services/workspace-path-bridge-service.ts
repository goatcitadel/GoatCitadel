import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH,
  WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
  canonicalJsonString,
  type WorkspacePathBridgeGitIdentityEvidence,
  type WorkspacePathBridgeReasonCode,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeRoundTripEvidence,
  type WorkspacePathBridgeSnapshotRecord,
  type WorkspacePathFlavor,
} from "@goatcitadel/contracts";
import { sealWorkspacePathBridgeSnapshot, type WorkspacePathBridgeSnapshotRepository } from "@goatcitadel/storage";

const execFileAsync = promisify(execFile);
const WIN = path.win32;
const SHA256 = /^[a-f0-9]{64}$/u;
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WINDOWS_FORBIDDEN = /[<>"|?*]/u;
const RESERVED_WIN32 = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 5_000;
const MAX_ALLOWED_ROOTS = 16;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}
const MAX_ALLOWED_ROOT_BYTES = 32 * 1024;

export type WorkspacePathBridgeExecutable = "git" | "wsl.exe";

export interface WorkspacePathBridgeProcessResult {
  stdout: string;
}

export interface WorkspacePathBridgeProcessRunner {
  run(
    executable: WorkspacePathBridgeExecutable,
    args: readonly string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ): Promise<WorkspacePathBridgeProcessResult>;
}

export class WorkspacePathBridgeExecutableUnavailableError extends Error {
  public constructor(public readonly executable: WorkspacePathBridgeExecutable) {
    super(`${executable} is unavailable.`);
    this.name = "WorkspacePathBridgeExecutableUnavailableError";
  }
}

export class NodeWorkspacePathBridgeProcessRunner implements WorkspacePathBridgeProcessRunner {
  public async run(
    executable: WorkspacePathBridgeExecutable,
    args: readonly string[],
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<WorkspacePathBridgeProcessResult> {
    if (executable !== "git" && executable !== "wsl.exe") {
      throw new Error("Unsupported workspace path bridge executable.");
    }
    try {
      const result = await execFileAsync(executable, [...args], {
        cwd: options.cwd,
        signal: options.signal,
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
        encoding: "utf8",
      });
      const stdout = result.stdout;
      if (Buffer.byteLength(stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
        throw new Error("Workspace path bridge subprocess output exceeded its bound.");
      }
      return { stdout };
    } catch (error) {
      if (isExecutableMissing(error)) {
        throw new WorkspacePathBridgeExecutableUnavailableError(executable);
      }
      throw error;
    }
  }
}

export interface WorkspacePathBridgeServiceOptions {
  repository: Pick<WorkspacePathBridgeSnapshotRepository, "create" | "find" | "get" | "listByWorkspace">;
  allowedRootsForWorkspace: (workspaceId: string) => readonly string[] | Promise<readonly string[]>;
  runner?: WorkspacePathBridgeProcessRunner;
  realpath?: (input: string) => Promise<string>;
  stat?: (input: string) => Promise<{ isDirectory(): boolean }>;
  lstat?: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  now?: () => Date;
}

interface CanonicalRoot {
  configuredPath: string;
  canonicalPath: string;
}

interface BridgeProgress {
  canonicalHostPath?: string;
  canonicalTargetPath?: string;
  roundTrip: WorkspacePathBridgeRoundTripEvidence;
  gitIdentity: WorkspacePathBridgeGitIdentityEvidence;
}

class BridgeFailure extends Error {
  public constructor(
    public readonly reasonCode: WorkspacePathBridgeReasonCode,
    public readonly availability: "blocked" | "unavailable" = "blocked",
  ) {
    super(`Workspace path bridge verification failed: ${reasonCode}.`);
    this.name = "BridgeFailure";
  }
}

export class WorkspacePathBridgeService {
  private readonly repository: WorkspacePathBridgeServiceOptions["repository"];
  private readonly allowedRootsForWorkspace: WorkspacePathBridgeServiceOptions["allowedRootsForWorkspace"];
  private readonly runner: WorkspacePathBridgeProcessRunner;
  private readonly realpath: (input: string) => Promise<string>;
  private readonly stat: (input: string) => Promise<{ isDirectory(): boolean }>;
  private readonly lstat: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  private readonly now: () => Date;

  public constructor(options: WorkspacePathBridgeServiceOptions) {
    this.repository = options.repository;
    this.allowedRootsForWorkspace = options.allowedRootsForWorkspace;
    this.runner = options.runner ?? new NodeWorkspacePathBridgeProcessRunner();
    this.realpath = options.realpath ?? fs.realpath;
    this.stat = options.stat ?? fs.stat;
    this.lstat = options.lstat ?? fs.lstat;
    this.now = options.now ?? (() => new Date());
  }

  public async resolve(
    request: WorkspacePathBridgeResolveRequest,
    options: { signal?: AbortSignal; allowedRoots?: readonly string[] } = {},
  ): Promise<WorkspacePathBridgeSnapshotRecord> {
    validateRequestEnvelope(request);
    throwIfAborted(options.signal);
    const configuredRoots = [...(options.allowedRoots ?? (await this.allowedRootsForWorkspace(request.workspaceId)))];
    const normalizedConfiguredRoots = normalizeConfiguredRoots(configuredRoots);
    if (normalizedConfiguredRoots.length === 0) {
      throw new Error("Workspace path bridge has no configured allowed roots.");
    }
    const inputPathHash = digestText(request.inputPath);
    const progress: BridgeProgress = {
      roundTrip: {
        attempted: false,
        converter: request.inputFlavor === "wsl" || request.targetFlavor === "wsl" ? "wslpath" : "native",
        equal: false,
      },
      gitIdentity: { status: "failed" },
    };

    const roots = await this.canonicalizeRoots(normalizedConfiguredRoots);
    const allowedRootsHash = digest(roots.map((root) => normalizeForIdentity(root.canonicalPath)).sort());
    const requestHash = digest({
      workspaceId: request.workspaceId,
      inputPathHash,
      inputFlavor: request.inputFlavor,
      targetFlavor: request.targetFlavor,
      requireGitIdentity: request.requireGitIdentity,
      distro: request.distro ?? null,
      expectedGitIdentitySha256: request.expectedGitIdentitySha256 ?? null,
      allowedRootsHash,
    });

    try {
      const syntacticHostPath = await this.toHostPath(request, options.signal);
      const rawInsideRoot = normalizedConfiguredRoots.some((root) => isInside(root, syntacticHostPath));
      if (!rawInsideRoot) {
        throw new BridgeFailure("outside_jail");
      }
      const canonicalHostPath = await this.canonicalizeExactDirectory(syntacticHostPath);
      progress.canonicalHostPath = canonicalHostPath;
      progress.roundTrip.inputHostPathSha256 = digestText(normalizeForIdentity(canonicalHostPath));
      if (!roots.some((root) => isInside(root.canonicalPath, canonicalHostPath))) {
        throw new BridgeFailure("symlink_escape");
      }

      const canonicalTargetPath = await this.fromHostPath(
        canonicalHostPath,
        request.targetFlavor,
        request.distro,
        options.signal,
      );
      progress.canonicalTargetPath = canonicalTargetPath;
      progress.roundTrip.targetPathSha256 = digestText(
        normalizeTargetIdentity(canonicalTargetPath, request.targetFlavor),
      );
      progress.roundTrip.attempted = true;

      const roundTripHostCandidate = await this.targetToHostPath(
        canonicalTargetPath,
        request.targetFlavor,
        request.distro,
        options.signal,
      );
      if (!normalizedConfiguredRoots.some((root) => isInside(root, roundTripHostCandidate))) {
        throw new BridgeFailure("round_trip_mismatch");
      }
      const roundTripCanonicalHost = await this.canonicalizeExactDirectory(roundTripHostCandidate);
      progress.roundTrip.roundTripHostPathSha256 = digestText(normalizeForIdentity(roundTripCanonicalHost));
      progress.roundTrip.equal = samePath(canonicalHostPath, roundTripCanonicalHost);
      if (!progress.roundTrip.equal) {
        throw new BridgeFailure("round_trip_mismatch");
      }
      if (!roots.some((root) => isInside(root.canonicalPath, roundTripCanonicalHost))) {
        throw new BridgeFailure("symlink_escape");
      }

      progress.gitIdentity = await this.inspectGitIdentity(canonicalHostPath, roots, options.signal);
      if (
        request.expectedGitIdentitySha256 &&
        progress.gitIdentity.identitySha256 !== request.expectedGitIdentitySha256
      ) {
        progress.gitIdentity = { ...progress.gitIdentity, status: "mismatch" };
        throw new BridgeFailure("git_identity_mismatch");
      }
      if (request.requireGitIdentity && progress.gitIdentity.status !== "verified") {
        throw gitFailureFor(progress.gitIdentity.status);
      }
      throwIfAborted(options.signal);

      return this.persist({
        request,
        requestHash,
        inputPathHash,
        allowedRootsHash,
        progress,
        status: "verified",
      });
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure) {
        throw error;
      }
      return this.persist({
        request,
        requestHash,
        inputPathHash,
        allowedRootsHash,
        progress,
        status: failure.availability,
        reasonCode: failure.reasonCode,
      });
    }
  }

  public inspect(workspaceId: string, snapshotId: string): WorkspacePathBridgeSnapshotRecord {
    validateIdentifier(workspaceId, "workspaceId", 256);
    validateIdentifier(snapshotId, "snapshotId", 256);
    const snapshot = this.repository.get(snapshotId);
    if (snapshot.workspaceId !== workspaceId) {
      throw new Error("Workspace path bridge snapshot is outside the requested workspace.");
    }
    return snapshot;
  }

  public list(workspaceId: string, limit = 50): WorkspacePathBridgeSnapshotRecord[] {
    validateIdentifier(workspaceId, "workspaceId", 256);
    return this.repository.listByWorkspace(workspaceId, limit);
  }

  private persist(input: {
    request: WorkspacePathBridgeResolveRequest;
    requestHash: string;
    inputPathHash: string;
    allowedRootsHash: string;
    progress: BridgeProgress;
    status: "verified" | "blocked" | "unavailable";
    reasonCode?: WorkspacePathBridgeReasonCode;
  }): WorkspacePathBridgeSnapshotRecord {
    const existing = this.repository.find(input.request.verificationId);
    const snapshot = sealWorkspacePathBridgeSnapshot({
      schemaVersion: WORKSPACE_PATH_BRIDGE_SNAPSHOT_VERSION,
      snapshotId: input.request.verificationId,
      requestHash: input.requestHash,
      workspaceId: input.request.workspaceId,
      inputFlavor: input.request.inputFlavor,
      targetFlavor: input.request.targetFlavor,
      gitIdentityRequired: input.request.requireGitIdentity,
      inputPathHash: input.inputPathHash,
      allowedRootsHash: input.allowedRootsHash,
      canonicalHostPath: input.progress.canonicalHostPath,
      canonicalTargetPath: input.progress.canonicalTargetPath,
      distro: input.request.distro,
      roundTrip: input.progress.roundTrip,
      gitIdentity: input.progress.gitIdentity,
      status: input.status,
      reasonCode: input.reasonCode,
      callable: input.status === "verified",
      createdAt: existing?.createdAt ?? this.now().toISOString(),
    });
    if (existing) {
      if (canonicalJsonString(existing) !== canonicalJsonString(snapshot)) {
        throw new Error(
          `Workspace path bridge verification ${input.request.verificationId} conflicts with current filesystem evidence.`,
        );
      }
      return existing;
    }
    return this.repository.create(snapshot);
  }

  private async canonicalizeRoots(configuredRoots: readonly string[]): Promise<CanonicalRoot[]> {
    const roots: CanonicalRoot[] = [];
    for (const configuredPath of configuredRoots) {
      let canonicalPath: string;
      try {
        await this.assertNoHostSymlinkComponents(configuredPath);
        canonicalPath = normalizeWindowsPath(await this.realpath(configuredPath));
        if (!(await this.stat(canonicalPath)).isDirectory()) {
          throw new Error("allowed root is not a directory");
        }
      } catch (error) {
        if (error instanceof BridgeFailure) throw error;
        throw new BridgeFailure("canonicalization_failed");
      }
      assertNotFileSystemRoot(canonicalPath);
      roots.push({ configuredPath, canonicalPath });
    }
    return dedupeRoots(roots);
  }

  private async canonicalizeExactDirectory(candidate: string): Promise<string> {
    try {
      const normalizedCandidate = normalizeWindowsPath(candidate);
      await this.assertNoHostSymlinkComponents(normalizedCandidate);
      const canonical = normalizeWindowsPath(await this.realpath(normalizedCandidate));
      if (!(await this.stat(canonical)).isDirectory()) {
        throw new Error("candidate is not a directory");
      }
      assertNotFileSystemRoot(canonical);
      return canonical;
    } catch (error) {
      if (error instanceof BridgeFailure) throw error;
      throw new BridgeFailure("canonicalization_failed");
    }
  }

  private async assertNoHostSymlinkComponents(candidate: string): Promise<void> {
    const normalized = normalizeWindowsPath(candidate);
    const root = WIN.parse(normalized).root;
    const relative = WIN.relative(root, normalized);
    let current = root;
    for (const component of relative.split(WIN.sep)) {
      current = WIN.join(current, component);
      try {
        if ((await this.lstat(current)).isSymbolicLink()) {
          throw new BridgeFailure("symlink_escape");
        }
      } catch (error) {
        if (error instanceof BridgeFailure) throw error;
        if (isMissingPath(error)) throw new BridgeFailure("canonicalization_failed");
        throw new BridgeFailure("canonicalization_failed");
      }
    }
  }

  private async toHostPath(request: WorkspacePathBridgeResolveRequest, signal?: AbortSignal): Promise<string> {
    if (request.inputFlavor === "wsl") {
      await this.assertWslAvailable(request.distro!, signal);
      const canonicalWsl = await this.canonicalizeWslPath(request.distro!, request.inputPath, signal);
      const converted = await this.runWslPath(request.distro!, "-w", canonicalWsl, signal);
      return parseWindowsPath(converted, "windows_forward");
    }
    return parseWindowsPath(request.inputPath, request.inputFlavor);
  }

  private async fromHostPath(
    hostPath: string,
    targetFlavor: WorkspacePathFlavor,
    distro: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (targetFlavor === "windows_native") {
      return normalizeWindowsPath(hostPath);
    }
    if (targetFlavor === "windows_forward") {
      return normalizeWindowsPath(hostPath).replaceAll("\\", "/");
    }
    if (targetFlavor === "msys") {
      return windowsToMsys(hostPath);
    }
    await this.assertWslAvailable(distro!, signal);
    const converted = await this.runWslPath(distro!, "-u", normalizeWindowsPath(hostPath), signal);
    return this.canonicalizeWslPath(distro!, converted, signal);
  }

  private async targetToHostPath(
    targetPath: string,
    targetFlavor: WorkspacePathFlavor,
    distro: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (targetFlavor !== "wsl") {
      return parseWindowsPath(targetPath, targetFlavor);
    }
    const converted = await this.runWslPath(distro!, "-w", targetPath, signal);
    return parseWindowsPath(converted, "windows_forward");
  }

  private async assertWslAvailable(distro: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.runner.run("wsl.exe", ["--distribution", distro, "--exec", "true"], { signal });
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      throw new BridgeFailure("wsl_unavailable", "unavailable");
    }
  }

  private async canonicalizeWslPath(distro: string, inputPath: string, signal?: AbortSignal): Promise<string> {
    validateWslPath(inputPath);
    try {
      const resolved = await this.runner.run(
        "wsl.exe",
        ["--distribution", distro, "--exec", "readlink", "-f", "--", inputPath],
        { signal },
      );
      const canonical = parseWslOutput(resolved.stdout);
      if (canonical !== inputPath) {
        throw new BridgeFailure("symlink_escape");
      }
      return canonical;
    } catch (error) {
      if (error instanceof BridgeFailure && error.reasonCode === "symlink_escape") throw error;
      if (isAbortError(error, signal)) throw error;
      try {
        const resolved = await this.runner.run(
          "wsl.exe",
          ["--distribution", distro, "--exec", "realpath", "-m", "--", inputPath],
          { signal },
        );
        const canonical = parseWslOutput(resolved.stdout);
        if (canonical !== inputPath) {
          throw new BridgeFailure("symlink_escape");
        }
        return canonical;
      } catch (fallbackError) {
        if (fallbackError instanceof BridgeFailure && fallbackError.reasonCode === "symlink_escape") {
          throw fallbackError;
        }
        if (isAbortError(fallbackError, signal)) throw fallbackError;
        throw new BridgeFailure("wsl_conversion_failed");
      }
    }
  }

  private async runWslPath(
    distro: string,
    mode: "-u" | "-w",
    inputPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    try {
      const result = await this.runner.run(
        "wsl.exe",
        ["--distribution", distro, "--exec", "wslpath", mode, inputPath],
        { signal },
      );
      return parseProcessPath(result.stdout);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof WorkspacePathBridgeExecutableUnavailableError) {
        throw new BridgeFailure("wsl_unavailable", "unavailable");
      }
      throw new BridgeFailure("wsl_conversion_failed");
    }
  }

  private async inspectGitIdentity(
    canonicalHostPath: string,
    roots: readonly CanonicalRoot[],
    signal?: AbortSignal,
  ): Promise<WorkspacePathBridgeGitIdentityEvidence> {
    const marker = await this.findGitMarker(canonicalHostPath, roots);
    if (marker === "absent") {
      return { status: "not_repository" };
    }
    if (marker === "failed") {
      return { status: "failed" };
    }
    let topLevelOutput: string;
    try {
      topLevelOutput = (
        await this.runner.run("git", ["-C", canonicalHostPath, "rev-parse", "--show-toplevel"], { signal })
      ).stdout;
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof WorkspacePathBridgeExecutableUnavailableError) {
        return { status: "unavailable" };
      }
      return { status: "failed" };
    }
    try {
      const topLevelCandidate = parseGitPathOutput(topLevelOutput, canonicalHostPath);
      await this.assertNoHostSymlinkComponents(topLevelCandidate);
      const topLevelPath = normalizeWindowsPath(await this.realpath(topLevelCandidate));
      if (
        !isInside(topLevelPath, canonicalHostPath) ||
        !roots.some((root) => isInside(root.canonicalPath, topLevelPath))
      ) {
        return { status: "failed" };
      }
      const commonOutput = (
        await this.runner.run("git", ["-C", canonicalHostPath, "rev-parse", "--git-common-dir"], { signal })
      ).stdout;
      const commonCandidate = parseGitPathOutput(commonOutput, canonicalHostPath);
      await this.assertNoHostSymlinkComponents(commonCandidate);
      const commonDirPath = normalizeWindowsPath(await this.realpath(commonCandidate));
      const identitySha256 = digest({
        topLevelPath: normalizeForIdentity(topLevelPath),
        commonDirPath: normalizeForIdentity(commonDirPath),
      });
      return { status: "verified", topLevelPath, commonDirPath, identitySha256 };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof WorkspacePathBridgeExecutableUnavailableError) {
        return { status: "unavailable" };
      }
      return { status: "failed" };
    }
  }

  private async findGitMarker(
    canonicalHostPath: string,
    roots: readonly CanonicalRoot[],
  ): Promise<"found" | "absent" | "failed"> {
    let probe = canonicalHostPath;
    for (let depth = 0; depth < 256; depth += 1) {
      if (!roots.some((root) => isInside(root.canonicalPath, probe))) {
        return "absent";
      }
      try {
        const markerPath = WIN.join(probe, ".git");
        if ((await this.lstat(markerPath)).isSymbolicLink()) {
          return "failed";
        }
        await this.stat(markerPath);
        return "found";
      } catch (error) {
        if (!isMissingPath(error)) {
          return "failed";
        }
      }
      const parent = WIN.dirname(probe);
      if (samePath(parent, probe)) {
        return "absent";
      }
      probe = parent;
    }
    return "failed";
  }
}

function validateRequestEnvelope(request: WorkspacePathBridgeResolveRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Workspace path bridge request is malformed.");
  }
  assertExactRequestKeys(request);
  validateIdentifier(request.verificationId, "verificationId", 256);
  validateIdentifier(request.workspaceId, "workspaceId", 256);
  if (!new Set<WorkspacePathFlavor>(["windows_native", "windows_forward", "msys", "wsl"]).has(request.inputFlavor)) {
    throw new Error("Workspace path bridge input flavor is invalid.");
  }
  if (!new Set<WorkspacePathFlavor>(["windows_native", "windows_forward", "msys", "wsl"]).has(request.targetFlavor)) {
    throw new Error("Workspace path bridge target flavor is invalid.");
  }
  if (typeof request.requireGitIdentity !== "boolean") {
    throw new Error("Workspace path bridge Git identity posture is required.");
  }
  if (typeof request.inputPath !== "string" || request.inputPath.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH) {
    throw new Error("Workspace path bridge input path is invalid.");
  }
  const requiresDistro = request.inputFlavor === "wsl" || request.targetFlavor === "wsl";
  if (
    requiresDistro !== (request.distro !== undefined) ||
    (request.distro !== undefined && !DISTRO.test(request.distro))
  ) {
    throw new Error("Workspace path bridge distro is invalid.");
  }
  if (request.expectedGitIdentitySha256 !== undefined) {
    if (!request.requireGitIdentity || !SHA256.test(request.expectedGitIdentitySha256)) {
      throw new Error("Workspace path bridge expected Git identity is invalid.");
    }
  }
}

function normalizeConfiguredRoots(roots: readonly string[]): string[] {
  if (roots.length > MAX_ALLOWED_ROOTS) {
    throw new Error("Workspace path bridge allowed-root count exceeds its bound.");
  }
  if (
    roots.some((root) => typeof root !== "string") ||
    roots.reduce((sum, root) => sum + Buffer.byteLength(root, "utf8"), 0) > MAX_ALLOWED_ROOT_BYTES
  ) {
    throw new Error("Workspace path bridge allowed-root bytes exceed their bound.");
  }
  const normalized = roots.map((root) =>
    parseWindowsPath(root, root.includes("/") ? "windows_forward" : "windows_native"),
  );
  return [...new Map(normalized.map((root) => [normalizeForIdentity(root), root])).values()];
}

function parseWindowsPath(input: string, flavor: Exclude<WorkspacePathFlavor, "wsl">): string {
  validateCommonPath(input);
  if (flavor === "windows_native" && input.includes("/")) {
    throw new BridgeFailure("invalid_path");
  }
  let windowsPath: string;
  if (flavor === "msys") {
    const normalized = input.replaceAll("\\", "/");
    if (!/^\/[A-Za-z]\//u.test(normalized) || normalized.includes("//")) {
      throw new BridgeFailure("invalid_path");
    }
    const drive = normalized[1]!.toUpperCase();
    windowsPath = `${drive}:\\${normalized.slice(3).replaceAll("/", "\\")}`;
  } else {
    windowsPath = input.replaceAll("/", "\\");
  }
  if (!/^[A-Za-z]:\\/u.test(windowsPath) || /^[A-Za-z]:[^\\]/u.test(windowsPath)) {
    throw new BridgeFailure("invalid_path");
  }
  if (windowsPath.slice(2).includes(":")) {
    throw new BridgeFailure("invalid_path");
  }
  const suffix = windowsPath.slice(3);
  if (!suffix || suffix.includes("\\\\")) {
    throw new BridgeFailure("invalid_path");
  }
  validateWindowsSegments(suffix.split("\\"));
  const normalized = WIN.normalize(`${windowsPath[0]!.toUpperCase()}${windowsPath.slice(1)}`);
  assertNotFileSystemRoot(normalized);
  return normalized;
}

function normalizeWindowsPath(input: string): string {
  return parseWindowsPath(input, input.includes("/") ? "windows_forward" : "windows_native");
}

function validateCommonPath(input: string): void {
  if (
    typeof input !== "string" ||
    !input ||
    input !== input.trim() ||
    input.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH ||
    hasControlCharacter(input) ||
    input.normalize("NFKC") !== input ||
    /^(?:\\\\|\/\/|\\[?.]\\|\/\/[?.]\/|\\\?\?\\)/u.test(input)
  ) {
    throw new BridgeFailure("invalid_path");
  }
}

function validateWindowsSegments(segments: readonly string[]): void {
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.endsWith(".") ||
      segment.endsWith(" ") ||
      WINDOWS_FORBIDDEN.test(segment) ||
      RESERVED_WIN32.test(segment)
    ) {
      throw new BridgeFailure("invalid_path");
    }
  }
}

function validateWslPath(input: string): void {
  validateCommonPath(input);
  if (!input.startsWith("/") || input.startsWith("//") || input.includes("\\") || input.includes(":")) {
    throw new BridgeFailure("invalid_path");
  }
  const segments = input.slice(1).split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new BridgeFailure("invalid_path");
  }
}

function windowsToMsys(input: string): string {
  const normalized = normalizeWindowsPath(input);
  const drive = normalized[0]!.toLowerCase();
  return `/${drive}/${normalized.slice(3).replaceAll("\\", "/")}`;
}

function parseProcessPath(stdout: string): string {
  const value = stdout.replace(/\r?\n$/u, "");
  if (
    !value ||
    value.includes("\n") ||
    value.includes("\r") ||
    Buffer.byteLength(value, "utf8") > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH
  ) {
    throw new BridgeFailure("wsl_conversion_failed");
  }
  return value;
}

function parseWslOutput(stdout: string): string {
  const value = parseProcessPath(stdout);
  validateWslPath(value);
  return value;
}

function parseGitPathOutput(stdout: string, cwd: string): string {
  const value = stdout.replace(/\r?\n$/u, "");
  if (!value || value.includes("\n") || value.includes("\r") || value.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH) {
    throw new Error("Git returned malformed path evidence.");
  }
  const candidate = /^[A-Za-z]:[\\/]/u.test(value) ? value : WIN.resolve(cwd, value);
  return normalizeWindowsPath(candidate);
}

function assertNotFileSystemRoot(input: string): void {
  const normalized = WIN.normalize(input);
  if (samePath(normalized, WIN.parse(normalized).root)) {
    throw new BridgeFailure("invalid_path");
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = WIN.relative(WIN.normalize(root), WIN.normalize(candidate));
  return relative === "" || (!relative.startsWith(`..${WIN.sep}`) && relative !== ".." && !WIN.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return normalizeForIdentity(left) === normalizeForIdentity(right);
}

function normalizeForIdentity(input: string): string {
  return WIN.normalize(input)
    .replace(/[\\/]+$/u, "")
    .toLocaleLowerCase("en-US");
}

function normalizeTargetIdentity(input: string, flavor: WorkspacePathFlavor): string {
  return flavor === "wsl" ? input : normalizeForIdentity(parseWindowsPath(input, flavor));
}

function dedupeRoots(roots: readonly CanonicalRoot[]): CanonicalRoot[] {
  return [...new Map(roots.map((root) => [normalizeForIdentity(root.canonicalPath), root])).values()];
}

function gitFailureFor(status: WorkspacePathBridgeGitIdentityEvidence["status"]): BridgeFailure {
  if (status === "unavailable") {
    return new BridgeFailure("git_unavailable", "unavailable");
  }
  if (status === "not_repository") {
    return new BridgeFailure("git_not_repository");
  }
  if (status === "mismatch") {
    return new BridgeFailure("git_identity_mismatch");
  }
  return new BridgeFailure("git_verification_failed");
}

function classifyFailure(error: unknown): BridgeFailure | undefined {
  if (error instanceof BridgeFailure) {
    return error;
  }
  return undefined;
}

function assertExactRequestKeys(request: WorkspacePathBridgeResolveRequest): void {
  const allowed = new Set([
    "verificationId",
    "workspaceId",
    "inputPath",
    "inputFlavor",
    "targetFlavor",
    "requireGitIdentity",
    "distro",
    "expectedGitIdentitySha256",
  ]);
  const required = ["verificationId", "workspaceId", "inputPath", "inputFlavor", "targetFlavor", "requireGitIdentity"];
  const actual = Object.keys(request);
  if (actual.some((key) => !allowed.has(key)) || required.some((key) => !actual.includes(key))) {
    throw new Error("Workspace path bridge request contains unsupported or missing fields.");
  }
}

function isMissingPath(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}

function isExecutableMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT",
  );
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(
    signal?.aborted ||
    (error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError"),
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("Workspace path bridge request was aborted.");
    error.name = "AbortError";
    throw error;
  }
}

function validateIdentifier(value: string, field: string, max: number): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.length > max ||
    hasControlCharacter(value)
  ) {
    throw new Error(`Workspace path bridge ${field} is invalid.`);
  }
}

function digest(value: unknown): string {
  return digestText(canonicalJsonString(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
