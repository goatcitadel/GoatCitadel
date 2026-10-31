import {
  NotFoundError,
  type CapabilityPluginInspection,
  type CapabilityPluginListItem,
  type CapabilityPluginListResponse,
  type CapabilityPluginState,
  type CapabilitySkillInstallStep,
  type PluginActionOutcome,
  type PluginManifest,
  type PluginPieceKind,
} from "@goatcitadel/contracts";
import type { CapabilityPluginInstallInput } from "./capability-plugin-actions-service.js";
import type { CapabilityPluginInspectInput } from "./capability-plugin-inspection-service.js";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { skillHubInstallStep } from "./capability-skill-install-projection.js";
import { namePluginOwnedError, type PluginOwnedError } from "./plugin-owned-refusal.js";
import type { SkillHubOperatorItem } from "./skill-hub-operator-service.js";

const BUILT_IN_DISPLAY = "Ships with GoatCitadel";
const INSPECTION_NOT_FOUND_MESSAGE = "That plugin check wasn't found, or it ran out of time. Check the plugin again.";

/**
 * A source that can fail on its own, leaving its part out rather than the whole answer: the list's built-in plugins and
 * Skill Hub checks, and the plugin store a refusal reads its plugin's name from.
 */
export type CapabilityPluginsSource = "built_in" | "skill_hub" | "plugin_store";

/** One reader per place the Plugins tab is built from, each through its existing owner. Only `inspect` keeps anything. */
export interface CapabilityPluginsRouteSources {
  /** The plugin store's records. */
  listInstalled(): Promise<readonly StoredPlugin[]>;
  /** The manifests of the plugins shipped under `<rootDir>/plugins`. */
  listBuiltIn(): Promise<readonly PluginManifest[]>;
  /** The newest Skill Hub checks of a workspace: the list the Skills tab's installs read. */
  listSkillHubChecks(workspaceId: string): Promise<readonly SkillHubOperatorItem[]>;
  /** Fetches a source and checks every piece. It installs nothing. */
  inspect(input: CapabilityPluginInspectInput): Promise<CapabilityPluginInspection>;
  /** A kept inspection that hasn't run out of time. */
  readInspection(inspectionId: string): Promise<CapabilityPluginInspection | undefined>;
  /** Installs an inspection's pieces through one Change Plan the operator confirms with this click. */
  install(input: CapabilityPluginInstallInput): Promise<PluginActionOutcome>;
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
   * finished and each skill's Skill Hub check is switched on; a check that can't be read, or isn't among a workspace's
   * newest checks, reads as not finished. `builtIn` lists every shipped plugin that isn't installed, from its manifest
   * alone: nothing is fetched or checked.
   */
  public async list(): Promise<CapabilityPluginListResponse> {
    const [installed, builtIn] = await Promise.all([this.sources.listInstalled(), this.readBuiltIn()]);
    const steps = await this.readSkillSteps(installed);
    const installedIds = new Set(installed.map((plugin) => plugin.pluginId));
    return {
      installed: byName(
        installed.map((plugin) => ({
          pluginId: plugin.pluginId,
          name: plugin.name,
          description: plugin.description,
          version: plugin.version,
          trust: plugin.trust,
          sourceDisplay: plugin.sourceDisplay,
          state: installedState(plugin, steps.get(plugin.workspaceId)),
          pieceCounts: countPieces(plugin.pieces),
        })),
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
   * Each workspace's Skill Hub check steps, by check id, read once per workspace that has an installed plugin with a
   * skill. A workspace whose checks can't be read is left out, so its plugins read as not finished, never installed.
   */
  private async readSkillSteps(
    plugins: readonly StoredPlugin[],
  ): Promise<ReadonlyMap<string, ReadonlyMap<string, CapabilitySkillInstallStep>>> {
    const workspaces = [
      ...new Set(
        plugins
          .filter((plugin) => plugin.state === "installed" && plugin.pieces.some((piece) => piece.kind === "skill"))
          .map((plugin) => plugin.workspaceId),
      ),
    ];
    const read = await Promise.all(
      workspaces.map(async (workspaceId) => {
        try {
          const checks = await this.sources.listSkillHubChecks(workspaceId);
          return [[workspaceId, new Map(checks.map((item) => [item.snapshotId, skillHubInstallStep(item)]))]] as const;
        } catch (error) {
          this.sources.reportFailure("skill_hub", error);
          return [];
        }
      }),
    );
    return new Map(read.flat());
  }
}

/** `install_not_finished` while the install plan runs, or until every skill piece's check reads switched on. */
function installedState(
  plugin: StoredPlugin,
  steps: ReadonlyMap<string, CapabilitySkillInstallStep> | undefined,
): CapabilityPluginState {
  if (plugin.state === "uninstalling") return "uninstalling";
  if (plugin.state === "installing") return "install_not_finished";
  const switchedOn = plugin.pieces
    .filter((piece) => piece.kind === "skill")
    .every((piece) => piece.skillSnapshotId !== undefined && steps?.get(piece.skillSnapshotId) === "done");
  return switchedOn ? "installed" : "install_not_finished";
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
