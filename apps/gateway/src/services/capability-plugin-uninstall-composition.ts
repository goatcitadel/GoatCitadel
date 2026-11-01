import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  NotFoundError,
  SKILL_HUB_LIFECYCLE_APPROVAL_KIND,
  SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA,
  type ApprovalListResponse,
  type ApprovalRequest,
  type McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import type { CapabilityPluginInstallOwners, PluginInstallShared } from "./capability-plugin-install-composition.js";
import type { RemovedPlugin, StoredPlugin } from "./capability-plugin-store.js";
import type { PluginUninstallRevokeInput, PluginUninstallRevokeOutcome } from "./capability-skill-actions-service.js";
import { deleteMcpServer, disconnectMcpServer, releaseMcpServerFromPlugin } from "./mcp-server-admin-service.js";
import type { ApprovalReading, PluginSkillCheck } from "./plugin-skill-checks.js";
import type { PluginUninstallSources } from "./plugin-uninstall-change-plan-adapter.js";
import type { PendingSkillStep } from "./plugin-uninstall-skills.js";
import { resolvePromptPackExportPath } from "./prompt-pack/import-export.js";

// How a plugin uninstall reaches its owners: the plain readers and writers its plan (the adapter) is handed. Every
// removal stays with its owner, and each owner checks the plugin's pass.

/** The most hooks read at once (the hooks list's own cap): a fuller list may have been cut off. */
const HOOK_LIST_LIMIT = 1_000;
/** The most prompt packs read to tell whether another pack writes the same export file. */
const PACK_LIST_LIMIT = 1_000;
/** The waiting approvals' largest page, and how many pages are read before the read fails rather than miss one. */
const PENDING_PAGE_LIMIT = 200;
const PENDING_MAX_PAGES = 25;

/** What the uninstall shares with the install, and what only it needs: the tombstone, the skills and the clock. */
export interface PluginUninstallShared extends Pick<
  PluginInstallShared,
  "readPlugin" | "updatePlugin" | "readManifest" | "readSnapshotText" | "deleteHookSecret"
