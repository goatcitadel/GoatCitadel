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
import type { StoredClaudeCodeImport, StoredPlugin } from "./capability-plugin-store.js";
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

/** A manifest read, and, for a Claude Code plugin, the translation it came from. */
export type SnapshotManifestParse = PluginManifestParse & {
  claudeCode?: Omit<StoredClaudeCodeImport, "ignored" | "coverage">;
};

/**
 * The manifest a snapshot holds now, read fresh: GoatCitadel's own, or a new translation of a Claude Code plugin with
 * today's translator and connector catalog. What an install checks against the inspected manifest's hash. The read is
 * keyed by the tree alone; a built-in plugin's snapshot always holds goatcitadel-plugin.json, which wins.
 */
export async function readSnapshotManifestParse(input: {
  snapshotDir: string;
  treeSha256: string;
  templates: readonly McpServerTemplateRecord[];
  log?: ClaudeCodeTranslatorLog;
}): Promise<SnapshotManifestParse> {
  const reading = await readSnapshotPluginManifest({ ...input, sourceKind: "folder" });
  if (reading.format !== "claude_code" || !reading.translation || !reading.parsed.ok) return reading.parsed;
  const { translation } = reading;
  return {
    ...reading.parsed,
    claudeCode: {
      translatorVersion: CLAUDE_CODE_TRANSLATOR_VERSION,
      pluginJsonSha256: translation.pluginJsonSha256,
      manifestText: translation.manifestText,
    },
  };
}

/**
 * The manifest an installed plugin was installed from: an installed Claude Code plugin's kept text when a record with
 * this tree holds one, else the fresh read. A caller still compares the hash with the record's `manifestSha256`.
 */
export async function readInstalledPluginManifest(
  treeSha256: string,
  plugins: readonly Pick<StoredPlugin, "snapshotTreeSha256" | "claudeCode">[],
  readFresh: (treeSha256: string) => Promise<PluginManifestParse>,
): Promise<PluginManifestParse> {
  const kept = plugins.find((plugin) => plugin.snapshotTreeSha256 === treeSha256 && plugin.claudeCode?.manifestText);
  return kept?.claudeCode ? parsePluginManifest(kept.claudeCode.manifestText) : await readFresh(treeSha256);
}

/**
 * What an installed Claude Code plugin's record keeps: the translation read again when the plan bound (whose hash is
 * the checked one), with the left-out list and coverage from the check. A GoatCitadel plugin keeps none of it.
 */
export function claudeCodeRecordFields(
  inspection: Pick<CapabilityPluginInspection, "sourceFormat" | "claudeCode" | "ignored">,
  translation: SnapshotManifestParse["claudeCode"],
): Pick<StoredPlugin, "sourceFormat" | "claudeCode"> {
  if (inspection.sourceFormat !== "claude_code" || !translation || !inspection.claudeCode) return {};
  return {
    sourceFormat: "claude_code",
    claudeCode: {
      ...translation,
      ignored: inspection.ignored.map((part) => ({ ...part })),
      coverage: { ...inspection.claudeCode.coverage },
    },
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
