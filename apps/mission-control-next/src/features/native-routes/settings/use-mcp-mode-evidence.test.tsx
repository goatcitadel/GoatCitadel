// @vitest-environment happy-dom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMcpModeEvidence } from "./mcp-mode-evidence";
import { manifestFixture, remoteFixture } from "./mcp-mode-evidence.test-support";
import { useMcpModeEvidence } from "./use-mcp-mode-evidence";

const api = vi.hoisted(() => ({ fetchMcpServerModeManifest: vi.fn(), fetchMcpRemotePreview: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let root: Root;
let container: HTMLDivElement;
let view: ReturnType<typeof useMcpModeEvidence>;
function Probe({ scope, enabled }: { scope: string; enabled: boolean }) {
  view = useMcpModeEvidence(scope, enabled);
  return <div>{view.data?.serverMode?.tools[0]?.title ?? "No current snapshot"}</div>;
}
async function render(scope = "a", enabled = true) {
  await act(async () => {
    root.render(
      <StrictMode>
        <Probe scope={scope} enabled={enabled} />
      </StrictMode>,
    );
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.fetchMcpServerModeManifest.mockResolvedValue(manifestFixture());
  api.fetchMcpRemotePreview.mockResolvedValue(remoteFixture());
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("MCP installation evidence", () => {
  it("reads both actual GET owners with the caller signal and keeps independent timestamps", async () => {
    const signal = new AbortController().signal;
    const result = await readMcpModeEvidence(signal);
    expect(api.fetchMcpServerModeManifest).toHaveBeenCalledWith(signal);
    expect(api.fetchMcpRemotePreview).toHaveBeenCalledWith(signal);
    expect(result.issues).toEqual([]);
    expect(result.serverMode?.generatedAt).not.toBe(result.remotePreview?.generatedAt);
  });
  it("preserves available evidence when one endpoint fails, without synthetic zero counts", async () => {
    api.fetchMcpRemotePreview.mockRejectedValue(new Error("offline"));
    const result = await readMcpModeEvidence(new AbortController().signal);
    expect(result.serverMode?.tools).toHaveLength(1);
    expect(result.remotePreview).toBeUndefined();
    expect(result.issues.join(" ")).toContain("offline");
  });
  it.each(["mutation", "duplicate", "count", "missing-context"])("withholds invalid manifest: %s", async (kind) => {
    const manifest = manifestFixture();
    if (kind === "mutation") Object.assign(manifest, { mutationSemantics: "governed_tool_invocation" });
    if (kind === "duplicate") {
      manifest.tools.push(manifest.tools[0]!);
      manifest.summary.exportedToolDescriptors = 2;
    }
    if (kind === "count") manifest.summary.exportedToolDescriptors = 9;
    if (kind === "missing-context") manifest.runtime.callPreview.requiredCallContext = [];
    api.fetchMcpServerModeManifest.mockResolvedValue(manifest);
    const result = await readMcpModeEvidence(new AbortController().signal);
    expect(result.serverMode).toBeUndefined();
    expect(result.remotePreview?.items).toHaveLength(1);
    expect(result.issues).toHaveLength(1);
  });
  it("withholds duplicate remote identities and malformed rows while keeping a valid manifest", async () => {
    for (const items of [[remoteFixture().items[0], remoteFixture().items[0]], [null]]) {
      api.fetchMcpRemotePreview.mockResolvedValue({ ...remoteFixture(), items });
      const result = await readMcpModeEvidence(new AbortController().signal);
      expect(result.remotePreview).toBeUndefined();
      expect(result.serverMode).toBeDefined();
    }
  });
  it("does not read before explicit inspection and supports StrictMode remount", async () => {
    await render("a", false);
    expect(api.fetchMcpServerModeManifest).not.toHaveBeenCalled();
    await render("a", true);
    expect(view.data?.serverMode?.tools).toHaveLength(1);
    expect(view.loading).toBe(false);
  });
  it("clears old evidence during refresh and rejects a late superseded read", async () => {
    await render();
    const first = deferred<ReturnType<typeof manifestFixture>>();
    api.fetchMcpServerModeManifest.mockReturnValueOnce(first.promise);
    let oldRead!: Promise<void>;
    act(() => {
      oldRead = view.refresh();
    });
    expect(view.loading).toBe(true);
    expect(view.data).toBeUndefined();
    expect(container.textContent).toBe("No current snapshot");
    const newer = manifestFixture();
    newer.tools[0]!.title = "Current read";
    api.fetchMcpServerModeManifest.mockResolvedValueOnce(newer);
    await act(async () => {
      await view.refresh();
    });
    await act(async () => {
      first.resolve(manifestFixture());
      await oldRead;
    });
    expect(container.textContent).toBe("Current read");
  });
  it("rejects away-and-back scope reads and aborts on unmount", async () => {
    await render();
    const pending = deferred<ReturnType<typeof manifestFixture>>();
    api.fetchMcpServerModeManifest.mockReturnValueOnce(pending.promise);
    let oldRead!: Promise<void>;
    act(() => {
      oldRead = view.refresh();
    });
    const oldSignal = api.fetchMcpServerModeManifest.mock.calls.at(-1)![0] as AbortSignal;
    await render("b");
    await render("a");
    const latest = view.data;
    await act(async () => {
      pending.resolve(manifestFixture());
      await oldRead;
    });
    expect(view.data).toBe(latest);
    expect(oldSignal.aborted).toBe(true);
    const signal = api.fetchMcpServerModeManifest.mock.calls.at(-1)![0] as AbortSignal;
    act(() => root.unmount());
    expect(signal.aborted).toBe(true);
    root = createRoot(container);
  });
});
