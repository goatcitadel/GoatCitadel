// Test-only observation entry. Importing this module never starts a Gateway.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";

export const EXECUTION_DIAGNOSTIC_PREFIX = "GOAT_WORKER_EXECUTION_DIAGNOSTIC ";
const UNCLASSIFIED = Object.freeze({ stage: "unclassified", reason: "unclassified" });

function project(value) {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return UNCLASSIFIED;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (fields.stage?.value === "artifact_admission" &&
    ["lease_parent_dispatch_mismatch", "other"].includes(fields.reason?.value)) {
    return { stage: "artifact_admission", reason: fields.reason.value };
  }
  return UNCLASSIFIED;
}

function emitWithoutReplacingOutcome(emit, line) {
  try { emit(line); }
  catch { return; } // A failed test diagnostic sink has no authority over execution.
}

/** No retries, input inspection, result replacement, or arbitrary-error output. */
export function observeExecutionRejections(execute, read, emit, maximum = 8) {
  const limit = Number.isSafeInteger(maximum) ? Math.min(8, Math.max(0, maximum)) : 8;
  let sequence = 0;
  return async function (...args) {
    try { return await Reflect.apply(execute, this, args); }
    catch (error) {
      if (sequence < limit) {
        sequence += 1;
        let diagnostic = UNCLASSIFIED;
        try { diagnostic = project(read(error)); }
        catch { diagnostic = UNCLASSIFIED; }
        emitWithoutReplacingOutcome(emit, EXECUTION_DIAGNOSTIC_PREFIX + JSON.stringify({ sequence, ...diagnostic }));
      }
      throw error;
    }
  };
}

/** Bounded line reader: discard overlong/non-prefix lines rather than keeping
 * arbitrary Gateway stdout in a second diagnostic artifact. */
export function createExecutionDiagnosticCollector() {
  const rows = [];
  const discarded = { malformed: 0, outOfSequence: 0, overlong: 0, incomplete: 0 };
  let line = "", discarding = false;
  let finalized;
  const recordGap = kind => { discarded[kind] = Math.min(8, discarded[kind] + 1); };
  return {
    push(chunk) {
      if (finalized) return;
      for (const character of chunk.toString("utf8")) {
        if (character !== "\n") {
          if (!discarding) {
            if (line.length < 256) line += character;
            else {
              if (line.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)) recordGap("overlong");
              line = ""; discarding = true;
            }
          }
          continue;
        }
        if (!discarding && line.startsWith(EXECUTION_DIAGNOSTIC_PREFIX)) {
          try {
            const value = JSON.parse(line.slice(EXECUTION_DIAGNOSTIC_PREFIX.length));
            const diagnostic = project(value);
            if (!Number.isSafeInteger(value?.sequence) || value.sequence !== rows.length + 1) {
              recordGap("outOfSequence");
            } else if (rows.length < 8) {
              rows.push(Object.freeze({ sequence: value.sequence, ...diagnostic }));
            }
          } catch { recordGap("malformed"); }
        }
        line = ""; discarding = false;
      }
    },
    rows() { return rows.slice(); },
    finish() {
      if (!finalized) {
        if (!discarding && line.length > 0 &&
          (line.startsWith(EXECUTION_DIAGNOSTIC_PREFIX) || EXECUTION_DIAGNOSTIC_PREFIX.startsWith(line))) {
          recordGap("incomplete");
        }
        // The observer emits at most eight rows. Reaching its ceiling cannot
        // establish completeness even when no ninth line reaches this reader.
        const capReached = rows.length >= 8;
        finalized = Object.freeze({ rows: Object.freeze(rows.slice()),
          diagnosticGap: rows.length === 0 || capReached || rows.some(row => row.stage === "unclassified") ||
            Object.values(discarded).some(count => count > 0),
          capReached, discarded: Object.freeze({ ...discarded }),
        });
        line = "";
      }
      return finalized;
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.env.GOATCITADEL_VERIFY_EXECUTION_DIAGNOSTICS !== "true" || process.env.GATEWAY_HOST !== "127.0.0.1") {
    throw new Error("Execution diagnostic fixture requires an explicit isolated loopback test run.");
  }
  const { RemoteWorkerAssignmentExecutionProtocolService } = await import("../../dist/services/remote-worker-assignment-execution-protocol-service.js");
  const { readExecutionRejectionDiagnostic } = await import("../../dist/services/remote-worker-assignment-execution-validators.js");
  const original = RemoteWorkerAssignmentExecutionProtocolService.prototype.execute;
  RemoteWorkerAssignmentExecutionProtocolService.prototype.execute = observeExecutionRejections(original,
    readExecutionRejectionDiagnostic, line => process.stdout.write(`${line}\n`));
  await import("../../dist/main.js");
}
