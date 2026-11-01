import {
  NotFoundError,
  type ApprovalRequest,
  type CapabilityPluginDetail,
  type CapabilityPluginInspection,
  type CapabilityPluginListItem,
  type CapabilityPluginListResponse,
  type ChangePlanStatus,
  type PluginActionOutcome,
  type PluginManifest,
  type PluginManifestParse,
  type PluginPieceKind,
} from "@goatcitadel/contracts";
import type {
  CapabilityPluginInstallInput,
  CapabilityPluginUninstallInput,
} from "./capability-plugin-actions-service.js";
import {
  buildPluginDetailPieces,
  describePluginPieces,
  installPlanEnded,
  needsInstallPlan,
  needsUninstallPlan,
  pluginPublicState,
  skillCheckIds,
  type PluginPieceLabel,
} from "./capability-plugin-detail.js";
import type { CapabilityPluginInspectInput } from "./capability-plugin-inspection-service.js";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { namePluginOwnedError, type PluginOwnedError } from "./plugin-owned-refusal.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";

const BUILT_IN_DISPLAY = "Ships with GoatCitadel";
const INSPECTION_NOT_FOUND_MESSAGE = "That plugin check wasn't found, or it ran out of time. Check the plugin again.";
const PLUGIN_NOT_INSTALLED_MESSAGE = "This plugin isn't installed.";
const MANIFEST_NOT_INSTALLED_ONE = "The plugin's stored copy doesn't hold the manifest it was installed from.";

/**
 * A source that can fail on its own, leaving its part out rather than the whole answer: the list's built-in plugins and
 * Skill Hub checks, the plugin store a refusal reads its plugin's name from, and a detail's install plan and snapshot.
 */
export type CapabilityPluginsSource =
  | "built_in"
  | "skill_hub"
  | "plugin_store"
  | "install_plan"
  | "snapshot"
  | "approval";

/** One reader per place the Plugins tab is built from, each through its existing owner. Only `inspect` keeps anything. */
export interface CapabilityPluginsRouteSources {
  /** The plugin store's records. */
  listInstalled(): Promise<readonly StoredPlugin[]>;
  /** The manifests of the plugins shipped under `<rootDir>/plugins`. */
  listBuiltIn(): Promise<readonly PluginManifest[]>;
  /**
   * A workspace's Skill Hub checks by their ids, whatever their place among its newest checks: what a plugin's skill
   * pieces are read from. A check that isn't there is left out.
   */
  readSkillChecks(workspaceId: string, snapshotIds: readonly string[]): Promise<ReadonlyMap<string, PluginSkillCheck>>;
  /** A plugin plan's status (its install's, or its uninstall's), read in the plugin's workspace as the operator who asked. */
  readInstallPlanStatus(workspaceId: string, planId: string, actorId: string): Promise<ChangePlanStatus>;
  /** Where an approval stands; undefined when it can't be read (the failure is reported by the reader). */
  readApprovalStatus(approvalId: string): Promise<ApprovalRequest["status"] | undefined>;
  /** The manifest in a snapshot, read again. */
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  /** A file in a snapshot, as text. */
  readSnapshotText(treeSha256: string, relativePath: string): Promise<string>;
  /** Fetches a source and checks every piece. It installs nothing. */
  inspect(input: CapabilityPluginInspectInput): Promise<CapabilityPluginInspection>;
  /** A kept inspection that hasn't run out of time. */
  readInspection(inspectionId: string): Promise<CapabilityPluginInspection | undefined>;
  /** Installs an inspection's pieces through one Change Plan the operator confirms with this click. */
  install(input: CapabilityPluginInstallInput): Promise<PluginActionOutcome>;
  /** Removes exactly what a plugin added through one Change Plan the operator confirms with this click. */
  uninstall(input: CapabilityPluginUninstallInput): Promise<PluginActionOutcome>;
  /** The first read of the tool groups plugins hold off, which startup awaits before any chat runs. */
  loadToolGroupHolds(): Promise<void>;
  /** Called with the real error of a part that couldn't be read, so the answer carries none of it. */
  reportFailure(source: CapabilityPluginsSource, error: unknown): void;
}

/**
 * Capabilities › Plugins: the installed plugins and the built-in ones, a plugin source's inspection, and reading an
 * inspection back. Plugins are install-wide; each installed plugin's skills are read from the workspace it was installed
 * in.
 */
export class CapabilityPluginsRouteService {
  public constructor(private readonly sources: CapabilityPluginsRouteSources) {}

