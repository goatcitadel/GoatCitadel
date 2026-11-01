import { createHash } from "node:crypto";
import {
  ConflictError,
  HOOK_TRIGGER_LABELS,
  SemanticValidationError,
  canonicalJsonString,
  isGoatError,
  type CapabilityPluginInspection,
  type CapabilityPluginPieceView,
  type ChangePlanPluginInstallRequest,
  type ChangePlanRecord,
  type ChangePlanStatus,
  type DeploymentProfile,
  type HookCreateInput,
  type McpServerCreateInput,
  type McpServerRecord,
  type McpServerTemplateRecord,
  type PluginManifest,
  type PluginManifestParse,
  type PluginPiece,
} from "@goatcitadel/contracts";
import type { StoredPlugin, StoredPluginPiece } from "./capability-plugin-store.js";
import { isHostAllowlistedInList } from "./connection-url-helpers.js";
import { findInstallableConnectorTemplate, missingHosts } from "./connector-install-change-plan-adapter.js";
import type {
  EvolutionControlPlaneAdapter,
  EvolutionControlPlaneAdapterContext,
  EvolutionControlPlaneAdapterOutcome,
} from "./evolution-control-plane-adapter.js";
import { mcpServerLabelKey } from "./mcp-money-moving.js";
import type { PluginPass } from "./plugin-owned-refusal.js";
import {
  OTHER_WORKSPACE_MESSAGE,
  PLUGIN_CHANGED_MESSAGE,
  boundedSentences,
  boundedTitle,
  failureDetail,
  groupLabel,
  hookHost,
  planPluginId,
  pluginAlreadyInstalled,
  pluginChanged,
  requireCapabilitiesOrigin,
  requireInstallableInspection,
  type KeptPluginInspection,
} from "./plugin-plan-support.js";
import {
  distinctPluginPromptPackNames,
  pluginPromptPackId,
  pluginPromptPackSourceLabel,
} from "./plugin-prompt-packs.js";
import { BuiltinPromptPackPostCommitError } from "./prompt-pack/builtin-import-errors.js";
import { builtinDefinitionRevision } from "./prompt-pack/builtin-definition.js";
import { preparePromptPackImport } from "./prompt-pack/prepare-import.js";

// A plugin install: one Change Plan that adds the pieces an inspection checked, each through its own owner and from the
// snapshot that was checked. The plan holds only references; a hook's signing secret is already in the key store.

const SECRET_REFS_MESSAGE = "Every hook needs its own signing secret, and no other piece takes one.";
const ORIGIN_REFUSAL = {
  message: "Plugins are installed from Capabilities.",
  diagnosticCode: "plugin_install_untrusted_origin",
} as const;
/** A plan in one of these never reached apply, so no hook holds a secret it names. */
const NOT_YET_APPLIED: ReadonlySet<ChangePlanStatus> = new Set([
  "draft",
  "awaiting_input",
  "awaiting_confirmation",
  "staging",
  "awaiting_approval",
]);

/** The settings an install reads. */
export interface PluginInstallSettings {
  readonly revision: number;
  readonly networkAllowlist: readonly string[];
  readonly deploymentProfile: DeploymentProfile;
}

/** The one settings write an install makes: the hosts it allows, under the settings' revision fence. */
export interface PluginInstallSettingsWrite {
  readonly expectedRevision: number;
  readonly networkAllowlist?: string[];
  readonly hookNetworkAllowlist?: string[];
}

/** What a plugin's connector is marked with: the plugin and the install that saved it. */
export type PluginConnectorOwner = NonNullable<McpServerRecord["pluginOwner"]>;

