// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ConnectorsTab } from "./ConnectorsTab";

const api = vi.hoisted(() => ({ fetchCapabilityConnectors: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-connectors", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
}));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ search: "", navigate: vi.fn() }) }));
vi.mock("../../../app/inspector", () => ({ useInspector: () => ({ open: vi.fn(), content: null }) }));
vi.mock("./use-connector-install", async (original) => ({
  ...(await original<object>()),
  useConnectorInstallStatus: () => ({ phase: "idle" }),
  useRecoveredInstalls: vi.fn(),
}));

it("the Advanced setup link is at least 24 px tall (U-GL-006)", async () => {
  api.fetchCapabilityConnectors.mockResolvedValue({
    workspaceId: "ws-1",
    items: [],
    issues: [],
    approvalReliefAvailable: true,
    generatedAt: "2026-10-25T10:00:00.000Z",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ConnectorsTab />
      </QueryClientProvider>,
    ),
  );
  try {
    await vi.waitFor(() => {
      const link = [...container.querySelectorAll("a")].find((entry) => entry.textContent === "Advanced setup");
      expect(link?.className).toContain("cockpit-target");
    });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
