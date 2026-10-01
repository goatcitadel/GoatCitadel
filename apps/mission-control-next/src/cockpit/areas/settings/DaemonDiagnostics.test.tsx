// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DaemonDiagnostics } from "./DaemonDiagnostics";
const api = vi.hoisted(() => ({ fetchDaemonStatus: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
let renderer: ReactTestRenderer, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  client.clear();
});
async function mount() {
  await act(async () => {
    renderer = create(
      <QueryClientProvider client={client}>
        <DaemonDiagnostics />
      </QueryClientProvider>,
    );
  });
}
it("shows actual owner diagnostics and manual handoffs without process mutation controls", async () => {
  api.fetchDaemonStatus.mockResolvedValue({
    running: true,
    state: "running",
    pid: 123,
    host: "fixture-host",
    supported: false,
    controllable: false,
    controlMessage: "Process controls require the external owner.",
    diagnostics: [{ id: "ownership", title: "Current process", severity: "pass", detail: "Reported by the Gateway" }],
    repairActions: [
      {
        id: "inspect",
        label: "Inspect ownership",
        description: "Check the launch terminal",
        requiresOwnerProof: true,
        command: "Get-Process -Id 123",
      },
    ],
    controlHandoff: {
      owner: "Launch terminal",
      serviceName: "GoatCitadel Gateway",
      reason: "External lifecycle",
      desktopControl: "Use the desktop host",
      commands: [
        { label: "Inspect process", command: "Get-Process -Id 123", description: "Read-only owner inspection" },
      ],
    },
  });
  await mount();
  await vi.waitFor(() => expect(JSON.stringify(renderer.toJSON())).toContain("fixture-host"));
  expect(renderer.root.findAllByType("button").map((item) => item.children.join(""))).toEqual([
    "Refresh Gateway process",
  ]);
  expect(JSON.stringify(renderer.toJSON())).toContain("never run by this page");
  expect(JSON.stringify(renderer.toJSON())).toContain("Verify process ownership");
});
it("shows unavailable evidence when the canonical read fails", async () => {
  api.fetchDaemonStatus.mockRejectedValue(Error("offline"));
  await mount();
  await vi.waitFor(() => expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(1));
  expect(JSON.stringify(renderer.toJSON())).not.toContain("fixture-host");
});
