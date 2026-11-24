import { NotFoundError, type LlmRuntimeConfig } from "@goatcitadel/contracts";
import { DEFAULT_SESSION_AUTONOMY_PREFS, type AsyncStorage } from "@goatcitadel/storage";

const STARTER_HEARTBEAT_KEY = "starter_heartbeat_v1";
const EXPLICIT_HEARTBEAT_PREFIX = "explicit_heartbeat_v1:";
const UNPRICED_HOLD_PREFIX = "heartbeat_unpriced_hold_v1:";
/** How long a heartbeat waits after its model was refused for having no price. */
export const UNPRICED_HEARTBEAT_HOLD_MS = 24 * 60 * 60 * 1000;

type ModelSelection = Pick<LlmRuntimeConfig, "activeProviderId" | "activeModel" | "utilityProviderId" | "utilityModel">;

interface UnpricedHold {
  heldAt: string;
  models: string;
}

interface HeartbeatBinding {
  workspaceId: string;
  sessionId: string;
  sessionCreatedAt: string;
}

type HeartbeatTarget = HeartbeatBinding & { privateOperator: boolean };

type HeartbeatEnrollmentStorage = Pick<
  AsyncStorage,
  "chatSessionMeta" | "sessions" | "chatTurnTraces" | "sessionAutonomyPrefs" | "systemSettings"
>;

/**
 * Session preferences historically defaulted heartbeatEnabled to true.
 * Eligibility now requires a single starter binding or an operator choice.
 */
export class StarterHeartbeat {
  public constructor(
    private readonly storage: HeartbeatEnrollmentStorage,
    private readonly readModels: () => ModelSelection = () => ({ activeProviderId: "", activeModel: "" }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async captureExplicitChoice(sessionId: string, enabled: boolean): Promise<void> {
    const target = await this.readTarget(sessionId);
    if (target) await this.storage.systemSettings.set(EXPLICIT_HEARTBEAT_PREFIX + sessionId, { ...target, enabled });
  }

  /** Whether the heartbeat may dispatch now: armed and not waiting out an unpriced-model refusal. */
  public async isArmed(sessionId: string): Promise<boolean> {
    const target = await this.readTarget(sessionId);
    if (!target) return false;
    if (await this.isHeldForUnpricedModel(sessionId)) return false;
    return await this.isTargetArmed(target);
  }

  /**
   * Records that the automatic budget refused this Chat's heartbeat because its
   * model has no per-token price (for example a subscription sign-in). Later
   * occurrences park quietly for a day, or until the model selection changes,
   * instead of failing every hour with the same reason.
   */
  public async holdAfterBudgetRefusal(sessionId: string, reason: string): Promise<void> {
    if (reason !== "pricing_unavailable") return;
    const hold: UnpricedHold = { heldAt: this.now().toISOString(), models: this.modelFingerprint() };
    await this.storage.systemSettings.set(UNPRICED_HOLD_PREFIX + sessionId, hold);
  }

  private async isHeldForUnpricedModel(sessionId: string): Promise<boolean> {
    const row = await this.storage.systemSettings.get<UnpricedHold>(UNPRICED_HOLD_PREFIX + sessionId);
    const hold = row?.value;
    if (!hold || typeof hold.heldAt !== "string" || typeof hold.models !== "string") return false;
    const heldAt = Date.parse(hold.heldAt);
    if (!Number.isFinite(heldAt)) return false;
    const age = this.now().getTime() - heldAt;
    return age >= 0 && age < UNPRICED_HEARTBEAT_HOLD_MS && hold.models === this.modelFingerprint();
  }

  private modelFingerprint(): string {
    const models = this.readModels();
    return JSON.stringify([
      models.activeProviderId,
      models.activeModel,
      models.utilityProviderId ?? null,
      models.utilityModel ?? null,
    ]);
  }

  public async armIfEligible(sessionId: string, providerReady: () => Promise<boolean>): Promise<boolean> {
    const target = await this.readTarget(sessionId);
    if (!target) return false;
    if (await this.isTargetArmed(target)) return true;
    if (!target.privateOperator) return false;
    const [binding, prefs, choice] = await Promise.all([
      this.storage.systemSettings.get<HeartbeatBinding>(STARTER_HEARTBEAT_KEY),
      this.storage.sessionAutonomyPrefs.get(sessionId),
      this.storage.systemSettings.get(EXPLICIT_HEARTBEAT_PREFIX + sessionId),
    ]);
    if (binding || prefs?.heartbeatEnabled === false || choice) return false;
    const traces = await this.storage.chatTurnTraces.listBySession(sessionId, 5);
    if (
      !traces.some(
        (trace) =>
          trace.status === "completed" &&
          trace.completion?.status === "complete" &&
          (trace.completion.providerCallCount ?? 0) > 0 &&
          !trace.failure,
      )
    )
      return false;
    if (!(await providerReady())) return false;
    // Insert-if-absent is atomic for both storage backends. The binding is
    // retained when a Chat is paused, archived or deleted.
    await this.storage.systemSettings.compareAndSet(STARTER_HEARTBEAT_KEY, undefined, target);
    return await this.isTargetArmed(target);
  }

  private async isTargetArmed(target: HeartbeatBinding): Promise<boolean> {
    const [prefs, choice, starter] = await Promise.all([
      this.storage.sessionAutonomyPrefs.get(target.sessionId),
      this.storage.systemSettings.get<HeartbeatBinding & { enabled: boolean }>(
        EXPLICIT_HEARTBEAT_PREFIX + target.sessionId,
      ),
      this.storage.systemSettings.get<HeartbeatBinding>(STARTER_HEARTBEAT_KEY),
    ]);
    if (prefs?.heartbeatEnabled === false) return false;
    if (choice && sameTarget(choice.value, target)) return choice.value.enabled;
    if (starter && sameTarget(starter.value, target)) return true;
    // A non-default heartbeat cadence is an existing operator setting. The
    // old default boolean by itself carries no enrollment authority.
    return Boolean(
      prefs &&
      prefs.heartbeatEnabled &&
      prefs.heartbeatIntervalSeconds !== DEFAULT_SESSION_AUTONOMY_PREFS.heartbeatIntervalSeconds,
    );
  }

  private async readTarget(sessionId: string): Promise<HeartbeatTarget | undefined> {
    try {
      const [session, meta] = await Promise.all([
        this.storage.sessions.getBySessionId(sessionId),
        this.storage.chatSessionMeta.get(sessionId),
      ]);
      if (meta?.lifecycleStatus !== "active" || meta.origin === "system" || meta.origin === "prompt_pack")
        return undefined;
      return {
        workspaceId: meta.workspaceId,
        sessionId,
        sessionCreatedAt: meta.createdAt,
        privateOperator: session.kind === "dm" && meta.origin === "operator",
      };
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}

function sameTarget(left: HeartbeatBinding, right: HeartbeatBinding): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.sessionCreatedAt === right.sessionCreatedAt
  );
}
