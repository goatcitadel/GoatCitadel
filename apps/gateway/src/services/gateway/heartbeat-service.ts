import type { SessionAutonomyPrefsRecord } from "@goatcitadel/storage";
import {
  type ActiveHoursWindow,
  getCooldownRemainingSeconds,
  isWithinActiveHours,
} from "./commitment-sweep-service.js";

/**
 * Heartbeat (P1-F4) — silent self-wake.
 *
 * Runs inside the maintenance scheduler tick. For each eligible session it fires
 * a single internal "does anything need the user?" turn under the most-restricted
 * (`heartbeat-restricted`, read-only) permission profile, delivered with
 * `deliverMode:"on_notify"` so **nothing reaches the user** unless the turn's
 * output signals `{notify:true}`. The model may THINK every interval but can only
 * ACT by producing a governed notify message.
 *
 * Multi-gate rate limiting (every gate must pass before a turn fires):
 *  1. master autonomy switch on (the whole sweep is a no-op otherwise),
 *  2. per-session heartbeat enabled,
 *  3. session is heartbeat-eligible (human, non-eval, non-scratch — the gateway
 *     supplies this predicate so the service stays free of session internals),
 *  4. within the session's active-hours window,
 *  5. idle for at least the idle floor,
 *  6. no turn currently running,
 *  7. per-session proactive cooldown elapsed,
 *  8. the heartbeat interval has elapsed since the last self-wake.
 *
 * Pure orchestration: all state access + the actual enqueue/delivery are injected
 * as callbacks; nothing here mutates its inputs.
 */

const DEFAULT_SESSION_LIMIT = 300;
/** Minimum idle time before a heartbeat may fire, seconds (5 minutes). */
export const DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS = 5 * 60;

/** Minimal session shape the tick needs (matches the proactive scheduler's view). */
export interface HeartbeatSessionRef {
  sessionId: string;
  lastActivityAt: string;
}

export interface HeartbeatTickDeps {
  /** Honor the master autonomy kill switch (`autonomyV1Disabled`). */
  isAutonomyEnabled(): boolean;
  /** Active mission sessions to consider (oldest-activity ordering is irrelevant). */
  listSessions(limit: number): HeartbeatSessionRef[];
  /** Per-session autonomy prefs (heartbeat flags + cooldown source). */
  getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefsRecord;
  /**
   * Whether this session may receive heartbeats at all. The gateway uses this to
   * skip non-human / eval-integrity / replay-scratch sessions (safety invariant:
   * eval-integrity turns are never affected).
   */
  isHeartbeatEligibleSession(sessionId: string): boolean;
  /** Seconds since the session's last activity. */
  getSessionIdleSeconds(sessionId: string): number;
  /** True while a turn is mid-flight for the session (skip — never overlap). */
  hasRunningTurn(sessionId: string): boolean;
  /**
   * Fire one silent heartbeat turn for the session. Enqueues a `chat.turn.execute`
   * autonomous run under the `heartbeat-restricted` profile, seeded with the
   * heartbeat prompt and `deliverMode:"on_notify"`. Resolves truthy when enqueued.
   */
  enqueueHeartbeatTurn(input: { sessionId: string; prompt: string }): Promise<boolean> | boolean;
  /** Idle floor override (seconds); defaults to {@link DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS}. */
  idleFloorSeconds?: number;
  /** Max sessions to scan per tick. */
  sessionLimit?: number;
  now?: () => Date;
}

export interface HeartbeatTickResult {
  scanned: number;
  fired: number;
  skippedDisabled: number;
  skippedIneligible: number;
  skippedActiveHours: number;
  skippedNotIdle: number;
  skippedRunningTurn: number;
  skippedCooldown: number;
  skippedInterval: number;
  failed: number;
}

function emptyResult(): HeartbeatTickResult {
  return {
    scanned: 0,
    fired: 0,
    skippedDisabled: 0,
    skippedIneligible: 0,
    skippedActiveHours: 0,
    skippedNotIdle: 0,
    skippedRunningTurn: 0,
    skippedCooldown: 0,
    skippedInterval: 0,
    failed: 0,
  };
}

