import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
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
import { TEMP_REMOVAL_OPTIONS, lookUpHostAddresses } from "./hardened-git.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { listBuiltInPluginManifests } from "./plugin-manifest-file.js";
import { PluginSnapshotStore, SNAPSHOT_SWEEP_GRACE_MS } from "./plugin-snapshot-store.js";
import { fetchPluginSource } from "./plugin-source-service.js";
import type { SkillHubOperatorListResponse } from "./skill-hub-operator-service.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";

const log = logger.child("capability-plugins");
/** What a version may hold to name a review key: the review's own key characters, kept short. */
const GATEWAY_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/u;

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
  // Never rejects (it logs its own failures); the catch only satisfies the async-boundary rule.
  reclaimPluginStorage(
    paths.temp,
    () => store.listReferencedSnapshots(),
    (keep, options) => snapshots.sweep(keep, options),
  ).catch(() => undefined);
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

/**
 * Runs once when plugins are wired, off the request path: clears the temp copies a crashed fetch left (nothing is in
 * flight at startup) and removes the snapshots no installed plugin or kept inspection points at and that are past the
 * grace window. A failure is logged and never blocks boot.
 */
export async function reclaimPluginStorage(
  tempRoot: string,
  listReferencedSnapshots: () => Promise<ReadonlySet<string>>,
  sweep: (keep: ReadonlySet<string>, options: { olderThanMs: number }) => Promise<unknown>,
  olderThanMs = SNAPSHOT_SWEEP_GRACE_MS,
): Promise<void> {
  try {
    const leftovers = await fs.readdir(tempRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of leftovers) await fs.rm(path.join(tempRoot, name), TEMP_REMOVAL_OPTIONS);
    await sweep(await listReferencedSnapshots(), { olderThanMs });
  } catch (error) {
    const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
    log.warn("unused plugin copies could not be cleaned up at startup", {
      err: redactStructuredSecrets(diagnostic).value,
    });
  }
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

/** The operator sees a plain line or a part left out; the real error stays in the redacted server log. */
function reportFailedRead(source: CapabilityPluginsSource, error: unknown): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error("a Capabilities plugins source could not be read", {
    source,
    err: redactStructuredSecrets(diagnostic).value,
  });
}
