import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import {
  isAbsolute as isAbsolutePath,
  join as joinPath,
  normalize as normalizePath,
  parse as parsePath,
  posix as POSIX,
  relative as relativePath,
  sep as nativeSeparator,
  win32 as WIN,
} from "node:path";
import {
  canonicalJsonString,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolveWorkspacePathBridgeRuntimeConfig } from "./workspace-path-bridge-config.js";
import {
  derivePosixProjectBindingVerificationId,
  WorkspacePathBridgeExecutionResolver,
  type PosixProjectGitBindingEvidence,
  type PosixProjectGitBindingStore,
  type WorkspacePathBridgeHostPlatform,
  type WorkspacePathBridgeSessionBinding,
} from "./workspace-path-bridge-integration.js";
import { WorkspacePathBridgePosixService } from "./workspace-path-bridge-posix-service.js";
import { WorkspacePathBridgeService } from "./workspace-path-bridge-service.js";

/**
 * The inspection surface shared by the Windows and POSIX bridge services. Both
 * emit the same immutable snapshot record, so routes and the external-source
 * verifier bind to this rather than to one host's implementation.
 */
export interface WorkspacePathBridgeInspectionService {
  resolve(
    request: WorkspacePathBridgeResolveRequest,
    options?: { signal?: AbortSignal; allowedRoots?: readonly string[] },
  ): Promise<WorkspacePathBridgeSnapshotRecord>;
  inspect(workspaceId: string, snapshotId: string): WorkspacePathBridgeSnapshotRecord;
  list(workspaceId: string, limit?: number): WorkspacePathBridgeSnapshotRecord[];
}

const SHA256 = /^[a-f0-9]{64}$/u;

type WorkspacePathBridgeRuntimeStorage = Pick<
  Storage,
  "chatProjects" | "chatSessionMeta" | "chatSessionProjects" | "workspacePathBridgeSnapshots" | "workspaces"
>;

export interface WorkspacePathBridgeRuntimeOptions {
  storage: WorkspacePathBridgeRuntimeStorage;
  rootDir: string;
  workspaceDir: string;
  writeJailRoots: readonly string[];
  dataDir?: string;
  hostPlatform?: WorkspacePathBridgeHostPlatform;
  environment?: Readonly<Record<string, string | undefined>>;
  service?: WorkspacePathBridgeInspectionService;
  realpath?: (input: string) => Promise<string>;
  stat?: (input: string) => Promise<{ isDirectory(): boolean }>;
  lstat?: (input: string) => Promise<{ isSymbolicLink(): boolean }>;
  runGit?: (args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string }>;
  posixProjectGitBindingStore?: PosixProjectGitBindingStore;
}

/**
 * Production composition owner for path inspection, immutable project Git
 * bindings, and the coordinator's fresh execution resolver.
 */
export class WorkspacePathBridgeRuntime {
  public readonly service: WorkspacePathBridgeInspectionService;
  public readonly executionResolver: WorkspacePathBridgeExecutionResolver;
  private readonly pathSource: WorkspacePathBridgeSessionBinding["pathSource"];
  private readonly workspaceRoot: string;
  private readonly hostPlatform: WorkspacePathBridgeHostPlatform;

