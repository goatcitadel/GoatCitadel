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
} from "./evolution-control-plane-adapter.js";
import type { PluginPass } from "./plugin-owned-refusal.js";
import { HOSTS_STAY, boundedSentences, boundedTitle, requireCapabilitiesOrigin } from "./plugin-plan-support.js";
import { pluginPromptPackId, pluginPromptPackSourceLabel } from "./plugin-prompt-packs.js";
import type { ApprovalReading, PluginSkillCheck } from "./plugin-skill-checks.js";
import {
  readUninstallScope,
  scopeEvidenceRef,
  type ConnectorDecision,
  type HookSecretHolder,
  type UninstallScope,
} from "./plugin-uninstall-scope.js";
import {
  decideSkillRemoval,
  mayHaveInstalledSkill,
  revokeEndedUnrevoked,
  type PendingSkillStep,
  type SkillRemovalDecision,
} from "./plugin-uninstall-skills.js";
import {
  completedSummary,
  connectorUnknownStop,
  holderKeptStop,
  holderWords,
  hookWords,
  isUnrecordedPack,
  keptConnectorWords,
  labelOf,
  plannedSentences,
  UninstallStepStopped,
  recordedStop,
  revokeDidntTakeStop,
  skillsStop,
  stopped,
  undecidedSecretsStop,
  waitingSummary,
  type UninstallProgress,
  type UninstallStep,
} from "./plugin-uninstall-words.js";

// A plugin uninstall: one Change Plan that removes exactly the pieces the plugin's install added, each through its own
// owner with the plugin's pass, in reverse install order. What was already there stays, and so do the hosts it allowed.

export const PLUGIN_NOT_INSTALLED_MESSAGE = "This plugin isn't installed.";
export const PLUGIN_IN_OTHER_WORKSPACE_MESSAGE = "This plugin was installed in another workspace. Uninstall it there.";
export const UNINSTALL_CHANGE_PLANS_OFF_MESSAGE =
  "Uninstalling plugins needs Change Plans, which are off on this install.";
export const UNINSTALL_ANSWER_GONE_MESSAGE =
  "This uninstall's first answer is no longer kept, so it can't be sent again. Uninstall the plugin again.";
const UNINSTALL_CHANGED_MESSAGE = "This plugin changed since you asked to uninstall it. Uninstall it again.";
const SCOPE_CHANGED_MESSAGE =
  "What uninstalling this plugin would remove or keep changed since you asked. Uninstall it again.";
/**
 * How often, and how many times, an approved revoke is read while its work runs, when the uninstall applies outside the
 * approval worker: about 10 seconds. Inside the worker it is read once, as that work runs only after the uninstall.
 */
const REVOKE_EFFECT_PAUSE_MS = 250;
const REVOKE_EFFECT_READS = 40;
const ORIGIN_REFUSAL = {
  message: "Plugins are uninstalled from Capabilities.",
  diagnosticCode: "plugin_uninstall_untrusted_origin",
} as const;

