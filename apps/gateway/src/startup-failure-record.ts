import fs from "node:fs/promises";
import path from "node:path";
import { isNonRetryableStartupError, readOperatorSummary } from "./startup-errors.js";

/**
 * The launcher sets this to the file the Gateway writes when it cannot start.
 * The Gateway only writes and removes that one file; the launcher only reads it.
 */
export const STARTUP_FAILURE_FILE_ENV = "GOATCITADEL_STARTUP_FAILURE_FILE";

const GENERAL_SUMMARY = "GoatCitadel's background service stopped while starting. Open Logs shows why.";
const RECORD_VERSION = 1;
const RECORD_FILE_NAME = "gateway-startup-failure.json";

/**
 * The launcher keeps its runtime logs in <install>/runtime/logs, beside (not under) the Gateway's
 * own root, so the guard is the shape of the path: the fixed file name inside a folder named "logs"
 * inside a folder named "runtime". Any other path is ignored, so a stray variable can neither
 * create nor delete an arbitrary file.
 */
export function isStartupFailureRecordPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const logsDir = path.dirname(resolved);
  return (
    path.basename(resolved) === RECORD_FILE_NAME &&
    path.basename(logsDir) === "logs" &&
    path.basename(path.dirname(logsDir)) === "runtime"
  );
}

/**
 * Records why the Gateway could not start: the operator summary attached to the
 * error (or a general sentence) and whether a retry can help. The record never
 * copies the error message, so it cannot carry connection strings or keys.
 * Does nothing without a path and never throws.
 */
export async function writeStartupFailureRecord(
  filePath: string | undefined,
  error: unknown,
  now: Date = new Date(),
): Promise<void> {
  const target = filePath?.trim();
  if (!target || !isStartupFailureRecordPath(target)) {
    return;
  }
  const record = {
    version: RECORD_VERSION,
    summary: readOperatorSummary(error) ?? GENERAL_SUMMARY,
    retryable: !isNonRetryableStartupError(error),
    at: now.toISOString(),
  };
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  } catch (writeError) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    reportRecordFailureOnce("write", writeError);
  }
}

/** Removes the record. Does nothing without a path and never throws. */
export async function clearStartupFailureRecord(filePath: string | undefined): Promise<void> {
  const target = filePath?.trim();
  if (!target || !isStartupFailureRecordPath(target)) {
    return;
  }
  try {
    await fs.rm(target, { force: true });
  } catch (clearError) {
    reportRecordFailureOnce("clear", clearError);
  }
}

let reported = false;

function reportRecordFailureOnce(action: "write" | "clear", error: unknown): void {
  if (reported) {
    return;
  }
  reported = true;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  process.stderr.write(`[gateway] could not ${action} the startup failure record${code ? ` (${code})` : ""}\n`);
}
