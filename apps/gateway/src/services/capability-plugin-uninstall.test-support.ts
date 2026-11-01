import { vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { readPluginPieceOwner, type StoredPlugin } from "./capability-plugin-store.js";
import type { PluginUninstallRevokeInput, PluginUninstallRevokeOutcome } from "./capability-skill-actions-service.js";
import type { EvolutionControlPlaneActor } from "./evolution-control-plane-service.js";
import {
  ISSUES_TEMPLATE,
  OPERATOR,
  PLUGIN_ID,
  WORKSPACE_ID,
  pluginInstallHarness,
  type PluginInstallFixture,
} from "./capability-plugin-install.test-support.js";
import { assertMcpServerRemovalAllowed, assertNotPluginOwned } from "./plugin-owned-refusal.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";
import {
  PluginUninstallChangePlanAdapter,
  type HookSecretHolder,
  type PluginUninstallSources,
} from "./plugin-uninstall-change-plan-adapter.js";
import type { PendingSkillStep } from "./plugin-uninstall-skills.js";

// One plugin install and then its uninstall, over the real Change Plan control plane and the plugin store's real
// compare-and-set rules, with every other owner kept in memory. Each owner checks the plugin's pass as the real one
// does. The skill revoke is handed in, so a test can drive the Skills tab's own one.

export const HOOK_SECRET = "whsec-meeting-tools-0123456789";
export const SKILL_CHECK_ID = "snapshot-skill-1";
export const SKILL_ID = "extra:meeting-notes";

/** A plugin skill piece's check, by default switched on from this check and not revoked. */
export function skillCheck(overrides: Partial<PluginSkillCheck> = {}): PluginSkillCheck {
  return {
    snapshotId: SKILL_CHECK_ID,
    title: "Meeting notes",
    skillId: SKILL_ID,
    version: "switched_on",
    revoked: false,
    pendingApprovals: {},
    installInactive: { allowed: false, blockers: ["SOURCE_ALREADY_INSTALLED", "RUNTIME_ALREADY_EXISTS"] },
    step: "done",
    ...overrides,
  };
}

/** The check once its revoke's effect applied. */
export const REVOKED = (overrides: Partial<PluginSkillCheck> = {}) =>
  skillCheck({ revoked: true, version: "installed_off", step: "installed_off", ...overrides });

export interface PluginUninstallFixture extends PluginInstallFixture {
  /** The Skills tab's revoke; by default one approved whose effect revokes the skill at once. */
  revokeSkill?: (input: PluginUninstallRevokeInput) => Promise<PluginUninstallRevokeOutcome>;
}

export function pluginUninstallHarness(input: PluginUninstallFixture = {}) {
  const h = pluginInstallHarness(input);
  const removal = {
    order: [] as string[],
    deletedHooks: new Set<string>(),
    deletedPacks: [] as string[],
    disconnected: [] as string[],
    /** The plugin's skill checks, by id; a test changes them as Skill Hub would. */
    skillChecks: new Map<string, PluginSkillCheck>([[SKILL_CHECK_ID, skillCheck()]]),
    /** Own install steps still waiting, as the full read of waiting approvals finds them. */
    pendingSteps: new Map<string, PendingSkillStep>(),
    /** The owner that fails: `hook`, `prompt_pack`, `hold_release`, `connector_delete`, `revoke` or `remove_record`. */
    failAt: undefined as string | undefined,
  };
  const step = (name: string) => {
    removal.order.push(name);
    if (removal.failAt === name) throw new Error(`The ${name} owner failed at C:\\goat\\data.`);
  };
  const revokeSkill = vi.fn(
    input.revokeSkill ??
      (async (revoke: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome> => {
        step("revoke");
        // Approved, and its effect lands while the approval resolves.
        removal.skillChecks.set(revoke.snapshotId, REVOKED({ snapshotId: revoke.snapshotId }));
        return { status: "approved", approvalId: `approval-revoke-${revoke.snapshotId}` };
      }),
  );
  const liveHooks = () =>
    h.state.hooks
      .map((hook, index) => ({ hookId: `hook-${index + 1}`, hook }))
      .filter(({ hookId }) => !removal.deletedHooks.has(hookId));
  const releasesHold = (current: StoredPlugin | undefined, next: StoredPlugin | undefined) =>
    current?.pieces.some(
      (piece) =>
        piece.kind === "tool_group_off" &&
        piece.ref !== undefined &&
        next?.pieces.find((item) => item.pieceId === piece.pieceId)?.ref === undefined,
    ) === true;
  const sources = {
    readPlugin: (pluginId: string) => h.store.get(pluginId),
    listPlugins: () => h.store.list(),
    updatePlugin: (pluginId, change) =>
      h.store.update(pluginId, (current) => {
        const next = change(current);
        if (releasesHold(current, next)) step("hold_release");
        return next;
      }),
    removePlugin: async (pluginId, remember) => {
      step("remove_record");
      await h.store.remove(pluginId, remember);
    },
    readManifest: (treeSha256) => h.sources.readManifest(treeSha256),
    readSnapshotText: (treeSha256, relativePath) => h.sources.readSnapshotText(treeSha256, relativePath),
    deleteHook: vi.fn(async (_workspaceId: string, hookId: string, pass) => {
      step("hook");
      // The hooks owner reads the plugin store to refuse a hook a plugin added, unless the pass is that plugin's.
      await assertNotPluginOwned((ref) => readPluginPieceOwner(h.rows, "hook", ref), hookId, pass);
      const found = liveHooks().find((item) => item.hookId === hookId);
      if (!found) return;
      removal.deletedHooks.add(hookId);
      // Its own signing secret goes with it, as the hooks owner deletes it.
      const secretRef = found.hook.action.type === "webhook" ? found.hook.action.webhook.secretRef : undefined;
      if (secretRef) h.state.keychain.delete(secretRef);
    }),
    listHookSecrets: vi.fn(
      async (_workspaceId: string): Promise<readonly HookSecretHolder[] | undefined> =>
        liveHooks().flatMap(({ hookId, hook }) =>
          hook.action.type === "webhook" && hook.action.webhook.secretRef
            ? [{ hookId, secretRef: hook.action.webhook.secretRef, url: hook.action.webhook.url }]
            : [],
        ),
    ),
    readInstallSecretRefs: vi.fn(async (workspaceId: string, installPlanId: string, actorId: string) => {
      const plan = await h.plans.get({ workspaceId, actorId, surface: "capabilities" }, installPlanId);
      return plan.request.kind === "plugin_install" ? (plan.request.hookSecretRefs ?? {}) : {};
    }),
    deleteHookSecret: (secretRef) => h.sources.deleteHookSecret(secretRef),
    deletePromptPack: vi.fn(async (packId: string) => {
      step("prompt_pack");
      h.state.packs = h.state.packs.filter((pack) => pack.packId !== packId);
      removal.deletedPacks.push(packId);
    }),
    listSavedConnectors: async () => [...h.state.servers],
    connectorTemplates: () => [ISSUES_TEMPLATE],
    disconnectConnector: vi.fn(async (serverId: string) => {
      step("connector_disconnect");
      removal.disconnected.push(serverId);
    }),
    deleteConnector: vi.fn(async (serverId: string, pass) => {
      step("connector_delete");
      // The MCP owner refuses a plugin's connector without the pass.
      assertMcpServerRemovalAllowed(
        h.state.servers.find((server) => server.serverId === serverId),
        pass,
      );
      h.state.servers = h.state.servers.filter((server) => server.serverId !== serverId);
    }),
    releaseConnector: vi.fn(async (serverId: string, pass) => {
      step("connector_release");
      const server = h.state.servers.find((item) => item.serverId === serverId);
      assertMcpServerRemovalAllowed(server, pass);
      h.state.servers = h.state.servers.map((item) => {
        if (item.serverId !== serverId) return item;
        const { pluginOwner: _released, ...unmarked } = item;
        return unmarked;
      });
    }),
    readSkillChecks: vi.fn(
      async (_workspaceId: string, snapshotIds: readonly string[]) =>
        new Map(
          snapshotIds.flatMap((id) => {
            const check = removal.skillChecks.get(id);
            return check ? [[id, structuredClone(check)] as const] : [];
          }),
        ),
    ),
    listPendingSkillSteps: vi.fn(
      async (_workspaceId: string, snapshotIds: readonly string[]) =>
        new Map(
          snapshotIds.flatMap((id) => (removal.pendingSteps.has(id) ? [[id, removal.pendingSteps.get(id)!]] : [])),
        ),
    ),
    revokeSkill,
    reportUndecidedSecrets: vi.fn((_pluginId: string, _secretRefs: readonly string[], _error: unknown) => undefined),
    // No real wait: a test changes the check between reads instead.
    pause: vi.fn(async (_ms: number) => undefined),
    now: () => new Date("2026-10-31T12:00:00.000Z"),
  } satisfies PluginUninstallSources;
  const adapter = new PluginUninstallChangePlanAdapter(sources);
  h.registry.register(adapter);

  const uninstall = (actor: EvolutionControlPlaneActor = OPERATOR, idempotencyKey = "uninstall-1") =>
    h.actions.uninstall({
      workspaceId: actor.workspaceId,
      pluginId: PLUGIN_ID,
      actorId: actor.actorId,
      idempotencyKey,
    });
  /** Installs the plugin as the Capabilities route does: its hook's secret stored, then one confirmation. */
  const install = (inspectionId = h.state.inspection.inspectionId) =>
    h.actions.install({
      workspaceId: WORKSPACE_ID,
      inspectionId,
      ...(h.state.inspection.pieces.some((piece) => piece.kind === "hook")
        ? { hookSecrets: { "tool-watch": HOOK_SECRET } }
        : {}),
      actorId: OPERATOR.actorId,
      idempotencyKey: `install-${inspectionId}-${Math.random()}`,
    });
  const confirm = (plan: ChangePlanRecord) => h.confirm(plan);

  return {
    ...h,
    removal,
    uninstallSources: sources,
    uninstallAdapter: adapter,
    revokeSkill,
    uninstall,
    install,
    confirm,
  };
}
