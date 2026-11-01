import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  SemanticValidationError,
  canonicalJsonString,
  isGoatError,
  type ChangePlanPluginUninstallRequest,
  type ChangePlanRecord,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type PluginManifestParse,
  type PluginPieceKind,
} from "@goatcitadel/contracts";
import { describePluginPieces, type PluginPieceLabel } from "./capability-plugin-detail.js";
import type { RemovedPlugin, StoredPlugin, StoredPluginPiece } from "./capability-plugin-store.js";
import type { PluginUninstallRevokeInput, PluginUninstallRevokeOutcome } from "./capability-skill-actions-service.js";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";
import { mcpServerLabelKey } from "./mcp-money-moving.js";
import type { PluginPass } from "./plugin-owned-refusal.js";
import {
  boundedSentences,
  boundedTitle,
  failureDetail,
  groupLabel,
  requireCapabilitiesOrigin,
} from "./plugin-plan-support.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";
import {
  decideSkillRemoval,
  hasInstalledSkill,
  type PendingSkillStep,
  type SkillWaitReason,
} from "./plugin-uninstall-skills.js";

// A plugin uninstall: one Change Plan that removes exactly the pieces the plugin's install added, each through its own
// owner with the plugin's pass, in reverse install order. What was already there stays, and so do the hosts it allowed.

export const PLUGIN_NOT_INSTALLED_MESSAGE = "This plugin isn't installed.";
export const PLUGIN_IN_OTHER_WORKSPACE_MESSAGE = "This plugin was installed in another workspace. Uninstall it there.";
export const UNINSTALL_CHANGE_PLANS_OFF_MESSAGE =
  "Uninstalling plugins needs Change Plans, which are off on this install.";
export const UNINSTALL_ANSWER_GONE_MESSAGE =
  "This uninstall's first answer is no longer kept, so it can't be sent again. Uninstall the plugin again.";
const UNINSTALL_CHANGED_MESSAGE = "This plugin changed since you asked to uninstall it. Uninstall it again.";
/** How often, and how many times, an approved revoke's check is read while its effect runs: about 10 seconds. */
const REVOKE_EFFECT_PAUSE_MS = 250;
const REVOKE_EFFECT_READS = 40;
const HOSTS_STAY = "Hosts it allowed stay in your allowlist.";
const ORIGIN_REFUSAL = {
  message: "Plugins are uninstalled from Capabilities.",
  diagnosticCode: "plugin_uninstall_untrusted_origin",
} as const;

/** A hook in the workspace that signs with a stored secret: what an uninstall reads to tell which secrets are in use. */
export interface HookSecretHolder {
  hookId: string;
  secretRef: string;
  url: string;
}

