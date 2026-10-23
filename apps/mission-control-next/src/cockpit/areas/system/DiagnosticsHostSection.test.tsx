// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DiagnosticsHostSection } from "./DiagnosticsHostSection";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
const api = vi.hoisted(() => ({ fetchHealthSummary: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ fetchHealthSummary: api.fetchHealthSummary }));

const vitals = {
  hostname: "goat-host",
  platform: "win32",
  release: "10.0.26300",
  uptimeSeconds: 7200,
  loadAverage: [0.5, 0.4, 0.3],
  cpuCount: 8,
  memoryTotalBytes: 16 * 1024 ** 3,
  memoryFreeBytes: 4 * 1024 ** 3,
  memoryUsedBytes: 12 * 1024 ** 3,
  processRssBytes: 300 * 1024 ** 2,
  processHeapUsedBytes: 100 * 1024 ** 2,
};
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  preferences.showTechnicalDetails = false;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  client.clear();
});
const render = async () => {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <DiagnosticsHostSection />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(host.textContent).not.toContain("Loading host"));
};
const metric = (term: string) =>
  [...host.querySelectorAll("dt")].find((node) => node.textContent === term)?.nextElementSibling?.textContent;

it("shows host figures and keeps the host name in technical details", async () => {
  api.fetchHealthSummary.mockResolvedValue({ systemVitals: vitals, daemonStatus: { diagnostics: [] } });
  await render();
  expect(host.querySelector("h2")?.textContent).toBe("Host");
  expect(metric("Free memory")).toBe("4.0 GB");
  expect(metric("CPU")).toBe("8 cores");
  expect(host.textContent).not.toContain("goat-host");
});

it("reads a missing figure as Unknown, not zero", async () => {
  api.fetchHealthSummary.mockResolvedValue({
    systemVitals: { ...vitals, memoryFreeBytes: undefined },
    daemonStatus: { diagnostics: [] },
  });
  await render();
  expect(metric("Free memory")).toBe("Unknown");
});

it("lists server checks with their severity", async () => {
  api.fetchHealthSummary.mockResolvedValue({
    systemVitals: vitals,
    daemonStatus: { diagnostics: [{ id: "x", title: "Port busy", detail: "8787 is taken", severity: "critical" }] },
  });
  await render();
  expect(host.textContent).toContain("Port busy");
  expect(host.textContent).toContain("Needs attention");
});

it("says the host could not be read when the health summary fails", async () => {
  api.fetchHealthSummary.mockRejectedValue(new Error("offline"));
  await render();
  expect(host.textContent).toContain("Host figures are unavailable");
});
