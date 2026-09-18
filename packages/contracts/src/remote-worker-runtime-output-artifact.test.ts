import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { nativeChatOutputContextFixture } from "./remote-worker-native-chat-context-test-fixture.js";
import { remoteWorkerRuntimeOutputEvidenceSha256 } from "./remote-worker-runtime-output.js";
import { normalizeRemoteWorkerRuntimeOutputArtifact, serializeRemoteWorkerRuntimeOutputArtifact,
  REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA } from "./remote-worker-runtime-output-artifact.js";

function fixture() {
  const context = nativeChatOutputContextFixture();
  if (context.schemaVersion !== "goatcitadel.remote-worker-native-chat-context.v2" || !context.recorded) throw new Error("Fixture requires output");
  return { schemaVersion: REMOTE_WORKER_RUNTIME_OUTPUT_ARTIFACT_SCHEMA, registryWorkspaceId: "workspace-a", assignmentId: "assignment-a",
    assignmentGeneration: 1, expectation: context.recorded.expectation, resultReceipt: context.recorded.receipt,
    outcome: context.recorded.outcome, output: context.output, evidenceSha256: remoteWorkerRuntimeOutputEvidenceSha256(context.output),
    recordedLeaseRevision: context.recorded.receipt.leaseRevision, recordedAt: context.recorded.receipt.recordedAt };
}

describe("native output evidence artifact", () => {
  it("downloads canonical evidence bytes with an independently reproducible content digest", () => {
    const artifact = serializeRemoteWorkerRuntimeOutputArtifact(fixture());
    expect(JSON.parse(artifact.content)).toEqual(artifact.document);
    expect(artifact.byteLength).toBe(Buffer.byteLength(artifact.content));
    expect(artifact.sha256).toBe(createHash("sha256").update(artifact.content).digest("hex"));
    expect(artifact.fileName).toBe(`native-output-${artifact.document.evidenceSha256}.json`);
    expect(artifact.document.output.streams.stdout.text).toBe("useful native output\n");
  });

  it.each([
    { assignmentGeneration: 0 }, { assignmentGeneration: 2147483648 }, { evidenceSha256: "ab".repeat(32) },
    { recordedLeaseRevision: 0 }, { recordedAt: "2000-01-01T00:00:00.000Z" }, { extra: true },
  ])("rejects invalid or changed retained bindings %j", patch => {
    expect(() => normalizeRemoteWorkerRuntimeOutputArtifact({ ...fixture(), ...patch })).toThrow();
  });

  it("rejects substituted result bytes and accessor fields without invoking getters", () => {
    const input = fixture();
    expect(() => normalizeRemoteWorkerRuntimeOutputArtifact({ ...input, output: { ...input.output, resultSha256: "ab".repeat(32) } })).toThrow();
    let read = false;
    Object.defineProperty(input, "output", { enumerable: true, get() { read = true; throw new Error("getter invoked"); } });
    expect(() => normalizeRemoteWorkerRuntimeOutputArtifact(input)).toThrow();
    expect(read).toBe(false);
  });
});
