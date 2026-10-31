import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_LIMITS,
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  pluginManifestSchema,
  pluginManifestTooLarge,
  type PluginManifest,
  type PluginManifestParse,
} from "@goatcitadel/contracts";

// Reading a plugin's `goatcitadel-plugin.json` on the Gateway: the same bounded read as the extensions SDK's
// `loadPluginManifest`, with the same words, so a plugin author's preflight and GoatCitadel agree. It reads the one
// file, never more than the manifest limit and one byte, and never follows a link.

/** The most folders the built-in list looks at. GoatCitadel ships a handful; anything past this isn't read. */
const MAX_BUILT_IN_FOLDERS = 64;

type Refusal = Extract<PluginManifestParse, { ok: false }>;

/** The manifest at the top of a plugin folder, parsed. A missing, oversized or unreadable file is a refusal, not a throw. */
export async function readPluginManifestFile(dir: string): Promise<PluginManifestParse> {
  const filePath = path.join(dir, PLUGIN_MANIFEST_FILENAME);
  let info;
  try {
    info = await fs.lstat(filePath);
  } catch (error) {
    return unreadable(error);
  }
  if (info.isSymbolicLink()) return linked();
  if (!info.isFile()) return invalid(`${PLUGIN_MANIFEST_FILENAME} isn't a regular file.`);
  if (info.size > PLUGIN_LIMITS.maxManifestBytes) return pluginManifestTooLarge();

  let bytes: Uint8Array;
  try {
    bytes = await readAtMost(filePath, PLUGIN_LIMITS.maxManifestBytes + 1);
  } catch (error) {
    return unreadable(error);
  }
  if (bytes.byteLength > PLUGIN_LIMITS.maxManifestBytes) return pluginManifestTooLarge();
  let text: string;
  try {
    // A byte-order mark stays in the text, so the hash covers every byte of the file; the parser reads past it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid(`${PLUGIN_MANIFEST_FILENAME} isn't valid UTF-8 text.`);
  }
  return parsePluginManifest(text);
}

/**
 * The manifests of the plugins that ship with GoatCitadel: each plain folder under `builtInRoot` whose name is a plugin
 * id and whose manifest names that same id (the id a built-in install asks for). A folder whose manifest is missing,
 * too large or refused is left out. Nothing is copied, fetched or checked, and a missing root lists nothing.
 */
export async function listBuiltInPluginManifests(builtInRoot: string): Promise<PluginManifest[]> {
  let dir;
  try {
    dir = await fs.opendir(builtInRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const folders: string[] = [];
  // A link (or a Windows junction) isn't a directory entry here: only plain folders ship.
  for await (const entry of dir) {
    if (!entry.isDirectory() || !isPluginId(entry.name)) continue;
    folders.push(entry.name);
    if (folders.length >= MAX_BUILT_IN_FOLDERS) break;
  }
  const manifests: PluginManifest[] = [];
  for (const folder of folders.sort()) {
    const parsed = await readPluginManifestFile(path.join(builtInRoot, folder));
    if (parsed.ok && parsed.manifest.pluginId === folder) manifests.push(parsed.manifest);
  }
  return manifests;
}

/** Whether `value` is a plugin id by the manifest's own rule. */
export function isPluginId(value: string): boolean {
  return pluginManifestSchema.shape.pluginId.safeParse(value).success;
}

/** Up to `limit` bytes from the start of a file, without following a link at the final step. */
async function readAtMost(filePath: string, limit: number): Promise<Uint8Array> {
  // O_NOFOLLOW is not defined on Windows; the lstat before this covers a link there.
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new NotARegularFile();
    const buffer = Buffer.alloc(limit);
    let total = 0;
    while (total < limit) {
      const { bytesRead } = await handle.read(buffer, total, limit - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

class NotARegularFile extends Error {}

function unreadable(error: unknown): Refusal {
  if (error instanceof NotARegularFile) return invalid(`${PLUGIN_MANIFEST_FILENAME} isn't a regular file.`);
  const errno = (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown error";
  if (errno === "ELOOP") return linked();
  const absent = errno === "ENOENT" || errno === "ENOTDIR";
  return {
    ok: false,
    code: "MANIFEST_MISSING",
    message: absent
      ? `There is no ${PLUGIN_MANIFEST_FILENAME} in the plugin folder.`
      : `${PLUGIN_MANIFEST_FILENAME} can't be read (${errno}).`,
  };
}

function linked(): Refusal {
  return invalid(`${PLUGIN_MANIFEST_FILENAME} is a link. It has to be a file in the plugin folder.`);
}

function invalid(message: string): Refusal {
  return { ok: false, code: "MANIFEST_INVALID", message };
}