  public constructor(private readonly options: WorkspacePathBridgeRuntimeOptions) {
    this.hostPlatform = options.hostPlatform ?? (process.platform === "win32" ? "windows" : "posix");
    this.pathSource = resolveWorkspacePathBridgeRuntimeConfig(options.environment, this.hostPlatform).pathSource;
    this.workspaceRoot = resolveAbsoluteConfigPath(options.rootDir, options.workspaceDir, this.hostPlatform);
    // A POSIX host has no path flavors to translate, and the Windows service
    // rejects every POSIX root it is handed. Selecting by host platform is what
    // makes registration — not just tool execution — work off Windows.
    const bridgeDependencies = {
      repository: options.storage.workspacePathBridgeSnapshots,
      allowedRootsForWorkspace: (workspaceId: string) => this.resolveAllowedRootsForWorkspace(workspaceId),
      ...(options.realpath ? { realpath: options.realpath } : {}),
      ...(options.stat ? { stat: options.stat } : {}),
      ...(options.lstat ? { lstat: options.lstat } : {}),
    };
    this.service =
      options.service ??
      (this.hostPlatform === "posix"
        ? new WorkspacePathBridgePosixService({
            ...bridgeDependencies,
            ...(options.runGit ? { runGit: options.runGit } : {}),
          })
        : new WorkspacePathBridgeService(bridgeDependencies));
    this.executionResolver = new WorkspacePathBridgeExecutionResolver({
      service: this.service,
      rootDir: options.rootDir,
      workspaceDir: options.workspaceDir,
      writeJailRoots: options.writeJailRoots,
      hostPlatform: this.hostPlatform,
      resolveSessionBinding: (sessionId) => this.resolveSessionBinding(sessionId),
      ...(options.realpath ? { realpath: options.realpath } : {}),
      ...(options.stat ? { stat: options.stat } : {}),
      ...(options.lstat ? { lstat: options.lstat } : {}),
      ...(options.runGit ? { runGit: options.runGit } : {}),
      ...(this.hostPlatform === "posix"
        ? {
            posixProjectGitBindingStore:
              options.posixProjectGitBindingStore ??
              new FilePosixProjectGitBindingStore(
                POSIX.join(
                  resolveAbsoluteConfigPath(options.rootDir, options.dataDir ?? "data", "posix"),
                  "workspace-path-bridge",
                  "project-bindings",
                ),
              ),
          }
        : {}),
    });
  }

  /**
   * Resolves only repository-owned session/project state. The model's cwd and
   * other tool arguments never select a path source, project, or Git identity.
   */
  public async resolveSessionBinding(sessionId: string): Promise<WorkspacePathBridgeSessionBinding | undefined> {
    const initial = this.readCanonicalSessionState(sessionId);
    if (!initial) {
      return undefined;
    }
    if (!initial.project) {
      return { workspaceId: initial.workspaceId, ...(this.pathSource ? { pathSource: this.pathSource } : {}) };
    }

    const projectRoot = resolveProjectRoot(this.workspaceRoot, initial.project.workspacePath, this.hostPlatform);
    if (!projectRoot) {
      return undefined;
    }
    const allowedRoots = narrowRootIntersections(projectRoot, this.resolveConfiguredWriteRoots(), this.hostPlatform);
    if (allowedRoots.length === 0) {
      return undefined;
    }

    if (this.hostPlatform === "posix") {
      const current = this.readCanonicalSessionState(sessionId);
      if (!current?.project || !sameCanonicalSessionState(initial, current)) return undefined;
      return {
        workspaceId: initial.workspaceId,
        project: {
          projectId: initial.project.projectId,
          revision: initial.project.revision,
          workspaceId: initial.workspaceId,
          workspacePath: initial.project.workspacePath,
          lifecycleStatus: "active",
        },
      };
    }

    const verificationId = deriveProjectBindingVerificationId(initial.project.projectId, initial.project.revision);
    let snapshot: WorkspacePathBridgeSnapshotRecord;
    try {
      snapshot = await this.service.resolve(
        {
          verificationId,
          workspaceId: initial.workspaceId,
          inputPath: projectRoot,
          inputFlavor: "windows_native",
          targetFlavor: "windows_native",
          requireGitIdentity: true,
        },
        { allowedRoots },
      );
    } catch {
      return undefined;
    }
    if (!isExactProjectBindingSnapshot(snapshot, verificationId, initial.workspaceId, projectRoot)) {
      return undefined;
    }

    // A project/session CAS that lands while Git is inspected invalidates this
    // attempt. A new project revision receives a new deterministic binding id.
    const current = this.readCanonicalSessionState(sessionId);
    if (!current?.project || !sameCanonicalSessionState(initial, current)) {
      return undefined;
    }
    return {
      workspaceId: initial.workspaceId,
      project: {
        projectId: initial.project.projectId,
        revision: initial.project.revision,
        workspaceId: initial.workspaceId,
        workspacePath: initial.project.workspacePath,
        lifecycleStatus: "active",
      },
      ...(this.pathSource ? { pathSource: this.pathSource } : {}),
      gitIdentity: {
        required: true,
        expectedIdentitySha256: snapshot.gitIdentity.identitySha256,
      },
    };
  }