/** One plain reader or writer per owner an uninstall goes through. The adapter only orders them. */
export interface PluginUninstallSources {
  readPlugin(pluginId: string): Promise<StoredPlugin | undefined>;
  /** Every plugin record: another plugin may keep a connector this one added. */
  listPlugins(): Promise<readonly StoredPlugin[]>;
  /** `CapabilityPluginStore.update`: the change may run again on a newer record. */
  updatePlugin(
    pluginId: string,
    change: (current: StoredPlugin | undefined) => StoredPlugin | undefined,
  ): Promise<void>;
  /** `CapabilityPluginStore.remove`: deletes the record and keeps its tombstone in the same write. */
  removePlugin(pluginId: string, remember: (current: StoredPlugin | undefined) => RemovedPlugin): Promise<void>;
  /** A plugin's manifest, read from its snapshot: for each piece's label, and what another plugin kept. */
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  readSnapshotText(treeSha256: string, relativePath: string): Promise<string>;
  /** The hooks owner's delete, with the plugin's pass; it deletes the hook's own signing secret with it. */
  deleteHook(workspaceId: string, hookId: string, pass: PluginPass): Promise<void>;
  /** Every hook in the workspace that signs with a stored secret; undefined when the list may have been cut off. */
  listHookSecrets(workspaceId: string): Promise<readonly HookSecretHolder[] | undefined>;
  /** The signing secrets the install plan stored, by hook piece. */
  readInstallSecretRefs(
    workspaceId: string,
    installPlanId: string,
    actorId: string,
  ): Promise<Readonly<Record<string, string>>>;
  /** Deletes a signing secret. It reports its own failure and never throws. */
  deleteHookSecret(secretRef: string): void;
  /** Deletes a prompt pack with every run, score and benchmark, and its export file. */
  deletePromptPack(packId: string): Promise<void>;
  /** The saved connectors. */
  listSavedConnectors(): Promise<readonly McpServerRecord[]>;
  /** The shipped connector catalog: what a kept connector piece is saved under. */
  connectorTemplates(): readonly McpServerTemplateRecord[];
  /** Disconnects a connector; one that is already gone is left as it is. */
  disconnectConnector(serverId: string): Promise<void>;
  /** The MCP owner's delete, with the plugin's pass. */
  deleteConnector(serverId: string, pass: PluginPass): Promise<void>;
  /** The MCP owner's release, with the plugin's pass: the connector becomes the operator's own and nothing else changes. */
  releaseConnector(serverId: string, pass: PluginPass): Promise<void>;
  /** The plugin's skill checks, by their ids; a check that isn't there is left out. */
  readSkillChecks(workspaceId: string, snapshotIds: readonly string[]): Promise<ReadonlyMap<string, PluginSkillCheck>>;
  /** Each check's own install step still waiting for its approval, read from every waiting approval. */
  listPendingSkillSteps(
    workspaceId: string,
    snapshotIds: readonly string[],
  ): Promise<ReadonlyMap<string, PendingSkillStep>>;
  /** The Skills tab's one revoke for a plugin's skill: approved at once, except on `remote_hardened`. */
  revokeSkill(input: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome>;
  /** Reports the signing secrets kept because it couldn't be told whether a hook still uses them. */
  reportUndecidedSecrets(pluginId: string, secretRefs: readonly string[], error: unknown): void;
  /** Waits this long before a skill's check is read again. */
  pause(ms: number): Promise<void>;
  now(): Date;
}

/** The uninstall's steps, in reverse install order; a failure's `failureCode` names the one it stopped at. */
type UninstallStep = "record" | "hooks" | "prompt_packs" | "tool_groups" | "connectors" | "skills" | "finish";

/** What an apply has done so far, read by its summary. */
interface UninstallProgress {
  removed: number;
  /** The piece a step was working on when it stopped. */
  current?: StoredPluginPiece;
  /** Connectors left to the operator because another installed plugin uses them. */
  readonly handedOver: string[];
  /** The skills whose removal still waits, by label. */
  readonly waiting: Array<{ label: string; reason: SkillWaitReason }>;
}

/** A step that stops with its own plain words, and the owner's in `failureDetail`. */
class UninstallStepStopped extends Error {
  public constructor(
    public readonly what: string,
    detail: string,
  ) {
    super(detail);
    this.name = "UninstallStepStopped";
  }
}

/**
 * Uninstalls a plugin as the operator's own Capabilities action: it deletes the plugin's hooks and the signing secrets
 * no hook uses any more, deletes its prompt packs with their runs, releases its tool-group holds, disconnects and
 * deletes its connectors (leaving one another installed plugin uses to the operator), and revokes its switched-on
 * skills. It touches only the pieces the plugin added, never one it kept, never the operator's own switches, and never
 * a host in either allowlist. The record reads `uninstalling` until every skill's check reads revoked, then it is
 * deleted and a tombstone keeps the skills it left behind named after it.
 */
export class PluginUninstallChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanPluginUninstallRequest> {
  readonly adapterId = "plugin-uninstall";
  readonly version = 1;
  readonly kinds = ["plugin_uninstall"] as const;
  /** An uninstall is undone by installing the plugin again. */
  readonly rollbackRefusal = "Install the plugin again instead.";
  constructor(private readonly sources: PluginUninstallSources) {}

