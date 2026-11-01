import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  NotFoundError,
  redactStructuredSecrets,
  type ApprovalRequest,
  type DeploymentProfile,
  type ToolGroupId,
  type ToolPolicyConfig,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { PluginToolGroupHold } from "@goatcitadel/policy-engine";
import { CapabilityPluginActionsService } from "./capability-plugin-actions-service.js";
import {
  pluginActionSources,
  pluginInstallSources,
  type CapabilityPluginInstallOwners,
  type PluginInstallShared,
} from "./capability-plugin-install-composition.js";
import { CapabilityPluginInspectionService } from "./capability-plugin-inspection-service.js";
import {
  CapabilityPluginStore,
  pluginToolGroupHolds,
  type RemovedPlugin,
  type StoredPlugin,
} from "./capability-plugin-store.js";
import { pluginUninstallSources } from "./capability-plugin-uninstall-composition.js";
import { CapabilityPluginsRouteService, type CapabilityPluginsSource } from "./capability-plugins-route-service.js";
import type { PluginUninstallRevokeInput, PluginUninstallRevokeOutcome } from "./capability-skill-actions-service.js";
import type { CapabilitySkillsOwners } from "./capability-skills-composition.js";
import { lookUpHostAddresses } from "./hardened-git.js";
import { HookSecretCustodyService } from "./hook-secret-custody-service.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { PluginInstallChangePlanAdapter } from "./plugin-install-change-plan-adapter.js";
import { listBuiltInPluginManifests, readPluginManifestFile } from "./plugin-manifest-file.js";
import { readPluginSkillChecks, type FindSkillHubChecks } from "./plugin-skill-checks.js";
import { PluginSnapshotChangedError, PluginSnapshotPathError, PluginSnapshotStore } from "./plugin-snapshot-store.js";
import { fetchPluginSource } from "./plugin-source-service.js";
import { PluginUninstallChangePlanAdapter } from "./plugin-uninstall-change-plan-adapter.js";
import { projectSwitchedOffToolGroups } from "./settings-operator-write-access.js";
import type { SkillHubOperatorListResponse } from "./skill-hub-operator-service.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";

const log = logger.child("capability-plugins");
/** What a version may hold to name a review key: the review's own key characters, kept short. */
const GATEWAY_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,64}$/u;

/** The first reads of the holds at startup, and the waits between them: about a second in all before it is reported. */
const FIRST_HOLDS_READ_WAITS_MS = [250, 1000] as const;

/** The install's folders and profile, and the operator's own tool switches, read from its live config. */
export interface CapabilityPluginsConfig {
  rootDir: string;
  assistant: { dataDir: string; deploymentProfile: DeploymentProfile };
  toolPolicy: Pick<ToolPolicyConfig, "tools" | "hooks">;
}

/** Where the groups plugins hold off take effect: the policy engine, which denies them in every chat. */
export interface PluginToolGroupHoldsTarget {
  setPluginToolGroupHolds(holds: readonly PluginToolGroupHold[]): void;
}

/**
 * The existing owner of each source the Plugins tab and its inspections read, and of each piece an install adds and an
 * uninstall removes. Inspecting writes only through the snapshot store, the Skill Hub's own review and the plugin
 * store; installing and uninstalling write only through Change Plans, whose adapters this composition adds to the
 * Change Plan adapters.
 */