/** One plain reader or writer per owner an install goes through. The adapter only orders them. */
export interface PluginInstallSources {
  /** The plugin store's kept inspection, unless it ran out of time or was dropped. */
  readInspection(inspectionId: string): Promise<KeptPluginInspection | undefined>;
  readPlugin(pluginId: string): Promise<StoredPlugin | undefined>;
  /** `CapabilityPluginStore.update`: the change may run again on a newer record. */
  updatePlugin(
    pluginId: string,
    change: (current: StoredPlugin | undefined) => StoredPlugin | undefined,
  ): Promise<void>;
  /** `PluginSnapshotStore.verify`: the snapshot's files still hash to its name, or a 409. */
  verifySnapshot(treeSha256: string): Promise<void>;
  /** The manifest, read from the snapshot. */
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  /** A file in the snapshot, as UTF-8 text. */
  readSnapshotText(treeSha256: string, relativePath: string): Promise<string>;
  /** The shipped connector catalog. */
  connectorTemplates(): readonly McpServerTemplateRecord[];
  listSavedConnectors(): Promise<readonly McpServerRecord[]>;
  readSettings(): Promise<PluginInstallSettings>;
  /** The hooks allowlist as it is now. Empty allows every public https host. */
  readHookAllowlist(): readonly string[];
  updateSettings(input: PluginInstallSettingsWrite): Promise<unknown>;
  /** Saves a connector marked as the plugin's. */
  createConnector(input: McpServerCreateInput, owner: PluginConnectorOwner): Promise<McpServerRecord>;
  /** The audited approval-setting write, with the plugin's own pass. */
  setConnectorApproval(
    server: McpServerRecord,
    approvalPosture: "reads_free" | "everything_asks",
    pass: PluginPass,
    actorId: string,
  ): Promise<McpServerRecord>;
  /** The groups the operator switched off themselves, never a plugin's hold. */
  operatorSwitchedOffToolGroups(): readonly string[];
  createHook(input: HookCreateInput): Promise<{ hookId: string }>;
  /** The prompt-pack owner's guarded create-if-absent: a pack is only ever created, never imported over. */
  importPromptPack(
    input: { content: string; name: string; sourceLabel: string; packId: string },
    guarded: { packKey: string; expectedDefinitionRevision: string },
  ): Promise<unknown>;
  /** Deletes a signing secret this install stored. It reports its own failure and never throws. */
  deleteHookSecret(secretRef: string): void;
  /** Reports secrets kept because the plugin's record couldn't be read to tell which a hook holds. */
  reportSecretsKept(error: unknown): void;
}

/** The install's steps in order; a failure's `failureCode` names the one it stopped at. */
type InstallStep = "record" | "hosts" | "connectors" | "tool_groups" | "hooks" | "prompt_packs" | "finish";

/** What one install binds: the kept inspection, its manifest read from the snapshot, and each piece's view. */
interface InstallBinding {
  readonly inspection: CapabilityPluginInspection;
  readonly manifest: PluginManifest;
  readonly treeSha256: string;
  readonly views: ReadonlyMap<string, CapabilityPluginPieceView>;
}

/** What an apply has done so far, read by the summary of a finished or a stopped install. */
interface InstallProgress {
  allowed: string[];
  hookHostsAllowed: string[];
  readonly done: string[];
  /** Hook pieces whose hook now holds its secret. */
  readonly attached: Set<string>;
  recordWritten: boolean;
  /** The piece a step was working on when it stopped. */
  current?: PluginPiece;
}

/**
 * Installs a plugin as the operator's own Capabilities action: it writes the plugin's record, allows the hosts its
 * connectors and hooks need, saves each connector switched off, holds its tool groups off, adds its hooks (observe
 * only, event details only) and creates its prompt packs. Every piece is read from the checked snapshot, never fetched
 * again. Nothing is staged, so the operator's confirmation reaches the approval skip.
 */
export class PluginInstallChangePlanAdapter implements EvolutionControlPlaneAdapter<ChangePlanPluginInstallRequest> {
  readonly adapterId = "plugin-install";
  readonly version = 1;
  readonly kinds = ["plugin_install"] as const;
  /** An install is undone by uninstalling the plugin, which removes exactly what it added. */
  readonly rollbackRefusal = "Uninstall the plugin instead.";
  constructor(private readonly sources: PluginInstallSources) {}

