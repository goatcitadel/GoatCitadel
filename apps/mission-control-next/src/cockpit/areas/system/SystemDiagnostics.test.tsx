// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { SystemDiagnostics } from "./SystemDiagnostics";

const preferences = vi.hoisted(() => ({ activeWorkspaceId: "ws-1", showTechnicalDetails: false }));
const api = vi.hoisted(() => ({ fetchDevDiagnostics: vi.fn(), fetchDaemonLogs: vi.fn(), fetchOperatorInbox: vi.fn() }));
vi.mock("../settings/FirstRunVerification", () => ({ FirstRunVerification: () => <p>Existing setup verification owner</p> }));
vi.mock("./RuntimeAuthorityMap", () => ({
  RuntimeAuthorityMap: ({ workspaceId }: { workspaceId: string }) => <p>Runtime authority owner {workspaceId}</p>,
}));
vi.mock("@goatcitadel/mission-control-shared/api/diagnostics", () => ({ fetchDevDiagnostics: api.fetchDevDiagnostics }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({ fetchDaemonLogs: api.fetchDaemonLogs }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: api.fetchOperatorInbox }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => preferences }));

describe("cockpit Diagnostics", () => {
  it("keeps scoped recovery visible when daemon logs fail", async () => {
    api.fetchDevDiagnostics.mockResolvedValue({ items: [{ id: "event-1", level: "warn", category: "api",
      event: "request_failed", timestamp: "2026-09-28T00:00:00.000Z", message: "Request timed out" }] });
    api.fetchDaemonLogs.mockRejectedValue(new Error("Logs offline"));
    api.fetchOperatorInbox.mockResolvedValue({ workspaceId: "ws-1", items: [
      { id: "letter-1", kind: "dead_letter", title: "Run needs recovery", summary: "The run stopped",
        source: { workspaceId: "ws-1", runId: "run-1" }, href: "/ops/run-1" },
    ], coverage: [{ source: "dead_letters", state: "partial", detail: "Only the first page was read." }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><SystemDiagnostics /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Logs unavailable"));
      expect(api.fetchOperatorInbox).toHaveBeenCalledWith("ws-1");
      expect(container.textContent).toContain("1 known unresolved dead letter");
      expect(container.textContent).toContain("Only the first page was read");
      expect(container.querySelector<HTMLAnchorElement>('a[href="/work/runs/run-1?shell=cockpit"]')).not.toBeNull();
      expect(container.textContent).toContain("Request timed out");
      expect(container.textContent).not.toContain('"id": "event-1"');
      preferences.showTechnicalDetails = true;
      await act(async () => root.render(<QueryClientProvider client={client}><SystemDiagnostics /></QueryClientProvider>));
      expect(container.querySelector('summary')?.textContent).toBe("Event technical details");
      expect(container.textContent).toContain('"id": "event-1"');
      expect(container.textContent).toContain("Run needs recovery");
      expect(container.textContent).toContain("Request timed out");
      preferences.showTechnicalDetails = false;
      expect(container.textContent).toContain("Existing setup verification owner");
      expect(container.textContent).toContain("Runtime authority owner ws-1");
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
    }
  });

  it("does not show recovery records from a mixed-workspace projection", async () => {
    api.fetchDevDiagnostics.mockResolvedValue({ items: [] });
    api.fetchDaemonLogs.mockResolvedValue({ items: [] });
    api.fetchOperatorInbox.mockResolvedValue({ workspaceId: "ws-1", items: [
      { id: "foreign", kind: "dead_letter", title: "Other workspace", summary: "Do not show",
        source: { workspaceId: "ws-2", runId: "run-2" }, href: "/ops/run-2" },
    ], coverage: [{ source: "dead_letters", state: "current" }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><SystemDiagnostics /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Recovery projection contains records outside"));
      expect(container.textContent).not.toContain("Other workspace");
      expect(container.querySelector('a[href="/work/runs/run-2?shell=cockpit"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
    }
  });

  it("puts warnings and errors first and bounds the routine event list", async () => {
    const events = Array.from({ length: 25 }, (_, index) => ({ id: `debug-${index}`, level: "debug", category: "api",
      event: "request_start", timestamp: "2026-09-28T00:00:00.000Z", message: `Routine request ${index}` }));
    api.fetchDevDiagnostics.mockResolvedValue({ items: [
      ...events,
      { id: "warn-1", level: "warn", category: "api", event: "request_failed", timestamp: "2026-09-28T00:00:00.000Z", message: "Request delayed" },
      { id: "error-1", level: "error", category: "api", event: "request_failed", timestamp: "2026-09-28T00:00:00.000Z", message: "Request failed" },
    ] });
    api.fetchDaemonLogs.mockResolvedValue({ items: [] });
    api.fetchOperatorInbox.mockResolvedValue({ workspaceId: "ws-1", items: [], coverage: [{ source: "dead_letters", state: "current" }] });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const eventRows = () => container.querySelectorAll('section[aria-labelledby="diagnostics-events-title"] h3');
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><SystemDiagnostics /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("2 warnings or errors"));
      expect(eventRows()).toHaveLength(2);
      expect(container.textContent).not.toContain("Request start");
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "All events")?.click());
      expect(eventRows()).toHaveLength(20);
      expect(container.textContent).toContain("Show remaining 7 events");
      await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Show remaining 7 events")?.click());
      expect(eventRows()).toHaveLength(27);
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
    }
  });

  it("downloads the bounded recent snapshot from this page", async () => {
    api.fetchDevDiagnostics.mockResolvedValue({ items: [{ id: "event-1", level: "warn", category: "api",
      event: "request_failed", source: "gateway", timestamp: "2026-09-28T00:00:00.000Z", message: "Request delayed",
      context: { hidden: "not-shown" } }] });
    api.fetchDaemonLogs.mockResolvedValue({ items: [] });
    api.fetchOperatorInbox.mockResolvedValue({ workspaceId: "ws-1", items: [], coverage: [] });
    let exportBlob: Blob | undefined;
    const createUrl = vi.fn((blob: Blob) => { exportBlob = blob; return "blob:recent-diagnostics"; });
    const revokeUrl = vi.fn();
    const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><SystemDiagnostics /></QueryClientProvider>));
      await vi.waitFor(() => expect(container.textContent).toContain("Request delayed"));
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "Export recent diagnostics");
      expect(button?.disabled).toBe(false);
      await act(async () => button?.click());
      expect(createUrl).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(revokeUrl).toHaveBeenCalledWith("blob:recent-diagnostics");
      const payload = JSON.parse(await exportBlob!.text()) as { diagnosticEvents: Array<{ message: string }>; sourceStatus: unknown };
      expect(payload.diagnosticEvents[0]?.message).toBe("Request delayed");
      expect(JSON.stringify(payload)).not.toContain("not-shown");
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
      click.mockRestore();
      if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });
});