  /**
   * Installed records come from the store, which must be readable. A plugin reads `installed` only when its install
   * finished and every piece is added or kept, its skills switched on (`pluginPublicState`, the detail's own rule).
   * Each skill is read by its check's id; a check that can't be read reads as not finished. `builtIn` lists every
   * shipped plugin that isn't installed, from its manifest alone: nothing is fetched or checked.
   */
  public async list(): Promise<CapabilityPluginListResponse> {
    const [installed, builtIn] = await Promise.all([this.sources.listInstalled(), this.readBuiltIn()]);
    const checks = await this.readInstalledSkillChecks(installed);
    const installedIds = new Set(installed.map((plugin) => plugin.pluginId));
    return {
      installed: byName(
        installed.map((plugin) =>
          listItem(plugin, pluginPublicState(plugin, { skillChecks: checks.get(plugin.workspaceId) })),
        ),
      ),
      builtIn: byName(
        builtIn
          .filter((manifest) => !installedIds.has(manifest.pluginId))
          .map(
            (manifest): CapabilityPluginListItem => ({
              pluginId: manifest.pluginId,
              name: manifest.name,
              description: manifest.description,
              version: manifest.version,
              trust: "built_in",
              sourceDisplay: BUILT_IN_DISPLAY,
              state: "available",
              pieceCounts: countPieces(manifest.pieces),
            }),
          ),
      ),
    };
  }

  /**
   * One installed plugin and each of its pieces, install-wide like the list: its skills read by their checks' ids in the
   * workspace it was installed in, its install plan read only when a piece's state depends on it, and its labels from
   * the manifest in its snapshot. Reading writes nothing. A plugin that isn't installed is a 404. A part that can't be
   * read leaves its pieces `unknown` (or labelled by their ids), never added.
   */
  public async detail(input: { pluginId: string; actorId: string }): Promise<CapabilityPluginDetail> {
    const plugin = (await this.sources.listInstalled()).find((item) => item.pluginId === input.pluginId);
    if (!plugin) throw new NotFoundError(PLUGIN_NOT_INSTALLED_MESSAGE);
    const [skillChecks, installEnded, uninstallEnded, manifest] = await Promise.all([
      this.readSkillChecks(plugin.workspaceId, skillCheckIds(plugin)),
      needsInstallPlan(plugin) ? this.readPlanEnded(plugin, plugin.installPlanId, input.actorId) : undefined,
      needsUninstallPlan(plugin) && plugin.uninstallPlanId
        ? this.readPlanEnded(plugin, plugin.uninstallPlanId, input.actorId)
        : undefined,
      this.readInstalledManifest(plugin),
    ]);
    const readings = {
      skillChecks,
      installEnded,
      uninstallEnded,
      approvalStatuses: await this.readWaitingApprovals(plugin),
    };
    const labels = manifest ? await this.describePieces(plugin, manifest) : undefined;
    return {
      ...listItem(plugin, pluginPublicState(plugin, readings)),
      ...(manifest?.author ? { author: manifest.author } : {}),
      pin: plugin.pin,
      installPlanId: plugin.installPlanId,
      installedAt: plugin.installedAt,
      pieces: buildPluginDetailPieces(plugin, manifest, labels, readings),
    };
  }

  public inspect(input: CapabilityPluginInspectInput): Promise<CapabilityPluginInspection> {
    return this.sources.inspect(input);
  }

  /**
   * Installs a kept inspection's pieces through one Change Plan: applied at once when the operator's skip applies,
   * otherwise waiting for its approval in the Inbox. Every refusal comes before any secret is stored or plan is made.
   */
  public install(input: CapabilityPluginInstallInput): Promise<PluginActionOutcome> {
    return this.sources.install(input);
  }

  /**
   * Removes exactly what a plugin added through one Change Plan: applied at once when the operator's skip applies,
   * otherwise waiting for its approval in the Inbox; and waiting, with its approval, while a skill's removal waits.
   */
  public uninstall(input: CapabilityPluginUninstallInput): Promise<PluginActionOutcome> {
    return this.sources.uninstall(input);
  }

  /** Settles once the tool groups plugins hold off were first read, or that read's failure was reported. */
  public loadToolGroupHolds(): Promise<void> {
    return this.sources.loadToolGroupHolds();
  }

  /**
   * The refusal for a piece a plugin added, named after its plugin when that plugin's record is saved: what an owner's
   * route answers when the owner couldn't name it from its own record. A store that can't be read leaves the refusal as
   * it came, with the failure logged, so the lookup never turns a refusal into another error.
   */
  public async namePluginOwnedError(error: PluginOwnedError): Promise<PluginOwnedError> {
    if (!error.unnamedPiece) return error;
    try {
      return namePluginOwnedError(error, await this.sources.listInstalled());
    } catch (cause) {
      this.sources.reportFailure("plugin_store", cause);
      return error;
    }
  }

  /** A kept inspection, or a plain 404 for one that isn't kept or has run out of time. */
  public async inspection(inspectionId: string): Promise<CapabilityPluginInspection> {
    const found = await this.sources.readInspection(inspectionId);
    if (!found) throw new NotFoundError(INSPECTION_NOT_FOUND_MESSAGE);
    return found;
  }

  /** The shipped plugins, or none (with the failure logged) when their folder can't be read. */
  private async readBuiltIn(): Promise<readonly PluginManifest[]> {
    try {
      return await this.sources.listBuiltIn();
    } catch (error) {
      this.sources.reportFailure("built_in", error);
      return [];
    }
  }

