import { describe, expect, it, vi } from "vitest";
import { normalizeRemoteWorkerNativeFileDisclosure as normalize, remoteWorkerNativeFileDisclosureSha256 as digest,
  remoteWorkerNativeFileStagingSha256 as planDigest, REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA } from "./remote-worker-native-file-disclosure.js";

const plan = () => ({ paths: ["outputs/result.txt"], maximumFileBytes: 1024, maximumTotalBytes: 2048 });
const fixture = () => ({ schemaVersion: REMOTE_WORKER_NATIVE_FILE_DISCLOSURE_SCHEMA, destination: "gateway_artifacts",
  registryWorkspaceId: "default", assignmentId: "assignment-a", assignmentGeneration: 1, nonce: "11".repeat(32),
  requestSha256: "22".repeat(32), executionWorkspaceId: "workspace-a", pathJailSha256: "33".repeat(32), fileStagingSha256: planDigest(plan()) });

describe("native artifact disclosure approval scope", () => {
  it("freezes exact scope and retains only the file-plan digest", () => {
    const source = fixture(), value = normalize(source); source.executionWorkspaceId = "changed";
    expect(value.executionWorkspaceId).toBe("workspace-a"); expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify(value)).not.toContain("result.txt"); expect(digest(value)).toHaveLength(64);
  });
  it.each(["registryWorkspaceId", "assignmentId", "assignmentGeneration", "nonce", "requestSha256", "executionWorkspaceId", "pathJailSha256", "fileStagingSha256"] as const)(
    "binds the exact %s into the disclosure identity", field => {
      const value = fixture(), changed = { ...value, [field]: field === "assignmentGeneration" ? 2 : field.endsWith("Sha256") || field === "nonce" ? "44".repeat(32) : "other" };
      expect(digest(changed)).not.toBe(digest(value));
    });
  it("binds path order and every byte ceiling", () => {
    const p = { ...plan(), paths: ["a.txt", "b.txt"] }, expected = planDigest(p);
    for (const changed of [{ ...p, paths: ["b.txt", "a.txt"] }, { ...p, maximumFileBytes: 512 }, { ...p, maximumTotalBytes: 4096 }])
      expect(planDigest(changed)).not.toBe(expected);
  });
  it("rejects other destinations, unknown fields, malformed hashes and accessors", () => {
    for (const changed of [null, { ...fixture(), destination: "model_context" }, { ...fixture(), destination: "telegram" },
      { ...fixture(), pathJailSha256: "0".repeat(64) }, { ...fixture(), assignmentGeneration: 0 }, { ...fixture(), extra: true }])
      expect(() => normalize(changed)).toThrow();
    const value = fixture(), get = vi.fn(); Object.defineProperty(value, "executionWorkspaceId", { get, enumerable: true });
    expect(() => normalize(value)).toThrow(); expect(get).not.toHaveBeenCalled();
  });
});
