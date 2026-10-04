// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Notice } from "../../../features/native-routes/settings/SettingsShared";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { ModelsSettings } from "./ModelsSettings";

const api = vi.hoisted(() => ({ fetchOnboardingState: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: undefined }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));
vi.mock("./ProviderCatalogSettings", () => ({ ProviderCatalogSettings: () => null }));
vi.mock("./ProviderConnectionSettings", () => ({ ProviderConnectionSettings: () => null }));
vi.mock("./ProviderManagementSettings", () => ({ ProviderManagementSettings: () => null }));
vi.mock("./ProviderRoutingSettings", () => ({ ProviderRoutingSettings: () => null }));
vi.mock("./ProviderAdviceSettings", () => ({ ProviderAdviceSettings: () => null }));
// Like the real owner after a completed change: it reports the result, then re-reads onboarding.
vi.mock("../../../features/native-routes/settings/sections/GuidedModelSetup", () => ({
  GuidedModelSetup: ({
    setNotice,
    reloadOnboarding,
  }: {
    setNotice: (notice: Notice | null) => void;
    reloadOnboarding: () => Promise<void>;
  }) => (
    <>
      <button type="button" onClick={() => setNotice({ tone: "success", message: "Change applied and verified." })}>
        Report change
      </button>
      <button type="button" onClick={() => void reloadOnboarding()}>
        Re-read onboarding
      </button>
    </>
  ),
}));

let root: Root, container: HTMLDivElement, client: QueryClient;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
const statusLines = () => [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent);
/** Query results reach React on zero-delay timers, so let them fire inside act until the view settles. */
async function settleUntil(done: () => boolean) {
  for (let pass = 0; pass < 20 && !done(); pass += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
  api.fetchOnboardingState.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("Models settings", () => {
  it("keeps the guided setup's notice when a failed re-read removes the card", async () => {
    api.fetchOnboardingState
      .mockResolvedValueOnce(onboardingFixture())
      .mockRejectedValueOnce(new Error("Gateway unavailable"));
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ModelsSettings />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() => button("Report change") !== undefined);
    await act(async () => button("Report change")!.click());
    expect(statusLines()).toEqual(["Change applied and verified."]);
    await act(async () => button("Re-read onboarding")!.click());
    await settleUntil(() => Boolean(container.textContent?.includes("Model setup unavailable")));
    expect(container.textContent).toContain("Model setup unavailable");
    expect(button("Report change")).toBeUndefined();
    expect(statusLines()).toEqual(["Change applied and verified."]);
  });
});
