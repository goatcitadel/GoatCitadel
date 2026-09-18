import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerAssignmentRuntime } from "@goatcitadel/contracts";
import { fetchRemoteWorkerNativeOutputArtifact } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { NativeOutputDownloads } from "./NativeOutputDownloads";

vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({ fetchRemoteWorkerNativeOutputArtifact: vi.fn() }));
const fetchArtifact = vi.mocked(fetchRemoteWorkerNativeOutputArtifact);
function runtime(nonces = ["ab".repeat(32)]) {
  return { workspaceId: "workspace-a", assignmentId: "assignment-a", assignmentGeneration: 2,
    artifactAndEffects: { value: { nativeOutputArtifacts: { nonces, truncated: false } } } } as unknown as RemoteWorkerAssignmentRuntime;
}
let renderer: ReactTestRenderer;
async function mount(value = runtime()) { await act(async () => { renderer = create(<NativeOutputDownloads runtime={value} />); }); }
afterEach(async () => { await act(async () => renderer?.unmount()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("native output downloads", () => {
  it("does not offer a download when no output has been retained", async () => {
    await mount(runtime([]));
    expect(renderer.toJSON()).toBeNull();
    expect(fetchArtifact).not.toHaveBeenCalled();
  });
  it("uses exact operator scope and downloads the validated JSON filename", async () => {
    const anchor = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    const append = vi.fn(), release: (() => void)[] = [];
    vi.stubGlobal("document", { createElement: vi.fn(() => anchor), body: { append } });
    vi.stubGlobal("window", { setTimeout: (callback: () => void) => release.push(callback) });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:retained-output");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    fetchArtifact.mockResolvedValue({ content: '{"output":"hello"}\n', contentType: "application/json", fileName: "native-output-test.json" } as unknown as Awaited<ReturnType<typeof fetchRemoteWorkerNativeOutputArtifact>>);
    await mount();
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.href).toBe("blob:retained-output");
    expect(anchor.download).toBe("native-output-test.json");
    expect(fetchArtifact).toHaveBeenCalledExactlyOnceWith("workspace-a", "assignment-a", 2, "ab".repeat(32));
    expect(anchor.remove).toHaveBeenCalledOnce();
    release.forEach(callback => callback());
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:retained-output");
  });
  it("shows a bounded failure and permits retry without exposing private errors", async () => {
    fetchArtifact.mockRejectedValue(new Error("secret=private-value"));
    await mount();
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("Could not download retained output");
    expect(JSON.stringify(renderer.toJSON())).not.toContain("private-value");
    expect(renderer.root.findByType("button").props.disabled).toBe(false);
  });
});