  async prepare(context: EvolutionControlPlaneAdapterContext, request: ChangePlanPluginInstallRequest) {
    requireCapabilitiesOrigin(context.origin, ORIGIN_REFUSAL);
    if (request.workspaceId !== context.origin.workspaceId) throw conflict(OTHER_WORKSPACE_MESSAGE);
    const binding = await this.bind(request);
    const settings = await this.sources.readSettings();
    const hosts = await this.hostsToAllow(binding, settings.networkAllowlist);
    const { manifest } = binding;
    const summary = boundedSentences(this.plannedSentences(binding, settings, hosts));
    return {
      target: {
        ownerId: "capability_plugins",
        resourceId: `plugin:${manifest.pluginId}`,
        expectedHash: bindingHash(undefined, request),
      },
      title: boundedTitle(`Install ${manifest.name}`),
      summary,
      impact: boundedSentences([
        ...(hosts.network.length > 0 ? ["Any tool can reach an allowed host, not only this plugin's connectors."] : []),
        "Uninstalling the plugin removes what this install adds, and keeps what was already there.",
        ...(binding.inspection.trust === "unverified"
          ? ["GoatCitadel checked each piece, not who wrote the plugin."]
          : []),
      ]),
      risk: "danger" as const,
      status: "awaiting_confirmation" as const,
      requiredAction: context.actions.confirmation({
        title: boundedTitle(`Install ${manifest.name}`),
        confirmationText: summary,
      }),
      evidenceRefs: [`plugin_inspection:${request.inspectionId}`],
    };
  }

  async apply(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    const request = requireRequest(plan);
    let binding: InstallBinding;
    try {
      // The bytes on disk, the kept check and the manifest: all as they were when the plan was made.
      await this.sources.verifySnapshot(request.snapshotTreeSha256);
      binding = await this.bind(request);
      // Kept as the plan's own binding (carry 8). `bind` has already refused any record, so the record part is null by
      // construction: what catches a change is `verifySnapshot` and `bind`, and this only catches a tampered target.
      if (bindingHash(await this.sources.readPlugin(binding.manifest.pluginId), request) !== plan.target.expectedHash) {
        throw pluginChanged();
      }
    } catch (error) {
      // Nothing was written, so no hook holds a secret yet: each one is this install's to delete.
      this.deleteUnheldSecrets(request, new Set());
      if (!isGoatError(error) || error.httpStatus >= 500) throw error;
      const changed = error instanceof ConflictError && error.code !== "ALREADY_EXISTS";
      return {
        status: "failed" as const,
        result: {
          summary: changed ? PLUGIN_CHANGED_MESSAGE : error.message,
          failureCode: changed ? "plugin_install_changed" : "plugin_install_refused",
        },
      };
    }
    const progress: InstallProgress = {
      allowed: [],
      hookHostsAllowed: [],
      done: [],
      attached: new Set(),
      recordWritten: false,
    };
    let step: InstallStep = "record";
    try {
      await this.writeRecord(binding, request, plan);
      progress.recordWritten = true;
      step = "hosts";
      await this.allowHosts(binding, progress);
      step = "connectors";
      await this.saveConnectors(binding, plan, progress);
      step = "tool_groups";
      await this.holdToolGroups(binding, plan, progress);
      step = "hooks";
      await this.addHooks(binding, request, plan, progress);
      step = "prompt_packs";
      await this.addPromptPacks(binding, plan, progress);
      step = "finish";
      await this.save(binding.manifest.pluginId, plan, (record) => ({ ...record, state: "installed" }));
      return {
        status: "completed" as const,
        evidenceRefs: [...plan.evidenceRefs, `plugin:${binding.manifest.pluginId}`],
        result: { summary: boundedSentences(finishedSentences(binding, progress, true)) },
      };
    } catch (error) {
      // A secret no hook holds yet is this install's to delete; one a hook holds goes with that hook.
      this.deleteUnheldSecrets(request, progress.attached);
      return stopped(binding, progress, step, error);
    }
  }

  /** Reports what the plugin's record holds after an interruption. It never writes, so nothing is applied twice. */
  async reconcile(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord) {
    requireRequest(plan);
    const pluginId = planPluginId(plan);
    const record = pluginId ? await this.sources.readPlugin(pluginId) : undefined;
    const own = record?.installPlanId === plan.planId ? record : undefined;
    if (own?.state === "installed") {
      return {
        effectObserved: true,
        status: "completed" as const,
        evidenceRefs: [...plan.evidenceRefs, `plugin:${own.pluginId}`],
        result: { summary: `Installed ${own.name}.` },
      };
    }
    return {
      effectObserved: false,
      status: "manual_required" as const,
      result: {
        summary: own
          ? `The install stopped before it finished. Uninstall ${own.name} to remove what it added, then install it again.`
          : "The install stopped before it finished.",
        failureCode: "plugin_install_interrupted",
      },
    };
  }

