// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { HealthOverview } from "./HealthOverview";
const api = vi.hoisted(() => ({ fetchHealthSummary: vi.fn(), fetchLlamaCppStatus: vi.fn(), fetchNpuStatus: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchChannelRuntimeStatus: vi.fn(), fetchRemoteWorkerRegistry: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({ fetchRemoteWorkerRegistry: api.fetchRemoteWorkerRegistry }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }) }));
vi.mock("../../../features/desktop-updates/desktop-update-bridge", () => ({ useDesktopUpdates: () => null }));
vi.mock("../../data/use-operator-inbox", () => ({ useOperatorInbox: () => ({ isError: false, data: { workspaceId: "workspace-a", items: [], coverage: [{ source: "backup_trust", state: "not_enabled" }] } }) }));
vi.mock("./HealthLocalRuntimeActions", () => ({ HealthLocalRuntimeActions: () => null }));
let container: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers(); Object.values(api).forEach(mock => mock.mockReset());
  api.fetchHealthSummary.mockResolvedValue({ database: { reachable: true, issues: [] }, daemonStatus: { supported: true, running: true, diagnostics: [] }, backups: { latest: null } });
  api.fetchLlamaCppStatus.mockResolvedValue({ enabled: false }); api.fetchNpuStatus.mockResolvedValue({ enabled: false });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [] }); api.fetchRemoteWorkerRegistry.mockResolvedValue({ items: [] });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); vi.useRealTimers(); });
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const render = () => act(async () => root.render(<QueryClientProvider client={client}><HealthOverview /></QueryClientProvider>));

it("shows current backup existence despite an older Inbox absence observation", async () => {
  api.fetchHealthSummary.mockResolvedValue({ database: { reachable: true, issues: [] }, daemonStatus: { supported: true, running: true, diagnostics: [] }, backups: { latest: { backupId: "B", createdAt: "2026-10-06T12:00:00Z" } } });
  await render(); await tick(10);
  expect(container.textContent).toContain("Not verified yet");
  expect(container.textContent).toContain("A backup record exists");
  expect(container.textContent).not.toContain("No backup yet");
  expect(container.textContent).toContain("Checks awaiting evidence");
  api.fetchHealthSummary.mockRejectedValue(new TypeError("Failed to fetch")); await tick(60_010);
  expect(container.textContent).toContain("Retained observation is stale");
  expect(container.textContent).not.toContain("No backup yet");
});

it.each([401, 403])("uses the full real loader without repeatedly fetching denied NPU %s", async (status) => {
  api.fetchNpuStatus.mockRejectedValue(new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/npu/status", status }));
  await render(); await tick(10);
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(1);
  await tick(125_000);
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(1);
  expect(api.fetchHealthSummary.mock.calls.length).toBeGreaterThan(1);
  expect(container.textContent).toContain("other sources continue refreshing");
  expect(container.textContent).toContain("Settings > Access");
  expect(container.textContent).toContain("cannot be verified");
});

it("shows stale prior observations after actual API transport rejection and clears them on recovery", async () => {
  await render(); await tick(10);
  expect(container.textContent).toContain("Available checks report no problems");
  api.fetchHealthSummary.mockRejectedValue(new TypeError("Failed to fetch"));
  await tick(60_010);
  expect(container.textContent).toContain("Retained observation is stale");
  expect(container.textContent).toContain("last observed");
  expect(container.textContent).toContain("cannot be verified");
  expect(container.textContent).toContain("The health summary is responding");
  api.fetchHealthSummary.mockResolvedValue({ database: { reachable: true, issues: [] }, daemonStatus: { supported: true, running: true, diagnostics: [] }, backups: { latest: null } });
  await tick(60_010);
  expect(container.textContent).not.toContain("Retained observation is stale");
  expect(container.textContent).toContain("Available checks report no problems");
});
