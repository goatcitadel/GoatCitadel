import fs from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_CODE_PLUGIN_MANIFEST_PATH,
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  type CapabilityPluginIgnoredPart,
  type CapabilityPluginInspection,
  type McpServerTemplateRecord,
  type PluginManifestParse,
  type PluginSource,
} from "@goatcitadel/contracts";
import {
  CLAUDE_CODE_TRANSLATOR_VERSION,
  translateClaudeCodePlugin,
  type ClaudeCodeTranslation,
  type ClaudeCodeTranslatorLog,
} from "./claude-code-plugin-translator.js";
import { readPluginManifestFile } from "./plugin-manifest-file.js";

// Which manifest a plugin snapshot is read from. GoatCitadel's own `goatcitadel-plugin.json` always wins; a Claude Code
// `.claude-plugin/plugin.json` is translated only when that is missing, and never for a plugin that ships with
// GoatCitadel.

export type SnapshotManifestReading =
  | { format: "goatcitadel"; parsed: PluginManifestParse }
  | {
      format: "claude_code";
      parsed: PluginManifestParse;
      translation?: ClaudeCodeTranslation;
      /** On a refused translation, what it had found. */
      ignored: CapabilityPluginIgnoredPart[];
    };

/**
 * `goatcitadel-plugin.json` wins. Else `.claude-plugin/plugin.json` (a plain file) is translated. Else the native read,
 * which answers MANIFEST_MISSING. A refused translation is `parsed: { ok: false, code, message }`.
 */
export async function readSnapshotPluginManifest(input: {
  snapshotDir: string;
  treeSha256: string;
  templates: readonly McpServerTemplateRecord[];
  /** A `built_in` source is never translated. */
  sourceKind: PluginSource["kind"];
  log?: ClaudeCodeTranslatorLog;
}): Promise<SnapshotManifestReading> {
  const native = () => readPluginManifestFile(input.snapshotDir);
  if (input.sourceKind === "built_in" || (await exists(path.join(input.snapshotDir, PLUGIN_MANIFEST_FILENAME)))) {
    return { format: "goatcitadel", parsed: await native() };
  }
  if (!(await isPlainFile(path.join(input.snapshotDir, ...CLAUDE_CODE_PLUGIN_MANIFEST_PATH.split("/"))))) {
    return { format: "goatcitadel", parsed: await native() };
  }
  const result = await translateClaudeCodePlugin(input);
  if (!result.ok) {
    return {
      format: "claude_code",
      parsed: { ok: false, code: result.code, message: result.message },
      ignored: result.ignored,
    };
  }
  const { translation } = result;
  return {
    format: "claude_code",
    parsed: parsePluginManifest(translation.manifestText),
    translation,
    ignored: translation.ignored,
  };
}

/** What an inspection records about the manifest it was read from. A GoatCitadel manifest records no format. */
export function claudeCodeInspectionFields(
  reading: SnapshotManifestReading,
): Pick<CapabilityPluginInspection, "ignored" | "sourceFormat" | "claudeCode"> {
  if (reading.format !== "claude_code") return { ignored: [] };
  const { translation } = reading;
  return {
    ignored: reading.ignored,
    sourceFormat: "claude_code",
    ...(translation
      ? {
          claudeCode: {
            translatorVersion: CLAUDE_CODE_TRANSLATOR_VERSION,
            pluginJsonSha256: translation.pluginJsonSha256,
            coverage: translation.coverage,
          },
        }
      : {}),
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function isPlainFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
