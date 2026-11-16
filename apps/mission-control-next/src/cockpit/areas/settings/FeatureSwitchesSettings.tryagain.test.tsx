// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { FeatureSwitchesSettings } from "./FeatureSwitchesSettings";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchSettings: api.fetchSettings,
}));

afterEach(() => {
  document.body.replaceChildren();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("Features offers one Try again for the whole section (U-ST-014)", () => {
  it("shows one Try again when the shared read fails, not one per switch", async () => {
    api.fetchSettings.mockRejectedValue(new Error("Gateway unreachable"));
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CockpitNavigationProvider>
            <FeatureSwitchesSettings />
          </CockpitNavigationProvider>
        </QueryClientProvider>,
      ),
    );
    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    const tryAgain = () => [...container.querySelectorAll("button")].filter((b) => b.textContent === "Try again");
    expect(tryAgain()).toHaveLength(1);
    api.fetchSettings.mockResolvedValue({ revision: 2, features: {} });
    await act(async () => tryAgain()[0]!.click());
    await vi.waitFor(() => expect(api.fetchSettings).toHaveBeenCalledTimes(2));
    await act(async () => root.unmount());
    client.clear();
  });
});
