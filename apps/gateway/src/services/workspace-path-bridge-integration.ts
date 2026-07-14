import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { posix as POSIX, win32 as WIN } from "node:path";
import { promisify } from "node:util";
import {
  canonicalJsonString,
  type ToolInvokeRequest,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
  type WorkspacePathFlavor,
} from "@goatcitadel/contracts";
import { resolveToolRequestPaths } from "./tool-path-resolution.js";
import type {
  WorkspacePathBridgeExecutionDecision,
  WorkspacePathBridgeResolutionContext,
} from "./tool-invocation-coordinator-service.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH = "__prompt_pack_repo__";
const execFileAsync = promisify(execFile);

export type WorkspacePathBridgeHostPlatform = "windows" | "posix";

export interface PosixProjectGitBindingEvidence {
  verificationId: string;
  workspaceId: string;
  projectId: string;
  projectRevision: number;
  canonicalProjectRoot: string;
  topLevelPath: string;
  commonDirPath: string;
  identitySha256: string;
}

export interface PosixProjectGitBindingStore {
  verifyOrEstablish(evidence: PosixProjectGitBindingEvidence): Promise<boolean>;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

export interface WorkspacePathBridgeProjectBinding {
  projectId: string;
  revision: number;
  workspaceId: string;
  workspacePath: string;
  lifecycleStatus?: "active" | "archived";
}

export interface WorkspacePathBridgeSessionBinding {
  workspaceId: string;
  project?: WorkspacePathBridgeProjectBinding;
  /** Trusted runtime provenance; never populate this from model tool arguments. */
  pathSource?: { flavor: "msys" } | { flavor: "wsl"; distro: string };
  gitIdentity?: {
    required?: boolean;
    expectedIdentitySha256?: string;
  };
}

export interface WorkspacePathBridgeResolveService {
  resolve(
    request: WorkspacePathBridgeResolveRequest,
    options?: { signal?: AbortSignal; allowedRoots?: readonly string[] },
  ): Promise<WorkspacePathBridgeSnapshotRecord>;
}

export interface WorkspacePathBridgeIntegrationOptions {
  service: WorkspacePathBridgeResolveService;
  rootDir: string;
  workspaceDir: string;
  writeJailRoots: readonly string[];
  hostPlatform?: WorkspacePathBridgeHostPlatform;
  resolveSessionBinding(
    sessionId: string,
  ): WorkspacePathBridgeSessionBinding | undefined | Promise<WorkspacePathBridgeSessionBinding | undefined>;
  allowPromptPackRepoExecution?: boolean;
  realpath?: (input: string) => Promise<string>;
  stat?: (input: string) => Promise<{ isDirectory(): boolean }>;
  lstat?: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  runGit?: (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string }>;
  posixProjectGitBindingStore?: PosixProjectGitBindingStore;
}

interface ResolvedExecutionScope {
  workspaceId: string;
  workspaceRoot: string;
  projectRoot?: string;
  projectWorkspacePath?: string;
  allowedRoots: string[];
  binding: WorkspacePathBridgeSessionBinding;
}

/**
 * Server-owned adapter between a final tool request and immutable path-bridge
 * evidence. It deliberately accepts no caller-supplied roots, flavor, distro,
 * Git posture, or historical snapshot identifier.
 */
export class WorkspacePathBridgeExecutionResolver {
  private readonly realpath: (input: string) => Promise<string>;
  private readonly stat: (input: string) => Promise<{ isDirectory(): boolean }>;
  private readonly lstat: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  private readonly hostPlatform: WorkspacePathBridgeHostPlatform;
  private readonly runGit: NonNullable<WorkspacePathBridgeIntegrationOptions["runGit"]>;
  private readonly posixProjectBindings: PosixProjectGitBindingStore;

  public constructor(private readonly options: WorkspacePathBridgeIntegrationOptions) {
    this.realpath = options.realpath ?? fs.realpath;
    this.stat = options.stat ?? fs.stat;
    this.lstat = options.lstat ?? fs.lstat;
    this.hostPlatform = options.hostPlatform ?? (process.platform === "win32" ? "windows" : "posix");
    this.runGit =
      options.runGit ??
      (async (args, runOptions = {}) => {
        const result = await execFileAsync("git", [...args], {
          signal: runOptions.signal,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          shell: false,
          encoding: "utf8",
        });
        return { stdout: result.stdout };
      });
    this.posixProjectBindings = options.posixProjectGitBindingStore ?? new InMemoryPosixProjectGitBindingStore();
  }

