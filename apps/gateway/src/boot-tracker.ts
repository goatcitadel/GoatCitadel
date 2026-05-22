/**
 * Boot-time progress tracker for the gateway process.
 *
 * Imported as the very first side-effect in main.ts so its setInterval is
 * registered before the heavy plugin chain in buildApp() executes. The
 * heartbeat prints to stderr every 2s (unless --verbose lifts the noise
 * floor higher) with the elapsed seconds and the most recent checkpoint
 * label.
 *
 * Why this exists: the gateway dev supervisor has observed a reproducible
 * Windows pattern where the first gateway process after a clean start sits
 * silent for the full 120s health-timeout window, then a kill+respawn boots
 * fine in ~5s. initCritical() has been instrumented separately and does not
 * fire its slow-step warnings, which means the hang is BEFORE initCritical.
 * The next plausible suspects (loadGatewayConfig, ensureBundledPostgresRuntime,
 * fastify plugin registration order, or a sync module-load step) need
 * per-step visibility from inside the gateway process — the supervisor
 * cannot see them because it only polls /health and /livez from outside.
 *
 * Behaviour:
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

heartbeatTimer = setInterval(emitHeartbeat, HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

// Print the initial checkpoint immediately so we have an anchor.
process.stderr.write(`[boot-tracker] started checkpoint="${currentCheckpoint}"\n`);

export function setBootCheckpoint(name: string): void {
  if (ended) return;
  const elapsedMs = Date.now() - bootStartedAt;
  const sinceCheckpointMs = Date.now() - lastCheckpointAt;
  process.stderr.write(
    `[boot-tracker] elapsed=${(elapsedMs / 1000).toFixed(1)}s checkpoint="${name}" prev="${currentCheckpoint}" prev_duration=${(sinceCheckpointMs / 1000).toFixed(1)}s\n`,
  );
  currentCheckpoint = name;
  lastCheckpointAt = Date.now();
}

export function endBootTracking(): void {
  if (ended) return;
  ended = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  const elapsedMs = Date.now() - bootStartedAt;
  process.stderr.write(
    `[boot-tracker] gateway boot complete in ${(elapsedMs / 1000).toFixed(1)}s, heartbeat stopped\n`,
  );
}