> {
  listPlugins(): Promise<readonly StoredPlugin[]>;
  removePlugin(pluginId: string, remember: (current: StoredPlugin | undefined) => RemovedPlugin): Promise<void>;
  readSkillChecks(workspaceId: string, snapshotIds: readonly string[]): Promise<ReadonlyMap<string, PluginSkillCheck>>;
  revokeSkill(input: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome>;
  connectorTemplates(): readonly McpServerTemplateRecord[];
  /** The Inbox's waiting approvals, a page at a time. */
  listPendingApprovals(input: { status: "pending"; limit: number; cursor?: string }): Promise<ApprovalListResponse>;
  /** Where one approval stands, and whether its work still runs; undefined when it can't be read. */
  readApproval(approvalId: string): Promise<ApprovalReading | undefined>;
  /** A prompt pack's export file that couldn't be removed: inert, and logged so it can be found. */
  reportExportFileKept(packId: string, error: unknown): void;
  reportUndecidedSecrets(pluginId: string, secretRefs: readonly string[], error: unknown): void;
}

/** The uninstall plan's owners. The install's root, under which a prompt pack's export file lives. */
export function pluginUninstallSources(
  shared: PluginUninstallShared,
  {
    rootDir,
    records,
    plans,
    hooks,
    mcp,
    mcpAdministration,
  }: Pick<CapabilityPluginInstallOwners, "records" | "plans" | "hooks" | "mcp" | "mcpAdministration"> & {
    rootDir: string;
  },
): PluginUninstallSources {
  return {
    readPlugin: (pluginId) => shared.readPlugin(pluginId),
    listPlugins: () => shared.listPlugins(),
    updatePlugin: (pluginId, change) => shared.updatePlugin(pluginId, change),
    removePlugin: (pluginId, remember) => shared.removePlugin(pluginId, remember),
    readManifest: (treeSha256) => shared.readManifest(treeSha256),
    readSnapshotText: (treeSha256, relativePath) => shared.readSnapshotText(treeSha256, relativePath),
    deleteHook: (workspaceId, hookId, pass) => hooks.deleteWorkspaceHook(workspaceId, hookId, pass),
    listHookSecrets: async (workspaceId) => {
      const listed = await hooks.listWorkspaceHooks(workspaceId, HOOK_LIST_LIMIT);
      if (listed.length >= HOOK_LIST_LIMIT) return undefined;
      return listed.flatMap((hook) =>
        hook.action.type === "webhook" && hook.action.webhook.secretRef
          ? [
              {
                hookId: hook.hookId,
                label: hook.label,
                secretRef: hook.action.webhook.secretRef,
                url: hook.action.webhook.url,
              },
            ]
          : [],
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
        if (error instanceof NotFoundError) return false;
        throw error;
      }
      // The export file goes first, as a reset that clears a pack's runs removes it: it can be written again from the
      // pack, so an uninstall stopped after this still finds the pack to delete. A file another pack also writes stays,
      // and so does one when the saved packs can't all be read at once (one beyond the read might write it).
      const exportFile = resolvePromptPackExportPath(rootDir, pack);
      const listed = await records.promptPacks.listPacks(PACK_LIST_LIMIT);
      const others = listed.filter((item) => item.packId !== packId);
      const writtenByAnother = others.some((item) => samePath(resolvePromptPackExportPath(rootDir, item), exportFile));
      if (listed.length >= PACK_LIST_LIMIT) {
        shared.reportExportFileKept(
          packId,
          new Error("Too many saved prompt packs to tell whether another writes it."),
        );
      } else if (!writtenByAnother) {
        await fs.rm(exportFile, { force: true }).catch((error: unknown) => shared.reportExportFileKept(packId, error));
      }
      await records.promptPacks.deletePackCascade(packId);
      return true;
    },
    listSavedConnectors: () => mcp.listMcpServers(),
    connectorTemplates: () => shared.connectorTemplates(),
    disconnectConnector: async (serverId) => {
      try {
        await disconnectMcpServer(mcpAdministration, serverId);
      } catch (error) {
        if (error instanceof NotFoundError) return;
        throw error;
      }
    },
    deleteConnector: async (serverId, pass) =>
      (await deleteMcpServer(mcpAdministration, serverId, undefined, pass)).deleted,
    releaseConnector: async (serverId, pass) => {
      await releaseMcpServerFromPlugin(mcpAdministration, serverId, pass);
    },
    readSkillChecks: (workspaceId, snapshotIds) => shared.readSkillChecks(workspaceId, snapshotIds),
    listPendingSkillSteps: (workspaceId, snapshotIds) =>
      readPendingSkillSteps((input) => shared.listPendingApprovals(input), workspaceId, snapshotIds),
    revokeSkill: (input) => shared.revokeSkill(input),
    readApproval: (approvalId) => shared.readApproval(approvalId),
    reportUndecidedSecrets: (pluginId, secretRefs, error) => shared.reportUndecidedSecrets(pluginId, secretRefs, error),
    pause: async (ms) => {
      await delay(ms);
    },
    now: () => new Date(),
  };
}

/**
 * Each of these checks' own install steps still waiting for approval, read from every waiting approval page by page
 * (never only a workspace's newest approvals), so a switch-on left waiting long ago is still found. A list longer than
 * the cap fails the read rather than answer from a part of it.
 */
export async function readPendingSkillSteps(
  listPage: PluginUninstallShared["listPendingApprovals"],
  workspaceId: string,
  snapshotIds: readonly string[],
): Promise<ReadonlyMap<string, PendingSkillStep>> {
  const wanted = new Set(snapshotIds);
  const steps = new Map<string, PendingSkillStep>();
  let cursor: string | undefined;
  for (let page = 0; page < PENDING_MAX_PAGES; page += 1) {
    const result = await listPage({ status: "pending", limit: PENDING_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    for (const approval of result.items) {
      const step = pendingSkillStep(approval, workspaceId);
      if (step && wanted.has(step.snapshotId) && !steps.has(step.snapshotId)) {
        steps.set(step.snapshotId, { approvalId: step.approvalId, operation: step.operation });
      }
    }
    if (!result.nextCursor) return steps;
    cursor = result.nextCursor;
  }
  throw new Error(`More than ${PENDING_MAX_PAGES} pages of waiting approvals`);
}

/** A waiting Skill Hub install step on one of the workspace's checks, read from the approval's own intent. */
function pendingSkillStep(
  approval: Pick<ApprovalRequest, "approvalId" | "kind" | "status" | "preview">,
  workspaceId: string,
): (PendingSkillStep & { snapshotId: string }) | undefined {
  if (approval.kind !== SKILL_HUB_LIFECYCLE_APPROVAL_KIND || approval.status !== "pending") return undefined;
  const preview = approval.preview as { schemaVersion?: unknown; intent?: Record<string, unknown> } | undefined;
  const intent = preview?.schemaVersion === SKILL_HUB_OPERATION_INTENT_PREVIEW_SCHEMA ? preview.intent : undefined;
  const operation = intent?.operationKind;
  if (intent?.workspaceId !== workspaceId || typeof intent.snapshotId !== "string") return undefined;
  if (operation !== "install_inactive" && operation !== "activate") return undefined;
  return { approvalId: approval.approvalId, operation, snapshotId: intent.snapshotId };
}

/** The same file, compared without case: a match keeps the file, the safe way round where case matters. */
function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