  /**
   * A plan that ends before it applies (cancelled, expired or refused) leaves no secret behind in the key store. A plan
   * that reached apply is never this method's to clean, even when a cancel of a finished plan is asked for (the control
   * plane refuses that only after calling it): its hooks hold their secrets until uninstalling removes them. Even before
   * apply, a secret this install's own record shows a hook holding is kept.
   */
  async discard(_context: EvolutionControlPlaneAdapterContext, plan: ChangePlanRecord): Promise<void> {
    if (plan.request.kind !== "plugin_install" || !NOT_YET_APPLIED.has(plan.status)) return;
    let held: ReadonlySet<string>;
    try {
      held = await this.hooksHeldByRecord(plan);
    } catch (error) {
      // A secret left behind is safer than a hook that can't sign: keep them all, and say so.
      this.sources.reportSecretsKept(error);
      return;
    }
    this.deleteUnheldSecrets(plan.request, held);
  }

  /** The hook pieces this plan's install record shows holding a hook (and so its secret), by piece id. */
  private async hooksHeldByRecord(plan: ChangePlanRecord): Promise<ReadonlySet<string>> {
    const record = await this.sources.readPlugin(planPluginId(plan));
    if (record?.installPlanId !== plan.planId) return new Set();
    return new Set(record.pieces.filter((piece) => piece.kind === "hook" && piece.ref).map((piece) => piece.pieceId));
  }

  /**
   * The kept inspection the request names, bound to it: the same workspace, manifest and snapshot, installable, every
   * hook with exactly one secret reference, and a plugin that isn't installed yet. The manifest is read again from the
   * snapshot, as its pieces' templates, addresses, groups and paths aren't in the inspection.
   */
  private async bind(request: ChangePlanPluginInstallRequest): Promise<InstallBinding> {
    const kept = requireInstallableInspection(
      await this.sources.readInspection(request.inspectionId),
      request.workspaceId,
    );
    const { inspection } = kept;
    if (
      inspection.manifestSha256 !== request.manifestSha256 ||
      kept.snapshotTreeSha256 !== request.snapshotTreeSha256
    ) {
      throw pluginChanged();
    }
    const parsed = await this.sources.readManifest(request.snapshotTreeSha256);
    if (
      !parsed.ok ||
      parsed.manifestSha256 !== request.manifestSha256 ||
      parsed.manifest.pluginId !== inspection.pluginId
    ) {
      throw pluginChanged();
    }
    const { manifest } = parsed;
    const views = new Map(inspection.pieces.map((view) => [view.pieceId, view]));
    if (manifest.pieces.some((piece) => views.get(piece.id)?.kind !== piece.kind)) throw pluginChanged();
    const hookIds = manifest.pieces.filter((piece) => piece.kind === "hook").map((piece) => piece.id);
    const refIds = Object.keys(request.hookSecretRefs ?? {});
    if (refIds.length !== hookIds.length || hookIds.some((id) => !refIds.includes(id))) {
      throw new SemanticValidationError(SECRET_REFS_MESSAGE);
    }
    const installed = await this.sources.readPlugin(manifest.pluginId);
    if (installed) throw pluginAlreadyInstalled(installed);
    return { inspection, manifest, treeSha256: request.snapshotTreeSha256, views };
  }

  /** Step 1: the record, listing every piece. A piece that was already there is kept, not owned. */
  private async writeRecord(binding: InstallBinding, request: ChangePlanPluginInstallRequest, plan: ChangePlanRecord) {
    const { inspection, manifest } = binding;
    const record: StoredPlugin = {
      pluginId: manifest.pluginId,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      trust: inspection.trust,
      sourceKind: inspection.sourceKind,
      sourceDisplay: inspection.sourceDisplay,
      pin: inspection.pin,
      manifestSha256: request.manifestSha256,
      snapshotTreeSha256: request.snapshotTreeSha256,
      workspaceId: request.workspaceId,
      installPlanId: plan.planId,
      state: "installing",
      installedAt: new Date().toISOString(),
      pieces: manifest.pieces.map((piece): StoredPluginPiece => {
        const view = binding.views.get(piece.id);
        return {
          pieceId: piece.id,
          kind: piece.kind,
          owned: view?.check.status !== "already_there",
          ...(piece.kind === "skill" && view?.skillSnapshotId ? { skillSnapshotId: view.skillSnapshotId } : {}),
        };
      }),
    };
    await this.sources.updatePlugin(manifest.pluginId, (current) => {
      if (current) throw pluginAlreadyInstalled(current);
      return record;
    });
  }

