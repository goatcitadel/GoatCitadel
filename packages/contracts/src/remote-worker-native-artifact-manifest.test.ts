import { describe, expect, it } from "vitest";
import { createRemoteWorkerNativeArtifactManifest, remoteWorkerNativeArtifactVerifierSha256 } from "./remote-worker-native-artifact-manifest.js";
import { nativeArtifactFixture } from "./remote-worker-native-artifact-test-fixture.js";

describe("server-owned native artifact manifests", () => {
  it.each(["", "native-result"])("derives exact receipt paths, bytes and verification for %j", text => {
    const f = nativeArtifactFixture(text), manifest = createRemoteWorkerNativeArtifactManifest(f);
    expect(manifest.totalBytes).toBe(f.bytes.length); expect(manifest.workerClaimIds).toEqual([]);
    expect(manifest.requiredVerifierProfileSha256).toBe(remoteWorkerNativeArtifactVerifierSha256(f.receipt));
    expect(manifest.entries[0]).toMatchObject({ logicalPath: "out/report.txt", blobSha256: f.receipt.files[0]!.contentSha256, mimeType: "application/octet-stream" });
    expect(Object.isFrozen(manifest)).toBe(true);
  });
  it.each(["registryWorkspaceId", "executionWorkspaceId", "assignmentId", "assignmentGeneration"])("refuses foreign %s", field => {
    const f = nativeArtifactFixture(); Object.assign(f.identity, { [field]: field === "assignmentGeneration" ? 2 : "foreign" });
    expect(() => createRemoteWorkerNativeArtifactManifest(f)).toThrow();
  });
  it("binds content changes into the server-derived verifier identity", () => {
    expect(remoteWorkerNativeArtifactVerifierSha256(nativeArtifactFixture("first").receipt))
      .not.toBe(remoteWorkerNativeArtifactVerifierSha256(nativeArtifactFixture("other").receipt));
  });
});
