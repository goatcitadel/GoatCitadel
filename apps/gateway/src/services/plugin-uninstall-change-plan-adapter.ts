import { createHash } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  SemanticValidationError,
  canonicalJsonString,
  isGoatError,
  type ChangePlanPluginUninstallRequest,
  type ChangePlanRecord,
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
import type { PluginPass } from "./plugin-owned-refusal.js";
import {
  boundedSentences,
  boundedTitle,
  failureDetail,
  groupLabel,
  requireCapabilitiesOrigin,
} from "./plugin-plan-support.js";
import type { PluginSkillCheck } from "./plugin-skill-checks.js";

// A plugin uninstall: one Change Plan that removes exactly the pieces the plugin's install added, each through its own
// owner with the plugin's pass, in reverse install order. What was already there stays, and so do the hosts it allowed.

export const PLUGIN_NOT_INSTALLED_MESSAGE = "This plugin isn't installed.";
export const PLUGIN_IN_OTHER_WORKSPACE_MESSAGE = "This plugin was installed in another workspace. Uninstall it there.";
const UNINSTALL_CHANGED_MESSAGE = "This plugin changed since you asked to uninstall it. Uninstall it again.";
const HOSTS_STAY = "Hosts it allowed stay in your allowlist.";
const ORIGIN_REFUSAL = {
  message: "Plugins are uninstalled from Capabilities.",
  diagnosticCode: "plugin_uninstall_untrusted_origin",
} as const;

/** One plain reader or writer per owner an uninstall goes through. The adapter only orders them. */
export interface PluginUninstallSources {
  readPlugin(pluginId: string): Promise<StoredPlugin | undefined>;
  /** `CapabilityPluginStore.update`: the change may run again on a newer record. */
  updatePlugin(
    pluginId: string,
    change: (current: StoredPlugin | undefined) => StoredPlugin | undefined,
  ): Promise<void>;
  /** `CapabilityPluginStore.remove`: deletes the record and keeps its tombstone in the same write. */
  removePlugin(pluginId: string, remember: (current: StoredPlugin | undefined) => RemovedPlugin): Promise<void>;
  /** The manifest the plugin was installed from, read from its snapshot: only for each piece's label. */
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  readSnapshotText(treeSha256: string, relativePath: string): Promise<string>;
  /** The hooks owner's delete, with the plugin's pass; it deletes the hook's own signing secret with it. */
  deleteHook(workspaceId: string, hookId: string, pass: PluginPass): Promise<void>;
  /** Every signing secret a hook in the workspace still uses; undefined when the list may have been cut off. */
  listHookSecretRefs(workspaceId: string): Promise<ReadonlySet<string> | undefined>;
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
  /** Disconnects a connector; one that is already gone is left as it is. */
  disconnectConnector(serverId: string): Promise<void>;
  /** The MCP owner's delete, with the plugin's pass. */
  deleteConnector(serverId: string, pass: PluginPass): Promise<void>;
  /** The plugin's skill checks, by their ids; a check that isn't there is left out. */
  readSkillChecks(workspaceId: string, snapshotIds: readonly string[]): Promise<ReadonlyMap<string, PluginSkillCheck>>;
  /** The Skills tab's one revoke for a plugin's skill: approved at once, except on `remote_hardened`. */
  revokeSkill(input: PluginUninstallRevokeInput): Promise<PluginUninstallRevokeOutcome>;
  /** Reports signing secrets kept because it couldn't be told whether a hook still uses them. */
  reportSecretsKept(error: unknown): void;
  now(): Date;
}

/** The uninstall's steps, in reverse install order; a failure's `failureCode` names the one it stopped at. */
type UninstallStep = "record" | "hooks" | "prompt_packs" | "tool_groups" | "connectors" | "skills" | "finish";

/** What an apply has done so far, read by its summary. */
interface UninstallProgress {
  removed: number;
  /** The piece a step was working on when it stopped. */
  current?: StoredPluginPiece;
  /** The skills whose removal still waits, by label. */
  readonly waiting: Array<{ label: string; reason: "revoke" | "own_step" }>;
}

/** Where one skill piece is once the uninstall asked: removed, or still waiting (with the approval, when there is one). */
type SkillRemoval =
  | { removed: true; skillId?: string }
  | { removed: false; reason: "revoke" | "own_step"; waiting?: NonNullable<StoredPluginPiece["waiting"]> };