  /** Step 2: one settings write for the hosts the connectors it saves and its hooks need. */
  private async allowHosts(binding: InstallBinding, progress: InstallProgress): Promise<void> {
    const settings = await this.sources.readSettings();
    const hosts = await this.hostsToAllow(binding, settings.networkAllowlist);
    if (hosts.network.length === 0 && hosts.hooks.length === 0) return;
    await this.sources.updateSettings({
      expectedRevision: settings.revision,
      ...(hosts.network.length > 0 ? { networkAllowlist: [...settings.networkAllowlist, ...hosts.network] } : {}),
      ...(hosts.hooks.length > 0
        ? { hookNetworkAllowlist: [...this.sources.readHookAllowlist(), ...hosts.hooks] }
        : {}),
    });
    progress.allowed = hosts.network;
    progress.hookHostsAllowed = hosts.hooks;
  }

  /** Step 3: each connector, saved switched off and marked as the plugin's, unless its label is already saved. */
  private async saveConnectors(binding: InstallBinding, plan: ChangePlanRecord, progress: InstallProgress) {
    const owner = { pluginId: binding.manifest.pluginId, name: binding.manifest.name, installPlanId: plan.planId };
    for (const piece of binding.manifest.pieces) {
      if (piece.kind !== "connector") continue;
      if (!this.isOwned(binding, piece)) {
        progress.done.push(`Kept ${binding.views.get(piece.id)?.label ?? piece.templateId}, which was already saved.`);
        continue;
      }
      progress.current = piece;
      const template = requireTemplate(this.sources.connectorTemplates(), piece.templateId);
      if (await this.isLabelSaved(template)) {
        // Saved since the check: the operator's own, which this install keeps and never changes.
        await this.savePiece(binding, plan, piece.id, { owned: false });
        progress.done.push(`Kept ${template.label}, which was already saved.`);
        continue;
      }
      const created = await this.sources.createConnector(connectorInput(template), owner);
      await this.savePiece(binding, plan, piece.id, { ref: created.serverId });
      const wanted = piece.asksFirst === "everything" ? "everything_asks" : "reads_free";
      // Written out even when it is what an unset value means, so the saved server says what the plugin asked for.
      if (created.policy.approvalPosture !== wanted) {
        // The operator who asked for the install, not whoever resumed it, is named in the audit record.
        await this.sources.setConnectorApproval(created, wanted, owner, plan.origin.actorId ?? "operator");
      }
      progress.done.push(savedConnectorSentence(template.label, wanted));
    }
    progress.current = undefined;
  }

  /** Step 4: each group held off, unless the operator had already switched it off (then it stays their switch). */
  private async holdToolGroups(binding: InstallBinding, plan: ChangePlanRecord, progress: InstallProgress) {
    const operatorOff = new Set(this.sources.operatorSwitchedOffToolGroups());
    const groups = binding.manifest.pieces.filter(
      (piece): piece is Extract<PluginPiece, { kind: "tool_group_off" }> => piece.kind === "tool_group_off",
    );
    if (groups.length === 0) return;
    const held = new Set(
      groups
        .filter((piece) => this.isOwned(binding, piece) && !operatorOff.has(piece.groupId))
        .map((piece) => piece.id),
    );
    await this.save(binding.manifest.pluginId, plan, (record) => ({
      ...record,
      pieces: record.pieces.map((stored) => {
        const group = groups.find((piece) => piece.id === stored.pieceId);
        if (!group) return stored;
        return held.has(group.id)
          ? { ...stored, owned: true, ref: group.groupId }
          : { pieceId: stored.pieceId, kind: stored.kind, owned: false };
      }),
    }));
    for (const piece of groups) {
      const label = groupLabel(piece.groupId);
      progress.done.push(
        held.has(piece.id)
          ? `Turned ${label} off in every chat.`
          : `${label} was already off, and stays your own switch.`,
      );
    }
  }

