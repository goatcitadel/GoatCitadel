import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import {
  NotFoundError,
  redactStructuredSecrets,
  type DeploymentProfile,
  type McpServerRecord,
  type ToolGroupId,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { PluginToolGroupHold } from "@goatcitadel/policy-engine";
import { CapabilityPluginInspectionService } from "./capability-plugin-inspection-service.js";
import {
  CapabilityPluginStore,
  pluginToolGroupHolds,
  type CapabilityPluginSettingRows,
  type StoredPlugin,
} from "./capability-plugin-store.js";
import { CapabilityPluginsRouteService, type CapabilityPluginsSource } from "./capability-plugins-route-service.js";
import { SKILL_HUB_LIST_LIMIT } from "./capability-skill-install-projection.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { lookUpHostAddresses } from "./hardened-git.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { listBuiltInPluginManifests } from "./plugin-manifest-file.js";
import { PluginSnapshotStore } from "./plugin-snapshot-store.js";
import { fetchPluginSource } from "./plugin-source-service.js";
import { projectSwitchedOffToolGroups } from "./settings-operator-write-access.js";
import type { SkillHubOperatorListResponse } from "./skill-hub-operator-service.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";

const log = logger.child("capability-plugins");
/** What a version may hold to name a review key: the review's own key characters, kept short. */
const GATEWAY_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/u;

/** The install's folders and profile, and the operator's own tool switches, read from its live config. */
export interface CapabilityPluginsConfig {
  rootDir: string;
  assistant: { dataDir: string; deploymentProfile: DeploymentProfile };
  toolPolicy: Pick<ToolPolicyConfig, "tools">;
}

/** Where the groups plugins hold off take effect: the policy engine, which denies them in every chat. */
export interface PluginToolGroupHoldsTarget {
  setPluginToolGroupHolds(holds: readonly PluginToolGroupHold[]): void;
}

/**
 * The existing owner of each source the Plugins tab and its inspections read. Inspecting writes only through the
 * snapshot store, the Skill Hub's own review and the plugin store; every other owner is only read.
 */
export interface CapabilityPluginsOwners {
  /** `<rootDir>/plugins` holds the plugins that ship; `<data>/plugins` holds the snapshots and their temp copies. */
  config: CapabilityPluginsConfig;
  /** The saved connectors. */
  mcp: { listMcpServers(): Promise<readonly Pick<McpServerRecord, "label">[]> };
  /** The network allowlist and the feature flags. */
  settings: {
    getSettings(): Promise<Pick<RuntimeSettings, "networkAllowlist" | "features">>;
  };
  /** Skill Hub's source review and its operator list, as the Skills tab reaches them. */
  skillHub: {
    reviewSkillHubSource(input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult>;
    listSkillHub(input: { workspaceId: string; limit?: number }): Promise<SkillHubOperatorListResponse>;
  };
  /** The `system_settings` rows; the plugin store keeps `capability_plugins_v1` there. */
  systemSettings: CapabilityPluginSettingRows;
  /** The saved prompt packs, by id. */
  promptPacks: { getPack(packId: string): Promise<unknown> };
  /** Takes the groups plugins hold off, loaded at startup and again after every write to the plugin store. */
  policy: PluginToolGroupHoldsTarget;
}

/** Where plugins live on this install. Snapshots and their temp copies share a volume, since a snapshot is renamed in. */
export function pluginDataPaths(config: CapabilityPluginsConfig): {
  snapshots: string;
  temp: string;
  builtIn: string;
} {
  const pluginsData = path.join(path.resolve(config.rootDir, config.assistant.dataDir), "plugins");
  return {
    snapshots: path.join(pluginsData, "snapshots"),
    temp: path.join(pluginsData, "tmp"),
    builtIn: path.join(path.resolve(config.rootDir), "plugins"),
  };
}

/** `PluginSnapshotStore.resolve` on this install's snapshots: what the Skill Hub review reads a plugin's skill through. */
export function pluginSnapshotResolver(
  config: CapabilityPluginsConfig,
): (treeSha256: string, relativePath: string) => string {
  const snapshots = new PluginSnapshotStore(pluginDataPaths(config).snapshots);
  return (treeSha256, relativePath) => snapshots.resolve(treeSha256, relativePath);
}

/** Wires the Plugins tab to its owners. */
export function composeCapabilityPlugins({
  config,
  mcp,
  settings,
  skillHub,
  systemSettings,
  promptPacks,
  policy,
}: CapabilityPluginsOwners): CapabilityPluginsRouteService {
  const paths = pluginDataPaths(config);
  const snapshots = new PluginSnapshotStore(paths.snapshots);
  const store = new CapabilityPluginStore(systemSettings);
  void feedPluginToolGroupHolds({
    readPlugins: () => store.list(),
    onStoreChange: (listener) => store.onChange(listener),
    setHolds: (holds) => policy.setPluginToolGroupHolds(holds),
    report: reportHoldsReadFailure,
  });
  const inspection = new CapabilityPluginInspectionService({
    fetchSource: (source) =>
      fetchPluginSource(source, {
        importSnapshot: (dir) => snapshots.importDirectory(dir),
        builtInRoot: paths.builtIn,
        deploymentProfile: config.assistant.deploymentProfile,
        tempRoot: paths.temp,
      }),
    resolveSnapshotPath: (treeSha256, relativePath) => snapshots.resolve(treeSha256, relativePath),
    reviewSkill: (input) => skillHub.reviewSkillHubSource(input),
    connectorTemplates: () => MCP_SERVER_TEMPLATES,
    listSavedConnectorLabels: async () => (await mcp.listMcpServers()).map((server) => server.label),
    readSettings: async () => {
      const current = await settings.getSettings();
      return {
        // The operator's own switch, never the union with holds: another plugin's hold isn't this plugin's to keep.
        switchedOffToolGroups: operatorSwitchedOffToolGroups(config),
        networkAllowlist: current.networkAllowlist,
        typedRunVariablesEnabled: current.features.typedRunVariablesV1Enabled === true,
      };
    },
    promptPackExists: async (packId) => {
      try {
        await promptPacks.getPack(packId);
        return true;
      } catch (error) {
        if (error instanceof NotFoundError) return false;
        throw error;
      }
    },
    lookupHost: (hostname) => lookUpHostAddresses(hostname),
    findInstalled: (pluginId) => store.get(pluginId),
    findKeptInspection: (actorScope, idempotencyKey) => store.findInspectionByRequest(actorScope, idempotencyKey),
    saveInspection: (kept, snapshotTreeSha256, request) => store.saveInspection(kept, snapshotTreeSha256, request),
    now: () => new Date(),
    newInspectionId: () => randomUUID(),
    gatewayVersion: gatewayVersionForReviewKeys(),
  });
  return new CapabilityPluginsRouteService({
    listInstalled: () => store.list(),
    listBuiltIn: () => listBuiltInPluginManifests(paths.builtIn),
    // The list the Skills tab's installs read, so a plugin's skill reads switched on exactly when that check does.
    listSkillHubChecks: async (workspaceId) =>
      (await skillHub.listSkillHub({ workspaceId, limit: SKILL_HUB_LIST_LIMIT })).items,
    inspect: (input) => inspection.inspect(input),
    readInspection: async (inspectionId) => (await store.getInspection(inspectionId))?.inspection,
    reportFailure: reportFailedRead,
  });
}

/** The plain readers the holds feed works through: the plugin store's records and its change hook, and the engine. */
export interface PluginToolGroupHoldsSources {
  readPlugins(): Promise<readonly StoredPlugin[]>;
  onStoreChange(listener: () => void): void;
  setHolds(holds: readonly PluginToolGroupHold[]): void;
  report(error: unknown): void;
}

/**
 * Feeds the groups plugins hold off to the policy engine: now, and again after every write to the plugin store. Each
 * read replaces the holds whole; a read that started earlier never replaces a later one. A store that can't be read
 * keeps the holds last read and reports the failure, so a hold never lifts because a read failed. Answers when the
 * first read settles.
 */
export async function feedPluginToolGroupHolds(sources: PluginToolGroupHoldsSources): Promise<void> {
  let started = 0;
  let applied = 0;
  const refresh = async () => {
    const read = (started += 1);
    try {
      const holds = pluginToolGroupHolds(await sources.readPlugins());
      if (read < applied) return;
      applied = read;
      sources.setHolds(holds);
    } catch (error) {
      sources.report(error);
    }
  };
  sources.onStoreChange(() => void refresh());
  await refresh();
}

/** The groups the operator switched off themselves, from the live tool policy. A plugin's hold is never among them. */
export function operatorSwitchedOffToolGroups(config: Pick<CapabilityPluginsConfig, "toolPolicy">): ToolGroupId[] {
  return projectSwitchedOffToolGroups(config.toolPolicy);
}

/** The label a plugin skill's review key uses when the Gateway package's version can't be read. */
export const UNVERSIONED_REVIEW_KEY_LABEL = "unversioned";

/**
 * The version a plugin skill's review key names, read once when plugins are wired. A version that can't be read is
 * logged and replaced by a fixed label, so plugins and every other route still start; a review-rule change under that
 * label is still caught by the inspection's fresh-key retry.
 */
export function gatewayVersionForReviewKeys(read: () => string = () => readGatewayVersion()): string {
  try {
    return read();
  } catch (error) {
    const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
    log.warn("the Gateway package's version couldn't be read; plugin skill checks use a fixed label", {
      label: UNVERSIONED_REVIEW_KEY_LABEL,
      err: redactStructuredSecrets(diagnostic).value,
    });
    return UNVERSIONED_REVIEW_KEY_LABEL;
  }
}

/**
 * The Gateway package's own version (`apps/gateway/package.json`, two folders up from this file in `src` and in
 * `dist` alike). It throws when the version can't be read or doesn't fit a review key, rather than making one up.
 */
export function readGatewayVersion(load: (specifier: string) => unknown = createRequire(import.meta.url)): string {
  const version = (load("../../package.json") as { version?: unknown } | undefined)?.version;
  if (typeof version !== "string" || !GATEWAY_VERSION_PATTERN.test(version)) {
    throw new Error("The Gateway package's version can't name a plugin skill's review key.");
  }
  return version;
}

/** A hold that can't be read is logged; the holds last read stay in force. */
function reportHoldsReadFailure(error: unknown): void {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  log.error("the tool groups plugins hold off couldn't be read; the last ones read stay in force", {
    err: redactStructuredSecrets(diagnostic).value,
  });
}

/** The operator sees a plain line or a part left out; the real error stays in the redacted server log. */
function reportFailedRead(source: CapabilityPluginsSource, error: unknown): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error("a Capabilities plugins source could not be read", {
    source,
    err: redactStructuredSecrets(diagnostic).value,
  });
}