  private readCanonicalSessionState(sessionId: string): CanonicalSessionState | undefined {
    const meta = this.options.storage.chatSessionMeta.get(sessionId);
    if (
      !meta ||
      meta.lifecycleStatus !== "active" ||
      !isBoundedIdentifier(meta.workspaceId) ||
      !Number.isSafeInteger(meta.revision) ||
      meta.revision < 1
    ) {
      return undefined;
    }
    const workspace = this.options.storage.workspaces.find(meta.workspaceId);
    if (!workspace || workspace.lifecycleStatus !== "active") {
      return undefined;
    }
    const assignment = this.options.storage.chatSessionProjects.get(sessionId);
    if (!assignment) {
      return { sessionRevision: meta.revision, workspaceId: meta.workspaceId };
    }
    const project = this.options.storage.chatProjects.find(assignment.projectId);
    if (
      !project ||
      project.lifecycleStatus !== "active" ||
      project.workspaceId !== meta.workspaceId ||
      !isBoundedIdentifier(project.projectId) ||
      !Number.isSafeInteger(project.revision) ||
      project.revision < 1
    ) {
      return undefined;
    }
    return {
      sessionRevision: meta.revision,
      workspaceId: meta.workspaceId,
      project: {
        projectId: project.projectId,
        revision: project.revision,
        workspacePath: project.workspacePath,
      },
    };
  }

  private resolveAllowedRootsForWorkspace(workspaceId: string): readonly string[] {
    const workspace = this.options.storage.workspaces.find(workspaceId);
    if (!workspace || workspace.lifecycleStatus !== "active") {
      return [];
    }
    return narrowRootIntersections(this.workspaceRoot, this.resolveConfiguredWriteRoots(), this.hostPlatform);
  }

  private resolveConfiguredWriteRoots(): string[] {
    return this.options.writeJailRoots.flatMap((configuredRoot) => {
      try {
        return [resolveAbsoluteConfigPath(this.options.rootDir, configuredRoot, this.hostPlatform)];
      } catch {
        return [];
      }
    });
  }
}

interface CanonicalSessionState {
  sessionRevision: number;
  workspaceId: string;
  project?: {
    projectId: string;
    revision: number;
    workspacePath: string;
  };
}

export function deriveProjectBindingVerificationId(projectId: string, projectRevision: number): string {
  if (!isBoundedIdentifier(projectId) || !Number.isSafeInteger(projectRevision) || projectRevision < 1) {
    throw new Error("Workspace path bridge project binding requires a valid project id and positive revision.");
  }
  const digest = createHash("sha256").update(canonicalJsonString({ projectId, projectRevision }), "utf8").digest("hex");
  return `project-binding:${digest}`;
}

/**
 * Immutable, restart-safe project-revision Git identity binding for native
 * POSIX hosts. Existing evidence is never rewritten: exact bytes verify, and
 * same-id drift fails closed.
 */
export class FilePosixProjectGitBindingStore implements PosixProjectGitBindingStore {
  private readonly evidenceRoot: string;

  public constructor(
    evidenceRoot: string,
    private readonly options: FilePosixProjectGitBindingStoreOptions = {},
  ) {
    const normalized = normalizePath(evidenceRoot);
    if (!isAbsolutePath(normalized) || sameNativePath(normalized, parsePath(normalized).root)) {
      throw new Error("POSIX project Git binding evidence root must be absolute and non-root.");
    }
    this.evidenceRoot = normalized;
  }

