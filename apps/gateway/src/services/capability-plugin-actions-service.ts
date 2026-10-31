import {
  ConflictError,
  GoatError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
  type ChangePlanPluginInstallRequest,
  type ChangePlanRecord,
  type PluginActionOutcome,
  type PluginManifestParse,
} from "@goatcitadel/contracts";
import type { StoredPlugin } from "./capability-plugin-store.js";
import { awaitsApplyConfirmation } from "./evolution-control-plane-action-guards.js";
import type { EvolutionControlPlaneActor } from "./evolution-control-plane-service.js";
import {
  PLUGIN_CHANGED_MESSAGE,
  PLUGIN_INSPECTION_GONE_MESSAGE,
  type KeptPluginInspection,
} from "./plugin-install-change-plan-adapter.js";
import { isSecretStoreUnavailableLikeError } from "./secret-store-service.js";

const MAX_SECRET_LENGTH = 512;
const CHANGE_PLANS_OFF_MESSAGE = "Installing plugins needs Change Plans, which are off on this install.";
const WORKSPACE_MISSING_MESSAGE = "That workspace isn't on this install.";
const OTHER_WORKSPACE_MESSAGE = "This plugin was checked for another workspace. Check it again here.";
const NOT_INSTALLABLE_MESSAGE = "This plugin has pieces that can't be installed. Check it again once they're fixed.";
const ANSWER_GONE_MESSAGE =
  "This install's first answer is no longer kept, so it can't be sent again. Install the plugin again.";
const MISSING_SECRET_MESSAGE = "Every hook needs its own signing secret.";
const EXTRA_SECRET_MESSAGE = "Only a hook takes a signing secret.";
const SECRET_SHAPE_MESSAGE = "A signing secret is 1 to 512 characters, with no space at either end.";
const KEY_STORE_UNAVAILABLE_MESSAGE =
  "This computer's key store can't be used right now, so a hook's signing secret can't be kept. Nothing was installed.";

/** 409 `PLUGIN_ID_RESERVED`: a plugin from another source takes the id of one that ships with GoatCitadel. */
export class PluginIdReservedError extends GoatError {
  public readonly code = "PLUGIN_ID_RESERVED" as const;
  public readonly httpStatus = 409;

  public constructor() {
    super("A plugin that ships with GoatCitadel already uses this id.");
  }
}

/** One plain reader or writer per owner the plugin actions go through. None of them installs anything itself. */
export interface CapabilityPluginActionSources {
  /** Whether Change Plans are on: a plugin install is one, with no direct-write fallback. */
  changePlansEnabled(): Promise<boolean>;
  /** The plan an earlier request with this key made, by the same operator on the same surface. */
  findPlan(actor: EvolutionControlPlaneActor, idempotencyKey: string): Promise<ChangePlanRecord | undefined>;
  createPlan(input: {
    actor: EvolutionControlPlaneActor;
    request: ChangePlanPluginInstallRequest;
    idempotencyKey: string;
  }): Promise<ChangePlanRecord>;
  /** The operator's own confirmation, as their own save route gives it: the approval skip may apply (#572). */
  confirmPlan(
    actor: EvolutionControlPlaneActor,
    plan: ChangePlanRecord,
    actionNonce: string,
  ): Promise<ChangePlanRecord>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  readInspection(inspectionId: string): Promise<KeptPluginInspection | undefined>;
  readPlugin(pluginId: string): Promise<StoredPlugin | undefined>;
  /** The ids of the plugins that ship with GoatCitadel. */
  listBuiltInPluginIds(): Promise<readonly string[]>;
  /** `PluginSnapshotStore.verify`: the snapshot's files still hash to its name, or a 409. */
  verifySnapshot(treeSha256: string): Promise<void>;
  readManifest(treeSha256: string): Promise<PluginManifestParse>;
  /** Keeps a hook's signing secret in the key store, and answers the reference the plan holds instead. */
  storeHookSecret(value: string): string;
  /** Deletes a secret this install stored. It reports its own failure and never throws. */
  deleteHookSecret(secretRef: string): void;
}