  public readonly resolve = async (
    request: ToolInvokeRequest,
    context: WorkspacePathBridgeResolutionContext,
  ): Promise<WorkspacePathBridgeExecutionDecision> => {
    if (!isBoundedIdentifier(context.invocationId)) {
      return blocked("invalid_path");
    }
    if (this.hostPlatform === "posix") {
      return this.resolvePosixNative(request, context);
    }

    const scope = await this.resolveExecutionScope(request);
    if (!scope) {
      return blocked("outside_jail");
    }

    let finalRequest: ToolInvokeRequest;
    try {
      finalRequest = resolveToolRequestPaths(request, {
        workspaceRoot: scope.workspaceRoot,
        projectRoot: scope.projectRoot,
        projectWorkspacePath: scope.projectWorkspacePath,
      });
    } catch {
      return blocked("outside_jail");
    }

    const inputPath = finalRequest.args?.cwd;
    if (typeof inputPath !== "string") {
      return blocked("invalid_path");
    }
    const source = detectServerOwnedPathFlavor(inputPath, scope.binding.pathSource);
    if (!source) {
      return blocked("invalid_path");
    }

    const projectBound = Boolean(scope.binding.project);
    const requireGitIdentity = projectBound || scope.binding.gitIdentity?.required === true;
    const expectedGitIdentitySha256 = scope.binding.gitIdentity?.expectedIdentitySha256;
    if (
      (projectBound && (expectedGitIdentitySha256 === undefined || !SHA256.test(expectedGitIdentitySha256))) ||
      (expectedGitIdentitySha256 !== undefined && (!requireGitIdentity || !SHA256.test(expectedGitIdentitySha256)))
    ) {
      return blocked("git_identity_mismatch");
    }

    const verificationId = `${context.invocationId}:${context.phase}`;
    if (!isBoundedIdentifier(verificationId)) {
      return blocked("invalid_path");
    }
    const bridgeRequest: WorkspacePathBridgeResolveRequest = {
      verificationId,
      workspaceId: scope.workspaceId,
      inputPath,
      inputFlavor: source.flavor,
      targetFlavor: "windows_native",
      requireGitIdentity,
      ...(source.distro ? { distro: source.distro } : {}),
      ...(expectedGitIdentitySha256 ? { expectedGitIdentitySha256 } : {}),
    };

    let snapshot: WorkspacePathBridgeSnapshotRecord;
    try {
      snapshot = await this.options.service.resolve(bridgeRequest, {
        ...(context.signal ? { signal: context.signal } : {}),
        allowedRoots: scope.allowedRoots,
      });
    } catch {
      return blocked("canonicalization_failed");
    }
    if (snapshot.status !== "verified") {
      return blocked(snapshot.reasonCode ?? "canonicalization_failed", snapshot.snapshotId);
    }
    const canonicalHostPath = snapshot.canonicalHostPath;
    if (
      !snapshot.callable ||
      snapshot.snapshotId !== verificationId ||
      snapshot.workspaceId !== scope.workspaceId ||
      snapshot.inputFlavor !== source.flavor ||
      snapshot.targetFlavor !== "windows_native" ||
      snapshot.gitIdentityRequired !== requireGitIdentity ||
      !canonicalHostPath ||
      !scope.allowedRoots.some((root) => isInside(root, canonicalHostPath))
    ) {
      return blocked("canonicalization_failed");
    }
    if (expectedGitIdentitySha256 !== undefined && snapshot.gitIdentity.identitySha256 !== expectedGitIdentitySha256) {
      return blocked("git_identity_mismatch");
    }
    if (scope.projectRoot) {
      if (snapshot.gitIdentity.status !== "verified") {
        return blocked("git_identity_mismatch");
      }
      const gitTopLevelPath = snapshot.gitIdentity.topLevelPath;
      if (!gitTopLevelPath || !samePath(scope.projectRoot, gitTopLevelPath)) {
        return blocked("git_identity_mismatch");
      }
    }
    return {
      status: "verified",
      snapshotId: snapshot.snapshotId,
      canonicalCwd: canonicalHostPath,
      snapshotFingerprintSha256: fingerprintExecutionSnapshot(snapshot),
      ...(snapshot.gitIdentity.identitySha256 ? { gitIdentitySha256: snapshot.gitIdentity.identitySha256 } : {}),
    };
  };

