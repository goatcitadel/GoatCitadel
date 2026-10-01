// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  manifestFixture,
  remoteFixture,
} from "../../../features/native-routes/settings/mcp-mode-evidence.test-support";
import { useMcpModeEvidence } from "../../../features/native-routes/settings/use-mcp-mode-evidence";
import { McpPreviewPanels } from "../../../features/native-routes/settings/sections/McpPreviewPanels";
import { McpModeInspection } from "./McpModeInspection";

const api = vi.hoisted(() => ({ fetchMcpServerModeManifest: vi.fn(), fetchMcpRemotePreview: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
let root: Root;
let container: HTMLDivElement;
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network call");
    }),
  );
  api.fetchMcpServerModeManifest.mockResolvedValue(manifestFixture(21));
  api.fetchMcpRemotePreview.mockResolvedValue(remoteFixture(21));
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  expect(globalThis.fetch).not.toHaveBeenCalled();
  container.remove();
  vi.unstubAllGlobals();
});
async function native() {
  await act(async () => {
    root.render(<McpModeInspection workspaceId="selected" onClose={() => {}} />);
  });
}
function Classic() {
  const evidence = useMcpModeEvidence("selected", true);
  return <McpPreviewPanels evidence={evidence} />;
}

it("bounds native descriptors and remote records, labels installation scope, and provides inspection only", async () => {
  await native();
  expect(container.textContent).toContain("not filtered to the selected workspace");
  expect(container.textContent).toContain("not a connection check");
  expect(container.querySelectorAll('ul[aria-label="MCP server-mode descriptors"] > li')).toHaveLength(20);
  expect(container.querySelectorAll('ul[aria-label="Remote MCP preview records"] > li')).toHaveLength(20);
  await act(async () => {
    button("Show more descriptors").click();
    button("Show more preview records").click();
  });
  expect(container.querySelectorAll('ul[aria-label="MCP server-mode descriptors"] > li')).toHaveLength(21);
  expect(container.querySelectorAll('ul[aria-label="Remote MCP preview records"] > li')).toHaveLength(21);
  const filter = container.querySelector("select")!;
  await act(async () => {
    filter.value = "server";
    filter.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("No remote records match this snapshot view.");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual(["Refresh MCP previews"]);
  expect(api.fetchMcpServerModeManifest.mock.calls[0]).toHaveLength(1);
  expect(api.fetchMcpServerModeManifest.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
});

it("hides the previous snapshot during refresh and renders partial failure without zero evidence", async () => {
  await native();
  let resolve!: (value: ReturnType<typeof manifestFixture>) => void;
  api.fetchMcpServerModeManifest.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  api.fetchMcpRemotePreview.mockRejectedValueOnce(new Error("Transport projection unavailable"));
  await act(async () => {
    button("Refresh MCP previews").click();
  });
  expect(container.textContent).not.toContain("Fixture descriptor 0");
  expect(container.textContent).not.toContain("Remote template 0");
  expect(button("Refresh MCP previews").disabled).toBe(true);
  await act(async () => {
    resolve(manifestFixture());
  });
  expect(container.textContent).toContain("Fixture descriptor 0");
  expect(container.textContent).toContain("Remote MCP evidence is unavailable.");
  expect(container.textContent).not.toContain("0 catalog templates");
});

it("uses the same validated evidence in classic and withholds malformed remote summary", async () => {
  api.fetchMcpRemotePreview.mockResolvedValue({ ...remoteFixture(), summary: undefined });
  await act(async () => {
    root.render(<Classic />);
  });
  expect(container.textContent).toContain("Installation-wide Gateway projections");
  expect(container.textContent).toContain("Fixture descriptor 0");
  expect(container.textContent).toContain("Remote preview is incomplete or inconsistent");
  expect(container.textContent).toContain("Remote MCP evidence is unavailable.");
  expect(container.textContent).not.toContain("Remote template 0");
});
