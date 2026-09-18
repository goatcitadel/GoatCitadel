import { runtimeResultPagesFixture } from "./remote-worker-runtime-result-pages-test-fixture.js";
import { readRemoteWorkerRuntimeResult } from "./remote-worker-runtime-result.js";
import { projectRemoteWorkerRuntimeOutcome } from "./remote-worker-runtime-outcome.js";
import { normalizeRemoteWorkerNativeContinuation } from "./remote-worker-native-continuation.js";
import { normalizeRemoteWorkerNativeChatContext } from "./remote-worker-native-chat-context.js";
import { REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA } from "./remote-worker-runtime-output.js";
import { sha256Hex } from "./sha256.js";

export function nativeChatContextFixture() {
  const f = runtimeResultPagesFixture(2);
  const continuation = normalizeRemoteWorkerNativeContinuation({ schemaVersion: "goatcitadel.remote-worker-native-continuation.v1",
    assignmentGeneration: 1, resumeSha256: "11".repeat(32), approvalId: "approval", approvalSha256: "22".repeat(32),
    nativeRuntimeBindingSha256: "33".repeat(32), decision: "approved" });
  return normalizeRemoteWorkerNativeChatContext({ schemaVersion: "goatcitadel.remote-worker-native-chat-context.v1", continuation,
    recorded: { expectation: f.expectation, receipt: f.response(null, true).record!,
      outcome: projectRemoteWorkerRuntimeOutcome(readRemoteWorkerRuntimeResult(f.resultHex, f.expectation, f.history)) } });
}

/** Model-context fixture; real result byte counts are tested by storage fixtures. */
export function nativeChatOutputContextFixture(text = "useful native output\n") {
  const base = nativeChatContextFixture(), recorded = base.recorded!;
  const bytes = new TextEncoder().encode(text).length;
  return normalizeRemoteWorkerNativeChatContext({ ...base, schemaVersion: "goatcitadel.remote-worker-native-chat-context.v2",
    recorded: { ...recorded, outcome: { ...recorded.outcome, stdoutBytes: bytes } },
    output: { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_SCHEMA, nonce: recorded.expectation.nonce, requestSha256: recorded.expectation.requestSha256,
      resultSha256: recorded.receipt.resultSha256, streams: {
        stdout: { bytes, sha256: sha256Hex(text), text, truncated: false, provenance: "native_stream_local_diagnostic" },
        stderr: { bytes: 0, sha256: sha256Hex(""), text: "", truncated: false, provenance: "native_stream_local_diagnostic" },
      } } });
}