  private async resolvePosixNative(
    request: ToolInvokeRequest,
    context: WorkspacePathBridgeResolutionContext,
  ): Promise<WorkspacePathBridgeExecutionDecision> {
    if (context.signal?.aborted) return blocked("canonicalization_failed");
    const scope = await this.resolvePosixExecutionScope(request);
    if (!scope) return blocked("outside_jail");
    const requestedCwd = resolvePosixExecutionCwd(request.args?.cwd, scope.projectRoot ?? scope.workspaceRoot);
    if (!requestedCwd) return blocked("invalid_path");
    if (!scope.allowedRoots.some((root) => isInsidePosix(root, requestedCwd))) return blocked("outside_jail");

    const canonicalCwd = await this.canonicalizePosixTrustedRoot(requestedCwd);
    if (!canonicalCwd) return blocked("canonicalization_failed");
    if (!scope.allowedRoots.some((root) => isInsidePosix(root, canonicalCwd))) return blocked("symlink_escape");

    const gitIdentity = await this.inspectPosixGitIdentity(canonicalCwd, scope.allowedRoots, context.signal);
    if (context.signal?.aborted) return blocked("canonicalization_failed");
    if (scope.projectRoot) {
      const project = scope.binding.project;
      const projectRevision = project?.revision;
      if (
        !project ||
        typeof projectRevision !== "number" ||
        !Number.isSafeInteger(projectRevision) ||
        projectRevision < 1 ||
        gitIdentity.status !== "verified" ||
        !samePosixPath(gitIdentity.topLevelPath, scope.projectRoot)
      ) {
        return blocked("git_identity_mismatch");
      }
      if (
        scope.binding.gitIdentity?.expectedIdentitySha256 !== undefined &&
        scope.binding.gitIdentity.expectedIdentitySha256 !== gitIdentity.identitySha256
      ) {
        return blocked("git_identity_mismatch");
      }
      const established = await this.posixProjectBindings.verifyOrEstablish({
        verificationId: derivePosixProjectBindingVerificationId(project.projectId, projectRevision),
        workspaceId: scope.workspaceId,
        projectId: project.projectId,
        projectRevision,
        canonicalProjectRoot: scope.projectRoot,
        topLevelPath: gitIdentity.topLevelPath,
        commonDirPath: gitIdentity.commonDirPath,
        identitySha256: gitIdentity.identitySha256,
      });
      if (!established) return blocked("git_identity_mismatch");
    }

    const verificationId = `${context.invocationId}:${context.phase}`;
    if (!isBoundedIdentifier(verificationId)) return blocked("invalid_path");
    const fingerprint = createHash("sha256")
      .update(
        canonicalJsonString({
          hostPlatform: "posix",
          workspaceId: scope.workspaceId,
          canonicalCwd,
          allowedRoots: [...scope.allowedRoots].sort(),
          project: scope.binding.project
            ? {
                projectId: scope.binding.project.projectId,
                revision: scope.binding.project.revision,
                canonicalProjectRoot: scope.projectRoot,
              }
            : null,
          gitIdentity: gitIdentity.status === "verified" ? gitIdentity : null,
        }),
        "utf8",
      )
      .digest("hex");
    return {
      status: "verified",
      snapshotId: verificationId,
      canonicalCwd,
      snapshotFingerprintSha256: fingerprint,
      ...(gitIdentity.status === "verified" ? { gitIdentitySha256: gitIdentity.identitySha256 } : {}),
    };
  }

