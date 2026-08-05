import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { posix as POSIX } from "node:path";
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
} from "@goatcitadel/contracts";
import { sealWorkspacePathBridgeSnapshot, type WorkspacePathBridgeSnapshotRepository } from "@goatcitadel/storage";
import { WorkspacePathBridgeUnsupportedFlavorError } from "./workspace-path-bridge-errors.js";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 5_000;
const MAX_ALLOWED_ROOTS = 16;
const MAX_ALLOWED_ROOT_BYTES = 32 * 1024;
const MAX_GIT_MARKER_DEPTH = 256;

type WorkspacePathBridgeRepositoryPort = {
  [Key in keyof Pick<WorkspacePathBridgeSnapshotRepository, "create" | "find" | "get" | "listByWorkspace">]: Pick<
    WorkspacePathBridgeSnapshotRepository,
    Key
  >[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result | Promise<Result>
    : never;
};

export interface WorkspacePathBridgePosixServiceOptions {
  repository: WorkspacePathBridgeRepositoryPort;
  allowedRootsForWorkspace: (workspaceId: string) => readonly string[] | Promise<readonly string[]>;
  realpath?: (input: string) => Promise<string>;
  stat?: (input: string) => Promise<{ isDirectory(): boolean }>;
  lstat?: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  runGit?: (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string }>;
  now?: () => Date;
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

class GitUnavailableError extends Error {
  public constructor() {
    super("git is unavailable.");
    this.name = "GitUnavailableError";
  }
}

interface BridgeProgress {
  canonicalHostPath?: string;
  canonicalTargetPath?: string;
  roundTrip: WorkspacePathBridgeRoundTripEvidence;
  gitIdentity: WorkspacePathBridgeGitIdentityEvidence;
}

/**
 * Native POSIX counterpart to {@link WorkspacePathBridgeService}.
 *
 * The Windows bridge exists to prove that a translation between path *flavors*
 * (`windows_native`, `windows_forward`, `msys`, `wsl`) lands where it claims.
 * A POSIX host has exactly one flavor, so there is nothing to translate and the
 * round trip is the identity. What remains is the part that actually carries
 * the security weight, and it is reproduced here in full: the jail check, exact
 * canonicalization, symlink refusal on every path component, and Git identity
 * evidence. The emitted snapshot is the same immutable record type, so every
 * downstream consumer — including the external-source registration re-check —
 * works unchanged.
 */
export class WorkspacePathBridgePosixService {
  private readonly repository: WorkspacePathBridgePosixServiceOptions["repository"];
  private readonly allowedRootsForWorkspace: WorkspacePathBridgePosixServiceOptions["allowedRootsForWorkspace"];
  private readonly realpath: (input: string) => Promise<string>;
  private readonly stat: (input: string) => Promise<{ isDirectory(): boolean }>;
  private readonly lstat: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  private readonly runGit: NonNullable<WorkspacePathBridgePosixServiceOptions["runGit"]>;
  private readonly now: () => Date;

  public constructor(options: WorkspacePathBridgePosixServiceOptions) {
    this.repository = options.repository;
    this.allowedRootsForWorkspace = options.allowedRootsForWorkspace;
    this.realpath = options.realpath ?? fs.realpath;
    this.stat = options.stat ?? fs.stat;
    this.lstat = options.lstat ?? fs.lstat;
    this.runGit = options.runGit ?? defaultRunGit;
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
      roundTrip: { attempted: false, converter: "native", equal: false },
      gitIdentity: { status: "failed" },
    };

    const roots = await this.canonicalizeRoots(normalizedConfiguredRoots);
    const allowedRootsHash = digest(roots.map((root) => root.canonicalPath).sort());
    const requestHash = digest({
      workspaceId: request.workspaceId,
      inputPathHash,
      inputFlavor: request.inputFlavor,
      targetFlavor: request.targetFlavor,
      requireGitIdentity: request.requireGitIdentity,
      distro: null,
      expectedGitIdentitySha256: request.expectedGitIdentitySha256 ?? null,
      allowedRootsHash,
    });

    try {
      const syntacticPath = parsePosixPath(request.inputPath);
      if (!normalizedConfiguredRoots.some((root) => isInside(root, syntacticPath))) {
        throw new BridgeFailure("outside_jail");
      }
      const canonicalHostPath = await this.canonicalizeExactDirectory(syntacticPath);
      progress.canonicalHostPath = canonicalHostPath;
      progress.roundTrip.inputHostPathSha256 = digestText(canonicalHostPath);
      if (!roots.some((root) => isInside(root.canonicalPath, canonicalHostPath))) {
        throw new BridgeFailure("symlink_escape");
      }

      // The POSIX target flavor is the host flavor, so the conversion and its
      // inverse are both the identity. The evidence is still recorded rather
      // than asserted, so a future non-identity conversion cannot silently
      // inherit a passing round trip.
      const canonicalTargetPath = canonicalHostPath;
      progress.canonicalTargetPath = canonicalTargetPath;
      progress.roundTrip.targetPathSha256 = digestText(canonicalTargetPath);
      progress.roundTrip.attempted = true;

      const roundTripHostCandidate = parsePosixPath(canonicalTargetPath);
      if (!normalizedConfiguredRoots.some((root) => isInside(root, roundTripHostCandidate))) {
        throw new BridgeFailure("round_trip_mismatch");
      }
      const roundTripCanonicalHost = await this.canonicalizeExactDirectory(roundTripHostCandidate);
      progress.roundTrip.roundTripHostPathSha256 = digestText(roundTripCanonicalHost);
      progress.roundTrip.equal = canonicalHostPath === roundTripCanonicalHost;
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

      return await this.persist({
        request,
        requestHash,
        inputPathHash,
        allowedRootsHash,
        progress,
        status: "verified",
      });
    } catch (error) {
      if (!(error instanceof BridgeFailure)) {
        throw error;
      }
      return await this.persist({
        request,
        requestHash,
        inputPathHash,
        allowedRootsHash,
        progress,
        status: error.availability,
        reasonCode: error.reasonCode,
      });
    }
  }

  public async inspect(workspaceId: string, snapshotId: string): Promise<WorkspacePathBridgeSnapshotRecord> {
    validateIdentifier(workspaceId, "workspaceId", 256);
    validateIdentifier(snapshotId, "snapshotId", 256);
    const snapshot = await this.repository.get(snapshotId);
    if (snapshot.workspaceId !== workspaceId) {
      throw new Error("Workspace path bridge snapshot is outside the requested workspace.");
    }
    return snapshot;
  }

  public async list(workspaceId: string, limit = 50): Promise<WorkspacePathBridgeSnapshotRecord[]> {
    validateIdentifier(workspaceId, "workspaceId", 256);
    return await this.repository.listByWorkspace(workspaceId, limit);
  }

  private async persist(input: {
    request: WorkspacePathBridgeResolveRequest;
    requestHash: string;
    inputPathHash: string;
    allowedRootsHash: string;
    progress: BridgeProgress;
    status: "verified" | "blocked" | "unavailable";
    reasonCode?: WorkspacePathBridgeReasonCode;
  }): Promise<WorkspacePathBridgeSnapshotRecord> {
    const existing = await this.repository.find(input.request.verificationId);
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
    return await this.repository.create(snapshot);
  }

  private async canonicalizeRoots(configuredRoots: readonly string[]): Promise<CanonicalRoot[]> {
    const roots: CanonicalRoot[] = [];
    for (const configuredPath of configuredRoots) {
      let canonicalPath: string;
      try {
        await this.assertNoSymlinkComponents(configuredPath);
        canonicalPath = parsePosixPath(await this.realpath(configuredPath));
        if (!(await this.stat(canonicalPath)).isDirectory()) {
          throw new Error("allowed root is not a directory");
        }
      } catch (error) {
        if (error instanceof BridgeFailure) throw error;
        throw new BridgeFailure("canonicalization_failed");
      }
      roots.push({ configuredPath, canonicalPath });
    }
    return [...new Map(roots.map((root) => [root.canonicalPath, root])).values()];
  }

  private async canonicalizeExactDirectory(candidate: string): Promise<string> {
    try {
      const normalizedCandidate = parsePosixPath(candidate);
      await this.assertNoSymlinkComponents(normalizedCandidate);
      const canonical = parsePosixPath(await this.realpath(normalizedCandidate));
      if (!(await this.stat(canonical)).isDirectory()) {
        throw new Error("candidate is not a directory");
      }
      return canonical;
    } catch (error) {
      if (error instanceof BridgeFailure) throw error;
      throw new BridgeFailure("canonicalization_failed");
    }
  }

  private async assertNoSymlinkComponents(candidate: string): Promise<void> {
    const normalized = parsePosixPath(candidate);
    let current = "/";
    for (const component of normalized.split("/").filter(Boolean)) {
      current = POSIX.join(current, component);
      try {
        if ((await this.lstat(current)).isSymbolicLink()) {
          throw new BridgeFailure("symlink_escape");
        }
      } catch (error) {
        if (error instanceof BridgeFailure) throw error;
        throw new BridgeFailure("canonicalization_failed");
      }
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
    try {
      const topLevelOutput = (
        await this.runGit(["-C", canonicalHostPath, "rev-parse", "--show-toplevel"], signal ? { signal } : undefined)
      ).stdout;
      const topLevelCandidate = parseGitPathOutput(topLevelOutput, canonicalHostPath);
      await this.assertNoSymlinkComponents(topLevelCandidate);
      const topLevelPath = parsePosixPath(await this.realpath(topLevelCandidate));
      if (
        !isInside(topLevelPath, canonicalHostPath) ||
        !roots.some((root) => isInside(root.canonicalPath, topLevelPath))
      ) {
        return { status: "failed" };
      }
      const commonOutput = (
        await this.runGit(["-C", canonicalHostPath, "rev-parse", "--git-common-dir"], signal ? { signal } : undefined)
      ).stdout;
      const commonCandidate = parseGitPathOutput(commonOutput, canonicalHostPath);
      await this.assertNoSymlinkComponents(commonCandidate);
      const commonDirPath = parsePosixPath(await this.realpath(commonCandidate));
      const identitySha256 = digest({ topLevelPath, commonDirPath });
      return { status: "verified", topLevelPath, commonDirPath, identitySha256 };
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      if (error instanceof GitUnavailableError) {
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
    for (let depth = 0; depth < MAX_GIT_MARKER_DEPTH; depth += 1) {
      if (!roots.some((root) => isInside(root.canonicalPath, probe))) {
        return "absent";
      }
      try {
        const markerPath = POSIX.join(probe, ".git");
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
      const parent = POSIX.dirname(probe);
      if (parent === probe) {
        return "absent";
      }
      probe = parent;
    }
    return "failed";
  }
}

interface CanonicalRoot {
  configuredPath: string;
  canonicalPath: string;
}

async function defaultRunGit(
  args: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ stdout: string }> {
  try {
    const result = await execFileAsync("git", [...args], {
      signal: options.signal,
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
      encoding: "utf8",
    });
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_PROCESS_OUTPUT_BYTES) {
      throw new Error("Workspace path bridge subprocess output exceeded its bound.");
    }
    return { stdout: result.stdout };
  } catch (error) {
    if (isMissingPath(error)) {
      throw new GitUnavailableError();
    }
    throw error;
  }
}

function validateRequestEnvelope(request: WorkspacePathBridgeResolveRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Workspace path bridge request is malformed.");
  }
  assertExactRequestKeys(request);
  validateIdentifier(request.verificationId, "verificationId", 256);
  validateIdentifier(request.workspaceId, "workspaceId", 256);
  if (request.inputFlavor !== "posix" || request.targetFlavor !== "posix") {
    throw new WorkspacePathBridgeUnsupportedFlavorError(
      "posix",
      request.inputFlavor === "posix" ? request.targetFlavor : request.inputFlavor,
    );
  }
  if (typeof request.requireGitIdentity !== "boolean") {
    throw new Error("Workspace path bridge Git identity posture is required.");
  }
  if (typeof request.inputPath !== "string" || request.inputPath.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH) {
    throw new Error("Workspace path bridge input path is invalid.");
  }
  if (request.distro !== undefined) {
    throw new Error("Workspace path bridge distro is invalid.");
  }
  if (request.expectedGitIdentitySha256 !== undefined) {
    if (!request.requireGitIdentity || !SHA256.test(request.expectedGitIdentitySha256)) {
      throw new Error("Workspace path bridge expected Git identity is invalid.");
    }
  }
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
  return [...new Set(roots.map((root) => parsePosixPath(root)))];
}

/**
 * Accepts only an absolute, canonical, non-root POSIX path. Every rejection is
 * a `BridgeFailure` so a caller-supplied path is recorded as blocked evidence
 * instead of escaping as an untyped error.
 */
function parsePosixPath(input: string): string {
  if (
    typeof input !== "string" ||
    !input ||
    input !== input.trim() ||
    input.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH ||
    hasControlCharacter(input) ||
    input.normalize("NFKC") !== input ||
    input.includes("\\") ||
    input.startsWith("//") ||
    /^[A-Za-z]:/u.test(input)
  ) {
    throw new BridgeFailure("invalid_path");
  }
  if (!POSIX.isAbsolute(input)) {
    throw new BridgeFailure("invalid_path");
  }
  const segments = input.slice(1).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new BridgeFailure("invalid_path");
  }
  const normalized = POSIX.normalize(input);
  if (normalized === "/" || normalized !== input) {
    throw new BridgeFailure("invalid_path");
  }
  return normalized;
}

function parseGitPathOutput(stdout: string, cwd: string): string {
  const value = stdout.replace(/\r?\n$/u, "");
  if (!value || value.includes("\n") || value.includes("\r") || value.length > WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH) {
    throw new Error("Git returned malformed path evidence.");
  }
  return parsePosixPath(POSIX.isAbsolute(value) ? value : POSIX.resolve(cwd, value));
}

function isInside(root: string, candidate: string): boolean {
  const relative = POSIX.relative(POSIX.normalize(root), POSIX.normalize(candidate));
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !POSIX.isAbsolute(relative));
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

function isMissingPath(error: unknown): boolean {
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

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function digest(value: unknown): string {
  return digestText(canonicalJsonString(value));
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