  public async verifyOrEstablish(evidence: PosixProjectGitBindingEvidence): Promise<boolean> {
    if (!isValidPosixProjectGitBindingEvidence(evidence)) return false;
    const expectedBytes = Buffer.from(`${canonicalJsonString(evidence)}\n`, "utf8");
    if (expectedBytes.byteLength > MAX_POSIX_BINDING_BYTES) return false;

    let directoryFd: number | undefined;
    let stableDirectoryReference: string | undefined;
    let stagedName: string | undefined;
    let evidenceName: string | undefined;
    let publishedByThisCall = false;
    let completed = false;
    try {
      fs.mkdirSync(this.evidenceRoot, { recursive: true, mode: 0o700 });
      const rootIdentity = captureEvidenceRootIdentity(this.evidenceRoot);
      if (!rootIdentity) return false;
      directoryFd = openEvidenceDirectory(this.evidenceRoot);
      stableDirectoryReference = this.resolveStableDirectoryReference(directoryFd);
      if (!verifyEvidenceRootIdentity(rootIdentity, directoryFd, stableDirectoryReference)) return false;

      evidenceName = `${createHash("sha256").update(evidence.verificationId, "utf8").digest("hex")}.json`;
      stagedName = `.${evidenceName}.${process.pid}.${randomBytes(12).toString("hex")}.stage`;

      this.options.beforeCriticalPhase?.("before_stage");
      if (!verifyEvidenceRootIdentity(rootIdentity, directoryFd, this.resolveStableDirectoryReference(directoryFd))) {
        return false;
      }

      stableDirectoryReference = this.resolveStableDirectoryReference(directoryFd);
      const stagedPath = joinPath(stableDirectoryReference, stagedName);
      const stagedFd = fs.openSync(
        stagedPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      let stagedIdentity: fs.Stats;
      try {
        stagedIdentity = fs.fstatSync(stagedFd);
        if (!isSafeEvidenceFileStat(stagedIdentity, 0)) return false;
      } finally {
        fs.closeSync(stagedFd);
      }

      this.options.beforeCriticalPhase?.("before_stage_write");
      if (!verifyEvidenceRootIdentity(rootIdentity, directoryFd, this.resolveStableDirectoryReference(directoryFd))) {
        return false;
      }
      stableDirectoryReference = this.resolveStableDirectoryReference(directoryFd);
      const stagedWriteFd = fs.openSync(
        joinPath(stableDirectoryReference, stagedName),
        fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      );
      try {
        const reopened = fs.fstatSync(stagedWriteFd);
        if (!sameFileIdentity(stagedIdentity, reopened) || !isSafeEvidenceFileStat(reopened, 0)) return false;
        writeExactBytes(stagedWriteFd, expectedBytes);
        fs.fsyncSync(stagedWriteFd);
        if (!isSafeEvidenceFileStat(fs.fstatSync(stagedWriteFd), expectedBytes.byteLength)) return false;
      } finally {
        fs.closeSync(stagedWriteFd);
      }

      this.options.beforeCriticalPhase?.("before_publish");
      if (!verifyEvidenceRootIdentity(rootIdentity, directoryFd, this.resolveStableDirectoryReference(directoryFd))) {
        return false;
      }

      stableDirectoryReference = this.resolveStableDirectoryReference(directoryFd);
      const evidencePath = joinPath(stableDirectoryReference, evidenceName);
      try {
        // A same-directory hard link is the create-once publication primitive:
        // unlike rename it cannot replace immutable evidence that already won.
        fs.linkSync(joinPath(stableDirectoryReference, stagedName), evidencePath);
        publishedByThisCall = true;
      } catch (error) {
        if (!isNodeErrorCode(error, "EEXIST")) return false;
      }
      if (safeUnlink(joinPath(stableDirectoryReference, stagedName))) stagedName = undefined;
      flushDirectoryBestEffort(directoryFd);

      if (!verifyEvidenceRootIdentity(rootIdentity, directoryFd, this.resolveStableDirectoryReference(directoryFd))) {
        return false;
      }
      this.options.beforeCriticalPhase?.("before_read");
      if (!verifyEvidenceRootIdentity(rootIdentity, directoryFd, this.resolveStableDirectoryReference(directoryFd))) {
        return false;
      }

      stableDirectoryReference = this.resolveStableDirectoryReference(directoryFd);
      const exact = readExactSafeEvidence(joinPath(stableDirectoryReference, evidenceName), expectedBytes);
      this.options.beforeCriticalPhase?.("after_read");
      completed =
        exact &&
        verifyEvidenceRootIdentity(rootIdentity, directoryFd, this.resolveStableDirectoryReference(directoryFd));
      return completed;
    } catch {
      return false;
    } finally {
      if (directoryFd !== undefined) {
        try {
          const cleanupRoot = this.resolveStableDirectoryReference(directoryFd);
          if (sameFileIdentity(fs.statSync(cleanupRoot), fs.fstatSync(directoryFd))) {
            if (stagedName) safeUnlink(joinPath(cleanupRoot, stagedName));
            if (publishedByThisCall && !completed && evidenceName) {
              // Only remove a failed publication through a reference that is
              // still bound to the opened directory object. A lexical fallback
              // that was swapped to an outside target is never used for cleanup.
              safeUnlink(joinPath(cleanupRoot, evidenceName));
            }
          }
        } catch {
          // Failing closed may leave an unreachable private stage behind, but
          // it must never redirect cleanup into a replacement directory.
        }
        fs.closeSync(directoryFd);
      }
    }
  }

  private resolveStableDirectoryReference(directoryFd: number): string {
    const injectedCandidates = this.options.resolveStableDirectoryReferenceCandidates?.(this.evidenceRoot, directoryFd);
    const candidates =
      injectedCandidates ??
      (this.options.resolveStableDirectoryReference
        ? [this.options.resolveStableDirectoryReference(this.evidenceRoot, directoryFd)]
        : [`/proc/self/fd/${directoryFd}`, `/dev/fd/${directoryFd}`]);
    const directoryIdentity = fs.fstatSync(directoryFd);
    for (const candidate of candidates) {
      try {
        if (isAbsolutePath(candidate) && sameFileIdentity(fs.statSync(candidate), directoryIdentity)) return candidate;
      } catch {
        // Try the next directory-handle projection.
        continue;
      }
    }
    throw new EvidenceDirectoryHandleProjectionUnavailableError();
  }
}

const MAX_POSIX_BINDING_BYTES = 16 * 1024;

class EvidenceDirectoryHandleProjectionUnavailableError extends Error {
  public constructor() {
    super("POSIX project Git binding evidence requires a stable directory-handle projection.");
    this.name = "EvidenceDirectoryHandleProjectionUnavailableError";
  }
}

export type FilePosixProjectGitBindingStoreCriticalPhase =
  | "before_stage"
  | "before_stage_write"
  | "before_publish"
  | "before_read"
  | "after_read";

export interface FilePosixProjectGitBindingStoreOptions {
  /** Synchronous fault-injection seam used to prove filesystem-race behavior. */
  beforeCriticalPhase?(phase: FilePosixProjectGitBindingStoreCriticalPhase): void;
  /** @internal Cross-platform projection of an already-open directory handle for deterministic tests. */
  resolveStableDirectoryReference?(evidenceRoot: string, directoryFd: number): string;
  /** @internal Complete candidate override used to prove unavailable and mismatched projections fail closed. */
  resolveStableDirectoryReferenceCandidates?(evidenceRoot: string, directoryFd: number): readonly string[];
}

interface EvidencePathIdentity {
  path: string;
  stat: fs.Stats;
}

interface EvidenceRootIdentity {
  ancestors: EvidencePathIdentity[];
  root: EvidencePathIdentity;
}

function captureEvidenceRootIdentity(evidenceRoot: string): EvidenceRootIdentity | undefined {
  try {
    const ancestors = listNativeAncestors(evidenceRoot).map((candidate): EvidencePathIdentity => {
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe evidence-root ancestor.");
      if (!sameNativePath(normalizePath(fs.realpathSync(candidate)), candidate)) {
        throw new Error("Evidence-root ancestor is not canonical.");
      }
      return { path: candidate, stat };
    });
    const root = ancestors.at(-1);
    if (!root || !hasSafeEvidenceRootPermissions(root.stat)) return undefined;
    return { ancestors, root };
  } catch {
    return undefined;
  }
}

function verifyEvidenceRootIdentity(
  expected: EvidenceRootIdentity,
  directoryFd: number,
  stableDirectoryReference: string,
): boolean {
  const current = captureEvidenceRootIdentity(expected.root.path);
  if (
    !current ||
    current.ancestors.length !== expected.ancestors.length ||
    !current.ancestors.every(
      (entry, index) =>
        sameNativePath(entry.path, expected.ancestors[index]?.path ?? "") &&
        sameFileIdentity(entry.stat, expected.ancestors[index]?.stat),
    ) ||
    !sameFileIdentity(expected.root.stat, fs.fstatSync(directoryFd))
  ) {
    return false;
  }
  try {
    return sameFileIdentity(expected.root.stat, fs.statSync(stableDirectoryReference));
  } catch {
    return false;
  }
}

function openEvidenceDirectory(evidenceRoot: string): number {
  return fs.openSync(
    evidenceRoot,
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0),
  );
}

