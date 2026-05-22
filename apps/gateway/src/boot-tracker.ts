/**
 * Boot-time progress tracker for the gateway process.
 *
 * Imported as the very first side-effect in main.ts so its setInterval is
 * registered before the heavy plugin chain in buildApp() executes. The
 * heartbeat prints to stderr every 2s with the elapsed seconds and the most
 * recent checkpoint label.
 *
 * GATED BEHIND `GOATCITADEL_VERBOSE=1` (or `pnpm dev --verbose`). Steady-state
 * boots see zero output from this module; only when verbose is enabled does
 * the heartbeat fire and `setBootCheckpoint` write its annotations. This
 * keeps the production boot log clean while preserving the full per-step
 * trace for future bug hunts — flip the env flag and the diagnostic surface
 * comes back.
 *
 * Why this module exists: the gateway dev supervisor has observed a Windows
 * pattern where a sync step inside the boot path (e.g., `execFileSync` with
 * pipe-inherited stdio) blocks the event loop and produces 120s of silence,
 * which the supervisor then treats as a health-timeout restart. The
 * boot-tracker output lets us localize *which* sync call is the blocker the
 * next time something like that regresses, by showing the LAST checkpoint
 * before the heartbeat stops firing.
 *
 * Behaviour (verbose mode only):
 * - Module load fires the heartbeat interval immediately (every 2s).
 * - Each step in the boot path calls `setBootCheckpoint("step-name")` to
 *   advertise where we are.
 * - When the gateway successfully starts listening, main.ts calls
 *   `endBootTracking()` to silence the heartbeat.
 * - If the event loop is BLOCKED by a synchronous step, the heartbeat will
 *   stop firing — that gap itself is diagnostic (last printed checkpoint
 *   is the sync work that's stuck).
 * - If the event loop is FREE but an awaited promise never resolves, the
 *   heartbeat keeps printing the same checkpoint forever.
 *
 * Output goes to stderr so it appears even if pino's stdout is buffered.
 */

const VERBOSE_ENV_TRUTHY = new Set(["1", "true", "yes", "on"]);
const verbose = VERBOSE_ENV_TRUTHY.has(process.env.GOATCITADEL_VERBOSE?.trim().toLowerCase() ?? "");

const bootStartedAt = Date.now();
let currentCheckpoint = "module-load";
let lastCheckpointAt = bootStartedAt;
let heartbeatTimer: NodeJS.Timeout | undefined;
let ended = false;

const HEARTBEAT_INTERVAL_MS = 2_000;

function emitHeartbeat(): void {
  if (ended) return;
  const elapsedMs = Date.now() - bootStartedAt;
  const sinceCheckpointMs = Date.now() - lastCheckpointAt;
  process.stderr.write(
    `[boot-tracker] elapsed=${(elapsedMs / 1000).toFixed(1)}s checkpoint="${currentCheckpoint}" since_checkpoint=${(sinceCheckpointMs / 1000).toFixed(1)}s\n`,
  );
}

if (verbose) {
  heartbeatTimer = setInterval(emitHeartbeat, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();
  process.stderr.write(`[boot-tracker] started checkpoint="${currentCheckpoint}"\n`);
}

export function setBootCheckpoint(name: string): void {
  if (ended) return;
  // Always update the in-memory state so the heartbeat (when verbose) shows
  // the freshest checkpoint even if the very next instruction blocks the
  // event loop. Skip the write in non-verbose mode to keep boots quiet.
  const elapsedMs = Date.now() - bootStartedAt;
  const sinceCheckpointMs = Date.now() - lastCheckpointAt;
  if (verbose) {
    process.stderr.write(
      `[boot-tracker] elapsed=${(elapsedMs / 1000).toFixed(1)}s checkpoint="${name}" prev="${currentCheckpoint}" prev_duration=${(sinceCheckpointMs / 1000).toFixed(1)}s\n`,
    );
  }
  currentCheckpoint = name;
  lastCheckpointAt = Date.now();
}

/**
 * Whether boot-tracker output is currently enabled. Other modules that want
 * to print one-shot diagnostic lines (e.g., probe-result snapshots) can gate
 * their writes on this so verbose-mode toggling stays centralized.
 */
export function isBootTrackerVerbose(): boolean {
  return verbose;
}

export function endBootTracking(): void {
  if (ended) return;
  ended = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (verbose) {
    const elapsedMs = Date.now() - bootStartedAt;
    process.stderr.write(
      `[boot-tracker] gateway boot complete in ${(elapsedMs / 1000).toFixed(1)}s, heartbeat stopped\n`,
    );
  }
}
