import fs from "node:fs";
import path from "node:path";

/** The Gateway writes its start failure to the file this names; the launcher only reads and clears it. */
export const GATEWAY_STARTUP_FAILURE_ENV = "GOATCITADEL_STARTUP_FAILURE_FILE";

const GATEWAY_STARTUP_FAILURE_FILE = "gateway-startup-failure.json";
const MAX_SUMMARY_LENGTH = 500;
const MAX_RECORD_BYTES = 16 * 1024;

export function gatewayStartupFailurePath(runtimeLogDir) {
  return path.join(runtimeLogDir, GATEWAY_STARTUP_FAILURE_FILE);
}

/**
 * Reads the Gateway's start-failure record. Returns undefined for a missing,
 * oversized or malformed record, so a damaged file never becomes a reason.
 */
export function readGatewayStartupFailure(filePath) {
  let parsed;
  try {
    if (fs.statSync(filePath).size > MAX_RECORD_BYTES) {
      return undefined;
    }
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    typeof parsed.summary !== "string" ||
    parsed.summary.trim().length === 0 ||
    typeof parsed.retryable !== "boolean" ||
    typeof parsed.at !== "string"
  ) {
    return undefined;
  }
  return {
    summary: parsed.summary.slice(0, MAX_SUMMARY_LENGTH),
    retryable: parsed.retryable,
    at: parsed.at,
  };
}

/** Removes the record before a new start so an earlier run's reason is never shown for this one. */
export function clearGatewayStartupFailure(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A record that cannot be removed is ignored; the Gateway overwrites or clears it.
  }
}
