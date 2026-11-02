import fs from "node:fs/promises";
import path from "node:path";
import { PLUGIN_LIMITS, isPortablePluginPath } from "@goatcitadel/contracts";

// Plain reads inside one plugin snapshot, for the Claude Code translator. Every path is relative with `/` separators,
// checked with `isPortablePluginPath` and resolved under the snapshot; nothing follows a link, and a JSON read never
// takes more than the manifest limit. Nothing here writes, runs or fetches.

export type SnapshotJsonRead =
  | { kind: "ok"; value: unknown; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "unreadable" };

export class ClaudeCodePluginFiles {
  public constructor(private readonly snapshotDir: string) {}

  /** The absolute path of a portable relative path inside the snapshot, or undefined. */
  public resolve(relativePath: string): string | undefined {
    if (!isPortablePluginPath(relativePath)) return undefined;
    const root = path.resolve(this.snapshotDir);
    const target = path.resolve(root, ...relativePath.split("/"));
    return target.startsWith(root + path.sep) ? target : undefined;
  }

  /** `file`, `dir` or undefined (missing, a link, or anything else). */
  public async kindOf(relativePath: string): Promise<"file" | "dir" | undefined> {
    const target = this.resolve(relativePath);
    if (target === undefined) return undefined;
    try {
      const stat = await fs.lstat(target);
      return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : undefined;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** A folder's plain files and folders, sorted by name. A missing folder lists nothing. */
  public async list(relativePath: string): Promise<Array<{ name: string; kind: "file" | "dir" }>> {
    if ((await this.kindOf(relativePath)) !== "dir") return [];
    const entries = await fs.readdir(this.resolve(relativePath)!, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() || entry.isDirectory())
      .map((entry) => ({ name: entry.name, kind: entry.isFile() ? ("file" as const) : ("dir" as const) }))
      .filter((entry) => isPortablePluginPath(`${relativePath}/${entry.name}`))
      .sort((left, right) => compareStrings(left.name, right.name));
  }

  /** Every plain file under a folder, as relative paths, sorted. */
  public async listFilesDeep(relativePath: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await this.list(relativePath)) {
      const child = `${relativePath}/${entry.name}`;
      if (entry.kind === "file") files.push(child);
      else files.push(...(await this.listFilesDeep(child)));
    }
    return files.sort(compareStrings);
  }

  /** A plain file's bytes, at most the manifest limit, parsed as JSON. A leading byte-order mark is allowed. */
  public async readJson(relativePath: string): Promise<SnapshotJsonRead> {
    const kind = await this.kindOf(relativePath);
    if (kind === undefined) return { kind: "missing" };
    if (kind !== "file") return { kind: "unreadable" };
    const target = this.resolve(relativePath)!;
    if ((await fs.lstat(target)).size > PLUGIN_LIMITS.maxManifestBytes) return { kind: "unreadable" };
    const bytes = await fs.readFile(target);
    if (bytes.byteLength > PLUGIN_LIMITS.maxManifestBytes) return { kind: "unreadable" };
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { kind: "ok", value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text), bytes };
    } catch {
      return { kind: "unreadable" };
    }
  }
}

/** A path as plugin.json writes it, without a leading `./`; undefined when it points outside the plugin. */
export function pluginRelativePath(raw: string): string | undefined {
  const trimmed = raw.replace(/^(?:\.\/)+/u, "").replace(/\/+$/u, "");
  return isPortablePluginPath(trimmed) ? trimmed : undefined;
}

/** A string, or the strings of an array; anything else gives none. */
export function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