export type { HookSecretHolder } from "./plugin-uninstall-scope.js";

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
  /** The hooks owner's delete, with the plugin's pass, which deletes the hook's own secret too: true when it was there. */
  deleteHook(workspaceId: string, hookId: string, pass: PluginPass): Promise<boolean>;
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
  /** Deletes a prompt pack with every run, score and benchmark, and its export file: true when it was there. */
  deletePromptPack(packId: string): Promise<boolean>;
  /** A saved prompt pack's source label, or undefined when no pack has that id. */
  readPromptPackSourceLabel(packId: string): Promise<string | undefined>;
  /** The saved connectors. */
  listSavedConnectors(): Promise<readonly McpServerRecord[]>;
  /** The shipped connector catalog: what a kept connector piece is saved under. */
  connectorTemplates(): readonly McpServerTemplateRecord[];
  /** Disconnects a connector; one that is already gone is left as it is. */
  disconnectConnector(serverId: string): Promise<void>;
  /** The MCP owner's delete, with the plugin's pass: true when it was there. */
  deleteConnector(serverId: string, pass: PluginPass): Promise<boolean>;
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
  /** Where an approval stands and whether its work still runs; undefined when it can't be read. */
  readApproval(approvalId: string): Promise<ApprovalReading | undefined>;
  /** Reports the signing secrets kept because it couldn't be told whether a hook still uses them. */
  reportUndecidedSecrets(pluginId: string, secretRefs: readonly string[], error: unknown): void;
  /** Waits this long before an approved revoke is read again. */
  pause(ms: number): Promise<void>;
  now(): Date;
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
    // What apply will act on beyond the record's own pieces; apply reads it again and refuses one that moved.
    const scope = await readUninstallScope(this.sources, record, context.origin.actorId ?? "operator", labels);
    const installedSkills = await this.installedSkillPieces(record);
    const summary = boundedSentences(plannedSentences(record, labels, installedSkills, scope));
    const title = boundedTitle(`Uninstall ${record.name}`);
    // A skill removed by an earlier pass still blocks a reinstall.
    const leftSkills = installedSkills.size > 0 || ownedPieces(record, "skill").some((piece) => piece.removed?.skillId);
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
        ...(leftSkills ? ["A skill it added can't be installed again until skills can be removed."] : []),
      ]),
      risk: "caution" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({ title, confirmationText: summary }),
      evidenceRefs: [`plugin:${record.pluginId}`, scopeEvidenceRef(scope)],
    };
  }

  async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    // The operator who asked for the uninstall, not whoever resumed it, is named on every revoke.
    const actorId = plan.origin.actorId ?? "operator";
    let record: StoredPlugin;
    let labels: ReadonlyMap<string, PluginPieceLabel>;
    let scope: UninstallScope;
    try {
      // The record, and what the plan said it would act on, as they were when the plan was made: a change since stops
      // the uninstall before anything is removed.
      record = await this.bind(request, plan.origin.workspaceId);
      if (recordHash(record) !== plan.target.expectedHash) throw uninstallChanged();
      labels = await this.labelsOf(record);
      scope = await readUninstallScope(this.sources, record, actorId, labels);
      if (!plan.evidenceRefs.includes(scopeEvidenceRef(scope))) {
        throw new ConflictError({ message: SCOPE_CHANGED_MESSAGE });
      }
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
    const pass: PluginPass = { pluginId: record.pluginId, installPlanId: record.installPlanId };
    // Resumed by its approval, it runs inside the approval worker, where a revoke's own work only runs after it.
    const readRevokeAgain = plan.approvalRefs.length === 0;
    const progress: UninstallProgress = { removed: 0, handedOver: [], waiting: [] };
    let step: UninstallStep = "record";
    try {
      await this.save(request, (current) => ({ ...current, state: "uninstalling", uninstallPlanId: plan.planId }));
      step = "hooks";
      await this.removeHooks(record, request, pass, actorId, labels, scope, progress);
      step = "prompt_packs";
      await this.removeEach(record, request, "prompt_pack", progress, (piece) => ({
        words: `the prompt pack ${labelOf(piece, labels)}`,
        remove: (ref) => this.sources.deletePromptPack(ref),
      }));
      await this.removeUnrecordedPacks(record, request, labels, progress);
      step = "tool_groups";
      await this.releaseHolds(record, request, progress);
      step = "connectors";
      await this.removeConnectors(record, request, pass, scope, progress);
      step = "skills";
      const skillIds = await this.removeSkills(record, request, actorId, labels, progress, readRevokeAgain);
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
        result: { summary: completedSummary(progress) },
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
        summary: boundedSentences([
          "The uninstall stopped before it finished.",
          `Uninstall ${record.name} again to finish.`,
        ]),
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
   * The skill pieces that may have something installed by the time the plan applies, by piece id, for the plan's own
   * words: installed now, or with an own step waiting or under way. A check that can't be read counts too, so the plan
   * never promises less than it might remove.
   */
  private async installedSkillPieces(record: StoredPlugin): Promise<ReadonlySet<string>> {
    const open = ownedPieces(record, "skill").filter((piece) => !piece.removed && piece.skillSnapshotId);
    if (open.length === 0) return new Set();
    const ids = open.map((piece) => piece.skillSnapshotId!);
    const checks = await this.sources.readSkillChecks(record.workspaceId, ids).catch(() => undefined);
    const steps = await this.sources.listPendingSkillSteps(record.workspaceId, ids).catch(() => undefined);
    return new Set(
      open
        .filter((piece) => {
          const check = checks?.get(piece.skillSnapshotId!);
          return !checks || !steps || !check || mayHaveInstalledSkill(check, steps.get(piece.skillSnapshotId!));
        })
        .map((piece) => piece.pieceId),
    );
  }

  /**
   * Step 1: the plugin's hooks, a hook its install made before its record named it, and then every signing secret the
   * install stored that no hook in the workspace uses. When the hooks can't be read in full, or another hook holds one of
   * those secrets, nothing is removed and the step stops, so nothing a hook still uses is deleted.
   */
  private async removeHooks(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    pass: PluginPass,
    actorId: string,
    labels: ReadonlyMap<string, PluginPieceLabel>,
    scope: UninstallScope,
    progress: UninstallProgress,
  ): Promise<void> {
    if ("unread" in scope.holders) {
      this.sources.reportUndecidedSecrets(record.pluginId, scope.holders.secretRefs, scope.holders.error);
      throw undecidedSecretsStop(scope.holders.error);
    }
    const kept = scope.holders.find((holder) => holder.action === "keep");
    if (kept) throw holderKeptStop(record, kept);
    await this.removeEach(record, request, "hook", progress, (piece) => ({
      words: hookWords(piece, labels),
      remove: (ref) => this.sources.deleteHook(record.workspaceId, ref, pass),
    }));
    for (const holder of scope.holders) {
      const piece = ownedPieces(record, "hook").find((item) => item.pieceId === holder.pieceId)!;
      progress.current = piece;
      if (await this.sources.deleteHook(record.workspaceId, holder.hookId, pass)) progress.removed += 1;
      await this.recordRemoved(request, piece, holderWords(holder));
    }
    progress.current = undefined;
    await this.removeLeftoverSecrets(record, request, actorId);
  }

  /** After the hooks: each stored secret no hook holds is deleted (a second delete is harmless). */
  private async removeLeftoverSecrets(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    actorId: string,
  ): Promise<void> {
    const hookPieces = ownedPieces(record, "hook");
    if (hookPieces.length === 0) return;
    let stored: Readonly<Record<string, string>> = {};
    let held: readonly HookSecretHolder[];
    try {
      stored = await this.sources.readInstallSecretRefs(record.workspaceId, record.installPlanId, actorId);
      const listed = await this.sources.listHookSecrets(record.workspaceId);
      if (!listed) throw new Error("The workspace has too many hooks to read them all at once.");
      held = listed;
    } catch (error) {
      this.sources.reportUndecidedSecrets(record.pluginId, Object.values(stored), error);
      throw undecidedSecretsStop(error);
    }
    for (const [pieceId, secretRef] of Object.entries(stored)) {
      if (held.some((hook) => hook.secretRef === secretRef)) continue;
      this.sources.deleteHookSecret(secretRef);
      // A hook piece the install never named and no hook holds the secret of: nothing of it is left.
      const piece = hookPieces.find((item) => item.pieceId === pieceId);
      if (piece && piece.ref === undefined && !piece.removed) await this.savePiece(request, pieceId, removedPiece);
    }
  }

  /**
   * After the recorded packs: a pack the install created before its record named it, found under the id the install
   * gives it (F7). It is deleted only when its source label is this plugin's and no other plugin's record lists that id,
   * as two plugins' ids can make the same pack id; one that fails either test is left as it is. One that isn't there is
   * settled, as nothing of it is left.
   */
  private async removeUnrecordedPacks(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    labels: ReadonlyMap<string, PluginPieceLabel>,
    progress: UninstallProgress,
  ): Promise<void> {
    const pieces = record.pieces.filter(isUnrecordedPack);
    if (pieces.length === 0) return;
    const others = (await this.sources.listPlugins()).filter((other) => other.pluginId !== record.pluginId);
    for (const piece of pieces) {
      progress.current = piece;
      const packId = pluginPromptPackId(record.pluginId, piece.pieceId);
      const sourceLabel = await this.sources.readPromptPackSourceLabel(packId);
      if (sourceLabel !== undefined) {
        // The import saves the label trimmed, so a name with a space (or U+00A0, or U+FEFF) at an end still matches (Q3).
        const ours =
          sourceLabel.trim() === pluginPromptPackSourceLabel(record.name).trim() &&
          !others.some((other) => listsPromptPack(other, packId));
        if (!ours) continue;
        if (await this.sources.deletePromptPack(packId)) progress.removed += 1;
      }
      await this.recordRemoved(request, piece, `the prompt pack ${labelOf(piece, labels)}`);
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
   * Step 4: the connectors, as the plan decided them: one another plugin kept is handed to the operator (its mark
   * released), the rest are disconnected and deleted. A connector already gone or no longer marked as this install's is
   * only marked. When another plugin's connectors can't be read, none is touched and the step stops.
   */
  private async removeConnectors(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    pass: PluginPass,
    scope: UninstallScope,
    progress: UninstallProgress,
  ): Promise<void> {
    const decisions = scope.connectors;
    if (!decisions) throw new Error("The saved connectors or the other plugins can't be read right now.");
    const unknown = decisions.find((decision) => decision.action === "unknown");
    if (unknown?.action === "unknown") throw connectorUnknownStop(record, unknown);
    const pieces = ownedPieces(record, "connector");
    for (const decision of decisions) {
      const piece = pieces.find((item) => item.pieceId === decision.pieceId);
      progress.current = piece ?? pieces.find((item) => item.ref === undefined);
      await this.applyConnectorDecision(request, pass, decision, piece, progress);
    }
    progress.current = undefined;
  }

  private async applyConnectorDecision(
    request: ChangePlanPluginUninstallRequest,
    pass: PluginPass,
    decision: ConnectorDecision,
    piece: StoredPluginPiece | undefined,
    progress: UninstallProgress,
  ): Promise<void> {
    if (decision.action === "keep") {
      await this.sources.releaseConnector(decision.serverId, pass);
      progress.handedOver.push(keptConnectorWords(decision, "Kept"));
    }
    if (decision.action === "remove") {
      await this.sources.disconnectConnector(decision.serverId);
      if (await this.sources.deleteConnector(decision.serverId, pass)) progress.removed += 1;
    }
    if (!piece) return;
    if (decision.action === "keep" || decision.action === "handed_over") {
      await this.savePiece(request, piece.pieceId, handedOverPiece);
    } else {
      await this.recordRemoved(request, piece, `the connector ${decision.label}`);
    }
  }

  /** Removes each owned piece of a kind that names what it became, counted once its owner removed it, then marks it. */
  private async removeEach(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    kind: "hook" | "prompt_pack",
    progress: UninstallProgress,
    owner: (piece: StoredPluginPiece) => { words: string; remove: (ref: string) => Promise<boolean> },
  ): Promise<void> {
    for (const piece of ownedPieces(record, kind)) {
      if (piece.ref === undefined) continue;
      progress.current = piece;
      const { words, remove } = owner(piece);
      if (await remove(piece.ref)) progress.removed += 1;
      await this.recordRemoved(request, piece, words);
    }
    progress.current = undefined;
  }

  /**
   * Step 5: each skill the plugin added that isn't removed yet, read by its check's id. A switched-on skill is revoked,
   * and counts as removed only once its check reads revoked; one installed and never switched on is left inert; one
   * still in the middle of its own step waits for that step. A skill whose removal can't take effect doesn't keep the
   * others from being revoked: every skill is tried, then the step stops naming each one left. Answers every removed
   * skill's id, for the tombstone.
   */
  private async removeSkills(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    actorId: string,
    labels: ReadonlyMap<string, PluginPieceLabel>,
    progress: UninstallProgress,
    readRevokeAgain: boolean,
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
    const stops: UninstallStepStopped[] = [];
    const counted = new Set<string>();
    for (const piece of open) {
      progress.current = piece;
      const id = piece.skillSnapshotId;
      const check = id ? checks.get(id) : undefined;
      const skill = { piece, check, label: check?.title ?? labelOf(piece, labels) };
      let outcome: SkillRemovalDecision;
      try {
        outcome = await this.removeSkill(record, actorId, skill, id ? pendingSteps.get(id) : undefined, {
          readRevokeAgain,
        });
      } catch (error) {
        if (!(error instanceof UninstallStepStopped)) throw error;
        stops.push(error);
        continue;
      }
      if (outcome.kind === "removed") {
        await this.savePiece(request, piece.pieceId, ({ waiting: _waiting, ...rest }) => ({
          ...rest,
          removed: outcome.skillId ? { skillId: outcome.skillId } : {},
        }));
        if (outcome.skillId) skillIds.push(outcome.skillId);
        if (outcome.counted) {
          progress.removed += 1;
          counted.add(piece.pieceId);
        }
      } else if (outcome.kind === "waiting") {
        await this.savePiece(request, piece.pieceId, ({ waiting: _waiting, ...rest }) => ({
          ...rest,
          ...(outcome.waiting ? { waiting: outcome.waiting } : {}),
        }));
        progress.waiting.push({
          label: skill.label,
          reason: outcome.reason,
          ...(outcome.waiting ? { operation: outcome.waiting.operation } : {}),
        });
      }
    }
    progress.current = undefined;
    if (stops.length > 0) throw skillsStop(stops, progress.waiting);
    if (progress.waiting.length === 0) {
      const labelFor = (piece: StoredPluginPiece) =>
        checks.get(piece.skillSnapshotId ?? "")?.title ?? labelOf(piece, labels);
      await this.waitForStepsAskedMeanwhile(record, request, labelFor, progress, counted);
    }
    return skillIds;
  }

  /**
   * The skills' own waiting steps, read again once every skill is settled, just before the record goes (F6): a step
   * asked for after the first read could switch a skill on once no plugin lists it. Its skill is unsettled again and
   * waits for the operator's decision on that step, so the record stays `uninstalling`.
   */
  private async waitForStepsAskedMeanwhile(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    labelFor: (piece: StoredPluginPiece) => string,
    progress: UninstallProgress,
    countedNow: ReadonlySet<string>,
  ): Promise<void> {
    const skills = ownedPieces(record, "skill").filter((piece) => piece.skillSnapshotId !== undefined);
    if (skills.length === 0) return;
    const ids = skills.map((piece) => piece.skillSnapshotId!);
    const steps = await this.sources.listPendingSkillSteps(record.workspaceId, ids);
    for (const piece of skills) {
      const waiting = steps.get(piece.skillSnapshotId!);
      if (!waiting) continue;
      await this.savePiece(request, piece.pieceId, ({ removed: _removed, ...rest }) => ({ ...rest, waiting }));
      if (countedNow.has(piece.pieceId)) progress.removed -= 1;
      progress.waiting.push({ label: labelFor(piece), reason: "decision", operation: waiting.operation });
    }
  }

  /**
   * One skill: its decision, and for a switched-on one the revoke, read again once it is approved. A revoke that ended
   * without revoking the skill is decided once more in the same pass: a fresh revoke is asked for, or, when Skill Hub
   * hands back the one that ended, the step stops with what would unblock it.
   */
  private async removeSkill(
    record: StoredPlugin,
    actorId: string,
    skill: { piece: StoredPluginPiece; check: PluginSkillCheck | undefined; label: string },
    pendingStep: PendingSkillStep | undefined,
    options: { readRevokeAgain: boolean },
  ): Promise<SkillRemovalDecision> {
    const { piece, label } = skill;
    let { check, effects } = await this.readUnsettledRevoke(record.workspaceId, skill.check);
    let decision = decideSkillRemoval(piece, check, pendingStep, effects);
    for (let ask = 0; decision.kind === "revoke"; ask += 1) {
      const revoked = await this.sources.revokeSkill({
        workspaceId: record.workspaceId,
        snapshotId: piece.skillSnapshotId!,
        pluginId: record.pluginId,
        actorId,
        ...(decision.knownApprovalId ? { knownApprovalId: decision.knownApprovalId } : {}),
      });
      const waiting = { approvalId: revoked.approvalId, operation: "revoke" as const };
      if (revoked.status === "waiting") return { kind: "waiting", reason: "revoke", waiting };
      // Handed back the revoke that already ended without revoking it: asking again gets the same answer.
      if (decision.staleApprovalId === revoked.approvalId) {
        throw revokeDidntTakeStop(record, label, revoked.approvalId, endedWords(check, revoked.approvalId, effects));
      }
      ({ check, effects } = await this.readAfterRevoke(record.workspaceId, piece, revoked.approvalId, options));
      if (check?.revoked)
        return { kind: "removed", counted: true, ...(check.skillId ? { skillId: check.skillId } : {}) };
      if (!revokeEndedUnrevoked(check, revoked.approvalId, effects))
        return { kind: "waiting", reason: "removing", waiting };
      if (ask >= 1) {
        throw revokeDidntTakeStop(record, label, revoked.approvalId, endedWords(check, revoked.approvalId, effects));
      }
      decision = decideSkillRemoval({ ...piece, waiting }, check, pendingStep, effects);
      if (decision.kind === "revoke") decision = { ...decision, staleApprovalId: revoked.approvalId };
    }
    return decision;
  }

  /**
   * For an approved revoke the check shows unsettled: whether its work still runs, and then the check again, in the
   * order `readAfterRevoke` reads them. A revoke that applied in between then reads as revoked, never as done against
   * the stale check read at the step's start.
   */
  private async readUnsettledRevoke(
    workspaceId: string,
    check: PluginSkillCheck | undefined,
  ): Promise<{ check: PluginSkillCheck | undefined; effects: ApprovalReading["effects"] | undefined }> {
    const latest = check?.revokeApproval;
    if (!check || check.revoked || latest?.status !== "approved" || latest.settled !== undefined) {
      return { check, effects: undefined };
    }
    const effects = (await this.sources.readApproval(latest.approvalId))?.effects;
    const fresh = (await this.sources.readSkillChecks(workspaceId, [check.snapshotId])).get(check.snapshotId);
    return { check: fresh, effects };
  }

  /**
   * The check once an approved revoke's work is done. Outside the approval worker its work runs alongside, so it is read
   * again until done (about 10 seconds at most); inside, it runs only after this uninstall, so it is read once.
   */
  private async readAfterRevoke(
    workspaceId: string,
    piece: StoredPluginPiece,
    approvalId: string,
    options: { readRevokeAgain: boolean },
  ): Promise<{ check: PluginSkillCheck | undefined; effects: ApprovalReading["effects"] | undefined }> {
    const snapshotId = piece.skillSnapshotId!;
    for (let read = 1; ; read += 1) {
      const effects = (await this.sources.readApproval(approvalId))?.effects;
      if (effects !== "running" || !options.readRevokeAgain || read >= REVOKE_EFFECT_READS) {
        const check = (await this.sources.readSkillChecks(workspaceId, [snapshotId])).get(snapshotId);
        return { check, effects };
      }
      await this.sources.pause(REVOKE_EFFECT_PAUSE_MS);
    }
  }

  /** Marks a piece its owner removed; a failed write says the piece went, though its record doesn't show it. */
  private async recordRemoved(
    request: ChangePlanPluginUninstallRequest,
    piece: StoredPluginPiece,
    words: string,
  ): Promise<void> {
    try {
      await this.savePiece(request, piece.pieceId, removedPiece);
    } catch (error) {
      throw recordedStop(words, error);
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

/** Whether another plugin's record lists this prompt pack id, as a recorded pack or one its install would name so. */
function listsPromptPack(other: StoredPlugin, packId: string): boolean {
  return other.pieces.some(
    (piece) =>
      piece.kind === "prompt_pack" &&
      (piece.ref === packId || pluginPromptPackId(other.pluginId, piece.pieceId) === packId),
  );
}

function ownedPieces(record: StoredPlugin, kind: PluginPieceKind): StoredPluginPiece[] {
  return record.pieces.filter((piece) => piece.kind === kind && piece.owned);
}

/** A piece its owner removed: it names nothing any more, and reads as removed by the uninstall. */
function removedPiece({ ref: _ref, ...piece }: StoredPluginPiece): StoredPluginPiece {
  return { ...piece, removed: {} };
}

/** A connector left to the operator: no longer the plugin's, so it reads as kept and nothing removes it. */
function handedOverPiece({ pieceId, kind }: StoredPluginPiece): StoredPluginPiece {
  return { pieceId, kind, owned: false, handedOver: true };
}

/** How an approved revoke ended without revoking the skill, for `failureDetail`. */
function endedWords(
  check: PluginSkillCheck | undefined,
  approvalId: string,
  effects: ApprovalReading["effects"] | undefined,
): string {
  const settled = check?.revokeApproval?.approvalId === approvalId ? check.revokeApproval.settled : undefined;
  if (settled) return `settled ${settled}`;
  return effects === "failed" ? "with its work failed" : "with no settlement";
}