export interface CapabilityPluginsOwners extends CapabilityPluginInstallOwners {
  /** `<rootDir>/plugins` holds the plugins that ship; `<data>/plugins` holds the snapshots and their temp copies. */
  config: CapabilityPluginsConfig;
  /** Skill Hub's source review, and its operator list, which a plugin's skills are read from by their checks' ids. */
  skillHub: {
    reviewSkillHubSource(input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult>;
    listSkillHub(input: { workspaceId: string; snapshotIds: readonly string[] }): Promise<SkillHubOperatorListResponse>;
  };
  /** Takes the groups plugins hold off, loaded at startup and again after every write to the plugin store. */
  policy: PluginToolGroupHoldsTarget;
  /**
   * The Skills tab's one revoke for a plugin's skill, as a plain function: the uninstall plan asks it for each skill
   * the plugin switched on, and never asks Skill Hub or approves anything itself.
   */
  revokeSkill(input: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome>;
  /**
   * The Inbox's owner: one approval, to tell whether a skill's removal still waits for it, and the waiting approvals,
   * page by page, where a skill's own step left waiting is found.
   */
  approvals: CapabilitySkillsOwners["approvals"];
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

/** The Plugins tab's routes, and the plugin records as a plain read for the other tabs that mark a plugin's pieces. */
export interface CapabilityPlugins {
  routes: CapabilityPluginsRouteService;
  /** Every plugin record, read through the one plugin store. It writes nothing. */
  readPlugins(): Promise<readonly StoredPlugin[]>;
  /** The uninstalled plugins the store remembers, newest first, read through the same store. It writes nothing. */
  readRemovedPlugins(): Promise<readonly RemovedPlugin[]>;
}

/**
 * Wires the Plugins tab and the plugin install and uninstall plans to their owners. All share one plugin store, so
 * every write either plan makes reaches the tool-group holds as an inspection's does.
 */
export function composeCapabilityPlugins(owners: CapabilityPluginsOwners): CapabilityPlugins {
  const { config, mcp, settings, skillHub, records, policy, plans, keychain, changePlanAdapters, approvals } = owners;
  const paths = pluginDataPaths(config);
  const snapshots = new PluginSnapshotStore(paths.snapshots);
  const store = new CapabilityPluginStore(records.systemSettings);
  const holds = feedPluginToolGroupHolds({
    readPlugins: () => store.list(),
    onStoreChange: (listener) => store.onChange(listener),
    setHolds: (held) => policy.setPluginToolGroupHolds(held),
    report: reportHoldsReadFailure,
    reportFirstReadFailure: reportFirstHoldsReadFailure,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const custody = new HookSecretCustodyService(keychain);
  // The one per-id read of a plugin's skill checks: by each check's own id, never through a workspace's newest checks.
  const readSkillChecks = (workspaceId: string, snapshotIds: readonly string[]) =>
    readPluginSkillChecks(findSkillHubChecks(skillHub), workspaceId, snapshotIds);
  const shared: PluginInstallShared = {
    readInspection: (inspectionId) => store.getInspection(inspectionId),
    readPlugin: (pluginId) => store.get(pluginId),
    updatePlugin: (pluginId, change) => store.update(pluginId, change),
    verifySnapshot: (treeSha256) => snapshots.verify(treeSha256),
    readManifest: (treeSha256) => readPluginManifestFile(resolveCheckedSnapshot(snapshots, treeSha256)),
    readSnapshotText: (treeSha256, relativePath) =>
      readSnapshotText(resolveCheckedSnapshot(snapshots, treeSha256, relativePath)),
    listBuiltInPluginIds: async () => (await listBuiltInPluginManifests(paths.builtIn)).map((item) => item.pluginId),
    storeHookSecret: (value) => custody.storeSecret(value),
    deleteHookSecret: (secretRef) => {
      try {
        custody.deleteSecret(secretRef);
      } catch (error) {
        // Never in the way of the plan's own end; the reference (never the secret) is logged so it can be found.
        reportFailedSecretDelete(secretRef, error);
      }
    },
    reportSecretsKept: reportKeptSecrets,
  };
  changePlanAdapters.register(new PluginInstallChangePlanAdapter(pluginInstallSources(shared, owners)));
  changePlanAdapters.register(
    new PluginUninstallChangePlanAdapter(
      pluginUninstallSources(
        {
          ...shared,
          listPlugins: () => store.list(),
          removePlugin: (pluginId, remember) => store.remove(pluginId, remember),
          readSkillChecks,
          revokeSkill: (input) => owners.revokeSkill(input),
          connectorTemplates: () => MCP_SERVER_TEMPLATES,
          listPendingApprovals: (input) => approvals.listApprovalsPage(input),
          reportExportFileKept: reportKeptExportFile,
          reportUndecidedSecrets,
        },
        { ...owners, rootDir: config.rootDir },
      ),
    ),
  );
  // Where an approval stands; one that can't be read answers undefined, and no one is sent to it.
  const readApprovalStatus = async (approvalId: string): Promise<ApprovalRequest["status"] | undefined> => {
    try {
      return (await approvals.getApproval(approvalId)).status;
    } catch (error) {
      reportFailedRead("approval", error);
      return undefined;
    }
  };
  const actions = new CapabilityPluginActionsService({ ...pluginActionSources(shared, owners), readApprovalStatus });
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
        await records.promptPacks.getPack(packId);
        return true;
      } catch (error) {
        if (error instanceof NotFoundError) return false;
        throw error;
      }
    },
    lookupHost: (hostname) => lookUpHostAddresses(hostname),
    readSkillCheck: async (workspaceId, snapshotId) =>
      (await readSkillChecks(workspaceId, [snapshotId])).get(snapshotId),
    findInstalled: (pluginId) => store.get(pluginId),
    findKeptInspection: (actorScope, idempotencyKey) => store.findInspectionByRequest(actorScope, idempotencyKey),
    saveInspection: (kept, snapshotTreeSha256, request) => store.saveInspection(kept, snapshotTreeSha256, request),
    now: () => new Date(),
    newInspectionId: () => randomUUID(),
    gatewayVersion: gatewayVersionForReviewKeys(),
  });
  const routes = new CapabilityPluginsRouteService({
    listInstalled: () => store.list(),
    listBuiltIn: () => listBuiltInPluginManifests(paths.builtIn),
    readSkillChecks,
    readInstallPlanStatus: async (workspaceId, planId, actorId) =>
      (await plans.get({ workspaceId, actorId, surface: "capabilities" }, planId)).status,
    readApprovalStatus,
    readManifest: (treeSha256) => shared.readManifest(treeSha256),
    readSnapshotText: (treeSha256, relativePath) => shared.readSnapshotText(treeSha256, relativePath),
    inspect: (input) => inspection.inspect(input),
    readInspection: async (inspectionId) => (await store.getInspection(inspectionId))?.inspection,
    install: (input) => actions.install(input),
    uninstall: (input) => actions.uninstall(input),
    loadToolGroupHolds: () => holds.load(),
    reportFailure: reportFailedRead,
  });
  return { routes, readPlugins: () => store.list(), readRemovedPlugins: () => store.listRemoved() };
}

/**
 * A workspace's checks by their ids, through Skill Hub's operator list: the one per-id read a plugin's skill pieces are
 * read with (here for the detail and the list, and for the uninstall's revokes and a reinstall's refusal).
 */
function findSkillHubChecks(skillHub: Pick<CapabilityPluginsOwners["skillHub"], "listSkillHub">): FindSkillHubChecks {
  return async ({ workspaceId, snapshotIds }) => (await skillHub.listSkillHub({ workspaceId, snapshotIds })).items;
}

/**
 * A snapshot's folder, or a path inside it, for a read the install makes after the snapshot was checked: a copy that
 * is gone, or a path it can't hold, is the same plain refusal as a copy whose bytes changed.
 */
function resolveCheckedSnapshot(
  snapshots: { resolve(treeSha256: string, relativePath?: string): string },
  treeSha256: string,
  relativePath?: string,
): string {
  try {
    return snapshots.resolve(treeSha256, relativePath);
  } catch (error) {
    if (error instanceof PluginSnapshotPathError) throw new PluginSnapshotChangedError();
    throw error;
  }
}

/** A snapshot file as UTF-8 text. The snapshot holds only plain files within the plugin limits, so one read is bounded. */
async function readSnapshotText(file: string): Promise<string> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await fs.readFile(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // The file was read and decoded when it was checked; missing or not text now, the copy changed.
    if (error instanceof TypeError || code === "ENOENT" || code === "ENOTDIR") throw new PluginSnapshotChangedError();
    throw error;
  }
}