  private async resolvePosixExecutionScope(request: ToolInvokeRequest): Promise<ResolvedExecutionScope | undefined> {
    const binding = await this.options.resolveSessionBinding(request.sessionId);
    if (!binding || !isBoundedIdentifier(binding.workspaceId)) return undefined;
    if (request.workspaceId !== undefined && request.workspaceId !== binding.workspaceId) return undefined;

    const configuredWorkspaceRoot = resolveTrustedPosixConfigRoot(this.options.rootDir, this.options.workspaceDir);
    if (!configuredWorkspaceRoot) return undefined;
    const workspaceRoot = await this.canonicalizePosixTrustedRoot(configuredWorkspaceRoot);
    if (!workspaceRoot) return undefined;

    let projectRoot: string | undefined;
    let projectWorkspacePath: string | undefined;
    if (binding.project) {
      if (
        binding.project.workspaceId !== binding.workspaceId ||
        binding.project.lifecycleStatus === "archived" ||
        !isBoundedIdentifier(binding.project.projectId) ||
        !Number.isSafeInteger(binding.project.revision) ||
        binding.project.revision < 1
      ) {
        return undefined;
      }
      projectWorkspacePath = binding.project.workspacePath;
      if (projectWorkspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH) {
        if (!this.options.allowPromptPackRepoExecution) return undefined;
        const promptPackRoot = normalizeAbsolutePosixPath(this.options.rootDir);
        projectRoot = promptPackRoot ? await this.canonicalizePosixTrustedRoot(promptPackRoot) : undefined;
      } else {
        const relativeProjectPath = normalizePosixProjectWorkspacePath(projectWorkspacePath);
        if (!relativeProjectPath) return undefined;
        projectRoot = await this.canonicalizePosixTrustedRoot(POSIX.resolve(workspaceRoot, relativeProjectPath));
        if (!projectRoot || !isInsidePosix(workspaceRoot, projectRoot)) return undefined;
      }
    }

    const logicalRoot = projectRoot ?? workspaceRoot;
    const canonicalWriteRoots = (
      await Promise.all(
        this.options.writeJailRoots.map(async (configuredRoot) => {
          const absoluteRoot = resolveTrustedPosixConfigRoot(this.options.rootDir, configuredRoot);
          return absoluteRoot ? this.canonicalizePosixTrustedRoot(absoluteRoot) : undefined;
        }),
      )
    ).filter((root): root is string => Boolean(root));
    const allowedRoots = narrowPosixRootIntersections(logicalRoot, canonicalWriteRoots);
    if (allowedRoots.length === 0) return undefined;
    return {
      workspaceId: binding.workspaceId,
      workspaceRoot,
      projectRoot,
      projectWorkspacePath,
      allowedRoots,
      binding,
    };
  }

  private async canonicalizePosixTrustedRoot(input: string): Promise<string | undefined> {
    const normalized = normalizeAbsolutePosixPath(input);
    if (!normalized) return undefined;
    try {
      await this.assertNoPosixSymlinkComponents(normalized);
      const canonical = normalizeAbsolutePosixPath(await this.realpath(normalized));
      if (!canonical || !samePosixPath(normalized, canonical) || !(await this.stat(canonical)).isDirectory()) {
        return undefined;
      }
      return canonical;
    } catch {
      return undefined;
    }
  }

  private async assertNoPosixSymlinkComponents(input: string): Promise<void> {
    let current = POSIX.parse(input).root;
    for (const component of POSIX.relative(current, input).split("/").filter(Boolean)) {
      current = POSIX.join(current, component);
      if ((await this.lstat(current)).isSymbolicLink()) throw new Error("POSIX execution path contains a symlink.");
    }
  }

  private async inspectPosixGitIdentity(
    canonicalCwd: string,
    allowedRoots: readonly string[],
    signal?: AbortSignal,
  ): Promise<PosixGitIdentity> {
    try {
      const runOptions = signal ? { signal } : undefined;
      const topOutput = (await this.runGit(["-C", canonicalCwd, "rev-parse", "--show-toplevel"], runOptions)).stdout;
      const topCandidate = parseSinglePosixGitPath(topOutput, canonicalCwd);
      const topLevelPath = await this.canonicalizePosixTrustedRoot(topCandidate);
      if (
        !topLevelPath ||
        !isInsidePosix(topLevelPath, canonicalCwd) ||
        !allowedRoots.some((root) => isInsidePosix(root, topLevelPath))
      ) {
        return { status: "failed" };
      }
      const commonOutput = (await this.runGit(["-C", canonicalCwd, "rev-parse", "--git-common-dir"], runOptions))
        .stdout;
      const commonCandidate = parseSinglePosixGitPath(commonOutput, canonicalCwd);
      const commonDirPath = await this.canonicalizePosixTrustedRoot(commonCandidate);
      if (!commonDirPath) return { status: "failed" };
      const identitySha256 = createHash("sha256")
        .update(canonicalJsonString({ topLevelPath, commonDirPath }), "utf8")
        .digest("hex");
      return { status: "verified", topLevelPath, commonDirPath, identitySha256 };
    } catch {
      return { status: "failed" };
    }
  }

