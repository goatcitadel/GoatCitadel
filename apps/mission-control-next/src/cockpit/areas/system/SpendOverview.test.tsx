// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { SpendOverview } from "./SpendOverview";

const api = vi.hoisted(() => ({ fetchCostSummary: vi.fn(), fetchSettings: vi.fn(), fetchModelUsageEvents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({
  fetchCostSummary: api.fetchCostSummary,
  fetchModelUsageEvents: api.fetchModelUsageEvents,
}));
vi.mock("@goatcitadel/mission-control-shared/api/settings", () => ({ fetchSettings: api.fetchSettings }));

describe("cockpit Spend", () => {
  it("shows provider evidence as a lower bound and does not imply the routing mode is a cap", async () => {
    const originalHref = window.location.pathname + window.location.search + window.location.hash;
    window.history.replaceState(
      { retained: "cost-context" },
      "",
      "/system/spend?runId=r%2F1&sessionId=s%2F1&citadelId=carried&keep=yes&shell=cockpit&shellScope=visit#cost-evidence",
    );
    api.fetchModelUsageEvents.mockResolvedValue({ items: [], summary: { attemptCount: 0, uncertainDispatchCount: 0 } });
    api.fetchCostSummary.mockResolvedValue({
      scope: "day",
      from: "2026-09-27T00:00:00.000Z",
      to: "2026-09-29T00:00:00.000Z",
      items: [{ key: "2026-09-28", tokenTotal: 30, costUsd: 3 }],
      dailySeries: [
        {
          isoDate: "2026-09-28",
          costUsd: 3,
          segments: [
            { providerKey: "alpha", label: "Alpha", tokenTotal: 30, costUsd: 3, models: ["model-a", "model-b"] },
          ],
        },
      ],
    });
    api.fetchSettings.mockResolvedValue({ budgetMode: "balanced" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <SpendOverview />
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Gateway budget preference: Balanced"));
      const continuation = [...container.querySelectorAll<HTMLAnchorElement>("a")].find(
        (link) => link.textContent === "Inspect detailed costs",
      );
      expect(continuation).toBeDefined();
      const destination = new URL(continuation!.href);
      expect(destination.pathname).toBe("/system/spend/details");
      expect(destination.searchParams.get("workspaceId")).toBe("default");
      expect(destination.searchParams.get("runId")).toBe("r/1");
      expect(destination.searchParams.get("sessionId")).toBe("s/1");
      expect(destination.searchParams.get("keep")).toBe("yes");
      expect(destination.searchParams.has("shellScope")).toBe(false);
      expect(destination.hash).toBe("#cost-evidence");
      expect(api.fetchCostSummary).toHaveBeenCalledWith("day");
      expect(container.textContent).toContain("Alpha");
      expect(container.textContent).toContain("$3.00+");
      expect(container.textContent).toContain("Models observed: model-a, model-b");
      expect(container.textContent).toContain("The mode is not a spend limit");
      expect(container.textContent).toContain("does not supply per-model cost totals");
      expect(container.textContent).toContain("2026-09-28 UTC");
      expect(container.textContent).toContain("currency USD");
      expect(container.textContent).toContain("(local time)");
      expect(container.textContent).toContain("does not make an estimate a measured bill");
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
      window.history.replaceState(null, "", originalHref);
    }
  });
});
