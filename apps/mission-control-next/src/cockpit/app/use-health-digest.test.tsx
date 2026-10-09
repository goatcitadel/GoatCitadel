// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { persistGatewayAuthState, getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/client-core";
import { useHealthDigestStatus, healthDigestKey, type HealthDigestStatus } from "./use-health-digest";
import type { SystemHealthSources } from "../areas/system/system-health-sources";
import { healthQueryScope } from "../data/health-query-scope";
import { deriveSystemHealthChecks } from "../areas/system/system-health";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
const inboxState = vi.hoisted(() => ({ isError: false, data: { workspaceId: "workspace-a", items: [], coverage: [{ source: "backup_trust", state: "not_enabled" }] } as unknown as OperatorInboxResponse }));
const api = vi.hoisted(() => ({ fetchHealthSummary: vi.fn(), fetchLlamaCppStatus: vi.fn(), fetchNpuStatus: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchChannelRuntimeStatus: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../features/desktop-updates/desktop-update-bridge", () => ({ useDesktopUpdates: () => null }));
vi.mock("../data/use-operator-inbox", () => ({ useOperatorInbox: () => inboxState }));
const summary = { database: { reachable: true, issues: [] }, daemonStatus: { supported: true, running: true, diagnostics: [] }, backups: { latest: null } };
let status: HealthDigestStatus;
let container: HTMLDivElement, root: Root, client: QueryClient;
function Probe({ workspaceId }: { workspaceId: string }) { status = useHealthDigestStatus(workspaceId, true); return <p data-phase={status.phase} data-tone={status.tone} title={status.title}>{status.label}</p>; }
beforeEach(() => { Object.values(api).forEach(mock => mock.mockReset()); api.fetchHealthSummary.mockResolvedValue(summary); api.fetchLlamaCppStatus.mockResolvedValue({ enabled: false }); api.fetchNpuStatus.mockResolvedValue({ enabled: false }); api.fetchIntegrationConnections.mockResolvedValue({ items: [] }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
beforeEach(() => { inboxState.isError = false; inboxState.data.coverage = [{ source: "backup_trust", state: "not_enabled" }]; });
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear(); vi.useRealTimers(); });
const render = (workspaceId = "workspace-a", consumers = 1) => act(async () => root.render(<QueryClientProvider client={client}>{Array.from({ length: consumers }, (_, index) => <Probe key={index} workspaceId={workspaceId} />)}</QueryClientProvider>));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
const data = () => { const scope = healthQueryScope(client, "workspace-a", getGatewayAccessRevision()); return client.getQueryData<SystemHealthSources>(healthDigestKey("workspace-a", scope[1], scope[2]))!; };
it.each(["verified", "failed", "stale"] as const)("digest cannot reuse backup A's %s proof for current B", async state => {
  api.fetchHealthSummary.mockResolvedValue({ ...summary, backups: { latest: { backupId: "B", createdAt: "2026-10-06T12:00:00Z" } } });
  inboxState.data.coverage = [{ source: "backup_trust", state: "limited", backupTrust: { state, backupId: "A", createdAt: "2026-10-06T12:00:00Z", observedAt: "now" } }];
  await render(); await settle();
  expect(status.tone).toBe("neutral"); expect(status.label).toContain("lack live proof");
  inboxState.isError = true; await render(); await settle();
  expect(status.tone).toBe("neutral"); expect(status.label).toContain("lack live proof");
  await act(async () => persistGatewayAuthState({ mode: "none" })); await settle();
  expect(status.tone).toBe("neutral"); expect(status.label).toContain("lack live proof");
});
it("digest retains existence and missing proof when Inbox cached absence precedes creation", async () => {
  api.fetchHealthSummary.mockResolvedValue({ ...summary, backups: { latest: { backupId: "B", createdAt: "2026-10-06T12:00:00Z" } } });
  await render(); await settle(); expect(status.label).toContain("lack live proof");
});
it("uses the real loader to retain source observation time across transport failure and recover independently", async () => {
  await render(); await settle(); expect(status.phase).toBe("ready"); expect(status.tone).toBe("done");
  const initial = data(); const observedAt = initial.summary.state === "current" ? initial.summary.observedAt : undefined;
  let fail!: (cause: Error) => void;
  api.fetchHealthSummary.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  api.fetchNpuStatus.mockResolvedValue({ enabled: true, healthy: true, processState: "running" });
  await act(async () => status.retry()); await settle(); expect(status.phase).toBe("checking"); expect(status.label).toContain("Checking for changes");
  await act(async () => { fail(new TypeError("Failed to fetch")); }); await settle();
  expect(status.phase).toBe("stale"); expect(status.tone).toBe("neutral"); expect(status.label).toContain("Stale"); expect(status.title).toContain("summary: last observed");
  expect(data().summary).toMatchObject({ state: "unavailable", retryable: true, lastKnown: { value: summary, observedAt } });
  expect(data().npu).toMatchObject({ state: "current", value: { enabled: true } });
  const gateway = deriveSystemHealthChecks(data(), null, "none").find(check => check.id === "gateway")!;
  expect(gateway.status).toEqual({ label: "Stale", tone: "neutral" }); expect(gateway.detail).toContain("The health summary is responding"); expect(gateway.detail).toContain("Retained observation is stale");
  api.fetchHealthSummary.mockResolvedValueOnce(summary); await act(async () => status.retry()); await settle();
  expect(status.phase).toBe("ready"); expect(status.tone).toBe("done"); expect(data().summary).not.toHaveProperty("lastKnown");
});
it.each([401, 403])("does not poll denied NPU %s and resets its query record on workspace/access changes", async (httpStatus) => {
  vi.useFakeTimers(); api.fetchNpuStatus.mockRejectedValue(new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/npu/status", status: httpStatus }));
  await render(); await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(310_000); });
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(1); expect(api.fetchHealthSummary.mock.calls.length).toBeGreaterThan(1);
  expect(data().npu).toMatchObject({ state: "unavailable", retryable: false, category: httpStatus === 401 ? "authentication" : "permission" });
  await render("workspace-b"); await act(async () => { await vi.advanceTimersByTimeAsync(10); }); expect(api.fetchNpuStatus).toHaveBeenCalledTimes(2);
  await act(async () => persistGatewayAuthState({ mode: "none" })); await act(async () => { await vi.advanceTimersByTimeAsync(10); }); expect(api.fetchNpuStatus).toHaveBeenCalledTimes(3);
});

it("shares the four-read digest between consumers and freshly revalidates a scope ABA once", async () => {
  vi.useFakeTimers();
  api.fetchNpuStatus.mockRejectedValue(new ApiRequestError("Denied", { kind: "http", method: "GET", path: "/api/v1/npu/status", status: 403 }));
  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(10); });
  await render("workspace-a", 2); await tick();
  expect(Object.values(api).reduce((total, mock) => total + mock.mock.calls.length, 0)).toBe(4);
  await render("workspace-b", 2); await tick(); expect(api.fetchNpuStatus).toHaveBeenCalledTimes(2);
  await render("workspace-a", 2); await tick(); expect(api.fetchNpuStatus).toHaveBeenCalledTimes(3);
  expect(api.fetchHealthSummary).toHaveBeenCalledTimes(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(310_000); });
  expect(api.fetchNpuStatus).toHaveBeenCalledTimes(3); expect(api.fetchHealthSummary).toHaveBeenCalledTimes(4);
});