  private async resolveExecutionScope(request: ToolInvokeRequest): Promise<ResolvedExecutionScope | undefined> {
    const binding = await this.options.resolveSessionBinding(request.sessionId);
    if (!binding || !isBoundedIdentifier(binding.workspaceId)) {
      return undefined;
    }
    if (request.workspaceId !== undefined && request.workspaceId !== binding.workspaceId) {
      return undefined;
    }

    const workspaceRoot = await this.canonicalizeTrustedRoot(
      WIN.resolve(this.options.rootDir, this.options.workspaceDir),
    );
    if (!workspaceRoot) {
      return undefined;
    }

    let projectRoot: string | undefined;
    let projectWorkspacePath: string | undefined;
    if (binding.project) {
      if (
        binding.project.workspaceId !== binding.workspaceId ||
        binding.project.lifecycleStatus === "archived" ||
        !isBoundedIdentifier(binding.project.projectId) ||
        !Number.isSafeInteger(binding.project.revision) ||
        binding.project.revision < 1
      ) {
        return undefined;
      }
      projectWorkspacePath = binding.project.workspacePath;
      if (projectWorkspacePath === PROMPT_PACK_REPO_PROJECT_WORKSPACE_PATH) {
        if (!this.options.allowPromptPackRepoExecution) {
          return undefined;
        }
        projectRoot = await this.canonicalizeTrustedRoot(this.options.rootDir);
      } else {
        const relativeProjectPath = normalizeProjectWorkspacePath(projectWorkspacePath);
        if (!relativeProjectPath) {
          return undefined;
        }
        projectRoot = await this.canonicalizeTrustedRoot(WIN.resolve(workspaceRoot, relativeProjectPath));
        if (!projectRoot || !isInside(workspaceRoot, projectRoot)) {
          return undefined;
        }
      }
      if (!projectRoot) {
        return undefined;
      }
    }

    const logicalRoot = projectRoot ?? workspaceRoot;
    const canonicalWriteRoots = (
      await Promise.all(
        this.options.writeJailRoots.map((root) => {
          const absoluteRoot = resolveTrustedConfigRoot(this.options.rootDir, root);
          return absoluteRoot ? this.canonicalizeTrustedRoot(absoluteRoot) : undefined;
        }),
      )
    ).filter((root): root is string => Boolean(root));
    const allowedRoots = narrowRootIntersections(logicalRoot, canonicalWriteRoots);
    if (allowedRoots.length === 0) {
      return undefined;
    }
    return {
      workspaceId: binding.workspaceId,
      workspaceRoot,
      projectRoot,
      projectWorkspacePath,
      allowedRoots,
      binding,
    };
  }

  private async canonicalizeTrustedRoot(input: string): Promise<string | undefined> {
    const normalized = normalizeAbsoluteHostPath(input);
    if (!normalized) {
      return undefined;
    }
    try {
      const canonical = normalizeAbsoluteHostPath(await this.realpath(normalized));
      if (!canonical || !samePath(normalized, canonical) || !(await this.stat(canonical)).isDirectory()) {
        return undefined;
      }
      return canonical;
    } catch {
      return undefined;
    }
  }
}

type PosixGitIdentity =
  | { status: "failed" }
  | { status: "verified"; topLevelPath: string; commonDirPath: string; identitySha256: string };

class InMemoryPosixProjectGitBindingStore implements PosixProjectGitBindingStore {
  private readonly evidenceById = new Map<string, string>();

