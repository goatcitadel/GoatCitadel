import fs from "node:fs";
import path from "node:path";

/**
 * HX-505 remote-worker cell filesystem adapter (production-dark).
 *
 * Path-jail preflight is NOT hostile-process isolation. Parent-side scans use
 * per-component no-follow identity checks that fail closed on any symlink,
 * junction, reparse point, ADS, device, socket, FIFO, hard link, mount
 * crossing, or device/UNC alias. Physical capacity is counted by unique
 * (device, inode) identity so hard links and overlapping roots cannot hide or
 * double-count bytes. The native node probe is injected so the boundary logic
 * is provable single-host with a double; the real probe uses `fs.lstatSync`
 * (no-follow) plus an injected Windows reparse inspector.
 */

export type WorkerCellFilesystemNodeKind =
  | "directory"
  | "file"
  | "symlink"
  | "reparse_point"
  | "alternate_data_stream"
  | "device"
  | "socket"
  | "fifo"
  | "hard_link_extra"
  | "unknown";

export interface WorkerCellFilesystemNode {
  readonly name: string;
  readonly kind: WorkerCellFilesystemNodeKind;
  readonly physicalBytes: number;
  readonly deviceId: number;
  readonly inode: number;
  readonly hardLinkCount: number;
}

export interface WorkerCellFilesystemProbe {
  /** No-follow identity of the node at `absolutePath`. Never dereferences a link. */
  probe(absolutePath: string): WorkerCellFilesystemNode;
  /** Directory entry names (no `.`/`..`), used only after `probe` confirms a real directory. */
  readdir(absolutePath: string): string[];
}

export interface WorkerCellFilesystemScanResult {
  readonly rootDeviceId: number;
  readonly uniquePhysicalBytes: number;
  readonly fileCount: number;
  readonly directoryCount: number;
  readonly uniqueInodeCount: number;
}

export interface WorkerCellFilesystemScanOptions {
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

const DEFAULT_MAX_ENTRIES = 1_000_000;
const DEFAULT_MAX_DEPTH = 64;

const SUSPICIOUS_KINDS: ReadonlySet<WorkerCellFilesystemNodeKind> = new Set([
  "symlink",
  "reparse_point",
  "alternate_data_stream",
  "device",
  "socket",
  "fifo",
  "unknown",
]);

export class WorkerCellFilesystemError extends Error {
  public constructor(
    public readonly code:
      | "jail_escape"
      | "unsafe_node"
      | "mount_crossing"
      | "hard_link"
      | "scan_bounds"
      | "not_a_directory"
      | "invalid_path",
    message: string,
  ) {
    super(message);
    this.name = "WorkerCellFilesystemError";
  }
}

/**
 * Assert a candidate path stays lexically within the jail root. This preflight
 * rejects `..` traversal, absolute escapes, and NUL bytes; it does not follow
 * links (that is the scan's job) and never touches the filesystem.
 */
export function assertWorkerCellPathInJail(candidatePath: string, jailRoot: string): string {
  if (typeof candidatePath !== "string" || typeof jailRoot !== "string" || candidatePath.length === 0) {
    throw new WorkerCellFilesystemError("invalid_path", "Remote worker cell path and jail root are required.");
  }
  if (candidatePath.includes("\0") || jailRoot.includes("\0")) {
    throw new WorkerCellFilesystemError("invalid_path", "Remote worker cell path contains a NUL byte.");
  }
  const resolvedRoot = path.resolve(jailRoot);
  const resolved = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedRoot, candidatePath);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative !== "" && (path.isAbsolute(relative) || relative.split(/[\\/]+/u).includes(".."))) {
    throw new WorkerCellFilesystemError("jail_escape", "Remote worker cell path is outside the jail root.");
  }
  return resolved;
}

/**
 * Scan the cell tree with per-component no-follow identity checks, failing
 * closed on any suspicious node, mount crossing, or hard link, and counting
 * unique physical bytes by (device, inode).
 */