  async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanPluginUninstallRequest) {
    requireCapabilitiesOrigin(context.origin, ORIGIN_REFUSAL);
    const record = await this.bind(request, context.origin.workspaceId);
    const labels = await this.labelsOf(record);
    const installedSkills = await this.installedSkillPieces(record);
    const keepers = await this.connectorKeepers(record).catch(() => new Map<string, string>());
    const saved = await this.sources.listSavedConnectors().catch(() => []);
    const summary = boundedSentences(plannedSentences(record, labels, installedSkills, keepers, saved));
    const title = boundedTitle(`Uninstall ${record.name}`);
    return {
      target: {
        ownerId: "capability_plugins",
        resourceId: `plugin:${record.pluginId}`,
        expectedHash: recordHash(record),
      },
      title,
      summary,
      impact: boundedSentences([
        "Anything that was there before the plugin stays.",
        HOSTS_STAY,
        ...(installedSkills.size > 0 ? ["A skill it added can't be installed again until skills can be removed."] : []),
      ]),
      risk: "caution" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({ title, confirmationText: summary }),
      evidenceRefs: [`plugin:${record.pluginId}`],
    };
  }

  async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    let record: StoredPlugin;
    try {
      // The record as it was when the plan was made: a change since stops the uninstall before anything is removed.
      record = await this.bind(request, plan.origin.workspaceId);
      if (recordHash(record) !== plan.target.expectedHash) throw uninstallChanged();
    } catch (error) {
      if (!isGoatError(error) || error.httpStatus >= 500) throw error;
      return {
        status: "failed" as const,
        result: {
          summary: error.message,
          failureCode: error instanceof ConflictError ? "plugin_uninstall_changed" : "plugin_uninstall_refused",
        },
      };
    }
    const labels = await this.labelsOf(record);
    const pass: PluginPass = { pluginId: record.pluginId, installPlanId: record.installPlanId };
    // The operator who asked for the uninstall, not whoever resumed it, is named on every revoke.
    const actorId = plan.origin.actorId ?? "operator";
    const progress: UninstallProgress = { removed: 0, handedOver: [], waiting: [] };
    let step: UninstallStep = "record";
    try {
      await this.save(request, (current) => ({ ...current, state: "uninstalling", uninstallPlanId: plan.planId }));
      step = "hooks";
      await this.removeEach(record, request, "hook", progress, (ref) =>
        this.sources.deleteHook(record.workspaceId, ref, pass),
      );
      await this.removeLeftoverHookSecrets(record, request, pass, actorId, labels, progress);
      step = "prompt_packs";
      await this.removeEach(record, request, "prompt_pack", progress, (ref) => this.sources.deletePromptPack(ref));
      step = "tool_groups";
      await this.releaseHolds(record, request, progress);
      step = "connectors";
      await this.removeConnectors(record, request, pass, labels, progress);
      step = "skills";
      const skillIds = await this.removeSkills(record, request, actorId, labels, progress);
      step = "finish";
      if (progress.waiting.length > 0) {
        return { status: "completed" as const, result: { summary: waitingSummary(record, progress) } };
      }
      await this.sources.removePlugin(request.pluginId, (current) => {
        if (current?.installPlanId !== request.installPlanId) throw uninstallChanged();
        return {
          pluginId: current.pluginId,
          name: current.name,
          skillIds,
          removedAt: this.sources.now().toISOString(),
        };
      });
      return {
        status: "completed" as const,
        evidenceRefs: [...plan.evidenceRefs, `plugin_uninstalled:${request.pluginId}`],
        result: {
          summary: boundedSentences([`Removed ${piecesCount(progress.removed)}.`, ...progress.handedOver, HOSTS_STAY]),
        },
      };
    } catch (error) {
      return stopped(record, labels, progress, step, error);
    }
  }

  /** Reports whether the plugin is gone after an interruption. It never writes, so nothing is removed twice. */
  async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    const record = await this.sources.readPlugin(request.pluginId);
    if (record?.installPlanId !== request.installPlanId) {
      return { effectObserved: true, status: "completed" as const, result: { summary: "The plugin is uninstalled." } };
    }
    return {
      effectObserved: false,
      status: "manual_required" as const,
      result: {
        summary: `The uninstall stopped before it finished. Uninstall ${record.name} again to finish.`,
        failureCode: "plugin_uninstall_interrupted",
      },
    };
  }

  /** The plugin's record, installed by the install the request names, in the plan's workspace. */
  private async bind(request: ChangePlanPluginUninstallRequest, workspaceId: string): Promise<StoredPlugin> {
    const record = await this.sources.readPlugin(request.pluginId);
    if (!record) throw new NotFoundError(PLUGIN_NOT_INSTALLED_MESSAGE);
    if (record.workspaceId !== workspaceId) throw new NotFoundError(PLUGIN_IN_OTHER_WORKSPACE_MESSAGE);
    if (record.installPlanId !== request.installPlanId) throw uninstallChanged();
    return record;
  }

  /** Each piece's label as the plugin's detail shows it, or none when its manifest can't be read: then ids stand in. */
  private async labelsOf(record: StoredPlugin): Promise<ReadonlyMap<string, PluginPieceLabel>> {
    try {
      const parsed = await this.sources.readManifest(record.snapshotTreeSha256);
      if (!parsed.ok || parsed.manifestSha256 !== record.manifestSha256) return new Map();
      return await describePluginPieces(
        parsed.manifest,
        (relativePath) => this.sources.readSnapshotText(record.snapshotTreeSha256, relativePath),
        () => undefined,
      );
    } catch {
      // Labels only name the pieces in the summary; what is removed comes from the record alone.
      return new Map();
    }
  }

  /**
   * The skill pieces that have something installed, by piece id, for the plan's own words. A check that can't be read
   * counts as installed, so the plan never promises less than it might remove.
   */
  private async installedSkillPieces(record: StoredPlugin): Promise<ReadonlySet<string>> {
    const open = ownedPieces(record, "skill").filter((piece) => !piece.removed && piece.skillSnapshotId);
    if (open.length === 0) return new Set();
    let checks: ReadonlyMap<string, PluginSkillCheck> | undefined;
    try {
      checks = await this.sources.readSkillChecks(
        record.workspaceId,
        open.map((piece) => piece.skillSnapshotId!),
      );
    } catch {
      checks = undefined;
    }
    return new Set(
      open
        .filter((piece) => {
          const check = checks?.get(piece.skillSnapshotId!);
          return !checks || !check || hasInstalledSkill(check);
        })
        .map((piece) => piece.pieceId),
    );
  }

  /**
   * After the hooks: every signing secret the install stored is deleted unless a hook in the workspace still uses it. A
   * hook still holding one is a hook this install made before its record named it (each secret was minted for this
   * install alone), so it is removed through the hooks owner, which takes its secret too. When it can't be told which
   * secrets are in use, nothing is deleted and the step stops, so uninstalling again finishes it.
   */
  private async removeLeftoverHookSecrets(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    pass: PluginPass,
    actorId: string,
    labels: ReadonlyMap<string, PluginPieceLabel>,
    progress: UninstallProgress,
  ): Promise<void> {
    // A plugin with no hooks stored no secret.
    if (!record.pieces.some((piece) => piece.kind === "hook" && piece.owned)) return;
    let stored: Readonly<Record<string, string>> = {};
    let holders: readonly HookSecretHolder[];
    try {
      stored = await this.sources.readInstallSecretRefs(record.workspaceId, record.installPlanId, actorId);
      const listed = await this.sources.listHookSecrets(record.workspaceId);
      if (!listed) throw new Error("The workspace has too many hooks to read them all at once.");
      holders = listed;
    } catch (error) {
      this.sources.reportUndecidedSecrets(record.pluginId, Object.values(stored), error);
      throw new UninstallStepStopped(
        "Couldn't tell whether its hooks still use the signing secrets it stored, so they were kept.",
        failureDetail(error) ?? "The hooks or the install couldn't be read.",
      );
    }
    for (const [pieceId, secretRef] of Object.entries(stored)) {
      const holder = holders.find((hook) => hook.secretRef === secretRef);
      if (!holder) {
        // A second delete of a secret already gone is harmless.
        this.sources.deleteHookSecret(secretRef);
        continue;
      }
      const piece = record.pieces.find((item) => item.kind === "hook" && item.pieceId === pieceId && item.owned);
      const host = labels.get(pieceId)?.hosts?.[0];
      if (!piece || (host && hostOf(holder.url) !== host)) {
        throw new UninstallStepStopped(
          `A hook that sends event details to ${hostOf(holder.url) ?? "another address"} uses a signing secret this ` +
            "plugin stored, and doesn't match its hook, so it was kept.",
          `Hook ${holder.hookId} holds the secret stored for piece ${pieceId}.`,
        );
      }
      progress.current = piece;
      await this.sources.deleteHook(record.workspaceId, holder.hookId, pass);
      await this.savePiece(request, pieceId, removedPiece);
      progress.removed += 1;
    }
    progress.current = undefined;
  }

  /** Step 3: every tool group the plugin holds off is released at once. The operator's own switch is never written. */
  private async releaseHolds(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    progress: UninstallProgress,
  ): Promise<void> {
    const held = ownedPieces(record, "tool_group_off").filter((piece) => piece.ref !== undefined);
    if (held.length === 0) return;
    const ids = new Set(held.map((piece) => piece.pieceId));
    await this.save(request, (current) => ({
      ...current,
      pieces: current.pieces.map((piece) => (ids.has(piece.pieceId) && piece.owned ? removedPiece(piece) : piece)),
    }));
    progress.removed += held.length;
  }

  /**
   * Step 4: each connector the plugin added, and any saved connector still marked as this install's that its record
   * never got to name. One another installed plugin kept is left to the operator (its mark released); the rest are
   * disconnected, then deleted.
   */
  private async removeConnectors(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    pass: PluginPass,
    labels: ReadonlyMap<string, PluginPieceLabel>,
    progress: UninstallProgress,
  ): Promise<void> {
    const saved = await this.sources.listSavedConnectors();
    const keepers = await this.connectorKeepers(record);
    const remove = async (serverId: string): Promise<boolean> => {
      const server = saved.find((item) => item.serverId === serverId);
      const keeper = server ? keepers.get(mcpServerLabelKey(server.label)) : undefined;
      if (server && keeper) {
        await this.sources.releaseConnector(serverId, pass);
        progress.handedOver.push(`Kept ${server.label}, which ${keeper} uses.`);
        return false;
      }
      await this.sources.disconnectConnector(serverId);
      await this.sources.deleteConnector(serverId, pass);
      return true;
    };
    const named = new Set<string>();
    for (const piece of ownedPieces(record, "connector")) {
      if (piece.ref === undefined) continue;
      named.add(piece.ref);
      progress.current = piece;
      const removed = await remove(piece.ref);
      await this.savePiece(request, piece.pieceId, removedPiece);
      if (removed) progress.removed += 1;
    }
    // Saved and marked by this install, which stopped before its record named it.
    const pieces = ownedPieces(record, "connector");
    for (const server of saved) {
      const owner = server.pluginOwner;
      if (owner?.pluginId !== record.pluginId || owner.installPlanId !== record.installPlanId) continue;
      if (named.has(server.serverId)) continue;
      progress.current = pieces.find((piece) => piece.ref === undefined);
      if (await remove(server.serverId)) progress.removed += 1;
    }
    progress.current = undefined;
  }

  /**
   * The other installed plugins that kept a connector, by the label key the inspection matches a saved connector on,
   * with the plugin's name. A plugin whose manifest can't be read stops the step: it can't be told what it kept.
   */
  private async connectorKeepers(record: StoredPlugin): Promise<ReadonlyMap<string, string>> {
    const keepers = new Map<string, string>();
    for (const other of await this.sources.listPlugins()) {
      if (other.pluginId === record.pluginId) continue;
      const kept = other.pieces.filter((piece) => piece.kind === "connector" && !piece.owned);
      if (kept.length === 0) continue;
      const parsed = await this.sources.readManifest(other.snapshotTreeSha256);
      if (!parsed.ok || parsed.manifestSha256 !== other.manifestSha256) {
        throw new UninstallStepStopped(
          `Couldn't tell which connectors ${other.name} uses, so none was removed.`,
          `The manifest of plugin ${other.pluginId} can't be read.`,
        );
      }
      for (const piece of kept) {
        const manifestPiece = parsed.manifest.pieces.find((item) => item.id === piece.pieceId);
        if (manifestPiece?.kind !== "connector") continue;
        const template = this.sources.connectorTemplates().find((item) => item.templateId === manifestPiece.templateId);
        if (template) keepers.set(mcpServerLabelKey(template.label), other.name);
      }
    }
    return keepers;
  }

  /** Removes each owned piece of a kind that names what it became, and clears that name once its owner removed it. */
  private async removeEach(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    kind: "hook" | "prompt_pack",
    progress: UninstallProgress,
    remove: (ref: string) => Promise<void>,
  ): Promise<void> {
    for (const piece of ownedPieces(record, kind)) {
      if (piece.ref === undefined) continue;
      progress.current = piece;
      await remove(piece.ref);
      await this.savePiece(request, piece.pieceId, removedPiece);
      progress.removed += 1;
    }
    progress.current = undefined;
  }

  /**
   * Step 5: each skill the plugin added that isn't removed yet, read by its check's id. A switched-on skill is revoked,
   * and counts as removed only once its check reads revoked; one installed and never switched on is left inert; one
   * still in the middle of its own step waits for that step. Answers every removed skill's id, for the tombstone.
   */
  private async removeSkills(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    actorId: string,
    labels: ReadonlyMap<string, PluginPieceLabel>,
    progress: UninstallProgress,
  ): Promise<string[]> {
    const skills = ownedPieces(record, "skill");
    const skillIds = skills.flatMap((piece) => (piece.removed?.skillId ? [piece.removed.skillId] : []));
    const open = skills.filter((piece) => piece.removed === undefined);
    const ids = open.flatMap((piece) => (piece.skillSnapshotId ? [piece.skillSnapshotId] : []));
    const [checks, pendingSteps] =
      ids.length > 0
        ? await Promise.all([
            this.sources.readSkillChecks(record.workspaceId, ids),
            this.sources.listPendingSkillSteps(record.workspaceId, ids),
          ])
        : [new Map<string, PluginSkillCheck>(), new Map<string, PendingSkillStep>()];
    for (const piece of open) {
      progress.current = piece;
      const id = piece.skillSnapshotId;
      const check = id ? checks.get(id) : undefined;
      const outcome = await this.removeSkill(record, actorId, piece, check, id ? pendingSteps.get(id) : undefined);
      if (outcome.kind === "removed") {
        await this.savePiece(request, piece.pieceId, ({ waiting: _waiting, ...rest }) => ({
          ...rest,
          removed: outcome.skillId ? { skillId: outcome.skillId } : {},
        }));
        if (outcome.skillId) skillIds.push(outcome.skillId);
        if (outcome.counted) progress.removed += 1;
      } else {
        await this.savePiece(request, piece.pieceId, ({ waiting: _waiting, ...rest }) => ({
          ...rest,
          ...(outcome.waiting ? { waiting: outcome.waiting } : {}),
        }));
        progress.waiting.push({ label: check?.title ?? labelOf(piece, labels), reason: outcome.reason });
      }
    }
    progress.current = undefined;
    return skillIds;
  }

  /** One skill: its decision, and for a switched-on one the revoke, read again from its check once it is approved. */
  private async removeSkill(
    record: StoredPlugin,
    actorId: string,
    piece: StoredPluginPiece,
    check: PluginSkillCheck | undefined,
    pendingStep: PendingSkillStep | undefined,
  ) {
    const decision = decideSkillRemoval(piece, check, pendingStep);
    if (decision.kind !== "revoke") return decision;
    const snapshotId = piece.skillSnapshotId!;
    const revoked = await this.sources.revokeSkill({
      workspaceId: record.workspaceId,
      snapshotId,
      pluginId: record.pluginId,
      actorId,
      ...(decision.knownApprovalId ? { knownApprovalId: decision.knownApprovalId } : {}),
    });
    const waiting = { approvalId: revoked.approvalId, operation: "revoke" as const };
    if (revoked.status === "waiting") return { kind: "waiting" as const, reason: "revoke" as const, waiting };
    // Handed back the revoke that already settled without revoking it: asking again can't remove it.
    if (decision.staleApprovalId === revoked.approvalId) {
      throw new UninstallStepStopped(
        `Couldn't remove the skill ${check?.title ?? piece.pieceId}: its removal was approved, but it didn't take effect.`,
        `Revoke approval ${revoked.approvalId} settled ${check?.revokeApproval?.settled ?? "without revoking it"}.`,
      );
    }
    // Approved: its effect runs in the approval effects worker, usually within moments, so the check is read again.
    const after = await this.readAfterRevoke(record.workspaceId, snapshotId, revoked.approvalId);
    if (after?.revoked) {
      return { kind: "removed" as const, counted: true, ...(after.skillId ? { skillId: after.skillId } : {}) };
    }
    return { kind: "waiting" as const, reason: "removing" as const, waiting };
  }

  /**
   * A skill's check once its approved revoke's effect is done: read again until it reads revoked, or that revoke
   * settled without revoking it, or `REVOKE_EFFECT_READS` reads went by. Then the skill waits to be removed.
   */
  private async readAfterRevoke(
    workspaceId: string,
    snapshotId: string,
    approvalId: string,
  ): Promise<PluginSkillCheck | undefined> {
    for (let read = 1; ; read += 1) {
      const check = (await this.sources.readSkillChecks(workspaceId, [snapshotId])).get(snapshotId);
      const settled = check?.revokeApproval?.approvalId === approvalId && check.revokeApproval.settled !== undefined;
      if (!check || check.revoked || settled || read >= REVOKE_EFFECT_READS) return check;
      await this.sources.pause(REVOKE_EFFECT_PAUSE_MS);
    }
  }

  /** Changes this install's own record; any other record (or none) is a conflict, never overwritten. */
  private async save(request: ChangePlanPluginUninstallRequest, change: (record: StoredPlugin) => StoredPlugin) {
    await this.sources.updatePlugin(request.pluginId, (current) => {
      if (current?.installPlanId !== request.installPlanId) throw uninstallChanged();
      return change(current);
    });
  }

  private async savePiece(
    request: ChangePlanPluginUninstallRequest,
    pieceId: string,
    change: (piece: StoredPluginPiece) => StoredPluginPiece,
  ): Promise<void> {
    await this.save(request, (record) => ({
      ...record,
      pieces: record.pieces.map((piece) => (piece.pieceId === pieceId ? change(piece) : piece)),
    }));
  }
}

