import {
  GoatError,
  PLUGIN_ID_PATTERN,
  isGoatError,
  type McpServerRecord,
  type SkillSourceProvider,
} from "@goatcitadel/contracts";
import { findPluginOwning, type StoredPlugin } from "./capability-plugin-store.js";
import { withoutControls } from "./plugin-plain-text.js";

// A plugin's pieces are read-only to every other editor: the operator can switch them, connect them and sign them in,
// and only the plugin's own install and uninstall change or remove them. Each owner refuses with the error here, decided
// from what it already loaded.

/** The plugin that added a piece, as its own record names it. */
export interface PluginPieceOwner {
  readonly pluginId: string;
  readonly name: string;
}

/** What the plugin service passes to change or remove its own piece: the plugin and the install that added it. */
export interface PluginPass {
  readonly pluginId: string;
  readonly installPlanId: string;
}

/** A piece the owner knows came with a plugin, but whose plugin it can't name from its own record. */
export interface UnnamedPluginPiece {
  readonly kind: "skill" | "prompt_pack";
  /** The Skill Hub check's id, or the prompt pack's id. */
  readonly ref: string;
  /** Known when the piece's own record names it: a plugin skill's source does. */
  readonly pluginId?: string;
}

const UNNAMED_MESSAGES: Record<UnnamedPluginPiece["kind"], string> = {
  skill: "This skill came with a plugin that isn't installed.",
  prompt_pack: "This prompt pack came with a plugin that isn't installed.",
};
const SKILL_NEEDS_INSTALL_MESSAGE = "This skill came with a plugin. Install the plugin to use it.";
/**
 * The note on a plugin skill's step that is declined for the operator: its plugin was uninstalled, or began
 * uninstalling, while the step was asked for, so the step could switch on a skill no plugin lists.
 */
export const PLUGIN_SKILL_STEP_DECLINED_NOTE =
  "Declined for you: the plugin this skill came with was being uninstalled when this step was asked for.";
/** What a Skill Hub review records as the source of a plugin's skill (the review's own `PLUGIN_SOURCE_PROVIDER`). */
const PLUGIN_SOURCE_PROVIDER: SkillSourceProvider = "goatcitadel_plugin";
/** A plugin skill's source: `plugin:<pluginId>/<pieceId>@<pin>`. */
const PLUGIN_SKILL_SOURCE_PATTERN = /^plugin:([^/]+)\//u;
/** The id an install gives a plugin's prompt pack: `plugin-<pluginId>-<pieceId>`. */
const PLUGIN_PROMPT_PACK_PREFIX = "plugin-";
/** The only keys an edit may carry and still be just a switch: on or off, with the revision the operator reviewed. */
const SWITCH_ONLY_KEYS: ReadonlySet<string> = new Set(["enabled", "expectedRevision"]);

/** 409 `PLUGIN_OWNED`: a piece a plugin added, which only uninstalling the plugin removes. */
export class PluginOwnedError extends GoatError {
  public readonly code = "PLUGIN_OWNED" as const;
  public readonly httpStatus = 409;
  /** Set when the plugin couldn't be named, so a caller that can read the plugin store names it. */
  public readonly unnamedPiece: UnnamedPluginPiece | undefined;

  public constructor(owner: PluginPieceOwner | UnnamedPluginPiece) {
    const named = "name" in owner;
    super(
      // An old or hand-edited record's name may carry controls; the refusal reaches plan summaries as it is (Q7).
      named ? withoutControls(`From ${owner.name}. Uninstall it to remove this.`) : UNNAMED_MESSAGES[owner.kind],
      owner.pluginId ? { pluginId: owner.pluginId } : undefined,
    );
    this.unnamedPiece = named ? undefined : { ...owner };
  }
}

/**
 * 409 `PLUGIN_OWNED`: an install step on a plugin's skill whose plugin isn't being installed, or isn't installed, in
 * this workspace with that skill listed. Installing the plugin is the only way its skills come in. It already says
 * what to do, so nothing names it after a plugin.
 */
export class PluginSkillNeedsInstallError extends GoatError {
  public readonly code = "PLUGIN_OWNED" as const;
  public readonly httpStatus = 409;

  public constructor(pluginId: string | undefined) {
    super(SKILL_NEEDS_INSTALL_MESSAGE, pluginId ? { pluginId } : undefined);
  }
}

