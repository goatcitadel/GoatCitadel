import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "./client-core.js";
import { fetchNativeFileList, downloadNativeFile } from "./remote-worker-native-files.js";
vi.mock("./client-core.js", () => ({ request: vi.fn(), buildGatewayUrl: (path: string) => `http://127.0.0.1${path}`, readGatewayAuthHeaders: () => ({ Authorization: "Bearer fixture-operator" }) }));
const scope = { registryWorkspaceId: "workspace", assignmentId: "assignment", assignmentGeneration: 2, nonce: "11".repeat(32) };
const bytes = new Uint8Array([0, 255, 2]), sha256 = createHash("sha256").update(bytes).digest("hex");
const file = { fileIndex: 0, logicalPath: "out/file.txt", byteCount: 3, sha256 };
const list = () => ({ ...scope, receiptSha256: "22".repeat(32), files: [{ ...file }] });
beforeEach(() => vi.resetAllMocks()); afterEach(() => vi.unstubAllGlobals());
describe("operator native file transport", () => {
  it("validates metadata scope and keeps it immutable", async () => {
    vi.mocked(request).mockResolvedValue(list()); const result = await fetchNativeFileList(scope);
    expect(Object.isFrozen(result.files[0])).toBe(true); expect(result).toEqual(list());
  });
  it.each(["scope", "generation", "hash", "index", "oversize", "extra"])("rejects %s metadata", async mode => {
    const value = list();
    if (mode === "scope") value.assignmentId = "foreign";
    if (mode === "generation") value.assignmentGeneration++;
    if (mode === "hash") value.files[0]!.sha256 = "00".repeat(32);
    if (mode === "index") value.files[0]!.fileIndex = 1;
    if (mode === "oversize") value.files[0]!.byteCount = 1048577;
    if (mode === "extra") Object.assign(value, { content: "private" });
    vi.mocked(request).mockResolvedValue(value); await expect(fetchNativeFileList(scope)).rejects.toThrow();
  });
  it("downloads authenticated, bounded, rehashed bytes using an inert filename", async () => {
    const fetcher = vi.fn(async () => new Response(bytes, { headers: { "content-type": "application/octet-stream", "x-content-sha256": sha256 } })); vi.stubGlobal("fetch", fetcher);
    const result = await downloadNativeFile(scope, file); expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(bytes);
    expect(result.fileName).toBe(`native-${scope.nonce.slice(0, 16)}-0.bin`);
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("fileIndex=0"), expect.objectContaining({ headers: { Authorization: "Bearer fixture-operator" } }));
  });
  it.each(["status", "type", "header", "hash", "extra", "short"])("withholds download after %s failure", async mode => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(mode === "extra" ? new Uint8Array(4) : mode === "short" ? new Uint8Array(1) : mode === "hash" ? new Uint8Array(3) : bytes,
      { status: mode === "status" ? 403 : 200, headers: { "content-type": mode === "type" ? "text/html" : "application/octet-stream", "x-content-sha256": mode === "header" ? "ff".repeat(32) : sha256 } })));
    await expect(downloadNativeFile(scope, file)).rejects.toThrow();
  });
});
