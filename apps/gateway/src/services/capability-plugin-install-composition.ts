import type {
  ChangePlanRecord,
  HookCreateInput,
  HookRecord,
  McpServerRecord,
  PluginManifestParse,
  PromptPackBuiltinImportInput,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import type { CapabilityPluginActionSources } from "./capability-plugin-actions-service.js";
import type { CapabilityPluginSettingRows, StoredPlugin } from "./capability-plugin-store.js";
import type { EvolutionControlPlaneAdapter } from "./evolution-control-plane-adapter.js";
import type { ConfirmOptions } from "./evolution-control-plane-operator-approval-skip.js";
import type {
  EvolutionControlPlaneActor,
  EvolutionControlPlaneCreateInput,
} from "./evolution-control-plane-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import { createMcpServer, updateMcpServerPolicy, type McpServerAdminHost } from "./mcp-server-admin-service.js";
import { mcpServerRevision } from "./mcp-server-revision.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import type { PluginInstallSources } from "./plugin-install-change-plan-adapter.js";
import type { KeptPluginInspection } from "./plugin-plan-support.js";
import { projectSwitchedOffToolGroups } from "./settings-operator-write-access.js";
import type { PluginInstallSettingsUpdate } from "./settings-auth-service.js";

// How a plugin install reaches its owners: the plain readers and writers its plan (the adapter) and the Capabilities
// install (the actions service) are handed. Every write stays with its owner.

/** The live tool policy: the operator's own tool switches and the hooks allowlist. */
export interface PluginInstallConfig {
  toolPolicy: Pick<ToolPolicyConfig, "tools" | "hooks">;
}

/** The storage parts an install reads or writes: the plugin store's row, the prompt packs, the workspaces. */
export interface PluginRecordsOwner {
  readonly systemSettings: CapabilityPluginSettingRows;
  readonly promptPacks: { getPack(packId: string): Promise<unknown> };
  readonly workspaces: { find(workspaceId: string): Promise<unknown> };
  runImmediateTransaction<T>(work: () => T | Promise<T>): Promise<Awaited<T>>;
}

/** The Change Plan control plane, as an install (and the plugin's detail, reading its install plan) uses it. */
export interface PluginPlansOwner {
  isEnabled(): Promise<boolean>;
  get(actor: EvolutionControlPlaneActor, planId: string): Promise<ChangePlanRecord>;
  findByIdempotencyKey(actor: EvolutionControlPlaneActor, key: string): Promise<ChangePlanRecord | undefined>;
  create(input: EvolutionControlPlaneCreateInput): Promise<ChangePlanRecord>;
  confirm(
    actor: EvolutionControlPlaneActor,
    planId: string,
    expectedRevision: number,
    actionNonce: string,
    options?: ConfirmOptions,
  ): Promise<ChangePlanRecord>;
}

/** The existing owner of each piece an install adds, and of the plan that adds them. */
export interface CapabilityPluginInstallOwners {
  config: PluginInstallConfig;
  /** The saved connectors. */
  mcp: { listMcpServers(): Promise<readonly McpServerRecord[]> };
  /** The settings, and their revision-fenced write. */
  settings: {
    getSettings(): Promise<Pick<RuntimeSettings, "revision" | "networkAllowlist" | "deploymentProfile" | "features">>;
    updateSettings(input: PluginInstallSettingsUpdate): Promise<unknown>;
  };
  records: PluginRecordsOwner;
  plans: PluginPlansOwner;
  /** The hooks owner's create, which checks the address, the mode, the scope and the secret's reference. */
  hooks: { createWorkspaceHook(input: HookCreateInput): Promise<HookRecord> };
  /** The OS key store a hook's signing secret is kept in. */
  keychain: {
    setSecret(account: string, secret: string): void;
    getSecret(account: string): string | undefined;
    deleteSecret(account: string): void;
  };
  /** The MCP owner a plugin's connector is saved and set through. */
  mcpAdministration: McpServerAdminHost;
  /** The prompt-pack owner's import; a plugin's pack goes only through its guarded create-if-absent. */
  promptPackImports: {
    importPromptPack(
      input: { content: string; name?: string; sourceLabel?: string; packId?: string },
      guarded?: PromptPackBuiltinImportInput & { packKey: string },
    ): Promise<unknown>;
  };
  /** The Change Plan adapters, which a plugin's install (and, in Task 18, uninstall) joins. */
  changePlanAdapters: { register(adapter: EvolutionControlPlaneAdapter): void };
}

/** What the install and its plan share: the plugin store, the snapshots and the key store, as plain functions. */
export interface PluginInstallShared {
  readInspection(inspectionId: string): Promise<KeptPluginInspection | undefined>;
  readPlugin(pluginId: string): Promise<StoredPlugin | undefined>;
  updatePlugin(
    pluginId: string,
    change: (current: StoredPlugin | undefined) => StoredPlugin | undefined,
  ): Promise<void>;
  verifySnapshot(treeSha256: string): Promise<void>;
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  readSnapshotText(treeSha256: string, relativePath: string): Promise<string>;
  listBuiltInPluginIds(): Promise<readonly string[]>;
  storeHookSecret(value: string): string;
  deleteHookSecret(secretRef: string): void;
  reportSecretsKept(error: unknown): void;
}

/** The install plan's owners. */
export function pluginInstallSources(
  shared: PluginInstallShared,
  {
    config,
    mcp,
    settings,
    records,
    hooks,
    mcpAdministration,
    promptPackImports,
  }: Omit<CapabilityPluginInstallOwners, "plans" | "keychain" | "changePlanAdapters">,
): PluginInstallSources {
  return {
    readInspection: (inspectionId) => shared.readInspection(inspectionId),
    readPlugin: (pluginId) => shared.readPlugin(pluginId),
    updatePlugin: (pluginId, change) => shared.updatePlugin(pluginId, change),
    verifySnapshot: (treeSha256) => shared.verifySnapshot(treeSha256),
    readManifest: (treeSha256) => shared.readManifest(treeSha256),
    readSnapshotText: (treeSha256, relativePath) => shared.readSnapshotText(treeSha256, relativePath),
    connectorTemplates: () => MCP_SERVER_TEMPLATES,
    listSavedConnectors: () => mcp.listMcpServers(),
    readSettings: async () => {
      const current = await settings.getSettings();
      return {
        revision: current.revision,
        networkAllowlist: current.networkAllowlist,
        deploymentProfile: current.deploymentProfile,
      };
    },
    readHookAllowlist: () => config.toolPolicy.hooks?.networkAllowlist ?? [],
    updateSettings: (input) => settings.updateSettings(input),
    createConnector: (input, owner) =>
      records.runImmediateTransaction(() =>
        createMcpServer(mcpAdministration, input, undefined, undefined, undefined, owner),
      ),
    setConnectorApproval: (server, approvalPosture, pass, actorId) =>
      updateMcpServerPolicy(
        mcpAdministration,
        server.serverId,
        { approvalPosture },
        { expectedRevision: mcpServerRevision(server), actorId },
        pass,
      ),
    // The operator's own switch, never the union with holds: a group another plugin holds isn't this plugin's to keep.
    operatorSwitchedOffToolGroups: () => projectSwitchedOffToolGroups(config.toolPolicy),
    createHook: (input) => hooks.createWorkspaceHook(input),
    importPromptPack: (input, guarded) => promptPackImports.importPromptPack(input, guarded),
    deleteHookSecret: (secretRef) => shared.deleteHookSecret(secretRef),
    reportSecretsKept: (error) => shared.reportSecretsKept(error),
  };
}

/** The Capabilities install's owners. */
export function pluginActionSources(
  shared: PluginInstallShared,
  { plans, records }: Pick<CapabilityPluginInstallOwners, "plans" | "records">,
): CapabilityPluginActionSources {
  return {
    changePlansEnabled: () => plans.isEnabled(),
    findPlan: (actor, idempotencyKey) => plans.findByIdempotencyKey(actor, idempotencyKey),
    createPlan: (input) => plans.create(input),
    // The operator's own install route, so it may ask for the opt-in approval skip (#572).
    confirmPlan: (actor, plan, actionNonce) =>
      plans.confirm(actor, plan.planId, plan.revision, actionNonce, { operatorSettingsSave: true }),
    workspaceExists: async (workspaceId) => (await records.workspaces.find(workspaceId)) !== undefined,
    readInspection: (inspectionId) => shared.readInspection(inspectionId),
    readPlugin: (pluginId) => shared.readPlugin(pluginId),
    listBuiltInPluginIds: () => shared.listBuiltInPluginIds(),
    verifySnapshot: (treeSha256) => shared.verifySnapshot(treeSha256),
    readManifest: (treeSha256) => shared.readManifest(treeSha256),
    storeHookSecret: (value) => shared.storeHookSecret(value),
    deleteHookSecret: (secretRef) => shared.deleteHookSecret(secretRef),
  };
}
