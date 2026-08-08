import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalJsonString, type SkillContentIntegrityManifest } from "@goatcitadel/contracts";
import {
  captureSkillContentIntegrity,
  decodeExactSkillUtf8,
  SKILL_CONTENT_INTEGRITY_LIMITS,
} from "./skill-content-integrity.js";
import {
  NodeSkillHubArtifactFilesystem,
  type SkillHubArtifactFileHandle,
  type SkillHubArtifactFilesystem,
  type SkillHubArtifactFilesystemStat,
} from "./skill-hub-artifact-store.js";

export interface SkillHubLifecycleFilesystemMutation {
  kind: "rename" | "write";
  sourcePath?: string;
  targetPath: string;
}

export interface SkillHubLifecycleFilesystemDependencies {
  filesystem?: SkillHubArtifactFilesystem;
  /** Test-only seam after identity capture and before the mutation-time revalidation. */
  beforeMutation?: (mutation: SkillHubLifecycleFilesystemMutation) => Promise<void> | void;
}

interface BoundNode {
  absolutePath: string;
  stat: SkillHubArtifactFilesystemStat;
}

class SkillHubLifecycleContentMismatchError extends Error {}

/**
 * Filesystem boundary for lifecycle projections outside the immutable artifact store.
 *
 * Every managed component is lstat/realpath checked, including Windows reparse
 * points. Mutations bind parent/source identities before the operation and
 * revalidate them immediately before and after it. Node has no portable dirfd
 * openat/renameat2 surface, so a detected post-syscall swap fails closed and is
 * left for operator inspection rather than following or deleting an unknown path.
 */
export class SkillHubLifecycleFilesystem {
  private readonly rootDir: string;
  private readonly filesystem: SkillHubArtifactFilesystem;
  private readonly beforeMutation: NonNullable<SkillHubLifecycleFilesystemDependencies["beforeMutation"]>;
  private rootAnchor: BoundNode | undefined;
  private rootAnchorInitialization: Promise<BoundNode> | undefined;

  public constructor(rootDir: string, dependencies: SkillHubLifecycleFilesystemDependencies = {}) {
    this.rootDir = path.resolve(rootDir);
    this.filesystem = dependencies.filesystem ?? new NodeSkillHubArtifactFilesystem();
    this.beforeMutation = dependencies.beforeMutation ?? (() => undefined);
  }

