import { createHash } from "node:crypto";
import {
  canonicalJsonString, normalizeRemoteWorkerCellProvisioningExchange,
  normalizeRemoteWorkerRuntimeResultExpectation, redactSecretText,
  REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, REMOTE_WORKER_RUNTIME_OUTPUT_TEXT_MAX_BYTES,
  verifyRemoteWorkerRuntimeOutputEvidence, type RemoteWorkerRuntimeResultExpectation,
  normalizeRemoteWorkerNativeFileExportSelection, readRemoteWorkerNativeFileContent, type RemoteWorkerNativeFileExportSelection,
} from "@goatcitadel/contracts";
import type { WorkerNativeContinuationOwner } from "./worker-native-continuation.js";
import { requireWorkerProtectedKeyOwner, type WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import { createWindowsWorkerNativeContinuation } from "./worker-windows-native-continuation.js";
import { retainWorkerRuntimeOutput } from "./worker-runtime-output-client.js";
import type { WindowsRuntimeParentSessionOwner } from "./worker-windows-runtime-parent-session.js";

const DIAGNOSTIC_BYTES = REMOTE_WORKER_RUNTIME_OUTPUT_TEXT_MAX_BYTES;
const refused = () => new Error("Installed native runtime policy lost its protected assignment binding.");

/** Only protected startup supplies this owner. Native launch remains separately
 * admitted by the Gateway and installed controller; foreground PEM workers do
 * not gain a native execution fallback. The unattended service has no stdin. */
export function createWindowsInstalledNativeRuntime(protectedKeys: WorkerProtectedKeyOwner): WorkerNativeContinuationOwner {
  const startupKeys = requireWorkerProtectedKeyOwner(protectedKeys.reference, protectedKeys);
  const requests = new WeakMap<AbortSignal, RemoteWorkerRuntimeResultExpectation>();
  const runtime = createWindowsWorkerNativeContinuation(async input => {
    const signal = input.signal ?? new AbortController().signal;
    const check = (callSignal: AbortSignal) => {
      signal.throwIfAborted(); callSignal.throwIfAborted();
      const reference = input.context.credential.protectedKey;
      if (!reference || input.context.credential.registryWorkspaceId !== input.lease.registryWorkspaceId ||
          !Number.isFinite(input.owner.remainingLeaseMs()) || input.owner.remainingLeaseMs() <= 0) throw refused();
      requireWorkerProtectedKeyOwner(reference, startupKeys);
      requireWorkerProtectedKeyOwner(reference, input.context.protectedKeys);
    };
    let binding: string | undefined;
    const authorizedFiles = new Map<string, RemoteWorkerNativeFileExportSelection>();
    let filesConsumed = false;
    const bind: WindowsRuntimeParentSessionOwner["authorizeRetention"] = async (expected, history, callSignal) => {
      check(callSignal);
      const request = normalizeRemoteWorkerRuntimeResultExpectation(expected);
      const retained = normalizeRemoteWorkerCellProvisioningExchange(history);
      if (retained.registryWorkspaceId !== input.lease.registryWorkspaceId || retained.assignmentId !== input.lease.assignmentId ||
          retained.assignmentGeneration !== input.lease.assignmentGeneration || retained.leaseRevision < input.lease.leaseRevision) throw refused();
      const identity = canonicalJsonString({ request, retained });
      if (binding !== undefined && binding !== identity) throw refused();
      binding = identity;
      requests.set(signal, request);
    };
    const streams = { stdout: capture(), stderr: capture() };
    const discard = () => { for (const stream of Object.values(streams)) stream.bytes.fill(0); };
    signal.addEventListener("abort", discard, { once: true });
    const owner: Omit<WindowsRuntimeParentSessionOwner, "retain"> = {
      signal,
      // The request's native wall/CPU/memory/output limits remain authoritative.
      timeoutMs: 86_400_000,
      authorizePeer: async callSignal => { check(callSignal); },
      authorizeRuntime: async (expected, history, _ordinal, callSignal) => bind(expected, history, callSignal),
      authorizeDelivery: async (expected, history, _ordinal, callSignal) => bind(expected, history, callSignal),
      authorizeRetention: bind,
      authorizeFile: async (expected, history, selected, callSignal) => {
        await bind(expected, history, callSignal);
        const selection = normalizeRemoteWorkerNativeFileExportSelection(selected);
        if (filesConsumed || selection.registryWorkspaceId !== input.lease.registryWorkspaceId || selection.assignmentId !== input.lease.assignmentId ||
            selection.assignmentGeneration !== input.lease.assignmentGeneration || selection.nonce !== expected.nonce || selection.requestSha256 !== expected.requestSha256)
          throw refused();
        const previous = authorizedFiles.get(selection.logicalPath);
        if (previous && canonicalJsonString(previous) !== canonicalJsonString(selection)) throw refused();
        authorizedFiles.set(selection.logicalPath, selection);
        if (authorizedFiles.size > 64) throw refused();
      },
      // Startup wraps this local custody check with exact admitted-plan checks,
      // fresh Gateway disclosure and complete-batch transfer/settlement.
      consumeFiles: async (files, callSignal) => {
        check(callSignal);
        if (filesConsumed || !binding || !Array.isArray(files) || files.length === 0 || files.length !== authorizedFiles.size) throw refused();
        const seen = new Set<string>();
        for (const file of files) {
          const selection = normalizeRemoteWorkerNativeFileExportSelection(file.selection), authorized = authorizedFiles.get(selection.logicalPath);
          if (!authorized || seen.has(selection.logicalPath) || canonicalJsonString(authorized) !== canonicalJsonString(selection) ||
              !Buffer.isBuffer(file.record) || file.record.length !== 200 + selection.logicalFileBytes) throw refused();
          readRemoteWorkerNativeFileContent(file.record.toString("hex"), selection); seen.add(selection.logicalPath);
        }
        check(callSignal); filesConsumed = true;
      },
      readInput: async (_maximum, callSignal) => { check(callSignal); return "eof"; },
      authorizeInput: async (expected, history, frame, callSignal) => {
        await bind(expected, history, callSignal);
        if (!frame.eof || frame.bytes.length !== 0 || frame.total !== 0) throw refused();
      },
      consumeOutput: async (expected, history, name, frame, callSignal) => {
        await bind(expected, history, callSignal);
        const stream = streams[name];
        if (!stream || stream.ended || !Buffer.isBuffer(frame.bytes) || frame.sequence !== stream.sequence + 1 ||
            frame.total !== stream.total + frame.bytes.length ||
            frame.total + streams[name === "stdout" ? "stderr" : "stdout"].total > expected.maxOutputBytes) throw refused();
        stream.sequence = frame.sequence; stream.total = frame.total; stream.hash.update(frame.bytes);
        const count = Math.min(frame.bytes.length, stream.bytes.length - stream.captured);
        frame.bytes.copy(stream.bytes, stream.captured, 0, count); stream.captured += count;
        if (!frame.eof) return;
        stream.ended = true;
        // Redact after joining frames, so splitting a secret across frames cannot
        // bypass the shared redactor. A truncated last line is omitted entirely.
        const captured = stream.bytes.subarray(0, stream.captured);
        const truncated = stream.total > stream.captured;
        const complete = truncated ? captured.subarray(0, Math.max(0, captured.lastIndexOf(10) + 1)) : captured;
        const redacted = redactSecretText(complete.toString("utf8"), {
          env: { WORKER_LEASE_TOKEN: input.lease.leaseToken }, redactEmailAddresses: true,
        }).value;
        const projection = Buffer.from(redacted, "utf8");
        const text = new TextDecoder().decode(projection.subarray(0, DIAGNOSTIC_BYTES), { stream: true });
        stream.bytes.fill(0);
        const previous = input.observed.nativeOutputDiagnostics as Record<string, unknown> | undefined;
        input.observed.nativeOutputDiagnostics = { ...previous, [name]: {
          bytes: stream.total, sha256: stream.hash.digest("hex"), text, truncated: truncated || projection.length > DIAGNOSTIC_BYTES,
          provenance: "native_stream_local_diagnostic",
        } };
        if (streams.stdout.ended && streams.stderr.ended) signal.removeEventListener("abort", discard);
      },
    };
    return owner;
  });
  return { run: async input => {
    const stop = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
    try {
      const result = await runtime.run({ ...input, signal });
      const streams = input.observed.nativeOutputDiagnostics;
      if (streams !== undefined) {
        const expected = requests.get(signal);
        const receipt = input.observed.nativeRuntimeReceipt as { resultSha256?: unknown } | undefined;
        const evidence = verifyRemoteWorkerRuntimeOutputEvidence({
          schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, nonce: expected?.nonce,
          requestSha256: expected?.requestSha256, resultSha256: receipt?.resultSha256, streams,
        }, expected, receipt, input.observed.nativeRuntimeOutcome);
        input.observed.nativeRuntimeOutput = evidence;
        input.observed.nativeRuntimeOutputReceipt = await retainWorkerRuntimeOutput(input.context, result.lease, evidence, signal);
      }
      return result;
    } finally { requests.delete(signal); stop.abort(); }
  } };
}

function capture() {
  return { bytes: Buffer.alloc(DIAGNOSTIC_BYTES), captured: 0, total: 0, sequence: 0, ended: false, hash: createHash("sha256") };
}