export interface CapabilityPluginInstallInput {
  workspaceId: string;
  inspectionId: string;
  /** One signing secret per hook piece, by piece id. Never kept anywhere but the key store. */
  hookSecrets?: Readonly<Record<string, string>>;
  actorId: string;
  /** The request's `Idempotency-Key`: the same key answers from the plan its first try made. */
  idempotencyKey: string;
  requestId?: string;
  /** The Gateway's attempt record says this key was answered: only the first plan's answer may be sent. */
  replayOnly?: boolean;
}

/**
 * Capabilities › Plugins' install (and, in Task 18, uninstall). An install is one Change Plan the operator confirms
 * with their own click: every check runs before any secret is stored or any plan is made, a hook's secret is kept in
 * the key store and the plan holds only its reference, and a retry with the same key answers from the first plan.
 */
export class CapabilityPluginActionsService {
  public constructor(private readonly sources: CapabilityPluginActionSources) {}

  public async install(input: CapabilityPluginInstallInput): Promise<PluginActionOutcome> {
    const actor: EvolutionControlPlaneActor = {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      surface: "capabilities",
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
    const idempotencyKey = `capabilities:plugin-install:${input.idempotencyKey}:${input.inspectionId}`;
    if (!(await this.sources.changePlansEnabled())) {
      throw new ServiceUnavailableError(CHANGE_PLANS_OFF_MESSAGE, { reason: "change_plans_off" });
    }
    if (!(await this.sources.workspaceExists(input.workspaceId))) throw new NotFoundError(WORKSPACE_MISSING_MESSAGE);
    // A retry is answered from its first plan before anything is checked or stored, so no second secret is ever kept.
    const earlier = await this.sources.findPlan(actor, idempotencyKey);
    if (earlier) return await this.answerFrom(actor, earlier);
    if (input.replayOnly) throw new ConflictError({ message: ANSWER_GONE_MESSAGE });

    const request = await this.checkedRequest(input);
    const hookSecretRefs = this.storeSecrets(input.hookSecrets ?? {});
    const refs = Object.values(hookSecretRefs);
    let plan: ChangePlanRecord;
    try {
      plan = await this.sources.createPlan({
        actor,
        request: { ...request, ...(refs.length > 0 ? { hookSecretRefs } : {}) },
        idempotencyKey,
      });
    } catch (error) {
      // No plan holds them, so nothing else would ever delete them.
      for (const ref of refs) this.sources.deleteHookSecret(ref);
      throw error;
    }
    // From here the plan owns the references: its own end (cancel, expiry, refusal or a failed step) deletes them.
    return await this.answerFrom(actor, plan);
  }

  /**
   * The install's request, after every refusal that comes before a secret or a plan: the check is kept, current,
   * installable and this workspace's; the plugin isn't installed and takes no shipped plugin's id; every hook and no
   * other piece has a well-formed secret; and the snapshot's bytes and manifest are still the ones checked.
   */
  private async checkedRequest(
    input: CapabilityPluginInstallInput,
  ): Promise<Omit<ChangePlanPluginInstallRequest, "hookSecretRefs">> {
    const kept = await this.sources.readInspection(input.inspectionId);
    if (!kept) throw new NotFoundError(PLUGIN_INSPECTION_GONE_MESSAGE);
    const { inspection, snapshotTreeSha256 } = kept;
    if (inspection.workspaceId !== input.workspaceId) throw new ConflictError({ message: OTHER_WORKSPACE_MESSAGE });
    if (!inspection.installable || !inspection.manifestSha256) {
      throw new ConflictError({ message: NOT_INSTALLABLE_MESSAGE });
    }
    if (
      inspection.trust === "unverified" &&
      (await this.sources.listBuiltInPluginIds()).includes(inspection.pluginId)
    ) {
      throw new PluginIdReservedError();
    }
    const installed = await this.sources.readPlugin(inspection.pluginId);
    if (installed) {
      throw new ConflictError({
        code: "ALREADY_EXISTS",
        message: `${installed.name} is already installed.`,
        details: { pluginId: inspection.pluginId },
      });
    }
    checkSecrets(
      inspection.pieces.filter((piece) => piece.kind === "hook").map((piece) => piece.pieceId),
      input.hookSecrets ?? {},
    );
    await this.sources.verifySnapshot(snapshotTreeSha256);
    const parsed = await this.sources.readManifest(snapshotTreeSha256);
    if (!parsed.ok || parsed.manifestSha256 !== inspection.manifestSha256) {
      throw new ConflictError({ message: PLUGIN_CHANGED_MESSAGE });
    }
    return {
      kind: "plugin_install",
      inspectionId: inspection.inspectionId,
      manifestSha256: inspection.manifestSha256,
      snapshotTreeSha256,
      workspaceId: input.workspaceId,
    };
  }

  /** Each secret in the key store; a failure deletes the ones already stored, so none is left behind. */
  private storeSecrets(secrets: Readonly<Record<string, string>>): Record<string, string> {
    const refs: Record<string, string> = {};
    try {
      for (const [pieceId, value] of Object.entries(secrets)) refs[pieceId] = this.sources.storeHookSecret(value);
    } catch (error) {
      for (const ref of Object.values(refs)) this.sources.deleteHookSecret(ref);
      if (isSecretStoreUnavailableLikeError(error)) {
        throw new ServiceUnavailableError(KEY_STORE_UNAVAILABLE_MESSAGE, { reason: "key_store_unavailable" });
      }
      throw error;
    }
    return refs;
  }

  /** The plan's answer; a plan still waiting for the operator's confirmation gets it first, as the operator's own. */
  private async answerFrom(actor: EvolutionControlPlaneActor, plan: ChangePlanRecord): Promise<PluginActionOutcome> {
    if (plan.kind !== "plugin_install") {
      throw new ConflictError({ message: "This request was already used for a different change. Try again." });
    }
    const settled = awaitsApplyConfirmation(plan)
      ? await this.sources.confirmPlan(actor, plan, plan.requiredAction.actionNonce)
      : plan;
    return outcomeOf(settled);
  }
}

/**
 * Every hook piece has exactly one secret and no other piece has one, each 1 to 512 characters with no space at
 * either end. Checked here, before the key store, because the key store trims a secret without saying so.
 */
function checkSecrets(hookIds: readonly string[], secrets: Readonly<Record<string, string>>): void {
  const given = Object.keys(secrets);
  if (given.some((pieceId) => !hookIds.includes(pieceId))) {
    throw new ValidationError({ field: "hookSecrets", message: EXTRA_SECRET_MESSAGE });
  }
  if (hookIds.some((pieceId) => !Object.hasOwn(secrets, pieceId))) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field: "hookSecrets", message: MISSING_SECRET_MESSAGE });
  }
  for (const value of Object.values(secrets)) {
    if (typeof value !== "string" || value.length < 1 || value.length > MAX_SECRET_LENGTH || value !== value.trim()) {
      throw new ValidationError({ field: "hookSecrets", message: SECRET_SHAPE_MESSAGE });
    }
  }
}

/** `applied` when it finished, `failed` when it stopped, and otherwise `waiting`, with the approval it waits for. */
function outcomeOf(plan: ChangePlanRecord): PluginActionOutcome {
  const summary = plan.result?.summary ?? plan.summary;
  if (plan.status === "completed") return { planId: plan.planId, outcome: "applied", summary };
  if (["failed", "manual_required", "cancelled", "rolled_back", "rollback_failed"].includes(plan.status)) {
    return { planId: plan.planId, outcome: "failed", summary };
  }
  const approvalId = plan.requiredAction?.kind === "approval" ? plan.requiredAction.approvalId : undefined;
  return { planId: plan.planId, outcome: "waiting", ...(approvalId ? { approvalId } : {}), summary };
}
