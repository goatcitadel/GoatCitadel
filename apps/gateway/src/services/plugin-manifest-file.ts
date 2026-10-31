import fs from "node:fs/promises";
import path from "node:path";
import { pluginManifestSchema, type PluginManifest, type PluginManifestParse } from "@goatcitadel/contracts";
import { loadPluginManifest } from "@goatcitadel/extensions-sdk";

// Reading plugin manifests on the Gateway. The read itself is the extensions SDK's own `loadPluginManifest`, the one
// a plugin author's preflight runs: it reads only `goatcitadel-plugin.json`, never more than the manifest limit and one
// byte, never follows a link, and answers a refusal rather than throwing.

/** The most built-in plugins listed. GoatCitadel ships a handful; past this, the first by folder name are listed. */
const MAX_BUILT_IN_FOLDERS = 64;
/** The most entries of the built-in folder looked at, so a huge folder is never read in full. */
const MAX_BUILT_IN_ENTRIES = 4096;

/** The manifest at the top of a plugin folder, parsed. A missing, oversized or unreadable file is a refusal. */
export function readPluginManifestFile(dir: string): Promise<PluginManifestParse> {
  return loadPluginManifest(dir);
}

/**
 * The manifests of the plugins that ship with GoatCitadel: each plain folder under `builtInRoot` whose name is a plugin
 * id and whose manifest names that same id (the id a built-in install asks for), the first 64 by name. A folder whose
 * manifest is missing, too large or refused is left out. Nothing is copied, fetched or checked, and a missing root
 * lists nothing.
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
  let entries = 0;
  // A link (or a Windows junction) isn't a directory entry here: only plain folders ship.
  for await (const entry of dir) {
    entries += 1;
    if (entries > MAX_BUILT_IN_ENTRIES) break;
    if (entry.isDirectory() && isPluginId(entry.name)) folders.push(entry.name);
  }
  const manifests: PluginManifest[] = [];
  // Sorted before the cap, so which plugins are listed never depends on the order the disk hands them back.
  for (const folder of folders.sort().slice(0, MAX_BUILT_IN_FOLDERS)) {
    const parsed = await readPluginManifestFile(path.join(builtInRoot, folder));
    if (parsed.ok && parsed.manifest.pluginId === folder) manifests.push(parsed.manifest);
  }
  return manifests;
}

/** Whether `value` is a plugin id by the manifest's own rule. */
export function isPluginId(value: string): boolean {
  return pluginManifestSchema.shape.pluginId.safeParse(value).success;
}
