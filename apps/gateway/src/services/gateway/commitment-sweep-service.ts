import type { AgentCommitmentRecord } from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord } from "@goatcitadel/storage";

/**
 * Commitment sweep (P1-F3).
 *
 * Runs inside the maintenance scheduler tick. Lists due + pending check-ins,
 * delivers each (via F1's autonomous-turn / channel-delivery convention)
 * respecting a per-session cooldown + active-hours window, then marks them sent.
 * Superseded/dismissed/sent rows are already excluded by `listDue` (pending-only).
 * The whole sweep is a no-op while the master autonomy switch is off.
 */

const DEFAULT_DUE_LIMIT = 50;
/** Default active-hours window (local hour, inclusive start / exclusive end). */
const DEFAULT_ACTIVE_HOURS: ActiveHoursWindow = { startHour: 8, endHour: 22 };

export interface ActiveHoursWindow {
  /** Inclusive local start hour [0, 23]. */
  startHour: number;
  /** Exclusive local end hour [1, 24]. Supports overnight windows (start > end). */
  endHour: number;
}

export interface CommitmentSweepDeps {
  /** Honor the master autonomy kill switch (`autonomyV1Disabled`). */
  isAutonomyEnabled(): boolean;
  /** Due + pending commitments, oldest-due first. */
  listDueCommitments(nowIso: string, limit: number): AgentCommitmentRecord[];
  /** Per-session autonomy prefs (cooldown source). */
  getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefsRecord;
  /**
   * Deliver one check-in. Reuses F1: enqueues an autonomous (restricted) turn
   * seeded with the suggested text and the `{notify}`/channel delivery path.
   * Resolves to true when delivery was enqueued.
   */
  deliverCommitment(commitment: AgentCommitmentRecord): Promise<boolean> | boolean;
  /** Transition a delivered commitment to `sent`. */
  markSent(commitmentId: string): boolean;
  now?: () => Date;
  /** Optional per-session active-hours override (defaults to 08:00–22:00 local). */
  resolveActiveHours?: (sessionId: string) => ActiveHoursWindow | undefined;
  limit?: number;
}

export interface CommitmentSweepResult {
  scanned: number;
  delivered: number;
  skippedCooldown: number;
  skippedActiveHours: number;
  failed: number;
}

/**
 * Deliver due check-ins. Per-session: skip if within cooldown or outside active
 * hours; otherwise deliver, then `markSent`. A delivery within the sweep applies
 * the session cooldown to *subsequent* due commitments in the same tick so a
 * backlog cannot fire as a burst.
 */
export async function runCommitmentSweep(deps: CommitmentSweepDeps): Promise<CommitmentSweepResult> {
  const result: CommitmentSweepResult = {
    scanned: 0,
    delivered: 0,
    skippedCooldown: 0,
    skippedActiveHours: 0,
    failed: 0,
  };
  if (!deps.isAutonomyEnabled()) {
    return result;
  }
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const due = deps.listDueCommitments(nowIso, deps.limit ?? DEFAULT_DUE_LIMIT);
  result.scanned = due.length;

  // Track sessions we have already delivered to this tick so a backlog respects
  // the per-session cooldown (one check-in per session per sweep).
  const deliveredSessionsThisTick = new Set<string>();

  for (const commitment of due) {
    if (deliveredSessionsThisTick.has(commitment.sessionId)) {
      result.skippedCooldown += 1;
      continue;
    }
    const prefs = deps.getSessionAutonomyPrefs(commitment.sessionId);
    if (getCooldownRemainingSeconds(prefs, now) > 0) {
      result.skippedCooldown += 1;
      continue;
    }
    const activeHours = deps.resolveActiveHours?.(commitment.sessionId) ?? DEFAULT_ACTIVE_HOURS;
    if (!isWithinActiveHours(now, activeHours)) {
      result.skippedActiveHours += 1;
      continue;
    }
    try {
      const delivered = await deps.deliverCommitment(commitment);
      if (!delivered) {
        result.failed += 1;
        continue;
      }
      deps.markSent(commitment.commitmentId);
      deliveredSessionsThisTick.add(commitment.sessionId);
      result.delivered += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Remaining cooldown seconds for a session. Mirrors
 * `chat-proactive-service.getProactiveCooldownRemainingSeconds`.
 */
export function getCooldownRemainingSeconds(
  prefs: Pick<SessionAutonomyPrefsRecord, "lastProactiveAt" | "cooldownSeconds">,
  now: Date,
): number {
  if (!prefs.lastProactiveAt || prefs.cooldownSeconds <= 0) {
    return 0;
  }
  const elapsedSeconds = Math.floor((now.getTime() - Date.parse(prefs.lastProactiveAt)) / 1000);
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds >= prefs.cooldownSeconds) {
    return 0;
  }
  return Math.max(0, prefs.cooldownSeconds - elapsedSeconds);
}

/**
 * Pure active-hours check against the local hour of `now`. Supports overnight
 * windows (e.g. `{ startHour: 22, endHour: 6 }`). A full-day window
 * (`startHour === endHour`) is always active.
 */
export function isWithinActiveHours(now: Date, window: ActiveHoursWindow): boolean {
  const start = clampHour(window.startHour);
  const end = clampHour(window.endHour);
  const hour = now.getHours();
  if (start === end) {
    return true; // full-day / always active
  }
  if (start < end) {
    return hour >= start && hour < end;
  }
  // Overnight window wraps past midnight.
  return hour >= start || hour < end;
}

function clampHour(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(Math.floor(value), 0), 24);
}

/**
 * Seed prompt for an autonomous check-in turn. Frames the inferred follow-up as
 * the agent proactively reaching out, so the restricted turn produces a natural
 * check-in message that F1's delivery convention routes to the user.
 */
export function buildCommitmentCheckInPrompt(suggestedText: string): string {
  return (
    "This is a scheduled, self-initiated follow-up check-in you committed to earlier. " +
    "Send the user a brief, friendly check-in. Suggested intent:\n\n" +
    suggestedText
  );
}
