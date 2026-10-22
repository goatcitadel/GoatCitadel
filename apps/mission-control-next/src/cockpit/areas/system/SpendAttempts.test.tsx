// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { SpendAttempts, attemptCostLabel } from "./SpendAttempts";
const api = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ fetchModelUsageEvents: api.read }));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn().mockResolvedValue({ items: [{ workspaceId: "default", name: "Lab" }] }),
}));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({
  fetchLlmConfig: vi
    .fn()
    .mockResolvedValue({ providerConfigs: [{ providerId: "user-provider", label: "User Provider" }] }),
  fetchLlmModels: vi.fn().mockResolvedValue({ items: [{ id: "user-model", label: "User Model" }] }),
}));
it("distinguishes provider accounting, estimate and missing price with explicit units and bounded scope", async () => {
  expect(attemptCostLabel({ costSource: "provider_reported", costUsd: 0 })).toBe("$0.00 · Provider reported");
  expect(attemptCostLabel({ costSource: "gateway_estimate", costUsd: 1 })).toBe("$1.00 · Estimated");
  expect(attemptCostLabel({ costSource: "not_available", costUsd: 100 })).toBe("Price unavailable");
  const start = "2026-10-06T01:02:03.000Z";
  api.read.mockResolvedValue({
    items: [
      {
        eventId: "measured",
        effectiveProviderId: "user-provider",
        effectiveModelId: "user-model",
        startedAt: start,
        inputTokens: 10,
        outputTokens: 2,
        cachedInputTokens: 0,
        durationMs: 15,
        costSource: "provider_reported",
        costUsd: 1,
      },
      { eventId: "estimated", startedAt: start, costSource: "gateway_estimate", costUsd: 2 },
      { eventId: "missing", startedAt: start, costSource: "not_available" },
    ],
    summary: { attemptCount: 3, uncertainDispatchCount: 1 },
    nextCursor: "more",
  });
  const container = document.createElement("div"),
    root = createRoot(container),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  document.body.append(container);
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SpendAttempts workspaceId="workspace-a" from={start} to={start} />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Provider reported"));
    expect(api.read).toHaveBeenCalledWith("workspace-a", start, start);
    await vi.waitFor(() => expect(container.textContent).toContain("User Model · User Provider"));
    expect(container.textContent).not.toContain("user-provider");
    expect(container.textContent).not.toContain("workspace-a");
    expect(container.textContent).toContain("3 recorded call attempts · 1 dispatch outcome uncertain");
    expect(container.textContent).toContain("10 tokens");
    expect(container.textContent).toContain("15 ms");
    expect(container.textContent).toContain("Price unavailable");
    expect(container.textContent).toContain("Older attempts are not shown");
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(start);
    expect(container.textContent).toContain("separate from installation totals");
  } finally {
    act(() => root.unmount());
    client.clear();
    container.remove();
  }
});
it("never substitutes zero calls or price when the owner read fails", async () => {
  api.read.mockRejectedValue(new Error("Read unavailable"));
  const container = document.createElement("div"),
    root = createRoot(container),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SpendAttempts workspaceId="w" from="2026-10-01T00:00:00Z" to="2026-10-06T00:00:00Z" />
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Cost provenance is unavailable"),
    );
    expect(container.textContent).not.toContain("0 recorded call attempts");
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