/**
 * Uninstalls a plugin as the operator's own Capabilities action: it deletes the plugin's hooks and the signing secrets
 * no hook uses any more, deletes its prompt packs with their runs, releases its tool-group holds, disconnects and
 * deletes its connectors, and revokes its switched-on skills. It touches only the pieces the plugin added, never one it
 * kept, never the operator's own switches, and never a host in either allowlist. The record reads `uninstalling` until
 * every skill is removed, then it is deleted and a tombstone keeps the skills it left behind named after it.
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
    const summary = boundedSentences(plannedSentences(record, labels));
    const title = boundedTitle(`Uninstall ${record.name}`);
    const ownsSkills = record.pieces.some((piece) => piece.kind === "skill" && piece.owned);
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
        ...(ownsSkills ? ["A skill it added can't be installed again until skills can be removed."] : []),
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
    const progress: UninstallProgress = { removed: 0, waiting: [] };
    let step: UninstallStep = "record";
    try {
      await this.save(request, (current) => ({ ...current, state: "uninstalling", uninstallPlanId: plan.planId }));
      step = "hooks";
      await this.removeHooks(record, request, pass, progress);
      await this.deleteLeftoverSecrets(record, request, actorId);
      step = "prompt_packs";
      await this.removeEach(record, request, "prompt_pack", progress, (ref) => this.sources.deletePromptPack(ref));
      step = "tool_groups";
      await this.releaseHolds(record, request, progress);
      step = "connectors";
      await this.removeEach(record, request, "connector", progress, async (ref) => {
        await this.sources.disconnectConnector(ref);
        await this.sources.deleteConnector(ref, pass);
      });
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
        result: { summary: `Removed ${piecesCount(progress.removed)}. ${HOSTS_STAY}` },
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

  /** Step 1: each hook the plugin added, with its signing secret. A plugin store that can't be read stops it here. */
  private async removeHooks(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    pass: PluginPass,
    progress: UninstallProgress,
  ): Promise<void> {
    await this.removeEach(record, request, "hook", progress, (ref) =>
      this.sources.deleteHook(record.workspaceId, ref, pass),
    );
  }

  /**
   * After the hooks: the signing secrets the install stored for hooks it never added (it stopped before them), unless
   * a hook in the workspace still uses one. A hook it added took its secret with it. Never in the way of the uninstall.
   */
  private async deleteLeftoverSecrets(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    actorId: string,
  ): Promise<void> {
    // A plugin with no hooks stored no secret.
    if (!record.pieces.some((piece) => piece.kind === "hook" && piece.owned)) return;
    const attached = new Set(
      record.pieces
        .filter((piece) => piece.kind === "hook" && (piece.ref !== undefined || piece.removed !== undefined))
        .map((piece) => piece.pieceId),
    );
    try {
      const stored = await this.sources.readInstallSecretRefs(record.workspaceId, record.installPlanId, actorId);
      const leftover = Object.entries(stored).filter(([pieceId]) => !attached.has(pieceId));
      if (leftover.length === 0) return;
      const held = await this.sources.listHookSecretRefs(record.workspaceId);
      if (!held) throw new Error("The workspace's hooks couldn't all be read, so no stored secret was deleted.");
      for (const [, secretRef] of leftover) if (!held.has(secretRef)) this.sources.deleteHookSecret(secretRef);
      // Done with: an uninstall that goes on from here later doesn't delete them again.
      const done = new Set(leftover.map(([pieceId]) => pieceId));
      await this.save(request, (current) => ({
        ...current,
        pieces: current.pieces.map((piece) =>
          piece.kind === "hook" && done.has(piece.pieceId) && piece.ref === undefined
            ? { ...piece, removed: {} }
            : piece,
        ),
      }));
    } catch (error) {
      // A secret left behind is inert; one deleted from under a hook would stop it signing.
      this.sources.reportSecretsKept(error);
    }
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

  /** Removes each owned piece of a kind that names what it became, and clears that name once its owner removed it. */
  private async removeEach(
    record: StoredPlugin,
    request: ChangePlanPluginUninstallRequest,
    kind: Exclude<PluginPieceKind, "skill" | "tool_group_off">,
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
   * Step 5: each skill the plugin added that isn't removed yet, read by its check's id. A switched-on skill is revoked;
   * one that was never switched on is left inert, as nothing can switch it on once no plugin lists it. One still in the
   * middle of its own step waits for that step. Answers every removed skill's id, for the tombstone.
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
    const checks =
      ids.length > 0
        ? await this.sources.readSkillChecks(record.workspaceId, ids)
        : new Map<string, PluginSkillCheck>();
    for (const piece of open) {
      progress.current = piece;
      const check = piece.skillSnapshotId ? checks.get(piece.skillSnapshotId) : undefined;
      const removal = await this.removeSkill(record, actorId, piece, check);
      if (removal.removed) {
        await this.savePiece(request, piece.pieceId, ({ waiting: _waiting, ...rest }) => ({
          ...rest,
          removed: removal.skillId ? { skillId: removal.skillId } : {},
        }));
        if (removal.skillId) skillIds.push(removal.skillId);
        progress.removed += 1;
      } else {
        await this.savePiece(request, piece.pieceId, ({ waiting: _waiting, ...rest }) => ({
          ...rest,
          ...(removal.waiting ? { waiting: removal.waiting } : {}),
        }));
        progress.waiting.push({ label: check?.title ?? labelOf(piece, labels), reason: removal.reason });
      }
    }
    progress.current = undefined;
    return skillIds;
  }

  private async removeSkill(
    record: StoredPlugin,
    actorId: string,
    piece: StoredPluginPiece,
    check: PluginSkillCheck | undefined,
  ): Promise<SkillRemoval> {
    // Never checked: nothing was installed from it.
    if (!piece.skillSnapshotId) return { removed: true };
    // A check that can't be read is never taken as removed.
    if (!check) throw new Error("Its check can't be read right now.");
    if (check.revoked) return { removed: true, ...(check.skillId ? { skillId: check.skillId } : {}) };
    const ownStep = check.pendingApprovals.activate
      ? { approvalId: check.pendingApprovals.activate, operation: "activate" as const }
      : check.pendingApprovals.install_inactive
        ? { approvalId: check.pendingApprovals.install_inactive, operation: "install_inactive" as const }
        : undefined;
    // An approved step still applying, or one waiting for its approval, could switch it on after the record is gone.
    if (ownStep) return { removed: false, reason: "own_step", waiting: ownStep };
    if (check.step === "installing" || check.step === "switching_on") return { removed: false, reason: "own_step" };
    if (check.version === "switched_on" && check.skillId) {
      const known = piece.waiting?.operation === "revoke" ? piece.waiting.approvalId : check.pendingApprovals.revoke;
      const revoked = await this.sources.revokeSkill({
        workspaceId: record.workspaceId,
        snapshotId: piece.skillSnapshotId,
        pluginId: record.pluginId,
        actorId,
        ...(known ? { knownApprovalId: known } : {}),
      });
      return revoked.status === "approved"
        ? { removed: true, skillId: check.skillId }
        : { removed: false, reason: "revoke", waiting: { approvalId: revoked.approvalId, operation: "revoke" } };
    }
    // Installed and never switched on, or never installed: inert, and nothing can switch it on any more.
    return { removed: true, ...(check.skillId ? { skillId: check.skillId } : {}) };
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

/** What a hook sends to, as its detail says it, or its label. */
function hookWords(piece: StoredPluginPiece, labels: ReadonlyMap<string, PluginPieceLabel>): string {
  const host = labels.get(piece.pieceId)?.hosts?.[0];
  return host ? `the hook that sends event details to ${host}` : `the hook ${labelOf(piece, labels)}`;
}

/** The plain steps the plan will take, in order, for its summary and its confirmation. */
function plannedSentences(record: StoredPlugin, labels: ReadonlyMap<string, PluginPieceLabel>): string[] {
  const sentences: string[] = [];
  const order: PluginPieceKind[] = ["hook", "prompt_pack", "tool_group_off", "connector", "skill"];
  for (const kind of order) {
    for (const piece of ownedPieces(record, kind)) {
      const label = labelOf(piece, labels);
      if (kind === "skill") {
        if (!piece.removed) sentences.push(`Remove the skill ${label}, so the AI can't use it.`);
        continue;
      }
      if (piece.ref === undefined) continue;
      if (kind === "hook") sentences.push(`Remove ${hookWords(piece, labels)}.`);
      if (kind === "prompt_pack") sentences.push(`Delete the prompt pack ${label}, with its runs and scores.`);
      if (kind === "tool_group_off") sentences.push(`Stop holding ${label} off.`);
      if (kind === "connector") sentences.push(`Remove the connector ${label}.`);
    }
  }
  for (const piece of record.pieces.filter((item) => !item.owned)) {
    sentences.push(`Keep ${labelOf(piece, labels)}, which was already there.`);
  }
  return [...sentences, HOSTS_STAY];
}

/** Everything else is removed; a skill still waits for its revoke's approval, or for one of its own steps. */
function waitingSummary(record: StoredPlugin, progress: UninstallProgress): string {
  return boundedSentences([
    `Removed ${piecesCount(progress.removed)}.`,
    HOSTS_STAY,
    ...progress.waiting.map(({ label, reason }) =>
      reason === "revoke"
        ? `Removing the skill ${label} waits for your approval.`
        : `The skill ${label} is still taking one of its own steps.`,
    ),
    `Then uninstall ${record.name} again to finish.`,
  ]);
}

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
        whatFailed(record, labels, progress.current, step),
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