  /** Step 5: each hook, in the plan's workspace: it only watches, sends event details only, and signs with its secret. */
  private async addHooks(
    binding: InstallBinding,
    request: ChangePlanPluginInstallRequest,
    plan: ChangePlanRecord,
    progress: InstallProgress,
  ) {
    for (const piece of binding.manifest.pieces) {
      if (piece.kind !== "hook") continue;
      progress.current = piece;
      const secretRef = request.hookSecretRefs?.[piece.id];
      if (!secretRef) throw new SemanticValidationError(SECRET_REFS_MESSAGE);
      const created = await this.sources.createHook({
        workspaceId: request.workspaceId,
        label: binding.views.get(piece.id)?.label ?? HOOK_TRIGGER_LABELS[piece.trigger] ?? piece.trigger,
        trigger: piece.trigger,
        mode: "observe",
        enabled: true,
        dataScope: "metadata",
        action: { type: "webhook", webhook: { url: piece.url, secretRef } },
      });
      progress.attached.add(piece.id);
      await this.savePiece(binding, plan, piece.id, { ref: created.hookId });
      progress.done.push(`Added a hook that sends event details to ${hookHost(piece.url)}.`);
    }
    progress.current = undefined;
  }

  /** Step 6: each prompt pack, created under its own id (never imported over), named as the inspection showed it. */
  private async addPromptPacks(binding: InstallBinding, plan: ChangePlanRecord, progress: InstallProgress) {
    const { manifest, treeSha256 } = binding;
    const sourceLabel = pluginPromptPackSourceLabel(manifest.name);
    const packs: Array<{ piece: Extract<PluginPiece, { kind: "prompt_pack" }>; content: string; name: string }> = [];
    for (const piece of manifest.pieces) {
      if (piece.kind !== "prompt_pack") continue;
      progress.current = piece;
      const content = await this.sources.readSnapshotText(treeSha256, piece.path);
      const packId = pluginPromptPackId(manifest.pluginId, piece.id);
      packs.push({ piece, content, name: preparePromptPackImport({ content, packId, sourceLabel }).write.name });
    }
    const names = distinctPluginPromptPackNames(packs.map((pack) => ({ pieceId: pack.piece.id, name: pack.name })));
    for (const pack of packs) {
      progress.current = pack.piece;
      const packId = pluginPromptPackId(manifest.pluginId, pack.piece.id);
      const input = { content: pack.content, name: names.get(pack.piece.id) ?? pack.name, sourceLabel, packId };
      const expectedDefinitionRevision = builtinDefinitionRevision(packId, preparePromptPackImport(input).write);
      try {
        await this.sources.importPromptPack(input, { packKey: packId, expectedDefinitionRevision });
      } catch (error) {
        // The pack is saved; only its export file failed. Record it, so uninstalling removes it.
        if (error instanceof BuiltinPromptPackPostCommitError)
          await this.savePiece(binding, plan, pack.piece.id, { ref: packId });
        throw error;
      }
      await this.savePiece(binding, plan, pack.piece.id, { ref: packId });
      progress.done.push(`Added the prompt pack ${input.name} to Library › Prompt packs.`);
    }
    progress.current = undefined;
  }

  /** The hosts the install adds: its connectors' missing hosts, and its hooks' hosts when the hooks list restricts. */
  private async hostsToAllow(binding: InstallBinding, networkAllowlist: readonly string[]) {
    const network: string[] = [];
    for (const piece of binding.manifest.pieces) {
      if (piece.kind !== "connector" || !this.isOwned(binding, piece)) continue;
      const template = requireTemplate(this.sources.connectorTemplates(), piece.templateId);
      if (await this.isLabelSaved(template)) continue;
      for (const host of missingHosts(template, [...networkAllowlist, ...network])) network.push(host);
    }
    // An empty hooks list already allows every public https host; adding one would block every other hook.
    const hookAllowlist = [...this.sources.readHookAllowlist()];
    const hooks: string[] = [];
    if (hookAllowlist.length > 0) {
      for (const piece of binding.manifest.pieces) {
        if (piece.kind !== "hook") continue;
        const host = hookHost(piece.url);
        if (!isHostAllowlistedInList(host, [...hookAllowlist, ...hooks])) hooks.push(host);
      }
    }
    return { network, hooks };
  }