/** The plain readers the holds feed works through: the plugin store's records and its change hook, and the engine. */
export interface PluginToolGroupHoldsSources {
  readPlugins(): Promise<readonly StoredPlugin[]>;
  onStoreChange(listener: () => void): void;
  setHolds(holds: readonly PluginToolGroupHold[]): void;
  /** A later read that failed: the holds last read stay in force. */
  report(error: unknown): void;
  /** The first read failed every time it was tried: no group is held until a later read lands. */
  reportFirstReadFailure(error: unknown): void;
  wait(ms: number): Promise<void>;
}

/** The holds feed: `load` is the first read, which startup awaits before any chat runs. */
export interface PluginToolGroupHoldsFeed {
  load(): Promise<void>;
}

/**
 * Feeds the groups plugins hold off to the policy engine: once at startup (`load`), and again after every write to the
 * plugin store. Each read replaces the holds whole; a read that started earlier never replaces a later one. A store
 * that can't be read keeps the holds last read and reports the failure, so a hold never lifts because a read failed.
 * The first read is tried again, twice, before its failure is reported; `load` settles then either way, and the next
 * write that can be read sets the holds.
 */
export function feedPluginToolGroupHolds(sources: PluginToolGroupHoldsSources): PluginToolGroupHoldsFeed {
  let started = 0;
  let applied = 0;
  const read = async (): Promise<void> => {
    const attempt = (started += 1);
    const holds = pluginToolGroupHolds(await sources.readPlugins());
    if (attempt < applied) return;
    applied = attempt;
    sources.setHolds(holds);
  };
  sources.onStoreChange(() => void read().catch((error: unknown) => sources.report(error)));
  let first: Promise<void> | undefined;
  const firstRead = async (): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        const wait = FIRST_HOLDS_READ_WAITS_MS[attempt];
        if (wait === undefined) return sources.reportFirstReadFailure(error);
        await sources.wait(wait);
      }
    }
  };
  return { load: () => (first ??= firstRead()) };
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

