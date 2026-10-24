import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryFileSource } from "@goatcitadel/memory-core";

/** Bounded walk of a workspace memory folder for the memory context composer. */
export interface WalkOptions {
  maxFiles: number;
  maxBytesPerFile: number;
  allowedExtensions: string[];
}

export async function walkMemoryFiles(
  baseDir: string,
  workspaceRoot: string,
  options: WalkOptions,
): Promise<MemoryFileSource[]> {
  const out: MemoryFileSource[] = [];
  await walkRecursive(baseDir, workspaceRoot, out, options);
  return out;
}

async function walkRecursive(
  currentDir: string,
  workspaceRoot: string,
  out: MemoryFileSource[],
  options: WalkOptions,
): Promise<void> {
  if (out.length >= options.maxFiles) {
    return;
  }
  let entries: Array<{ isDirectory: () => boolean; isFile: () => boolean; name: string }>;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (out.length >= options.maxFiles) {
      return;
    }
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkRecursive(fullPath, workspaceRoot, out, options);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!options.allowedExtensions.includes(ext)) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }
    if (stat.size > options.maxBytesPerFile) {
      continue;
    }

    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }

    const relativePath = path.relative(workspaceRoot, fullPath).replaceAll("\\", "/");
    out.push({
      type: "file",
      relativePath,
      content,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
}
