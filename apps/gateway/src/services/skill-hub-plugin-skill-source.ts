import path from "node:path";
import {
  PLUGIN_PIECE_ID_PATTERN,
  ValidationError,
  pluginManifestSchema,
  type PluginTrust,
  type SkillSourceProvider,
} from "@goatcitadel/contracts";
import { PluginSnapshotPathError } from "./plugin-snapshot-store.js";

// How the Skill Hub review reads one skill out of a plugin's stored copy. The review owns the checks; this file only
// turns the plugin skill the Gateway's plugin check handed it into a folder to read and the name the record keeps.

const PLUGIN_PIN_LABEL_PATTERN = /^(?:commit:[a-f0-9]{40}|content:[a-f0-9]{64})$/u;
const PLUGIN_TRUSTS: ReadonlySet<string> = new Set<PluginTrust>(["built_in", "unverified"]);

/** What a review records as the source of a plugin's skill. */
export const PLUGIN_SOURCE_PROVIDER: SkillSourceProvider = "goatcitadel_plugin";

/** `PluginSnapshotStore.resolve`: the folder of a stored copy, or of a path inside it. */
export type PluginSkillDirResolver = (treeSha256: string, path: string) => string;

/**
 * A skill that sits in a plugin's stored copy. Only the plugin inspection service builds one, from a manifest it has
 * read, so no route, request or Chat turn can name a folder or a trust level.
 */
export interface SkillHubPluginSkillInput {
  /** The SHA-256 of the plugin copy the skill sits in. */
  snapshotTreeSha256: string;
  /** The skill's own folder in the copy, with `/` separators. Its SKILL.md sits directly in it. */
  path: string;
  pluginId: string;
  pieceId: string;
  trust: PluginTrust;
  /** How the plugin was pinned: `commit:<40 hex>` or `content:<64 hex>`. */
  pinLabel: string;
}

/** What the record says in place of the folder the skill was read from, which it must not keep. */
export interface PluginSkillRecord {
  sourceRef: string;
  canonicalSourceKey: string;
  trust: PluginTrust;
}

export interface PluginSkillSource {
  /** The folder the import service reads. It stays out of the record. */
  sourceRef: string;
  sourceType: "local_path";
  plugin: PluginSkillRecord;
}

/**
 * Maps a plugin's skill to its folder in the stored copy. The stored copy answers only for a path inside itself, so no
 * caller-supplied path reaches the filesystem. Every refusal is a plain `ValidationError` on `pluginSkill`; none names a
 * folder on this computer.
 */
export function resolvePluginSkillSource(
  skill: SkillHubPluginSkillInput,
  otherSources: { packId?: string; sourceRef?: string },
  resolveDir: PluginSkillDirResolver | undefined,
): PluginSkillSource {
  // `cause` keeps an unexpected failure for the logs; like the native one it stays off the message and the wire shape.
  const refuse = (message: string, cause?: unknown): never => {
    const refusal = new ValidationError({ field: "pluginSkill", message });
    if (cause !== undefined) {
      Object.defineProperty(refusal, "cause", { value: cause, configurable: true, writable: true });
    }
    throw refusal;
  };
  if (typeof skill !== "object" || skill === null || Array.isArray(skill)) {
    return refuse("The plugin's skill details aren't valid.");
  }
  if (otherSources.packId !== undefined || otherSources.sourceRef !== undefined) {
    return refuse("Review a plugin's skill on its own, not together with a shipped skill pack or a source URL.");
  }
  if (!resolveDir) return refuse("Plugin skills are not available in this Gateway.");
  if (typeof skill.pluginId !== "string" || !pluginManifestSchema.shape.pluginId.safeParse(skill.pluginId).success) {
    return refuse("The plugin's id isn't valid.");
  }
  if (typeof skill.pieceId !== "string" || !PLUGIN_PIECE_ID_PATTERN.test(skill.pieceId)) {
    return refuse("The skill's id in the plugin isn't valid.");
  }
  if (typeof skill.pinLabel !== "string" || !PLUGIN_PIN_LABEL_PATTERN.test(skill.pinLabel)) {
    return refuse("The plugin's pin isn't a commit or a content hash.");
  }
  if (typeof skill.trust !== "string" || !PLUGIN_TRUSTS.has(skill.trust)) {
    return refuse("The plugin's trust isn't one GoatCitadel knows.");
  }
  if (typeof skill.snapshotTreeSha256 !== "string" || typeof skill.path !== "string" || skill.path.length === 0) {
    return refuse("The skill's place in the plugin isn't valid.");
  }
  let skillDir: string;
  try {
    skillDir = resolveDir(skill.snapshotTreeSha256, skill.path);
  } catch (error) {
    // The stored copy's own refusals are plain by design ("That plugin copy isn't on this computer."), so they pass
    // through. Anything else (a disk fault, say) can name folders: the operator gets a fixed message and the original
    // rides on `cause`.
    if (error instanceof PluginSnapshotPathError) return refuse(error.message);
    return refuse("That plugin's skill isn't available to review.", error);
  }
  const key = `plugin:${skill.pluginId}/${skill.pieceId}`;
  return {
    sourceRef: skillDir,
    sourceType: "local_path",
    plugin: { sourceRef: `${key}@${skill.pinLabel}`, canonicalSourceKey: key, trust: skill.trust },
  };
}

/** A plugin's skill keeps its SKILL.md directly in its own folder, so the review reads that folder and no other. */
export function assertPluginSkillFolder(source: Pick<PluginSkillSource, "sourceRef">, skillDir: string): void {
  if (path.resolve(skillDir) !== path.resolve(source.sourceRef)) {
    throw new ValidationError({
      field: "SOURCE_IDENTITY_MISMATCH",
      message: "A plugin's skill must keep its SKILL.md in the skill's own folder.",
    });
  }
}

/** The source a review records: the plugin's name for its skill, or else what the import service validated. */
export function recordedSource(
  plugin: PluginSkillRecord | undefined,
  candidate: { sourceProvider: string; sourceRef: string; canonicalKey: string },
): { sourceProvider: string; sourceRef: string; canonicalSourceKey: string } {
  return plugin
    ? {
        sourceProvider: PLUGIN_SOURCE_PROVIDER,
        sourceRef: plugin.sourceRef,
        canonicalSourceKey: plugin.canonicalSourceKey,
      }
    : {
        sourceProvider: candidate.sourceProvider,
        sourceRef: candidate.sourceRef,
        canonicalSourceKey: candidate.canonicalKey,
      };
}
