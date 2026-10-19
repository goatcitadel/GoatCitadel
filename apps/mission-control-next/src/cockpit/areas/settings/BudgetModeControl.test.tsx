// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { BudgetModeControl } from "./BudgetModeControl";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";

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
    window.history.replaceState(
      { retained: true },
      "",
      "/settings/safety?source=budget&sessionId=retained&shell=cockpit#budget-mode",
    );
    const base = awaitingLlamaApproval(llamaPlanFixture());
    const canonical = {
      ...base,
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: { operation: "budget_mode" as const, mode: "saver" as const },
      },
      target: { ownerId: "runtime_settings", resourceId: "budget_mode", expectedRevision: 2 },
    };
    api.patchSettings.mockResolvedValue({ revision: 2, budgetMode: "balanced", changePlanReceipt: canonical });
    api.fetchChangePlan.mockResolvedValue(canonical);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <CockpitNavigationProvider>
              <BudgetModeControl />
            </CockpitNavigationProvider>
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
      // Each mode says what it means, and the help says none of them switches models or caps spending.
      expect(container.querySelector("dl")?.textContent).toBe(
        "Saver: Your preference is lower cost.Balanced: The everyday default: no lean toward cost or quality.Power: Your preference is answer quality over cost.",
      );
      const select = container.querySelector("select")!;
      expect(document.getElementById(select.getAttribute("aria-describedby")!)?.textContent).toBe(
        "Saved as a preference only: no mode switches models or caps spending today.",
      );
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
      let link!: HTMLAnchorElement;
      await vi.waitFor(() => {
        link = container.querySelector<HTMLAnchorElement>('a[href^="/inbox?"]')!;
        expect(link).not.toBeNull();
      });
      const target = new URL(link.href);
      expect(target.searchParams.getAll("approvalId")).toEqual(["approval-1"]);
      expect(target.searchParams.get("workspaceId")).toBe("default");
      expect(target.searchParams.get("source")).toBe("budget");
      expect(target.searchParams.get("sessionId")).toBe("retained");
      expect(target.hash).toBe("#budget-mode");
      expect(target.searchParams.get("shell")).toBe("cockpit");
      expect(target.searchParams.has("shellScope")).toBe(false);
      expect(container.querySelector('a[href*="shell=classic"]')).toBeNull();
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
      expect(container.querySelector('a[href^="/inbox?"]')).toBeNull();
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
            <CockpitNavigationProvider>
              <BudgetModeControl />
            </CockpitNavigationProvider>
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

it("offers native budget inspection after an uncertain write without another mutation or clearing the lock", async () => {
  api.fetchSettings.mockResolvedValue({ revision: 2, budgetMode: "balanced" });
  api.patchSettings.mockRejectedValue(new Error("Lost response"));
  window.history.replaceState(
    { retained: true },
    "",
    "/settings/safety?source=budget&runId=run%2Fone&shell=cockpit#budget-mode",
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitNavigationProvider>
            <BudgetModeControl />
          </CockpitNavigationProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("Current: Balanced"));
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "saver";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = [...container.querySelectorAll("button")].find((item) => item.textContent === "Save preference")!;
    await act(async () => save.click());
    await vi.waitFor(() => expect(container.textContent).toContain("Save outcome is uncertain"));
    const link = [...container.querySelectorAll("a")].find(
      (item) => item.textContent === "Inspect budget settings activity",
    )!;
    const target = new URL(link.href);
    expect(target.pathname).toBe("/settings/safety");
    expect(target.hash).toBe("#budget-mode");
    expect(target.searchParams.get("source")).toBe("budget");
    expect(target.searchParams.get("runId")).toBe("run/one");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(container.querySelector('a[href*="shell=classic"]')).toBeNull();
    await act(async () =>
      [...container.querySelectorAll("button")].find((item) => item.textContent === "Refresh")!.click(),
    );
    expect(save.disabled).toBe(true);
    expect(select.disabled).toBe(true);
    expect(api.patchSettings).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Save outcome is uncertain");
  } finally {
    act(() => root.unmount());
    client.clear();
    container.remove();
  }
});
