import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteWorkerArtifactWorkspaceShard } from "@goatcitadel/contracts";
import { RemoteWorkerArtifactStore, RemoteWorkerArtifactStoreError } from "./remote-worker-artifact-store.js";

const D = (value: string): string => createHash("sha256").update(value).digest("hex");
const controller = new AbortController();

let rootDir: string;

beforeEach(() => {
  rootDir = path.join(os.tmpdir(), `hx506-store-${randomUUID()}`);
  fs.mkdirSync(rootDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

function bytesFor(value: string): { bytes: Uint8Array; sha: string } {
  const bytes = new TextEncoder().encode(value);
  return { bytes, sha: createHash("sha256").update(bytes).digest("hex") };
}

describe("HX-506 artifact store (CAS reuse)", () => {
  it("installs a blob at a server-derived CAS address and reads it back verified", async () => {
    const store = new RemoteWorkerArtifactStore(rootDir);
    const { bytes, sha } = bytesFor("artifact-content");
    const installed = await store.installBlob({
      executionWorkspaceId: "default",
      blobSha256: sha,
      bytes,
      signal: controller.signal,
    });
    expect(installed.reused).toBe(false);
    const shard = remoteWorkerArtifactWorkspaceShard("default");
    expect(installed.physicalRelPath).toBe(`remote-workers/artifacts/${shard}/sha256/${sha.slice(0, 2)}/${sha}`);
    // The physical path never contains a worker logical path.
    expect(installed.physicalRelPath).not.toContain("content");
    const readBack = await store.readBlob({
      executionWorkspaceId: "default",
      blobSha256: sha,
      signal: controller.signal,
    });
    expect(new TextDecoder().decode(readBack)).toBe("artifact-content");
  });

  it("converges on the same hash without replacing the immutable object", async () => {
    const store = new RemoteWorkerArtifactStore(rootDir);
    const { bytes, sha } = bytesFor("same-content");
    const first = await store.installBlob({
      executionWorkspaceId: "default",
      blobSha256: sha,
      bytes,
      signal: controller.signal,
    });
    const second = await store.installBlob({
      executionWorkspaceId: "default",
      blobSha256: sha,
      bytes,
      signal: controller.signal,
    });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.physicalRelPath).toBe(first.physicalRelPath);
  });

  it("rejects bytes whose digest does not match the immutable address", async () => {
    const store = new RemoteWorkerArtifactStore(rootDir);
    const { bytes } = bytesFor("real");
    await expect(
      store.installBlob({ executionWorkspaceId: "default", blobSha256: D("wrong"), bytes, signal: controller.signal }),
    ).rejects.toBeInstanceOf(RemoteWorkerArtifactStoreError);
  });

  it("reports not_found for an uninstalled blob", async () => {
    const store = new RemoteWorkerArtifactStore(rootDir);
    await expect(
      store.readBlob({ executionWorkspaceId: "default", blobSha256: D("missing"), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects an address outside the artifact namespace", () => {
    const store = new RemoteWorkerArtifactStore(rootDir);
    expect(() => store.resolvePath("../escape")).toThrow(RemoteWorkerArtifactStoreError);
    expect(() => store.resolvePath("other-namespace/x")).toThrow(RemoteWorkerArtifactStoreError);
  });
});
