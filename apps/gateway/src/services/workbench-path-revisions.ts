import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ConflictError, NotFoundError, ValidationError,
  type ChatSessionWorkbenchFileOperationPreviewRequest,
  type ChatSessionWorkbenchFileOperationPreviewResponse,
} from "@goatcitadel/contracts";

const MAX_PATHS = 500;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 32;

export interface WorkbenchPathScope {
  sessionId: string;
  projectId: string;
  projectRoot: string;
  assertAllowed(targetPath: string): void;
}

export function workbenchPathConflict(): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The file action's source, destination or project changed. Review the action again before applying it.",
    details: { reason: "WORKBENCH_PATH_REVISION_CONFLICT" },
  });
}

/** Caller holds the physical project's Workbench lock for the whole review/apply. */
export async function readWorkbenchPathRevision(
  scope: WorkbenchPathScope,
  input: ChatSessionWorkbenchFileOperationPreviewRequest,
): Promise<ChatSessionWorkbenchFileOperationPreviewResponse> {
  const source = path.resolve(scope.projectRoot, input.path);
  const destination = input.targetPath ? path.resolve(scope.projectRoot, input.targetPath) : undefined;
  const creating = input.operation === "create_file" || input.operation === "create_folder";
  const hash = createHash("sha256");
  const bind = (value: unknown) => { hash.update(JSON.stringify(value)); hash.update("\n"); };
  const parents = [...new Set([scope.projectRoot, path.dirname(source), ...(destination ? [path.dirname(destination)] : [])])];
  const parentIdentities = await Promise.all(parents.map((parent) => readParent(scope, parent)));
  bind(["workbench-path-v1", scope.sessionId, scope.projectId, await fs.realpath(scope.projectRoot), input, parentIdentities]);
  const affectedPaths: ChatSessionWorkbenchFileOperationPreviewResponse["affectedPaths"] = [];
  let totalBytes = 0;

  const visit = async (target: string, depth: number): Promise<"file" | "directory"> => {
    if (depth > MAX_DEPTH || affectedPaths.length >= MAX_PATHS) throw reviewLimit();
    scope.assertAllowed(target);
    const before = await fs.lstat(target, { bigint: true });
    if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
      throw new ValidationError({ message: "File action reviews require regular files and folders without symbolic links or junctions." });
    }
    const relativePath = path.relative(scope.projectRoot, target).replaceAll("\\", "/");
    const kind = before.isDirectory() ? "directory" : "file";
    affectedPaths.push({ path: relativePath, kind, sizeBytes: kind === "file" ? Number(before.size) : 0 });
    bind([relativePath, kind, fingerprint(before)]);
    if (kind === "directory") {
      const names: string[] = [];
      const directory = await fs.opendir(target);
      for await (const entry of directory) {
        names.push(entry.name);
        if (names.length + affectedPaths.length > MAX_PATHS) throw reviewLimit();
      }
      names.sort();
      bind(names);
      for (const name of names) await visit(path.join(target, name), depth + 1);
    } else {
      if (before.size > BigInt(MAX_BYTES - totalBytes)) throw reviewLimit();
      const file = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        if (fingerprint(await file.stat({ bigint: true })) !== fingerprint(before)) throw workbenchPathConflict();
        const contentHash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          totalBytes += bytesRead;
          if (totalBytes > MAX_BYTES) throw reviewLimit();
          contentHash.update(buffer.subarray(0, bytesRead));
        }
        if (offset !== Number(before.size) || fingerprint(await file.stat({ bigint: true })) !== fingerprint(before)) {
          throw workbenchPathConflict();
        }
        bind(contentHash.digest("hex"));
      } finally { await file.close(); }
    }
    scope.assertAllowed(target);
    if (fingerprint(await fs.lstat(target, { bigint: true })) !== fingerprint(before)) throw workbenchPathConflict();
    return kind;
  };

  let sourceKind: ChatSessionWorkbenchFileOperationPreviewResponse["sourceKind"];
  if (creating) {
    await assertAbsent(source, input.path);
    sourceKind = "absent";
  } else {
    if (!(await lstatOptional(source))) throw new NotFoundError({ entity: "Workbench file action path", id: input.path });
    sourceKind = await visit(source, 0);
    if (input.operation === "duplicate" && (sourceKind !== "file" || totalBytes > 256 * 1024)) {
      throw new ValidationError({ message: "Duplicate supports files of at most 262144 bytes only." });
    }
  }
  if (destination) await assertAbsent(destination, input.targetPath!);
  // Parent timestamps change when unrelated siblings or the Workbench lock change.
  // Bind physical identity and access mode, without invalidating unrelated actions.
  const currentParents = await Promise.all(parents.map((parent) => readParent(scope, parent)));
  if (JSON.stringify(parentIdentities) !== JSON.stringify(currentParents)) throw workbenchPathConflict();
  bind([sourceKind, destination ? "destination-absent" : null]);
  return { revision: hash.digest("hex"), input, sourceKind, affectedPaths, totalBytes };
}

async function readParent(scope: WorkbenchPathScope, parent: string): Promise<string[]> {
  scope.assertAllowed(parent);
  const stat = await fs.lstat(parent, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ValidationError({ message: "Workbench file action parent must be an existing folder without a symbolic link or junction." });
  }
  return [await fs.realpath(parent), stat.dev, stat.ino, stat.birthtimeNs, stat.mode].map(String);
}

async function lstatOptional(target: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(target, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function assertAbsent(target: string, relativePath: string): Promise<void> {
  if (await lstatOptional(target)) {
    throw new ValidationError({ message: `Workbench file action target already exists: ${relativePath}` });
  }
}

function fingerprint(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs, stat.size, stat.mode, stat.nlink].join(":");
}

function reviewLimit(): ValidationError {
  return new ValidationError({ message: "This file action is too large to review safely. Select a smaller scope (at most 500 paths, 32 MiB and 32 folder levels)." });
}