export function isPluginOwnedError(error: unknown): error is PluginOwnedError {
  return error instanceof PluginOwnedError || (isGoatError(error) && error.code === "PLUGIN_OWNED");
}

/**
 * Whether a Skill Hub check came with a plugin: undefined for any other check, otherwise the plugin its source names
 * (`pluginId` undefined when the source names none GoatCitadel could have written).
 */
export function pluginSkillSource(snapshot: {
  sourceProvider: string;
  sourceRef: string;
}): { pluginId: string | undefined } | undefined {
  if (snapshot.sourceProvider !== PLUGIN_SOURCE_PROVIDER) return undefined;
  const named = PLUGIN_SKILL_SOURCE_PATTERN.exec(snapshot.sourceRef)?.[1];
  return { pluginId: named && PLUGIN_ID_PATTERN.test(named) ? named : undefined };
}

/** The refusal named after the installed plugin that added the piece, or the refusal as it was when none did. */
export function namePluginOwnedError(error: PluginOwnedError, plugins: readonly StoredPlugin[]): PluginOwnedError {
  const piece = error.unnamedPiece;
  if (!piece) return error;
  const plugin = piece.pluginId
    ? plugins.find((candidate) => candidate.pluginId === piece.pluginId)
    : findPluginOwning(plugins, piece.kind, piece.ref);
  return plugin ? new PluginOwnedError({ pluginId: plugin.pluginId, name: plugin.name }) : error;
}

/** True when an edit only switches its piece on or off: every other field is left out. */
export function switchesOnlyOnOrOff(input: object): boolean {
  return Object.entries(input).every(([key, value]) => value === undefined || SWITCH_ONLY_KEYS.has(key));
}

/** The plugin's own pass names the plugin and the install that added the piece. */
function passFits(owner: PluginPieceOwner & { installPlanId: string }, pass: PluginPass | undefined): boolean {
  return pass !== undefined && pass.pluginId === owner.pluginId && pass.installPlanId === owner.installPlanId;
}

/** An edit of a plugin's connector is refused unless it only switches it, or the plugin's own pass is given. */
export function assertMcpServerEditAllowed(server: McpServerRecord, input: object, pass?: PluginPass): void {
  const owner = server.pluginOwner;
  if (!owner || switchesOnlyOnOrOff(input) || passFits(owner, pass)) return;
  throw new PluginOwnedError(owner);
}

/** Removing a plugin's connector is refused unless the plugin's own pass is given. */
export function assertMcpServerRemovalAllowed(server: McpServerRecord | undefined, pass?: PluginPass): void {
  const owner = server?.pluginOwner;
  if (!owner || passFits(owner, pass)) return;
  throw new PluginOwnedError(owner);
}

/** Refuses a change to a piece a plugin added, read through the owner's plain reader, unless the pass is that plugin's. */
export async function assertNotPluginOwned(
  findOwner: ((ref: string) => Promise<(PluginPieceOwner & { installPlanId: string }) | undefined>) | undefined,
  ref: string,
  pass?: PluginPass,
): Promise<void> {
  const owner = await findOwner?.(ref);
  if (!owner || passFits(owner, pass)) return;
  throw new PluginOwnedError({ pluginId: owner.pluginId, name: owner.name });
}

/**
 * An import or reset of a `plugin-` prompt pack is refused: the id says a plugin added it. The plugin's install creates
 * its pack through the guarded create-if-absent, whose key is the pack's own id, so that create-only key is the pass.
 */
export function assertPromptPackIdNotFromPlugin(packId: string | undefined, createOnlyKey?: string): void {
  if (!packId?.startsWith(PLUGIN_PROMPT_PACK_PREFIX) || createOnlyKey === packId) return;
  throw new PluginOwnedError({ kind: "prompt_pack", ref: packId });
}

/**
 * Every Skill Hub step on a check that came with a plugin is refused unless that plugin's own pass is given. A plugin
 * check whose source doesn't name a plugin is refused whatever the pass says.
 */
export function assertSkillHubSnapshotNotFromPlugin(
  snapshot: { snapshotId: string; sourceProvider: string; sourceRef: string },
  pass?: { pluginId: string },
): void {
  const source = pluginSkillSource(snapshot);
  if (!source) return;
  const { pluginId } = source;
  if (pluginId && pass?.pluginId === pluginId) return;
  throw new PluginOwnedError({ kind: "skill", ref: snapshot.snapshotId, ...(pluginId ? { pluginId } : {}) });
}