  public async verifyOrEstablish(evidence: PosixProjectGitBindingEvidence): Promise<boolean> {
    const canonical = canonicalJsonString(evidence);
    const existing = this.evidenceById.get(evidence.verificationId);
    if (existing !== undefined) return existing === canonical;
    this.evidenceById.set(evidence.verificationId, canonical);
    return true;
  }
}

export function derivePosixProjectBindingVerificationId(projectId: string, projectRevision: number): string {
  if (!isBoundedIdentifier(projectId) || !Number.isSafeInteger(projectRevision) || projectRevision < 1) {
    throw new Error("POSIX project binding requires a valid project id and positive revision.");
  }
  return `posix-project-binding:${createHash("sha256")
    .update(canonicalJsonString({ projectId, projectRevision }), "utf8")
    .digest("hex")}`;
}

function resolvePosixExecutionCwd(value: unknown, logicalRoot: string): string | undefined {
  if (value === undefined) return logicalRoot;
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.normalize("NFKC") !== value ||
    hasControlCharacter(value) ||
    value.includes("\\") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return undefined;
  }
  const resolved = POSIX.isAbsolute(value) ? POSIX.normalize(value) : POSIX.resolve(logicalRoot, value);
  return normalizeAbsolutePosixPath(resolved);
}

function normalizeAbsolutePosixPath(value: string): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.normalize("NFKC") !== value ||
    hasControlCharacter(value) ||
    value.includes("\\") ||
    value.startsWith("//")
  ) {
    return undefined;
  }
  const normalized = POSIX.normalize(value);
  if (!POSIX.isAbsolute(normalized) || normalized === "/") return undefined;
  return normalized;
}

function normalizePosixProjectWorkspacePath(value: string): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.normalize("NFKC") !== value ||
    hasControlCharacter(value) ||
    value.includes("\\") ||
    POSIX.isAbsolute(value)
  ) {
    return undefined;
  }
  const segments = value.split("/");
  return segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..") ? value : undefined;
}

function resolveTrustedPosixConfigRoot(rootDir: string, configuredRoot: string): string | undefined {
  if (
    typeof configuredRoot !== "string" ||
    !configuredRoot ||
    configuredRoot !== configuredRoot.trim() ||
    configuredRoot.normalize("NFKC") !== configuredRoot ||
    hasControlCharacter(configuredRoot) ||
    configuredRoot.includes("\\") ||
    configuredRoot.startsWith("//")
  ) {
    return undefined;
  }
  return normalizeAbsolutePosixPath(
    POSIX.isAbsolute(configuredRoot) ? configuredRoot : POSIX.resolve(rootDir, configuredRoot),
  );
}

function narrowPosixRootIntersections(logicalRoot: string, writeRoots: readonly string[]): string[] {
  const intersections = writeRoots.flatMap((writeRoot) => {
    if (isInsidePosix(writeRoot, logicalRoot)) return [logicalRoot];
    if (isInsidePosix(logicalRoot, writeRoot)) return [writeRoot];
    return [];
  });
  const deduped = [...new Set(intersections)];
  return deduped.filter((root) => !deduped.some((candidate) => root !== candidate && isInsidePosix(root, candidate)));
}

function isInsidePosix(root: string, candidate: string): boolean {
  const relative = POSIX.relative(POSIX.normalize(root), POSIX.normalize(candidate));
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !POSIX.isAbsolute(relative));
}

function samePosixPath(left: string | undefined, right: string | undefined): boolean {
  return typeof left === "string" && typeof right === "string" && POSIX.normalize(left) === POSIX.normalize(right);
}

function parseSinglePosixGitPath(output: string, cwd: string): string {
  if (Buffer.byteLength(output, "utf8") > 64 * 1024 || hasControlCharacter(output.replace(/[\r\n]/gu, ""))) {
    throw new Error("Git path output is invalid.");
  }
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const [line] = lines;
  if (!line || lines.length !== 1 || line.includes("\\")) throw new Error("Git path output is ambiguous.");
  return POSIX.isAbsolute(line) ? line : POSIX.resolve(cwd, line);
}

function fingerprintExecutionSnapshot(snapshot: WorkspacePathBridgeSnapshotRecord): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        schemaVersion: snapshot.schemaVersion,
        requestHash: snapshot.requestHash,
        workspaceId: snapshot.workspaceId,
        inputFlavor: snapshot.inputFlavor,
        targetFlavor: snapshot.targetFlavor,
        distro: snapshot.distro ?? null,
        inputPathHash: snapshot.inputPathHash,
        allowedRootsHash: snapshot.allowedRootsHash,
        canonicalHostPath: snapshot.canonicalHostPath ?? null,
        canonicalTargetPath: snapshot.canonicalTargetPath ?? null,
        roundTrip: snapshot.roundTrip,
        gitIdentity: snapshot.gitIdentity,
        status: snapshot.status,
        callable: snapshot.callable,
      }),
      "utf8",
    )
    .digest("hex");
}