  /** The plain steps the plan will take, in order, for its summary and its confirmation. */
  private plannedSentences(
    binding: InstallBinding,
    settings: PluginInstallSettings,
    hosts: { readonly network: readonly string[]; readonly hooks: readonly string[] },
  ): string[] {
    const { manifest } = binding;
    const sentences = [
      ...(hosts.network.length > 0 ? [`Allow ${hosts.network.join(", ")}.`] : []),
      ...(hosts.hooks.length > 0 ? [`Allow ${hosts.hooks.join(", ")} for hooks.`] : []),
    ];
    // Skills come last: each is added in its own steps once this plan has finished.
    const skills: string[] = [];
    for (const piece of manifest.pieces) {
      const view = binding.views.get(piece.id);
      const kept = view?.check.status === "already_there";
      switch (piece.kind) {
        case "connector": {
          const label = view?.label ?? piece.templateId;
          sentences.push(
            kept
              ? `Keep ${label}, which is already saved.`
              : settings.deploymentProfile === "remote_hardened"
                ? `Save ${label}, switched off. On this install every action it takes asks you first.`
                : piece.asksFirst === "everything"
                  ? `Save ${label}, switched off, and everything it does asks you first.`
                  : `Save ${label}, switched off, set to Reading is free.`,
          );
          break;
        }
        case "tool_group_off": {
          const label = groupLabel(piece.groupId);
          sentences.push(
            kept
              ? `${label} is already off, and stays your own switch.`
              : `Turn ${label} off in every chat while ${manifest.name} is installed.`,
          );
          break;
        }
        case "hook":
          sentences.push(
            `Add a hook that sends event details, never message text, to ${hookHost(piece.url)}: ` +
              `${HOOK_TRIGGER_LABELS[piece.trigger] ?? piece.trigger}.`,
          );
          break;
        case "prompt_pack":
          sentences.push(`Add the prompt pack ${view?.label ?? piece.id} to Library › Prompt packs.`);
          break;
        case "skill":
          skills.push(`List the skill ${view?.label ?? piece.id}, which is added in its own steps after this.`);
          break;
      }
    }
    return [...sentences, ...skills];
  }

  private isOwned(binding: InstallBinding, piece: PluginPiece): boolean {
    return binding.views.get(piece.id)?.check.status !== "already_there";
  }

  private async isLabelSaved(template: McpServerTemplateRecord): Promise<boolean> {
    const label = mcpServerLabelKey(template.label);
    return (await this.sources.listSavedConnectors()).some((server) => mcpServerLabelKey(server.label) === label);
  }

  /** Saves what one piece became in this install's own record. */
  private async savePiece(
    binding: InstallBinding,
    plan: ChangePlanRecord,
    pieceId: string,
    change: { ref?: string; owned?: boolean },
  ): Promise<void> {
    await this.save(binding.manifest.pluginId, plan, (record) => ({
      ...record,
      pieces: record.pieces.map((stored) =>
        stored.pieceId !== pieceId
          ? stored
          : change.owned === false
            ? { pieceId: stored.pieceId, kind: stored.kind, owned: false }
            : { ...stored, ...(change.ref ? { ref: change.ref } : {}) },
      ),
    }));
  }

  /** Changes this install's own record; any other record (or none) is a conflict, never overwritten. */
  private async save(pluginId: string, plan: ChangePlanRecord, change: (record: StoredPlugin) => StoredPlugin) {
    await this.sources.updatePlugin(pluginId, (current) => {
      if (current?.installPlanId !== plan.planId) throw pluginChanged();
      return change(current);
    });
  }

  private deleteUnheldSecrets(request: ChangePlanPluginInstallRequest, held: ReadonlySet<string>): void {
    for (const [pieceId, secretRef] of Object.entries(request.hookSecretRefs ?? {})) {
      if (!held.has(pieceId)) this.sources.deleteHookSecret(secretRef);
    }
  }
}

function requireRequest(plan: ChangePlanRecord): ChangePlanPluginInstallRequest {
  if (plan.request.kind !== "plugin_install") throw new SemanticValidationError("Expected a plugin install request.");
  return plan.request;
}

function conflict(message: string): ConflictError {
  return new ConflictError({ message });
}

/**
 * The plan's binding: the plugin's record now (none, before an install), the inspection and the manifest and snapshot
 * it checked. Taken when the plan is made and again at apply, so a change in between stops the install plainly.
 */