function listNativeAncestors(target: string): string[] {
  const root = normalizePath(parsePath(target).root);
  const relative = relativePath(root, target);
  const ancestors = [root];
  let current = root;
  for (const component of relative.split(nativeSeparator).filter(Boolean)) {
    current = joinPath(current, component);
    ancestors.push(current);
  }
  return ancestors;
}

function hasSafeEvidenceRootPermissions(stat: fs.Stats): boolean {
  if (process.platform === "win32") return true;
  if ((stat.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function isSafeEvidenceFileStat(stat: fs.Stats, exactSize: number): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.size === exactSize &&
    stat.size <= MAX_POSIX_BINDING_BYTES &&
    (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === process.getuid?.()))
  );
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats | undefined): boolean {
  return right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

function writeExactBytes(fileDescriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(fileDescriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written < 1) throw new Error("Unable to write exact POSIX project binding evidence.");
    offset += written;
  }
}

function readExactSafeEvidence(evidencePath: string, expectedBytes: Buffer): boolean {
  const fileDescriptor = fs.openSync(evidencePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const initial = fs.fstatSync(fileDescriptor);
    if (!isSafeEvidenceFileStat(initial, expectedBytes.byteLength)) return false;
    const actual = Buffer.alloc(expectedBytes.byteLength);
    let offset = 0;
    while (offset < actual.byteLength) {
      const read = fs.readSync(fileDescriptor, actual, offset, actual.byteLength - offset, offset);
      if (read < 1) return false;
      offset += read;
    }
    const named = fs.lstatSync(evidencePath);
    return (
      isSafeEvidenceFileStat(named, expectedBytes.byteLength) &&
      sameFileIdentity(initial, named) &&
      actual.equals(expectedBytes)
    );
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

function safeUnlink(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    // Best-effort cleanup cannot authorize or overwrite evidence.
    return false;
  }
}

function flushDirectoryBestEffort(directoryFd: number): void {
  try {
    fs.fsyncSync(directoryFd);
  } catch {
    // Windows and some POSIX filesystems do not support directory fsync.
    return;
  }
}

function isExactProjectBindingSnapshot(
  snapshot: WorkspacePathBridgeSnapshotRecord,
  verificationId: string,
  workspaceId: string,
  projectRoot: string,
): boolean {
  return (
    snapshot.snapshotId === verificationId &&
    snapshot.workspaceId === workspaceId &&
    snapshot.status === "verified" &&
    snapshot.callable &&
    snapshot.inputFlavor === "windows_native" &&
    snapshot.targetFlavor === "windows_native" &&
    snapshot.gitIdentityRequired &&
    samePath(snapshot.canonicalHostPath, projectRoot) &&
    snapshot.gitIdentity.status === "verified" &&
    samePath(snapshot.gitIdentity.topLevelPath, projectRoot) &&
    typeof snapshot.gitIdentity.commonDirPath === "string" &&
    SHA256.test(snapshot.gitIdentity.identitySha256 ?? "")
  );
}

function sameCanonicalSessionState(left: CanonicalSessionState, right: CanonicalSessionState): boolean {
  return canonicalJsonString(left) === canonicalJsonString(right);
}

function isValidPosixProjectGitBindingEvidence(evidence: PosixProjectGitBindingEvidence): boolean {
  try {
    return (
      evidence.verificationId ===
        derivePosixProjectBindingVerificationId(evidence.projectId, evidence.projectRevision) &&
      isBoundedIdentifier(evidence.workspaceId) &&
      isCanonicalPosixEvidencePath(evidence.canonicalProjectRoot) &&
      isCanonicalPosixEvidencePath(evidence.topLevelPath) &&
      isCanonicalPosixEvidencePath(evidence.commonDirPath) &&
      evidence.canonicalProjectRoot === evidence.topLevelPath &&
      SHA256.test(evidence.identitySha256)
    );
  } catch {
    return false;
  }
}

function isCanonicalPosixEvidencePath(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 1 &&
    value.length <= 4_096 &&
    value === value.trim() &&
    value.normalize("NFKC") === value &&
    !hasControlCharacter(value) &&
    !value.includes("\\") &&
    !value.startsWith("//") &&
    POSIX.isAbsolute(value) &&
    POSIX.normalize(value) === value
  );
}

