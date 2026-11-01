import fs from "node:fs/promises";
import { NotFoundError } from "@goatcitadel/contracts";
import type { CapabilityPluginInstallOwners, PluginInstallShared } from "./capability-plugin-install-composition.js";
import type { RemovedPlugin, StoredPlugin } from "./capability-plugin-store.js";
import type { PluginUninstallRevokeInput, PluginUninstallRevokeOutcome } from "./capability-skill-actions-service.js";
import { deleteMcpServer, disconnectMcpServer } from "./mcp-server-admin-service.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";
import type { PluginUninstallSources } from "./plugin-uninstall-change-plan-adapter.js";
import { resolvePromptPackExportPath } from "./prompt-pack/import-export.js";

// How a plugin uninstall reaches its owners: the plain readers and writers its plan (the adapter) is handed. Every
// removal stays with its owner, and each owner checks the plugin's pass.

/** The most hooks read at once (the hooks list's own cap): a fuller list may have been cut off. */
const HOOK_LIST_LIMIT = 1_000;

/** What the uninstall shares with the install, and what only it needs: the tombstone, the skills and the clock. */
export interface PluginUninstallShared extends Pick<
  PluginInstallShared,
  "readPlugin" | "updatePlugin" | "readManifest" | "readSnapshotText" | "deleteHookSecret" | "reportSecretsKept"
> {
  removePlugin(pluginId: string, remember: (current: StoredPlugin | undefined) => RemovedPlugin): Promise<void>;
  readSkillChecks(workspaceId: string, snapshotIds: readonly string[]): Promise<ReadonlyMap<string, PluginSkillCheck>>;
  revokeSkill(input: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome>;
  /** A prompt pack's export file that couldn't be removed: inert, and logged so it can be found. */
  reportExportFileKept(packId: string, error: unknown): void;
}

/** The uninstall plan's owners. The install's root, under which a prompt pack's export file lives. */
export function pluginUninstallSources(
  shared: PluginUninstallShared,
  {
    rootDir,
    records,
    plans,
    hooks,
    mcpAdministration,
  }: Pick<CapabilityPluginInstallOwners, "records" | "plans" | "hooks" | "mcpAdministration"> & { rootDir: string },
): PluginUninstallSources {
  return {
    readPlugin: (pluginId) => shared.readPlugin(pluginId),
    updatePlugin: (pluginId, change) => shared.updatePlugin(pluginId, change),
    removePlugin: (pluginId, remember) => shared.removePlugin(pluginId, remember),
    readManifest: (treeSha256) => shared.readManifest(treeSha256),
    readSnapshotText: (treeSha256, relativePath) => shared.readSnapshotText(treeSha256, relativePath),
    deleteHook: async (workspaceId, hookId, pass) => {
      await hooks.deleteWorkspaceHook(workspaceId, hookId, pass);
    },
    listHookSecretRefs: async (workspaceId) => {
      const listed = await hooks.listWorkspaceHooks(workspaceId, HOOK_LIST_LIMIT);
      if (listed.length >= HOOK_LIST_LIMIT) return undefined;
      return new Set(
        listed.flatMap((hook) =>
          hook.action.type === "webhook" && hook.action.webhook.secretRef ? [hook.action.webhook.secretRef] : [],
        ),
      );
    },
    readInstallSecretRefs: async (workspaceId, installPlanId, actorId) => {
      const plan = await plans.get({ workspaceId, actorId, surface: "capabilities" }, installPlanId);
      return plan.request.kind === "plugin_install" ? (plan.request.hookSecretRefs ?? {}) : {};
    },
    deleteHookSecret: (secretRef) => shared.deleteHookSecret(secretRef),
    deletePromptPack: async (packId) => {
      let pack;
      try {
        pack = await records.promptPacks.getPack(packId);
      } catch (error) {
        // Already gone: nothing of it is left to delete.
        if (error instanceof NotFoundError) return;
        throw error;
      }
      await records.promptPacks.deletePackCascade(packId);
      // As a reset that clears a pack's runs does: its export file goes with them.
      await fs.rm(resolvePromptPackExportPath(rootDir, pack), { force: true }).catch((error: unknown) => {
        shared.reportExportFileKept(packId, error);
      });
    },
    disconnectConnector: async (serverId) => {
      try {
        await disconnectMcpServer(mcpAdministration, serverId);
      } catch (error) {
        if (error instanceof NotFoundError) return;
        throw error;
      }
    },
    deleteConnector: async (serverId, pass) => {
      await deleteMcpServer(mcpAdministration, serverId, undefined, pass);
    },
    readSkillChecks: (workspaceId, snapshotIds) => shared.readSkillChecks(workspaceId, snapshotIds),
    revokeSkill: (input) => shared.revokeSkill(input),
    reportSecretsKept: (error) => shared.reportSecretsKept(error),
    now: () => new Date(),
  };
}