function requireRequest(plan: ChangePlanRecord): ChangePlanPluginUninstallRequest {
  if (plan.request.kind !== "plugin_uninstall") {
    throw new SemanticValidationError("Expected a plugin uninstall request.");
  }
  return plan.request;
}

function uninstallChanged(): ConflictError {
  return new ConflictError({ message: UNINSTALL_CHANGED_MESSAGE });
}

/** The plan's binding: the plugin's record as it was when the plan was made, checked again when it applies. */
function recordHash(record: StoredPlugin): string {
  return createHash("sha256").update(canonicalJsonString({ record })).digest("hex");
}

function ownedPieces(record: StoredPlugin, kind: PluginPieceKind): StoredPluginPiece[] {
  return record.pieces.filter((piece) => piece.kind === kind && piece.owned);
}

/** A piece its owner removed: it names nothing any more, and reads as removed by the uninstall. */
function removedPiece({ ref: _ref, ...piece }: StoredPluginPiece): StoredPluginPiece {
  return { ...piece, removed: {} };
}

function labelOf(piece: StoredPluginPiece, labels: ReadonlyMap<string, PluginPieceLabel>): string {
  const label = labels.get(piece.pieceId)?.label;
  if (label) return label;
  return piece.kind === "tool_group_off" && piece.ref ? groupLabel(piece.ref) : piece.pieceId;
}

