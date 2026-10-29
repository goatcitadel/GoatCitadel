// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { ChatThinkingStreamControl } from "./ChatThinkingStreamControl";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";

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

const settingsAt = (revision: number, thinking?: boolean) => ({
  revision,
  features: thinking === undefined ? {} : { chatThinkingStreamV1Enabled: thinking },
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
          <ChatThinkingStreamControl />
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

const checkbox = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit model reasoning in Chat setting", () => {
  it("names the setting plainly, says it is off by default, and states its limits", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect(container.querySelector("h3")?.textContent).toBe("Model reasoning in Chat");
      expect(container.textContent).toContain("Off by default.");
      const facts = document.getElementById(checkbox(container).getAttribute("aria-describedby")!)!;
      expect(facts.textContent).toContain("unreviewed text");
      expect(facts.textContent).toContain("Only models that report their reasoning send any.");
      expect(facts.textContent).toContain("gone after a page reload");
      expect(checkbox(container).checked).toBe(false);
      expect(checkbox(container).disabled).toBe(false);
    } finally {
      unmount();
    }
  });

  it("turning it on raises a feature_flag change plan that waits for approval", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    window.history.replaceState({}, "", "/settings/models?shell=cockpit#chat-thinking-stream");
    const canonical = {
      ...awaitingLlamaApproval(llamaPlanFixture()),
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: { operation: "feature_flag" as const, flag: "chatThinkingStreamV1Enabled" as const, enabled: true },
      },
      target: { ownerId: "runtime_settings", resourceId: "feature:chatThinkingStreamV1Enabled", expectedRevision: 2 },
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
        features: { chatThinkingStreamV1Enabled: true },
      });
      expect(container.textContent).toContain("Approval required");
      expect(container.textContent).not.toContain("Setting saved.");
      let link!: HTMLAnchorElement;
      await vi.waitFor(() => {
        link = container.querySelector<HTMLAnchorElement>('a[href^="/inbox?"]')!;
        expect(link).not.toBeNull();
      });
      expect(new URL(link.href).hash).toBe("#chat-thinking-stream");
    } finally {
      unmount();
    }
  });

  it("shows a missing flag as unreported instead of off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("GoatCitadel did not report this setting"));
      expect(container.textContent).not.toContain("Current: Off");
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    } finally {
      unmount();
    }
  });
});