export function scanWorkerCellFootprint(
  rootPath: string,
  probe: WorkerCellFilesystemProbe,
  options: WorkerCellFilesystemScanOptions = {},
): WorkerCellFilesystemScanResult {
  const resolvedRoot = path.resolve(rootPath);
  const maxEntries = boundedPositive(options.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxDepth = boundedPositive(options.maxDepth, DEFAULT_MAX_DEPTH);
  const rootNode = probe.probe(resolvedRoot);
  if (rootNode.kind !== "directory") {
    throw new WorkerCellFilesystemError("not_a_directory", "Remote worker cell root is not a directory.");
  }
  const rootDeviceId = rootNode.deviceId;
  const seen = new Set<string>();
  let uniquePhysicalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;
  let visited = 0;

  const stack: Array<{ absolutePath: string; node: WorkerCellFilesystemNode; depth: number }> = [
    { absolutePath: resolvedRoot, node: rootNode, depth: 0 },
  ];

  while (stack.length > 0) {
    const { absolutePath, node, depth } = stack.pop()!;
    visited += 1;
    if (visited > maxEntries) {
      throw new WorkerCellFilesystemError("scan_bounds", "Remote worker cell scan exceeded the entry bound.");
    }
    if (SUSPICIOUS_KINDS.has(node.kind)) {
      throw new WorkerCellFilesystemError(
        "unsafe_node",
        `Remote worker cell scan rejected a ${node.kind} node (fail closed).`,
      );
    }
    if (node.deviceId !== rootDeviceId) {
      throw new WorkerCellFilesystemError("mount_crossing", "Remote worker cell scan rejected a mount crossing.");
    }
    if (node.kind === "hard_link_extra" || (node.kind === "file" && node.hardLinkCount > 1)) {
      throw new WorkerCellFilesystemError("hard_link", "Remote worker cell scan rejected a hard-linked node.");
    }

    const identity = `${node.deviceId}:${node.inode}`;
    const counted = seen.has(identity);
    if (!counted) seen.add(identity);

    if (node.kind === "directory") {
      directoryCount += 1;
      if (!counted) uniquePhysicalBytes += node.physicalBytes;
      if (depth >= maxDepth) {
        throw new WorkerCellFilesystemError("scan_bounds", "Remote worker cell scan exceeded the depth bound.");
      }
      for (const name of probe.readdir(absolutePath)) {
        if (name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\")) {
          throw new WorkerCellFilesystemError("unsafe_node", "Remote worker cell scan rejected an unsafe entry name.");
        }
        const childPath = path.join(absolutePath, name);
        stack.push({ absolutePath: childPath, node: probe.probe(childPath), depth: depth + 1 });
      }
      continue;
    }

    // Regular file.
    fileCount += 1;
    if (!counted) uniquePhysicalBytes += node.physicalBytes;
  }

  return {
    rootDeviceId,
    uniquePhysicalBytes,
    fileCount,
    directoryCount,
    uniqueInodeCount: seen.size,
  };
}

export interface WorkerCellReparseInspector {
  /** True when the OS reports a reparse point / junction at the path (Windows). */
  isReparsePoint(absolutePath: string): boolean;
}

/**
 * Real single-host probe: `fs.lstatSync` (no-follow) plus an injected Windows
 * reparse inspector. Any non-file/non-directory node, symlink, or reparse point
 * is surfaced as a suspicious kind so the scan fails closed.
 */
export class NodeWorkerCellFilesystemProbe implements WorkerCellFilesystemProbe {
  public constructor(private readonly reparseInspector?: WorkerCellReparseInspector) {}

  public probe(absolutePath: string): WorkerCellFilesystemNode {
    const stat = fs.lstatSync(absolutePath, { bigint: false });
    const name = path.basename(absolutePath);
    let kind: WorkerCellFilesystemNodeKind = "unknown";
    if (stat.isSymbolicLink()) kind = "symlink";
    else if (stat.isCharacterDevice() || stat.isBlockDevice()) kind = "device";
    else if (stat.isFIFO()) kind = "fifo";
    else if (stat.isSocket()) kind = "socket";
    else if (stat.isDirectory()) kind = "directory";
    else if (stat.isFile()) kind = "file";
    if ((kind === "directory" || kind === "file") && this.reparseInspector?.isReparsePoint(absolutePath)) {
      kind = "reparse_point";
    }
    return {
      name,
      kind,
      physicalBytes: Number(stat.blocks) > 0 ? Number(stat.blocks) * 512 : stat.size,
      deviceId: Number(stat.dev),
      inode: Number(stat.ino),
      hardLinkCount: Number(stat.nlink),
    };
  }

  public readdir(absolutePath: string): string[] {
    return fs.readdirSync(absolutePath, { encoding: "utf8" });
  }
}

function boundedPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}