function sameNativePath(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left).replace(/[\\/]+$/u, "");
  const normalizedRight = normalizePath(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function resolveProjectRoot(
  workspaceRoot: string,
  workspacePath: string,
  hostPlatform: WorkspacePathBridgeHostPlatform,
): string | undefined {
  if (!isSafeRelativePath(workspacePath, hostPlatform)) {
    return undefined;
  }
  const candidate =
    hostPlatform === "windows"
      ? WIN.resolve(workspaceRoot, workspacePath.replaceAll("/", "\\"))
      : POSIX.resolve(workspaceRoot, workspacePath);
  return isInsideForPlatform(workspaceRoot, candidate, hostPlatform) ? candidate : undefined;
}

function resolveAbsoluteConfigPath(
  rootDir: string,
  configuredPath: string,
  hostPlatform: WorkspacePathBridgeHostPlatform,
): string {
  if (
    typeof configuredPath !== "string" ||
    !configuredPath ||
    configuredPath !== configuredPath.trim() ||
    hasControlCharacter(configuredPath) ||
    configuredPath.normalize("NFKC") !== configuredPath ||
    configuredPath.startsWith("//")
  ) {
    throw new Error("Workspace path bridge config path is invalid.");
  }
  if (hostPlatform === "posix") {
    if (configuredPath.includes("\\")) throw new Error("Workspace path bridge POSIX config path is invalid.");
    const resolved = POSIX.isAbsolute(configuredPath)
      ? POSIX.normalize(configuredPath)
      : POSIX.resolve(rootDir, configuredPath);
    if (!POSIX.isAbsolute(resolved) || resolved === "/") {
      throw new Error("Workspace path bridge config path must be an absolute non-root POSIX path.");
    }
    return resolved;
  }
  if (configuredPath.startsWith("\\\\")) throw new Error("Workspace path bridge config path is invalid.");
  const normalized = configuredPath.replaceAll("/", "\\");
  const resolved = WIN.isAbsolute(normalized) ? WIN.normalize(normalized) : WIN.resolve(rootDir, normalized);
  if (!/^[A-Za-z]:\\/u.test(resolved) || samePath(resolved, WIN.parse(resolved).root)) {
    throw new Error("Workspace path bridge config path must be an absolute non-root Windows path.");
  }
  return resolved;
}

function isSafeRelativePath(value: string, hostPlatform: WorkspacePathBridgeHostPlatform): boolean {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    hasControlCharacter(value) ||
    value.normalize("NFKC") !== value
  ) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  return (
    (hostPlatform === "windows" ? !WIN.isAbsolute(value) : !POSIX.isAbsolute(value) && !value.includes("\\")) &&
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    segments.every((segment) => Boolean(segment) && segment !== "." && segment !== "..")
  );
}