/**
 * Run one heartbeat sweep. Walks eligible sessions and fires at most one silent
 * self-wake turn per session per tick. No-op while the master autonomy switch is
 * off.
 */
export async function runHeartbeatTick(deps: HeartbeatTickDeps): Promise<HeartbeatTickResult> {
  const result = emptyResult();
  if (!deps.isAutonomyEnabled()) {
    return result;
  }
  const now = deps.now ? deps.now() : new Date();
  const idleFloor = deps.idleFloorSeconds ?? DEFAULT_HEARTBEAT_IDLE_FLOOR_SECONDS;
  const sessions = deps.listSessions(deps.sessionLimit ?? DEFAULT_SESSION_LIMIT);
  result.scanned = sessions.length;

  for (const session of sessions) {
    const prefs = deps.getSessionAutonomyPrefs(session.sessionId);
    if (!prefs.heartbeatEnabled) {
      result.skippedDisabled += 1;
      continue;
    }
    if (!deps.isHeartbeatEligibleSession(session.sessionId)) {
      result.skippedIneligible += 1;
      continue;
    }
    if (!isWithinActiveHours(now, toActiveHoursWindow(prefs))) {
      result.skippedActiveHours += 1;
      continue;
    }
    if (deps.getSessionIdleSeconds(session.sessionId) < idleFloor) {
      result.skippedNotIdle += 1;
      continue;
    }
    if (deps.hasRunningTurn(session.sessionId)) {
      result.skippedRunningTurn += 1;
      continue;
    }
    if (getCooldownRemainingSeconds(prefs, now) > 0) {
      result.skippedCooldown += 1;
      continue;
    }
    if (getHeartbeatIntervalRemainingSeconds(prefs, now) > 0) {
      result.skippedInterval += 1;
      continue;
    }
    try {
      const fired = await deps.enqueueHeartbeatTurn({
        sessionId: session.sessionId,
        prompt: HEARTBEAT_SYSTEM_PROMPT,
      });
      if (fired) {
        result.fired += 1;
      } else {
        result.failed += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Remaining seconds before the next heartbeat may fire for a session, based on
 * `lastProactiveAt` (the shared self-wake timestamp also touched by proactive +
 * commitment turns) and the session's `heartbeatIntervalSeconds`. Returns 0 when
 * no prior self-wake is recorded or the interval has elapsed.
 */
export function getHeartbeatIntervalRemainingSeconds(
  prefs: Pick<SessionAutonomyPrefsRecord, "lastProactiveAt" | "heartbeatIntervalSeconds">,
  now: Date,
): number {
  if (!prefs.lastProactiveAt || prefs.heartbeatIntervalSeconds <= 0) {
    return 0;
  }
  const elapsedSeconds = Math.floor((now.getTime() - Date.parse(prefs.lastProactiveAt)) / 1000);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds >= prefs.heartbeatIntervalSeconds) {
    return 0;
  }
  return Math.max(0, prefs.heartbeatIntervalSeconds - elapsedSeconds);
}

/** Adapt the persisted `{start,end}` active-hours window to the sweep's shape. */
function toActiveHoursWindow(prefs: Pick<SessionAutonomyPrefsRecord, "activeHours">): ActiveHoursWindow {
  return { startHour: prefs.activeHours.start, endHour: prefs.activeHours.end };
}

/**
 * Seed prompt for a silent self-wake turn. Instructs the model to review state
 * and stay silent by default — only surfacing to the user when something
 * genuinely warrants attention, via a structured `{notify}` signal that F1's
 * `deliverMode:"on_notify"` path keys on.
 */
export const HEARTBEAT_SYSTEM_PROMPT =
  "This is a silent, periodic self-check — the user did not message you. " +
  "Review the recent conversation and any pending commitments, then decide whether " +
  "anything genuinely needs the user's attention right now. " +
  "Respond with a JSON object: {notify: boolean, message?: string}. " +
  'Set notify:true ONLY if you must reach out (include a brief "message"); otherwise respond ' +
  "with {notify: false}. Default to {notify: false} and stay silent — do not message the user for " +
  "routine or low-value reasons. You have read-only tools only; do not attempt to take actions.";
