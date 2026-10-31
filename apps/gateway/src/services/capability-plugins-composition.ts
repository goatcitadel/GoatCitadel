import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  NotFoundError,
  redactStructuredSecrets,
  type DeploymentProfile,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import { CapabilityPluginInspectionService } from "./capability-plugin-inspection-service.js";
import { CapabilityPluginStore, type CapabilityPluginSettingRows } from "./capability-plugin-store.js";
import { CapabilityPluginsRouteService, type CapabilityPluginsSource } from "./capability-plugins-route-service.js";
import { SKILL_HUB_LIST_LIMIT } from "./capability-skill-install-projection.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { lookUpHostAddresses } from "./hardened-git.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { listBuiltInPluginManifests } from "./plugin-manifest-file.js";
import { PluginSnapshotStore } from "./plugin-snapshot-store.js";
import { fetchPluginSource } from "./plugin-source-service.js";
import type { SkillHubOperatorListResponse } from "./skill-hub-operator-service.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";

const log = logger.child("capability-plugins");

/** The install's folders and profile, read from its config. */
export interface CapabilityPluginsConfig {
  rootDir: string;
  assistant: { dataDir: string; deploymentProfile: DeploymentProfile };
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
  /** The operator's tool switches, the network allowlist and the feature flags. */
  settings: {
    getSettings(): Promise<Pick<RuntimeSettings, "switchedOffToolGroups" | "networkAllowlist" | "features">>;
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
}: CapabilityPluginsOwners): CapabilityPluginsRouteService {
  const paths = pluginDataPaths(config);
  const snapshots = new PluginSnapshotStore(paths.snapshots);
  const store = new CapabilityPluginStore(systemSettings);
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
        switchedOffToolGroups: current.switchedOffToolGroups,
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
    findKeptInspection: (actorId, idempotencyKey) => store.findInspectionByRequest(actorId, idempotencyKey),
    saveInspection: (kept, snapshotTreeSha256, request) => store.saveInspection(kept, snapshotTreeSha256, request),
    now: () => new Date(),
    newInspectionId: () => randomUUID(),
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

/** The operator sees a plain line or a part left out; the real error stays in the redacted server log. */
function reportFailedRead(source: CapabilityPluginsSource, error: unknown): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error("a Capabilities plugins source could not be read", {
    source,
    err: redactStructuredSecrets(diagnostic).value,
  });
}
