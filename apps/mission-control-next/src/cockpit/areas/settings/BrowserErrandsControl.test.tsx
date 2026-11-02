// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { BrowserErrandsControl } from "./BrowserErrandsControl";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: () => new Promise(() => undefined),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

const settingsAt = (revision: number, enabled?: boolean) => ({
  revision,
  features: enabled === undefined ? {} : { browserErrandsEnabled: enabled },
});

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <BrowserErrandsControl />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const checkbox = (container: HTMLElement) => container.querySelector<HTMLInputElement>("input[type=checkbox]")!;

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit Browser errands setting", () => {
  it("shows the shared description and the Web access note", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect(container.textContent).toContain(
        CHANGE_PLAN_RUNTIME_FEATURE_FLAG_LABELS.browserErrandsEnabled!.description,
      );
      expect(container.textContent).toContain("Web access turned on in Chat");
    } finally {
      unmount();
    }
  });

  it("toggles browserErrandsEnabled through a change plan", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    const base = awaitingLlamaApproval(llamaPlanFixture());
    const canonical = {
      ...base,
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: { operation: "feature_flag" as const, flag: "browserErrandsEnabled" as const, enabled: true },
      },
      target: { ownerId: "runtime_settings", resourceId: "feature:browserErrandsEnabled", expectedRevision: 2 },
    };
    api.patchSettings.mockResolvedValue({ ...settingsAt(2, false), changePlanReceipt: canonical });
    api.fetchChangePlan.mockResolvedValue(canonical);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      await act(async () => checkbox(container).click());
      await act(async () => {
        [...container.querySelectorAll("button")].find((item) => item.textContent === "Save setting")!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 2,
        features: { browserErrandsEnabled: true },
      });
      expect(container.textContent).toContain("Approval required");
      expect(container.textContent).not.toContain("Setting saved.");
    } finally {
      unmount();
    }
  });

  it("shows a missing flag as unreported instead of off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("GoatCitadel did not report this setting"));
      expect(container.querySelector("input[type=checkbox]")).toBeNull();
    } finally {
      unmount();
    }
  });
});
