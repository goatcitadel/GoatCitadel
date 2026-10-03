// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { BudgetModeControl } from "./BudgetModeControl";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit budget preference", () => {
  it("submits the current revision and keeps a change plan pending", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 2, budgetMode: "balanced" });
    api.patchSettings.mockResolvedValue({
      revision: 2,
      budgetMode: "balanced",
      changePlanReceipt: {
        planId: "plan-1",
        status: "awaiting_approval",
        revision: 1,
        summary: "Approval required",
        requiredAction: { kind: "approval", approvalId: "approval-1" },
      },
    });
    api.fetchChangePlan.mockResolvedValue({
      planId: "plan-1",
      status: "awaiting_approval",
      revision: 1,
      origin: { workspaceId: "default", surface: "settings" },
      kind: "runtime_configuration",
      request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "saver" } },
      target: { ownerId: "runtime_settings", expectedRevision: 2 },
      summary: "Approval required",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <BudgetModeControl />
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
      const select = container.querySelector("select")!;
      await act(async () => {
        select.value = "saver";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>("button.bg-accent")?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await vi.waitFor(() =>
        expect(api.patchSettings).toHaveBeenCalledWith({ expectedRevision: 2, budgetMode: "saver" }),
      );
      expect(container.textContent).toContain("Approval required");
      expect(container.textContent).toContain("draft remains unsaved");
      expect(container.textContent).not.toContain("Budget preference saved");
      expect(container.querySelector<HTMLButtonElement>("button.bg-accent")?.disabled).toBe(true);
      expect(container.querySelector('a[href="/ops/approvals?shell=classic&shellScope=visit"]')).not.toBeNull();
      api.fetchSettings.mockResolvedValue({ revision: 3, budgetMode: "saver" });
      api.fetchChangePlan.mockResolvedValue({
        planId: "plan-1",
        status: "completed",
        revision: 3,
        origin: { workspaceId: "default", surface: "settings" },
        kind: "runtime_configuration",
        request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "saver" } },
        target: { ownerId: "runtime_settings", expectedRevision: 2 },
        summary: "Applied",
      });
      await act(async () => {
        [...container.querySelectorAll("button")].find((item) => item.textContent === "Refresh change status")!.click();
      });
      await vi.waitFor(() => expect(container.textContent).toContain("Change saved and confirmed."));
      expect(container.textContent).not.toContain("Change submitted.");
      expect(container.textContent).not.toContain("Continue approved change");
      expect(container.querySelector('a[href="/ops/approvals?shell=classic&shellScope=visit"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
    }
  });

  it("re-reads settings and blocks a stale draft before mutation", async () => {
    api.fetchSettings
      .mockResolvedValueOnce({ revision: 2, budgetMode: "balanced" })
      .mockResolvedValue({ revision: 3, budgetMode: "power" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <BudgetModeControl />
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
      const select = container.querySelector("select")!;
      await act(async () => {
        select.value = "saver";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>("button.bg-accent")?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await vi.waitFor(() => expect(container.textContent).toContain("Budget settings changed"));
      expect(api.patchSettings).not.toHaveBeenCalled();
      expect(container.textContent).toContain("The saved setting changed after this draft began");
    } finally {
      act(() => root.unmount());
      client.clear();
      container.remove();
    }
  });
});
