// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { HealthOverview } from "./HealthOverview";
const api = vi.hoisted(() => ({
  fetchHealthSummary: vi.fn(),
  fetchLlamaCppStatus: vi.fn(),
  fetchNpuStatus: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchRemoteWorkerRegistry: vi.fn(),
  fetchOnboardingState: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/remote-workers", () => ({
  fetchRemoteWorkerRegistry: api.fetchRemoteWorkerRegistry,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("../../../features/desktop-updates/desktop-update-bridge", () => ({ useDesktopUpdates: () => null }));
vi.mock("../../data/use-operator-inbox", () => ({
  useOperatorInbox: () => ({
    isError: false,
    data: { workspaceId: "workspace-a", items: [], coverage: [{ source: "backup_trust", state: "not_enabled" }] },
  }),
}));
vi.mock("./HealthLocalRuntimeActions", () => ({ HealthLocalRuntimeActions: () => null }));
let container: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  Object.values(api).forEach((mock) => mock.mockReset());
  api.fetchHealthSummary.mockResolvedValue({
    database: { reachable: true, issues: [] },
    daemonStatus: { supported: true, running: true, diagnostics: [] },
    backups: { latest: null },
  });
  api.fetchLlamaCppStatus.mockResolvedValue({ enabled: false });
  api.fetchNpuStatus.mockResolvedValue({ enabled: false });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
  api.fetchRemoteWorkerRegistry.mockResolvedValue({ items: [] });
  api.fetchOnboardingState.mockResolvedValue(onboardingFixture());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.useRealTimers();
});
const tick = (ms: number) =>
  act(async () => {
    await vi.dynamicImportSettled();
    await vi.advanceTimersByTimeAsync(ms);
  });
const render = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <HealthOverview />
      </QueryClientProvider>,
    ),
  );

it("shows current backup existence despite an older Inbox absence observation", async () => {
  api.fetchHealthSummary.mockResolvedValue({
    database: { reachable: true, issues: [] },
    daemonStatus: { supported: true, running: true, diagnostics: [] },
    backups: { latest: { backupId: "B", createdAt: "2026-10-06T12:00:00Z" } },
  });
  await render();
  await tick(10);
  expect(container.textContent).toContain("Not verified yet");
  expect(container.textContent).toContain("A backup record exists");
  expect(container.textContent).not.toContain("No backup yet");
  expect(container.textContent).toContain("· 1 unverified");
  api.fetchHealthSummary.mockRejectedValue(new TypeError("Failed to fetch"));
  await tick(60_010);
  expect(container.textContent).toContain("Last known (Health summary, checked");
  expect(container.textContent).not.toContain("No backup yet");
});

it("says this release has no live remote-worker status, in one statement", async () => {
  await render();
  await tick(10);
  expect(container.textContent).toContain(
    "This release does not include live remote-worker status. The workers page lists saved worker records.",
  );
  expect(container.textContent).not.toContain("Held back from this release.");
});

it("passes the latest backup folder to the card only when the health summary was read", async () => {
  api.fetchHealthSummary.mockResolvedValue({
    database: { reachable: true, issues: [] },
    daemonStatus: { supported: true, running: true, diagnostics: [] },
    backups: { latest: { backupId: "B", createdAt: "2026-10-06T12:00:00Z", outputPath: "/var/backups/B.backup" } },
  });
  await render();
  await tick(10);
  expect(container.textContent).toContain("in this folder:");
  expect(container.textContent).toContain("/var/backups/B.backup");
});

it("says nothing about the backup folder when the health summary could not be read", async () => {
  api.fetchHealthSummary.mockRejectedValue(new TypeError("Failed to fetch"));
  await render();
  await tick(10);
  expect(container.textContent).not.toContain("Latest backup saved");
  expect(container.textContent).not.toContain("installation's backup folder");
});

it.each([401, 403])("uses the full real loader without repeatedly fetching denied NPU %s", async (status) => {
  api.fetchNpuStatus.mockRejectedValue(
    new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/npu/status", status }),
  );
  await render();
  await tick(10);
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(1);
  await tick(125_000);
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(1);
  expect(api.fetchHealthSummary.mock.calls.length).toBeGreaterThan(1);
  expect(container.textContent).toContain("other sources continue refreshing");
  expect(container.textContent).toContain("Settings > Access");
  expect(container.textContent).toContain("unverified");
});

it("reports no confirmed checks when every current owner is unavailable", async () => {
  Object.values(api).forEach((request) => request.mockRejectedValue(new TypeError("Failed to fetch")));
  await render();
  await tick(10);
  expect(container.textContent).toContain("No health checks could be confirmed · 9 unverified");
  expect(container.textContent).not.toContain("All reachable checks report no problems");
  expect(container.textContent).toContain("7 health sources are unavailable");
});

it("shows stale prior observations after actual API transport rejection and clears them on recovery", async () => {
  await render();
  await tick(10);
  expect(container.textContent).toContain("All reachable checks report no problems");
  api.fetchHealthSummary.mockRejectedValue(new TypeError("Failed to fetch"));
  await tick(60_010);
  expect(container.textContent).toContain("Last known: checked");
  expect(container.textContent).toContain("unverified");
  // The current state comes first; the earlier result is its own line, never joined into one sentence.
  const lines = [...container.querySelectorAll("article p")].map((node) => node.textContent ?? "");
  expect(lines).toContain("The health summary could not be read.");
  expect(
    lines.some(
      (line) =>
        line.startsWith("Last known (Health summary, checked ") &&
        line.endsWith("): The health summary is responding."),
    ),
  ).toBe(true);
  expect(lines.some((line) => line.includes("could not be read") && line.includes("is responding"))).toBe(false);
  for (const key of ["llama:", "npu:", "last observed"]) expect(container.textContent).not.toContain(key);
  api.fetchHealthSummary.mockResolvedValue({
    database: { reachable: true, issues: [] },
    daemonStatus: { supported: true, running: true, diagnostics: [] },
    backups: { latest: null },
  });
  await tick(60_010);
  expect(container.textContent).not.toContain("Last known");
  expect(container.textContent).toContain("All reachable checks report no problems");
});

it("keeps focus on Refresh while the health summary reloads (U-GL-047)", async () => {
  await render();
  await tick(10);
  const refresh = [...container.querySelectorAll("button")].find((entry) =>
    entry.textContent?.includes("Refresh system health"),
  );
  if (!refresh) throw new Error("Missing Refresh system health button");
  api.fetchHealthSummary.mockReturnValue(new Promise(() => undefined));
  refresh.focus();
  await act(async () => refresh.click());
  await tick(10);
  expect(refresh.disabled).toBe(false);
  expect(refresh.getAttribute("aria-busy")).toBe("true");
  expect(document.activeElement).toBe(refresh);
});