function piecesCount(count: number): string {
  return `${count} ${count === 1 ? "piece" : "pieces"}`;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** What a hook sends to, as its detail says it, or its label. */
function hookWords(piece: StoredPluginPiece, labels: ReadonlyMap<string, PluginPieceLabel>): string {
  const host = labels.get(piece.pieceId)?.hosts?.[0];
  return host ? `the hook that sends event details to ${host}` : `the hook ${labelOf(piece, labels)}`;
}

/** The plain steps the plan will take, in order, for its summary and its confirmation. */
function plannedSentences(
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
  installedSkills: ReadonlySet<string>,
  keepers: ReadonlyMap<string, string>,
  saved: readonly McpServerRecord[],
): string[] {
  const sentences: string[] = [];
  const order: PluginPieceKind[] = ["hook", "prompt_pack", "tool_group_off", "connector", "skill"];
  for (const kind of order) {
    for (const piece of ownedPieces(record, kind)) {
      const label = labelOf(piece, labels);
      if (kind === "skill") {
        if (installedSkills.has(piece.pieceId)) sentences.push(`Remove the skill ${label}, so the AI can't use it.`);
        continue;
      }
      if (piece.ref === undefined) continue;
      if (kind === "hook") sentences.push(`Remove ${hookWords(piece, labels)}.`);
      if (kind === "prompt_pack") sentences.push(`Delete the prompt pack ${label}, with its runs and scores.`);
      if (kind === "tool_group_off") sentences.push(`Stop holding ${label} off.`);
      if (kind === "connector") sentences.push(connectorSentence(piece.ref, label, keepers, saved));
    }
  }
  for (const piece of record.pieces.filter((item) => !item.owned)) {
    sentences.push(`Keep ${labelOf(piece, labels)}, which was already there.`);
  }
  return [...sentences, HOSTS_STAY];
}

function connectorSentence(
  serverId: string,
  label: string,
  keepers: ReadonlyMap<string, string>,
  saved: readonly McpServerRecord[],
): string {
  const server = saved.find((item) => item.serverId === serverId);
  const keeper = server ? keepers.get(mcpServerLabelKey(server.label)) : undefined;
  return keeper && server ? `Keep ${server.label}, which ${keeper} uses.` : `Remove the connector ${label}.`;
}

/** Everything else is removed; a skill still waits for its revoke, for that revoke to apply, or for its own step. */
function waitingSummary(record: StoredPlugin, progress: UninstallProgress): string {
  return boundedSentences([
    `Removed ${piecesCount(progress.removed)}.`,
    ...progress.handedOver,
    HOSTS_STAY,
    ...progress.waiting.map(({ label, reason }) => WAITING_WORDS[reason](label)),
    `Then uninstall ${record.name} again to finish.`,
  ]);
}

const WAITING_WORDS: Readonly<Record<SkillWaitReason, (label: string) => string>> = {
  revoke: (label) => `Removing the skill ${label} waits for your approval.`,
  removing: (label) => `The skill ${label} is still being removed.`,
  own_step: (label) => `The skill ${label} is still taking one of its own steps.`,
};

/**
 * The outcome when a step fails: what was removed, what wasn't, and what to do next. The record keeps listing what is
 * left, so uninstalling again goes on from there. The owner's own words go to `failureDetail` only.
 */
function stopped(
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
  progress: UninstallProgress,
  step: UninstallStep,
  error: unknown,
): EvolutionControlPlaneAdapterOutcome {
  // Another change to the record landed first: the plain refusal says so, and nothing was removed.
  if (step === "record" && isGoatError(error) && error.httpStatus < 500) {
    return { status: "failed", result: { summary: error.message, failureCode: "plugin_uninstall_refused" } };
  }
  const detail = failureDetail(error);
  return {
    status: step === "record" ? "failed" : "manual_required",
    result: {
      summary: boundedSentences([
        ...(progress.removed > 0 ? [`Removed ${piecesCount(progress.removed)}.`] : []),
        ...progress.handedOver,
        error instanceof UninstallStepStopped ? error.what : whatFailed(record, labels, progress.current, step),
        step === "record"
          ? "Nothing was removed, so trying again is safe."
          : `Uninstall ${record.name} again to finish.`,
      ]),
      failureCode: `plugin_uninstall_${step}_failed`,
      ...(detail ? { failureDetail: detail } : {}),
    },
  };
}

/** What didn't happen, naming the piece the step was working on. */
function whatFailed(
  record: StoredPlugin,
  labels: ReadonlyMap<string, PluginPieceLabel>,
  piece: StoredPluginPiece | undefined,
  step: UninstallStep,
): string {
  const label = piece ? labelOf(piece, labels) : undefined;
  switch (step) {
    case "record":
      return `Couldn't start uninstalling ${record.name}.`;
    case "hooks":
      return piece ? `Couldn't remove ${hookWords(piece, labels)}.` : "Couldn't remove its hooks.";
    case "prompt_packs":
      return label ? `Couldn't delete the prompt pack ${label}.` : "Couldn't delete its prompt packs.";
    case "tool_groups":
      return "Couldn't stop holding its tool groups off.";
    case "connectors":
      return label ? `Couldn't remove the connector ${label}.` : "Couldn't remove its connectors.";
    case "skills":
      return label ? `Couldn't remove the skill ${label}.` : "Couldn't remove its skills.";
    case "finish":
      return `Couldn't finish uninstalling ${record.name}.`;
  }
}
