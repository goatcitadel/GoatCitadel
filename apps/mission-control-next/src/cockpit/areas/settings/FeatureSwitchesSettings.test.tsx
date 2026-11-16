// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { FeatureSwitchesSettings } from "./FeatureSwitchesSettings";
import { FEATURE_SWITCHES, FEATURE_SWITCH_FLAGS } from "./feature-switches";

const api = vi.hoisted(() => ({ fetchSettings: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
// The in-place approval dialog reads its approval; these tests cover the save, so the read never settles.
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: () => new Promise(() => undefined),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
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
  const unmount = () => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  };
  return { container, unmount };
}

function switchNamed(container: HTMLElement, name: string) {
  return [...container.querySelectorAll<HTMLElement>('[role="switch"]')].find(
    (entry) => entry.getAttribute("aria-label") === name,
  )!;
}

async function saveIn(container: HTMLElement, rowId: string) {
  await act(async () => {
    [...container.querySelectorAll<HTMLElement>(`#${rowId} button`)]
      .find((item) => item.textContent === "Save setting")!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit Features switches", () => {
  it("says the features are off unless turned on here, and that each row shows its state", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 4, features: { memoryLifecycleAdminV1Enabled: true } });
    const { container, unmount } = await mount();
    expect(container.textContent).toContain(
      "These features are off unless you turn them on here, and each row shows its current state.",
    );
    expect(container.textContent).not.toContain("ship turned off");
    unmount();
  });

  it("brings the switch a link names into view", async () => {
    window.history.replaceState(null, "", "/settings/advanced?shell=cockpit#feature-switch-scheduler-review");
    api.fetchSettings.mockResolvedValue({ revision: 4, features: { cronReviewQueueV1Enabled: false } });
    const scroll = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    try {
      const { container, unmount } = await mount();
      await vi.waitFor(() => expect(scroll).toHaveBeenCalled());
      expect(scroll.mock.contexts[0]).toBe(container.querySelector("#feature-switch-scheduler-review"));
      unmount();
    } finally {
      Element.prototype.scrollIntoView = original;
      window.history.replaceState(null, "", "/");
    }
  });

  it("lists every switch with its plain name and saves one flag through the settings patch", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 4, features: { memoryLifecycleAdminV1Enabled: false } });
    api.patchSettings.mockResolvedValue({
      revision: 5,
      features: { memoryLifecycleAdminV1Enabled: true },
      changePlanReceipt: {
        planId: "plan-memory",
        status: "completed",
        revision: 3,
        summary: "Memory administration is now on.",
      },
    });
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect([...container.querySelectorAll("h4")].map((entry) => entry.textContent)).toEqual(
        FEATURE_SWITCHES.map((entry) => entry.label),
      );
      expect(container.querySelector("#feature-switch-memory-administration")).not.toBeNull();
      await act(async () => switchNamed(container, "Turn it on or off: Memory administration").click());
      expect(container.textContent).toContain("Unsaved draft: On");
      await saveIn(container, "feature-switch-memory-administration");
      expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
        expectedRevision: 4,
        features: { memoryLifecycleAdminV1Enabled: true },
      });
    } finally {
      unmount();
    }
  });

  it("shows a switch the Gateway did not report as unreported, not as off", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 4, features: {} });
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "GoatCitadel did not report this setting. Try again, or update GoatCitadel, before changing it.",
        ),
      );
      expect(container.textContent).not.toContain("Current: Off");
    } finally {
      unmount();
    }
  });

  it("keeps setting keys out of the page while Technical details are off", async () => {
    api.fetchSettings.mockResolvedValue({
      revision: 4,
      features: Object.fromEntries(FEATURE_SWITCH_FLAGS.map((flag) => [flag, false])),
    });
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      for (const flag of FEATURE_SWITCH_FLAGS) expect(container.textContent).not.toContain(flag);
    } finally {
      unmount();
    }
  });
});