/** The first read failed each time: nothing a plugin holds off is held until a later write is read. */
function reportFirstHoldsReadFailure(error: unknown): void {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  log.error(
    "the tool groups plugins hold off couldn't be read at startup; none is held off until the plugin records can be read",
    { err: redactStructuredSecrets(diagnostic).value },
  );
}

/** A prompt pack's export file an uninstall couldn't remove: inert, and logged by its pack so it can be found. */
function reportKeptExportFile(packId: string, error: unknown): void {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  log.error("an uninstalled plugin's prompt pack export file couldn't be removed", {
    packId,
    err: redactStructuredSecrets(diagnostic).value,
  });
}

/** An uninstall that couldn't tell which stored secrets are in use kept them: logged by plugin and reference. */
function reportUndecidedSecrets(pluginId: string, secretRefs: readonly string[], error: unknown): void {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  log.error("a plugin uninstall kept its stored signing secrets, as it couldn't tell whether a hook still uses them", {
    pluginId,
    secretRefs: [...secretRefs],
    err: redactStructuredSecrets(diagnostic).value,
  });
}

/** A signing secret that couldn't be deleted is logged by its reference, so it can be found and removed. */
function reportKeptSecrets(error: unknown): void {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  log.error(
    "a plugin install plan ended unapplied, and its stored signing secrets were kept: its record can't be read",
    {
      err: redactStructuredSecrets(diagnostic).value,
    },
  );
}

function reportFailedSecretDelete(secretRef: string, error: unknown): void {
  const diagnostic = error instanceof Error ? { name: error.name, message: error.message } : { value: error };
  log.error("a plugin hook's stored signing secret couldn't be deleted", {
    secretRef,
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
