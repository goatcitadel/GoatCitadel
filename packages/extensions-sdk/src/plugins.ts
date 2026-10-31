import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  PLUGIN_LIMITS,
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  type PluginManifestParse,
} from "@goatcitadel/contracts";

export {
  PLUGIN_LIMITS,
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  pluginManifestSchema,
} from "@goatcitadel/contracts";
export type {
  PluginManifest,
  PluginManifestParse,
  PluginManifestRefusalCode,
  PluginPiece,
  PluginPieceKind,
  PluginPin,
  PluginSource,
  PluginTrust,
} from "@goatcitadel/contracts";

type Refusal = Extract<PluginManifestParse, { ok: false }>;

/**
 * Read and check `goatcitadel-plugin.json` in a plugin folder.
 *
 * This only reads the one file. It never runs, imports or requires anything from the folder, and it reads at most
 * `PLUGIN_LIMITS.maxManifestBytes + 1` bytes of it, however large the file is. A manifest that is a symbolic link, or
 * anything but a regular file, is refused. A refusal comes back as a value; this does not throw for a bad folder.
 */
export async function loadPluginManifest(dir: string): Promise<PluginManifestParse> {
  const filePath = path.join(dir, PLUGIN_MANIFEST_FILENAME);

  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    return unreadable(error);
  }
  if (info.isSymbolicLink()) {
    return invalid(`${PLUGIN_MANIFEST_FILENAME} is a link. It has to be a file in the plugin folder.`);
  }
  if (!info.isFile()) return invalid(`${PLUGIN_MANIFEST_FILENAME} isn't a regular file.`);
  if (info.size > PLUGIN_LIMITS.maxManifestBytes) return tooLarge();

  let bytes: Uint8Array;
  try {
    bytes = await readAtMost(filePath, PLUGIN_LIMITS.maxManifestBytes + 1);
  } catch (error) {
    return unreadable(error);
  }
  if (bytes.byteLength > PLUGIN_LIMITS.maxManifestBytes) return tooLarge();

  let text: string;
  try {
    // Keep a byte-order mark in the text so the hash covers every byte of the file; the parser reads past it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid(`${PLUGIN_MANIFEST_FILENAME} isn't valid UTF-8 text.`);
  }
  return parsePluginManifest(text);
}

/** Up to `limit` bytes from the start of a file, without following a link at the final step. */
async function readAtMost(filePath: string, limit: number): Promise<Uint8Array> {
  // O_NOFOLLOW is not defined on Windows; the earlier lstat covers a link there.
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
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
  if (errno === "ELOOP") {
    return invalid(`${PLUGIN_MANIFEST_FILENAME} is a link. It has to be a file in the plugin folder.`);
  }
  const absent = errno === "ENOENT" || errno === "ENOTDIR";
  return {
    ok: false,
    code: "MANIFEST_MISSING",
    message: absent
      ? `There is no ${PLUGIN_MANIFEST_FILENAME} in the plugin folder.`
      : `${PLUGIN_MANIFEST_FILENAME} can't be read (${errno}).`,
  };
}

function invalid(message: string): Refusal {
  return { ok: false, code: "MANIFEST_INVALID", message };
}

function tooLarge(): Refusal {
  return {
    ok: false,
    code: "MANIFEST_TOO_LARGE",
    message: `The manifest is over ${PLUGIN_LIMITS.maxManifestBytes / 1024} KiB, which is the most it can be.`,
  };
}