  /**
   * The installed plugins' skill checks, by workspace: each workspace's checks read once, by the ids its installed
   * plugins list. Only an installed plugin's state depends on them. A workspace whose checks can't be read is left out,
   * so its plugins read as not finished, never installed.
   */
  private async readInstalledSkillChecks(
    plugins: readonly StoredPlugin[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, PluginSkillCheck>>> {
    const idsByWorkspace = new Map<string, Set<string>>();
    for (const plugin of plugins) {
      if (plugin.state !== "installed") continue;
      const ids = idsByWorkspace.get(plugin.workspaceId) ?? new Set<string>();
      for (const id of skillCheckIds(plugin)) ids.add(id);
      idsByWorkspace.set(plugin.workspaceId, ids);
    }
    const read = await Promise.all(
      [...idsByWorkspace].map(async ([workspaceId, ids]) => {
        const checks = await this.readSkillChecks(workspaceId, [...ids]);
        return checks ? [[workspaceId, checks] as const] : [];
      }),
    );
    return new Map(read.flat());
  }

  /** A workspace's skill checks by their ids; undefined, with the failure logged, when they can't be read. */
  private async readSkillChecks(
    workspaceId: string,
    snapshotIds: readonly string[],
  ): Promise<ReadonlyMap<string, PluginSkillCheck> | undefined> {
    if (snapshotIds.length === 0) return new Map();
    try {
      return await this.sources.readSkillChecks(workspaceId, snapshotIds);
    } catch (error) {
      this.sources.reportFailure("skill_hub", error);
      return undefined;
    }
  }

  /** While a plugin is uninstalled: where each approval a skill's removal waits for stands, by its id. */
  private async readWaitingApprovals(
    plugin: StoredPlugin,
  ): Promise<ReadonlyMap<string, ApprovalRequest["status"]> | undefined> {
    if (plugin.state !== "uninstalling") return undefined;
    const ids = plugin.pieces.flatMap((piece) => (piece.waiting ? [piece.waiting.approvalId] : []));
    const statuses = new Map<string, ApprovalRequest["status"]>();
    for (const approvalId of ids) {
      const status = await this.sources.readApprovalStatus(approvalId);
      if (status) statuses.set(approvalId, status);
    }
    return statuses;
  }

  /** Whether one of the plugin's plans is done with the record; undefined when it can't be read. */
  private async readPlanEnded(plugin: StoredPlugin, planId: string, actorId: string): Promise<boolean | undefined> {
    try {
      const status = await this.sources.readInstallPlanStatus(plugin.workspaceId, planId, actorId);
      return installPlanEnded(status);
    } catch (error) {
      this.sources.reportFailure("install_plan", error);
      return undefined;
    }
  }

  /** The manifest the plugin was installed from, read again from its snapshot; undefined when it isn't that one. */
  private async readInstalledManifest(plugin: StoredPlugin): Promise<PluginManifest | undefined> {
    try {
      const parsed = await this.sources.readManifest(plugin.snapshotTreeSha256);
      if (parsed.ok && parsed.manifestSha256 === plugin.manifestSha256) return parsed.manifest;
      throw new Error(MANIFEST_NOT_INSTALLED_ONE);
    } catch (error) {
      this.sources.reportFailure("snapshot", error);
      return undefined;
    }
  }

  /** Each piece's label, from the manifest; a prompt pack's from its file in the snapshot. */
  private async describePieces(
    plugin: StoredPlugin,
    manifest: PluginManifest,
  ): Promise<ReadonlyMap<string, PluginPieceLabel>> {
    return await describePluginPieces(
      manifest,
      (relativePath) => this.sources.readSnapshotText(plugin.snapshotTreeSha256, relativePath),
      (error) => this.sources.reportFailure("snapshot", error),
    );
  }
}

/** An installed plugin as the list shows it, in the state its pieces were read in. */
function listItem(plugin: StoredPlugin, state: CapabilityPluginListItem["state"]): CapabilityPluginListItem {
  return {
    pluginId: plugin.pluginId,
    name: plugin.name,
    description: plugin.description,
    version: plugin.version,
    trust: plugin.trust,
    sourceDisplay: plugin.sourceDisplay,
    state,
    pieceCounts: countPieces(plugin.pieces),
  };
}

function countPieces(pieces: readonly { kind: PluginPieceKind }[]): Partial<Record<PluginPieceKind, number>> {
  const counts: Partial<Record<PluginPieceKind, number>> = {};
  for (const piece of pieces) counts[piece.kind] = (counts[piece.kind] ?? 0) + 1;
  return counts;
}

function byName(items: CapabilityPluginListItem[]): CapabilityPluginListItem[] {
  return [...items].sort(
    (left, right) => left.name.localeCompare(right.name, "en") || left.pluginId.localeCompare(right.pluginId, "en"),
  );
}
