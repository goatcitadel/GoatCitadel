import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerAssignmentRuntime } from "@goatcitadel/contracts";
import { fetchNativeFileList, downloadNativeFile } from "@goatcitadel/mission-control-shared/api/remote-worker-native-files";
import { NativeFileDownloads } from "./NativeFileDownloads";
vi.mock("@goatcitadel/mission-control-shared/api/remote-worker-native-files", () => ({ fetchNativeFileList: vi.fn(), downloadNativeFile: vi.fn() }));
const nonce = "11".repeat(32), scope = { registryWorkspaceId: "workspace", assignmentId: "assignment", assignmentGeneration: 2, nonce };
const file = { fileIndex: 0, logicalPath: "out/report.txt", byteCount: 3, sha256: "22".repeat(32) };
const runtime = { workspaceId: "workspace", assignmentId: "assignment", assignmentGeneration: 2,
  artifactAndEffects: { value: { nativeFileArtifacts: { nonces: [nonce], truncated: false } } } } as unknown as RemoteWorkerAssignmentRuntime;
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("generated file controls", () => {
  it("loads filenames on demand and downloads without rendering their contents", async () => {
    vi.mocked(fetchNativeFileList).mockResolvedValue({ ...scope, receiptSha256: "33".repeat(32), files: [file] });
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, body: { append: vi.fn() } }); vi.stubGlobal("window", { setTimeout: (fn: () => void) => fn() });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:native"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.mocked(downloadNativeFile).mockResolvedValue({ blob: new Blob(["<script>private</script>"]), fileName: "native-fixed.bin" });
    await act(async () => { renderer = create(<NativeFileDownloads runtime={runtime} />); }); expect(fetchNativeFileList).not.toHaveBeenCalled();
    await act(async () => renderer!.root.findByType("button").props.onClick()); expect(fetchNativeFileList).toHaveBeenCalledWith(scope);
    expect(JSON.stringify(renderer!.toJSON())).toContain("out/report.txt");
    await act(async () => renderer!.root.findByType("button").props.onClick()); expect(downloadNativeFile).toHaveBeenCalledWith(scope, file);
    expect(anchor.click).toHaveBeenCalledOnce(); expect(anchor.download).toBe("native-fixed.bin"); expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("private");
  });
  it("shows a retryable bounded failure without leaking server errors", async () => {
    vi.mocked(fetchNativeFileList).mockRejectedValue(new Error("private-credential"));
    await act(async () => { renderer = create(<NativeFileDownloads runtime={runtime} />); });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("could not be verified");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("private-credential"); expect(renderer!.root.findByType("button").props.disabled).toBe(false);
  });
});