function narrowRootIntersections(
  logicalRoot: string,
  configuredRoots: readonly string[],
  hostPlatform: WorkspacePathBridgeHostPlatform,
): string[] {
  const intersections = configuredRoots.flatMap((configuredRoot) => {
    if (isInsideForPlatform(configuredRoot, logicalRoot, hostPlatform)) return [logicalRoot];
    if (isInsideForPlatform(logicalRoot, configuredRoot, hostPlatform)) return [configuredRoot];
    return [];
  });
  const deduped = [
    ...new Map(intersections.map((root) => [pathIdentityForPlatform(root, hostPlatform), root])).values(),
  ];
  return deduped.filter(
    (root) =>
      !deduped.some(
        (candidate) =>
          !samePathForPlatform(root, candidate, hostPlatform) && isInsideForPlatform(root, candidate, hostPlatform),
      ),
  );
}

function isInsideForPlatform(root: string, candidate: string, hostPlatform: WorkspacePathBridgeHostPlatform): boolean {
  if (hostPlatform === "windows") return isInside(root, candidate);
  const relative = POSIX.relative(POSIX.normalize(root), POSIX.normalize(candidate));
  return relative === "" || (!relative.startsWith("../") && relative !== ".." && !POSIX.isAbsolute(relative));
}

function samePathForPlatform(left: string, right: string, hostPlatform: WorkspacePathBridgeHostPlatform): boolean {
  return pathIdentityForPlatform(left, hostPlatform) === pathIdentityForPlatform(right, hostPlatform);
}

function pathIdentityForPlatform(value: string, hostPlatform: WorkspacePathBridgeHostPlatform): string {
  return hostPlatform === "windows" ? pathIdentity(value) : POSIX.normalize(value).replace(/\/+$/u, "");
}

function isInside(root: string, candidate: string): boolean {
  const relative = WIN.relative(WIN.normalize(root), WIN.normalize(candidate));
  return relative === "" || (!relative.startsWith(`..${WIN.sep}`) && relative !== ".." && !WIN.isAbsolute(relative));
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return typeof left === "string" && typeof right === "string" && pathIdentity(left) === pathIdentity(right);
}

function pathIdentity(value: string): string {
  return WIN.normalize(value)
    .replace(/[\\/]+$/u, "")
    .toLocaleLowerCase("en-US");
}

function isBoundedIdentifier(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