export function detectServerOwnedPathFlavor(
  inputPath: string,
  source?: WorkspacePathBridgeSessionBinding["pathSource"],
): { flavor: WorkspacePathFlavor; distro?: string } | undefined {
  const candidate = inputPath.trim();
  if (!candidate) {
    return undefined;
  }
  if (/^[A-Za-z]:/u.test(candidate)) {
    return { flavor: candidate.includes("/") ? "windows_forward" : "windows_native" };
  }
  if (candidate.startsWith("\\")) {
    return { flavor: "windows_native" };
  }
  if (candidate.startsWith("//")) {
    return { flavor: "windows_forward" };
  }
  if (!candidate.startsWith("/")) {
    return undefined;
  }
  if (source?.flavor === "msys") {
    return { flavor: "msys" };
  }
  if (source?.flavor === "wsl" && isBoundedDistro(source.distro)) {
    return { flavor: "wsl", distro: source.distro };
  }
  return undefined;
}

function normalizeProjectWorkspacePath(input: string): string | undefined {
  if (
    typeof input !== "string" ||
    input !== input.trim() ||
    hasControlCharacter(input) ||
    input.normalize("NFKC") !== input
  ) {
    return undefined;
  }
  const normalized = input.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized.replaceAll("/", "\\");
}

function normalizeAbsoluteHostPath(input: string): string | undefined {
  if (
    typeof input !== "string" ||
    !input ||
    input !== input.trim() ||
    hasControlCharacter(input) ||
    input.normalize("NFKC") !== input ||
    /^(?:\\\\|\/\/)/u.test(input)
  ) {
    return undefined;
  }
  const normalized = WIN.normalize(input.replaceAll("/", "\\"));
  if (!/^[A-Za-z]:\\/u.test(normalized) || samePath(normalized, WIN.parse(normalized).root)) {
    return undefined;
  }
  return normalized;
}

function resolveTrustedConfigRoot(rootDir: string, configuredRoot: string): string | undefined {
  if (
    typeof configuredRoot !== "string" ||
    !configuredRoot ||
    configuredRoot !== configuredRoot.trim() ||
    hasControlCharacter(configuredRoot) ||
    configuredRoot.normalize("NFKC") !== configuredRoot ||
    /^(?:\\\\|\/\/)/u.test(configuredRoot)
  ) {
    return undefined;
  }
  const normalized = configuredRoot.replaceAll("/", "\\");
  if (normalized.startsWith("\\") || (/^[A-Za-z]:/u.test(normalized) && !/^[A-Za-z]:\\/u.test(normalized))) {
    return undefined;
  }
  return WIN.isAbsolute(normalized) ? normalized : WIN.resolve(rootDir, normalized);
}

function narrowRootIntersections(logicalRoot: string, writeRoots: readonly string[]): string[] {
  const intersections = writeRoots.flatMap((writeRoot) => {
    if (isInside(writeRoot, logicalRoot)) return [logicalRoot];
    if (isInside(logicalRoot, writeRoot)) return [writeRoot];
    return [];
  });
  const deduped = [...new Map(intersections.map((root) => [identity(root), root])).values()];
  return deduped.filter(
    (root) => !deduped.some((candidate) => !samePath(root, candidate) && isInside(root, candidate)),
  );
}

function isInside(root: string, candidate: string): boolean {
  const relative = WIN.relative(WIN.normalize(root), WIN.normalize(candidate));
  return relative === "" || (!relative.startsWith(`..${WIN.sep}`) && relative !== ".." && !WIN.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return identity(left) === identity(right);
}

function identity(input: string): string {
  return WIN.normalize(input)
    .replace(/[\\/]+$/u, "")
    .toLocaleLowerCase("en-US");
}

function isBoundedIdentifier(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function isBoundedDistro(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function blocked(
  reasonCode: Extract<WorkspacePathBridgeExecutionDecision, { status: "blocked" }>["reasonCode"],
  snapshotId?: string,
): WorkspacePathBridgeExecutionDecision {
  return { status: "blocked", reasonCode, ...(snapshotId ? { snapshotId } : {}) };
}
