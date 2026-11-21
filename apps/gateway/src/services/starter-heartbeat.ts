import { NotFoundError } from "@goatcitadel/contracts";
import { DEFAULT_SESSION_AUTONOMY_PREFS, type AsyncStorage } from "@goatcitadel/storage";

const STARTER_HEARTBEAT_KEY = "starter_heartbeat_v1";
const EXPLICIT_HEARTBEAT_PREFIX = "explicit_heartbeat_v1:";

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
  public constructor(private readonly storage: HeartbeatEnrollmentStorage) {}

  public async captureExplicitChoice(sessionId: string, enabled: boolean): Promise<void> {
    const target = await this.readTarget(sessionId);
    if (target) await this.storage.systemSettings.set(EXPLICIT_HEARTBEAT_PREFIX + sessionId, { ...target, enabled });
  }

  public async isArmed(sessionId: string): Promise<boolean> {
    const target = await this.readTarget(sessionId);
    if (!target) return false;
    return await this.isTargetArmed(target);
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
