import { bundledPostgresOperatorSummary } from "./bundled-postgres-runtime.js";
import type { StartupPhaseSnapshot } from "./diagnostics/startup-phases.js";
import { attachOperatorSummary, readOperatorSummary } from "./startup-errors.js";

const BUNDLED_POSTGRES_PHASE = "bundled_postgres";
const PLUGIN_TIMEOUT_CODES = new Set(["ERR_AVVIO_PLUGIN_TIMEOUT", "FST_ERR_PLUGIN_TIMEOUT"]);

/**
 * With default settings Fastify's plugin timeout (120 s) fires before the bundled database's own
 * start timeout (180 s) and replaces its error. When that happens while the bundled database phase
 * is still open, the database is what timed out: say so in plain words. Any other failure is
 * returned unchanged.
 */
export function withBundledDatabaseTimeoutSummary<T extends Error>(error: T, snapshot: StartupPhaseSnapshot): T {
  if (readOperatorSummary(error) !== undefined) {
    return error;
  }
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code !== "string" || !PLUGIN_TIMEOUT_CODES.has(code)) {
    return error;
  }
  const phase = snapshot.inProgress.find((item) => item.id === BUNDLED_POSTGRES_PHASE);
  if (!phase) {
    return error;
  }
  return attachOperatorSummary(
    error,
    bundledPostgresOperatorSummary("timeout", 0, Math.round(phase.ageMs / 1000) * 1000),
  );
}