function bindingHash(record: StoredPlugin | undefined, request: ChangePlanPluginInstallRequest): string {
  return createHash("sha256")
    .update(
      canonicalJsonString({
        record: record ?? null,
        inspectionId: request.inspectionId,
        manifestSha256: request.manifestSha256,
        snapshotTreeSha256: request.snapshotTreeSha256,
      }),
    )
    .digest("hex");
}

/** The shipped template a connector piece names, by the connector install's own rule, or the rule's plain refusal. */
function requireTemplate(templates: readonly McpServerTemplateRecord[], templateId: string): McpServerTemplateRecord {
  const found = findInstallableConnectorTemplate(templates, templateId);
  if (!found.ok) throw conflict(found.message);
  return found.template;
}

/** The template's own configuration and policy, switched off. The approval setting is the audited write after. */
function connectorInput(template: McpServerTemplateRecord): McpServerCreateInput {
  return {
    label: template.label,
    transport: template.transport,
    command: template.command,
    args: template.args,
    url: template.url,
    authType: template.authType,
    oauth: template.oauth,
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: template.policy,
    enabled: false,
  };
}

function savedConnectorSentence(label: string, approval: "reads_free" | "everything_asks"): string {
  return approval === "reads_free"
    ? `Saved ${label}, switched off, set to Reading is free.`
    : `Saved ${label}, switched off, and everything it does asks you first.`;
}

/** One plain sentence per finished step, then a skill's own steps (R66). */
function finishedSentences(binding: InstallBinding, progress: InstallProgress, finished: boolean): string[] {
  const skills = binding.manifest.pieces.filter((piece) => piece.kind === "skill");
  return [
    ...(finished ? [`Installed ${binding.manifest.name}.`] : []),
    ...(progress.allowed.length > 0 ? [`Allowed ${progress.allowed.join(", ")}.`] : []),
    ...(progress.hookHostsAllowed.length > 0 ? [`Allowed ${progress.hookHostsAllowed.join(", ")} for hooks.`] : []),
    ...progress.done,
    ...(finished
      ? skills.map((piece) => `The skill ${binding.views.get(piece.id)?.label ?? piece.id} still needs its own steps.`)
      : []),
  ];
}

/**
 * The outcome when a step fails (R79): plain sentences for what was added, what didn't happen and what to do next. The
 * record keeps listing what was added, so uninstalling the plugin removes it. The owner's own words go to
 * `failureDetail`, for technical details only.
 */
function stopped(
  binding: InstallBinding,
  progress: InstallProgress,
  step: InstallStep,
  error: unknown,
): EvolutionControlPlaneAdapterOutcome {
  const name = binding.manifest.name;
  // Another install's record landed first: the plain refusal says so, and nothing of this install was written.
  if (step === "record" && isGoatError(error) && error.httpStatus < 500) {
    return { status: "failed", result: { summary: error.message, failureCode: "plugin_install_refused" } };
  }
  const detail = failureDetail(error);
  const next = progress.recordWritten
    ? `Uninstall ${name} to remove what it added, then install it again.`
    : "Nothing was changed, so trying again is safe.";
  return {
    status: progress.recordWritten ? "manual_required" : "failed",
    result: {
      summary: boundedSentences([
        ...finishedSentences(binding, progress, false),
        whatFailed(binding, progress, step),
        next,
      ]),
      failureCode: `plugin_install_${step}_failed`,
      ...(detail ? { failureDetail: detail } : {}),
    },
  };
}

/** What didn't happen, naming the piece the step was working on. */
function whatFailed(binding: InstallBinding, progress: InstallProgress, step: InstallStep): string {
  const piece = progress.current;
  const label = piece ? (binding.views.get(piece.id)?.label ?? piece.id) : undefined;
  switch (step) {
    case "record":
      return `Couldn't start installing ${binding.manifest.name}.`;
    case "hosts":
      return "Couldn't allow the hosts it needs.";
    case "connectors":
      return label ? `Couldn't save ${label}.` : "Couldn't save its connectors.";
    case "tool_groups":
      return "Couldn't turn its tool groups off.";
    case "hooks":
      return piece?.kind === "hook"
        ? `Couldn't add the hook that sends event details to ${hookHost(piece.url)}.`
        : "Couldn't add its hooks.";
    case "prompt_packs":
      return label ? `Couldn't add the prompt pack ${label}.` : "Couldn't add its prompt packs.";
    case "finish":
      return "Couldn't mark the install as finished.";
  }
}