  public async ensureManagedRoot(managedRoot: string, signal: AbortSignal): Promise<void> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const binding = await this.captureDirectoryBinding(this.rootDir, signal);
    let current = this.rootDir;
    for (const component of relativeComponents(this.rootDir, resolvedRoot)) {
      current = path.join(current, component);
      let stat = await this.tryLstat(current, signal);
      if (!stat) {
        await this.assertDirectoryBinding(binding, signal);
        try {
          await this.filesystem.mkdir(current, 0o700, signal);
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
        }
        stat = await this.safeLstat(current, signal);
      }
      await this.assertSafeNode(current, stat, "directory", signal);
      binding.push({ absolutePath: current, stat });
    }
    await this.assertDirectoryBinding(binding, signal);
  }

  public async ensureDirectory(managedRoot: string, directory: string, signal: AbortSignal): Promise<void> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const resolvedDirectory = this.assertContained(resolvedRoot, directory, true);
    await this.ensureManagedRoot(resolvedRoot, signal);
    const binding = await this.captureDirectoryBinding(resolvedRoot, signal);
    let current = resolvedRoot;
    for (const component of relativeComponents(resolvedRoot, resolvedDirectory)) {
      current = path.join(current, component);
      let stat = await this.tryLstat(current, signal);
      if (!stat) {
        await this.assertDirectoryBinding(binding, signal);
        try {
          await this.filesystem.mkdir(current, 0o700, signal);
        } catch (error) {
          if (!isErrno(error, "EEXIST")) throw error;
        }
        stat = await this.safeLstat(current, signal);
      }
      await this.assertSafeNode(current, stat, "directory", signal);
      binding.push({ absolutePath: current, stat });
    }
    await this.assertDirectoryBinding(binding, signal);
  }

  public async createFreshDirectory(managedRoot: string, directory: string, signal: AbortSignal): Promise<void> {
    await this.removeTreeIfPresent(managedRoot, directory, signal);
    await this.ensureDirectory(managedRoot, directory, signal);
  }

  public async writeImmutableFile(
    managedRoot: string,
    target: string,
    content: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.writeImmutableBytes(managedRoot, target, Buffer.from(content, "utf8"), signal);
  }

  public async fileMatches(
    managedRoot: string,
    target: string,
    content: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const targetPath = this.assertContained(resolvedRoot, target, false);
    await this.ensureManagedRoot(resolvedRoot, signal);
    const parentBinding = await this.captureDirectoryBinding(path.dirname(targetPath), signal);
    if (!(await this.tryLstat(targetPath, signal))) {
      await this.assertDirectoryBinding(parentBinding, signal);
      return false;
    }
    const expected = Buffer.from(content, "utf8");
    try {
      const observed = await this.readVerifiedBytes(targetPath, expected.byteLength, digestBytes(expected), signal);
      await this.assertDirectoryBinding(parentBinding, signal);
      return Buffer.from(observed).equals(expected);
    } catch (error) {
      if (error instanceof SkillHubLifecycleContentMismatchError) {
        await this.assertDirectoryBinding(parentBinding, signal);
        return false;
      }
      throw error;
    }
  }

  public async copyVerifiedFile(input: {
    sourceRoot: string;
    sourcePath: string;
    targetRoot: string;
    targetPath: string;
    expectedBytes: number;
    expectedSha256: string;
    signal: AbortSignal;
  }): Promise<void> {
    const sourceRoot = path.resolve(input.sourceRoot);
    const sourcePath = this.assertContained(sourceRoot, input.sourcePath, false);
    const bytes = await this.readVerifiedBytes(sourcePath, input.expectedBytes, input.expectedSha256, input.signal);
    await this.writeImmutableBytes(input.targetRoot, input.targetPath, bytes, input.signal);
  }

  public async readVerifiedText(input: {
    sourceRoot: string;
    sourcePath: string;
    expectedBytes: number;
    expectedSha256: string;
    signal: AbortSignal;
  }): Promise<string> {
    const sourceRoot = path.resolve(input.sourceRoot);
    const sourcePath = this.assertContained(sourceRoot, input.sourcePath, false);
    return decodeExactSkillUtf8(
      await this.readVerifiedBytes(sourcePath, input.expectedBytes, input.expectedSha256, input.signal),
      `Skill Hub artifact ${path.basename(sourcePath)}`,
    );
  }

  public async renameDirectory(
    managedRoot: string,
    source: string,
    target: string,
    signal: AbortSignal,
  ): Promise<void> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const sourcePath = this.assertContained(resolvedRoot, source, false);
    const targetPath = this.assertContained(resolvedRoot, target, false);
    if (!sameCanonicalPath(path.dirname(sourcePath), path.dirname(targetPath))) {
      throw new Error("Skill Hub lifecycle rename must stay within one bound parent.");
    }
    const parentBinding = await this.captureDirectoryBinding(path.dirname(sourcePath), signal);
    const sourceStat = await this.safeLstat(sourcePath, signal);
    await this.assertSafeNode(sourcePath, sourceStat, "directory", signal);
    if (await this.tryLstat(targetPath, signal)) {
      throw new Error("Skill Hub lifecycle rename target already exists.");
    }
    await this.beforeMutation({ kind: "rename", sourcePath, targetPath });
    await this.assertDirectoryBinding(parentBinding, signal);
    await this.assertNodeIdentity(sourcePath, sourceStat, "directory", signal);
    if (await this.tryLstat(targetPath, signal)) {
      throw new Error("Skill Hub lifecycle rename target changed before commit.");
    }
    await this.filesystem.renameDirectory(sourcePath, targetPath, signal);
    const installed = await this.safeLstat(targetPath, signal);
    await this.assertSafeNode(targetPath, installed, "directory", signal);
    if (!sameFilesystemIdentity(sourceStat, installed)) {
      throw new Error("Skill Hub lifecycle rename changed filesystem identity.");
    }
    if (await this.tryLstat(sourcePath, signal)) {
      throw new Error("Skill Hub lifecycle rename left an ambiguous source path.");
    }
    await this.assertDirectoryBinding(parentBinding, signal);
  }

  public async removeTreeIfPresent(managedRoot: string, target: string, signal: AbortSignal): Promise<void> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const targetPath = this.assertContained(resolvedRoot, target, false);
    await this.ensureManagedRoot(resolvedRoot, signal);
    const parentBinding = await this.captureDirectoryBinding(path.dirname(targetPath), signal);
    const stat = await this.tryLstat(targetPath, signal);
    if (!stat) {
      await this.assertDirectoryBinding(parentBinding, signal);
      return;
    }
    await this.assertSafeNode(targetPath, stat, "directory", signal);
    const nodes = await this.captureTreeNodes(targetPath, signal);
    await this.assertTreeNodesUnchanged(nodes, signal);
    await this.assertDirectoryBinding(parentBinding, signal);
    await this.filesystem.removeTree(targetPath, signal);
    if (await this.tryLstat(targetPath, signal)) {
      throw new Error("Skill Hub lifecycle cleanup did not remove its bound directory.");
    }
    await this.assertDirectoryBinding(parentBinding, signal);
  }

  public async pathKind(
    managedRoot: string,
    target: string,
    signal: AbortSignal,
  ): Promise<"directory" | "missing" | "other"> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const targetPath = this.assertContained(resolvedRoot, target, false);
    await this.ensureManagedRoot(resolvedRoot, signal);
    const parentBinding = await this.captureDirectoryBinding(path.dirname(targetPath), signal);
    const stat = await this.tryLstat(targetPath, signal);
    if (!stat) {
      await this.assertDirectoryBinding(parentBinding, signal);
      return "missing";
    }
    if (stat.symbolicLink || stat.reparsePoint) throw new Error("Skill Hub lifecycle path is unsafe.");
    if (stat.kind === "directory") await this.assertSafeNode(targetPath, stat, "directory", signal);
    else if (stat.kind === "file") await this.assertSafeNode(targetPath, stat, "file", signal);
    else throw new Error("Skill Hub lifecycle path is unsafe.");
    await this.assertDirectoryBinding(parentBinding, signal);
    return stat.kind === "directory" ? "directory" : "other";
  }

  public async directoryMatches(
    managedRoot: string,
    directory: string,
    manifest: SkillContentIntegrityManifest,
    signal: AbortSignal,
  ): Promise<boolean> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const directoryPath = this.assertContained(resolvedRoot, directory, false);
    await this.ensureManagedRoot(resolvedRoot, signal);
    const parentBinding = await this.captureDirectoryBinding(path.dirname(directoryPath), signal);
    const stat = await this.tryLstat(directoryPath, signal);
    if (!stat) {
      await this.assertDirectoryBinding(parentBinding, signal);
      return false;
    }
    await this.assertSafeNode(directoryPath, stat, "directory", signal);
    const nodes = await this.captureTreeNodes(directoryPath, signal);
    const observed = await captureSkillContentIntegrity(directoryPath);
    await this.assertTreeNodesUnchanged(nodes, signal);
    await this.assertNodeIdentity(directoryPath, stat, "directory", signal);
    await this.assertDirectoryBinding(parentBinding, signal);
    return canonicalJsonString(observed) === canonicalJsonString(manifest);
  }

  private async writeImmutableBytes(
    managedRoot: string,
    target: string,
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const resolvedRoot = this.assertManagedRoot(managedRoot);
    const targetPath = this.assertContained(resolvedRoot, target, false);
    await this.ensureDirectory(resolvedRoot, path.dirname(targetPath), signal);
    const parentBinding = await this.captureDirectoryBinding(path.dirname(targetPath), signal);
    const existing = await this.tryLstat(targetPath, signal);
    if (existing) {
      await this.assertExactFile(targetPath, bytes, signal);
      await this.assertDirectoryBinding(parentBinding, signal);
      return;
    }

    await this.beforeMutation({ kind: "write", targetPath });
    await this.assertDirectoryBinding(parentBinding, signal);
    if (await this.tryLstat(targetPath, signal)) {
      await this.assertExactFile(targetPath, bytes, signal);
      await this.assertDirectoryBinding(parentBinding, signal);
      return;
    }

    let handle: SkillHubArtifactFileHandle | undefined;
    let opened: SkillHubArtifactFilesystemStat | undefined;
    try {
      handle = await this.filesystem.openExclusive(targetPath, 0o600, signal);
      opened = await handle.stat(signal);
      await this.assertSafeNode(targetPath, await this.safeLstat(targetPath, signal), "file", signal);
      if (!sameFilesystemIdentity(opened, await this.safeLstat(targetPath, signal))) {
        throw new Error("Skill Hub lifecycle file identity changed after exclusive create.");
      }
      await this.assertDirectoryBinding(parentBinding, signal);
      await writeAll(handle, bytes, signal);
      await handle.sync(signal);
      const written = await handle.stat(signal);
      if (!sameFilesystemIdentity(opened, written) || written.size !== BigInt(bytes.byteLength)) {
        throw new Error("Skill Hub lifecycle file changed during immutable write.");
      }
      await handle.close();
      handle = undefined;
      await this.assertDirectoryBinding(parentBinding, signal);
      const installed = await this.safeLstat(targetPath, signal);
      if (!sameIdentityAndVersion(written, installed)) {
        throw new Error("Skill Hub lifecycle file changed after immutable write.");
      }
      await this.assertExactFile(targetPath, bytes, signal);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (opened) await this.removeOwnedFileIfSafe(targetPath, opened, parentBinding, signal);
      throw error;
    }
  }

  private async assertExactFile(target: string, expected: Uint8Array, signal: AbortSignal): Promise<void> {
    const observed = await this.readVerifiedBytes(target, expected.byteLength, digestBytes(expected), signal);
    if (!Buffer.from(observed).equals(Buffer.from(expected))) {
      throw new SkillHubLifecycleContentMismatchError(
        "Immutable Skill Hub lifecycle artifact contains different bytes.",
      );
    }
  }

  private async readVerifiedBytes(
    target: string,
    expectedBytes: number,
    expectedSha256: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    assertBoundedFileExpectation(expectedBytes, expectedSha256);
    const binding = await this.captureSafeChain(target, "file", signal);
    const before = binding.at(-1)!.stat;
    if (before.size !== BigInt(expectedBytes)) {
      throw new SkillHubLifecycleContentMismatchError("Skill Hub lifecycle file bytes do not match.");
    }
    const handle = await this.filesystem.openReadOnly(target, signal);
    const bytes = new Uint8Array(expectedBytes);
    try {
      const opened = await handle.stat(signal);
      if (!sameIdentityAndVersion(before, opened)) throw new Error("Skill Hub lifecycle file identity changed.");
      let offset = 0;
      while (offset < bytes.byteLength) {
        const length = Math.min(64 * 1024, bytes.byteLength - offset);
        const count = await handle.read(bytes, offset, length, offset, signal);
        if (!Number.isSafeInteger(count) || count < 1 || count > length) {
          throw new Error("Skill Hub lifecycle file read did not complete exactly.");
        }
        offset += count;
      }
      const after = await handle.stat(signal);
      if (!sameIdentityAndVersion(before, after)) throw new Error("Skill Hub lifecycle file changed while read.");
    } finally {
      await handle.close().catch(() => undefined);
    }
    await this.assertDirectoryBinding(binding.slice(0, -1), signal);
    const afterPath = await this.safeLstat(target, signal);
    if (!sameIdentityAndVersion(before, afterPath)) throw new Error("Skill Hub lifecycle file identity changed.");
    if (digestBytes(bytes) !== expectedSha256) {
      throw new SkillHubLifecycleContentMismatchError("Skill Hub lifecycle file bytes do not match.");
    }
    return bytes;
  }

  private async captureTreeNodes(root: string, signal: AbortSignal): Promise<BoundNode[]> {
    const queue = [root];
    const nodes: BoundNode[] = [];
    let entries = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      const currentStat = await this.safeLstat(current, signal);
      await this.assertSafeNode(current, currentStat, "directory", signal);
      nodes.push({ absolutePath: current, stat: currentStat });
      for (const name of await this.filesystem.readdir(current, signal)) {
        entries += 1;
        if (entries > SKILL_CONTENT_INTEGRITY_LIMITS.maxEntries) {
          throw new Error("Skill Hub lifecycle tree exceeds its bounded entry count.");
        }
        const child = path.join(current, name);
        const stat = await this.safeLstat(child, signal);
        if (stat.kind !== "directory" && stat.kind !== "file") {
          throw new Error("Skill Hub lifecycle tree contains an unsafe node.");
        }
        await this.assertSafeNode(child, stat, stat.kind, signal);
        nodes.push({ absolutePath: child, stat });
        if (stat.kind === "directory") queue.push(child);
      }
    }
    return nodes;
  }

  private async assertTreeNodesUnchanged(nodes: readonly BoundNode[], signal: AbortSignal): Promise<void> {
    for (const node of nodes) {
      const kind = node.stat.kind === "directory" ? "directory" : "file";
      await this.assertNodeIdentity(node.absolutePath, node.stat, kind, signal);
    }
  }

  private async removeOwnedFileIfSafe(
    target: string,
    opened: SkillHubArtifactFilesystemStat,
    parentBinding: readonly BoundNode[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.assertDirectoryBinding(parentBinding, signal);
      const observed = await this.safeLstat(target, signal);
      await this.assertSafeNode(target, observed, "file", signal);
      if (sameFilesystemIdentity(opened, observed)) await this.filesystem.unlink(target, signal);
    } catch {
      // Fail closed: swapped cleanup targets remain for operator inspection.
    }
  }

  private async captureSafeChain(
    absoluteTarget: string,
    leafKind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<BoundNode[]> {
    const resolvedTarget = path.resolve(absoluteTarget);
    const underGatewayRoot = isSameOrContained(this.rootDir, resolvedTarget);
    if (!underGatewayRoot) return this.captureAbsoluteSafeChain(resolvedTarget, leafKind, signal);

    const anchor = await this.ensureRootAnchor(signal);
    await this.assertNodeIdentity(anchor.absolutePath, anchor.stat, "directory", signal);
    let current = this.rootDir;
    const binding: BoundNode[] = [anchor];
    const components = relativeComponents(this.rootDir, resolvedTarget);
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      const kind = index === components.length - 1 ? leafKind : "directory";
      const stat = await this.safeLstat(current, signal);
      await this.assertSafeNode(current, stat, kind, signal);
      binding.push({ absolutePath: current, stat });
    }
    return binding;
  }

  private async captureAbsoluteSafeChain(
    absoluteTarget: string,
    leafKind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<BoundNode[]> {
    const parsed = path.parse(absoluteTarget);
    let current = parsed.root;
    const binding: BoundNode[] = [];
    const components = relativeComponents(parsed.root, absoluteTarget);
    const rootStat = await this.safeLstat(current, signal);
    await this.assertSafeNode(current, rootStat, "directory", signal);
    binding.push({ absolutePath: current, stat: rootStat });
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]!);
      const kind = index === components.length - 1 ? leafKind : "directory";
      const stat = await this.safeLstat(current, signal);
      await this.assertSafeNode(current, stat, kind, signal);
      binding.push({ absolutePath: current, stat });
    }
    return binding;
  }

  private ensureRootAnchor(signal: AbortSignal): Promise<BoundNode> {
    if (this.rootAnchor) return Promise.resolve(this.rootAnchor);
    this.rootAnchorInitialization ??= this.captureAbsoluteSafeChain(this.rootDir, "directory", signal).then(
      (binding) => {
        const anchor = binding.at(-1)!;
        this.rootAnchor = anchor;
        return anchor;
      },
    );
    return this.rootAnchorInitialization;
  }

  private captureDirectoryBinding(absoluteDirectory: string, signal: AbortSignal): Promise<BoundNode[]> {
    return this.captureSafeChain(path.resolve(absoluteDirectory), "directory", signal);
  }

  private async assertDirectoryBinding(binding: readonly BoundNode[], signal: AbortSignal): Promise<void> {
    for (const node of binding) {
      await this.assertNodeIdentity(node.absolutePath, node.stat, "directory", signal);
    }
  }

  private async assertNodeIdentity(
    absolutePath: string,
    expected: SkillHubArtifactFilesystemStat,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    const observed = await this.safeLstat(absolutePath, signal);
    await this.assertSafeNode(absolutePath, observed, kind, signal);
    if (!sameFilesystemIdentity(expected, observed)) {
      throw new Error("Skill Hub lifecycle filesystem identity changed.");
    }
  }

  private async assertSafeNode(
    absolutePath: string,
    stat: SkillHubArtifactFilesystemStat,
    kind: "directory" | "file",
    signal: AbortSignal,
  ): Promise<void> {
    assertValidStat(stat);
    if (stat.kind !== kind || stat.symbolicLink || stat.reparsePoint) {
      throw new Error("Skill Hub lifecycle path is unsafe.");
    }
    const canonical = await this.filesystem.realpath(absolutePath, signal);
    if (!sameCanonicalPath(canonical, absolutePath)) throw new Error("Skill Hub lifecycle path is unsafe.");
  }

  private assertManagedRoot(managedRoot: string): string {
    return this.assertContained(this.rootDir, managedRoot, false);
  }

  private assertContained(root: string, candidate: string, allowSame: boolean): string {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (
      (!allowSame && !relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Skill Hub lifecycle path escapes its managed root.");
    }
    return resolvedCandidate;
  }

  private safeLstat(absolutePath: string, signal: AbortSignal): Promise<SkillHubArtifactFilesystemStat> {
    return this.filesystem.lstat(absolutePath, signal);
  }

  private async tryLstat(
    absolutePath: string,
    signal: AbortSignal,
  ): Promise<SkillHubArtifactFilesystemStat | undefined> {
    try {
      return await this.safeLstat(absolutePath, signal);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

async function writeAll(handle: SkillHubArtifactFileHandle, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const length = Math.min(64 * 1024, bytes.byteLength - offset);
    const written = await handle.write(bytes, offset, length, offset, signal);
    if (!Number.isSafeInteger(written) || written < 1 || written > length) {
      throw new Error("Skill Hub lifecycle file write did not complete exactly.");
    }
    offset += written;
  }
}

function assertBoundedFileExpectation(expectedBytes: number, expectedSha256: string): void {
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    expectedBytes > SKILL_CONTENT_INTEGRITY_LIMITS.maxFileBytes ||
    !/^[a-f0-9]{64}$/u.test(expectedSha256)
  ) {
    throw new Error("Skill Hub lifecycle file expectation is invalid.");
  }
}

function assertValidStat(stat: SkillHubArtifactFilesystemStat): void {
  if (
    !stat ||
    !["directory", "file", "other"].includes(stat.kind) ||
    typeof stat.symbolicLink !== "boolean" ||
    typeof stat.reparsePoint !== "boolean" ||
    [stat.device, stat.inode, stat.size, stat.mtimeNs, stat.birthtimeNs, stat.mode].some(
      (value) => typeof value !== "bigint" || value < 0n,
    )
  ) {
    throw new Error("Skill Hub lifecycle filesystem stat is invalid.");
  }
}

function sameFilesystemIdentity(left: SkillHubArtifactFilesystemStat, right: SkillHubArtifactFilesystemStat): boolean {
  return (
    left.kind === right.kind &&
    left.symbolicLink === right.symbolicLink &&
    left.reparsePoint === right.reparsePoint &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function sameIdentityAndVersion(left: SkillHubArtifactFilesystemStat, right: SkillHubArtifactFilesystemStat): boolean {
  return sameFilesystemIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function relativeComponents(root: string, target: string): string[] {
  return path.relative(root, target).split(path.sep).filter(Boolean);
}

function isSameOrContained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = normalizeExtendedPath(path.resolve(left));
  const normalizedRight = normalizeExtendedPath(path.resolve(right));
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function normalizeExtendedPath(value: string): string {
  if (value.startsWith("\\\\?\\UNC\\")) return `\\\\${value.slice(8)}`;
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error) && typeof error === "object" && (error as NodeJS.ErrnoException).code === code;
}
