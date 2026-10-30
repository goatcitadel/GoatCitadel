// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { SettingsApprovalSkipControl } from "./SettingsApprovalSkipControl";
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

const settingsAt = (revision: number, skip?: boolean) => ({
  revision,
  features: skip === undefined ? {} : { settingsApprovalSkipEnabled: skip },
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
          <SettingsApprovalSkipControl />
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

function checkbox(container: HTMLElement) {
  return container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit Settings approval skip", () => {
  it("shows the switch off by default with what it does and does not cover", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      // The heading and the checkbox both name the setting; neither sends skill approvals to the Inbox (a skill change
      // is approved in the Skills tab, where it was asked for, and also waits in the Inbox).
      expect(container.querySelector("h3")?.textContent).toBe(
        "Apply my Settings and Capabilities changes without asking first",
      );
      expect(container.querySelector("label")?.textContent).toBe(
        "Apply my Settings and Capabilities changes without asking first",
      );
      expect(container.textContent).toContain("apply right away instead of waiting for your approval.");
      expect(container.textContent).not.toContain("Inbox");
      expect(container.textContent).toContain("connectors you install from Capabilities");
      expect(container.textContent).toContain("skills you switch on from Capabilities");
      // Off, and pausing a skill that is on, apply without asking whatever the setting says (Q1: A, Ruling R10),
      // except on a remote-hardened install. Pausing an off skill gives power back, so the copy never claims it.
      expect(container.textContent).toContain(
        "Turning a skill off, or pausing one that is on, from Capabilities applies right away even when this is off",
      );
      expect(container.textContent).not.toContain("pausing it from Capabilities");
      expect(container.textContent).toContain("a remote-hardened install still asks");
      expect(container.textContent).toContain("A skill switch keeps its approval, marked as approved by you");
      // Installs from Capabilities beyond connectors don't exist yet, so the copy doesn't claim them.
      expect(container.textContent).not.toContain("skills you install");
      expect(container.textContent).not.toContain("Apply my Settings changes without");
      expect(container.textContent).toContain("Change requests a model makes in Chat still need your approval.");
      expect(container.textContent).toContain(
        "GoatCitadel sign-in, API keys and other credentials still ask for approval.",
      );
      expect(container.textContent).toContain("A remote-hardened install ignores it.");
      expect(checkbox(container).checked).toBe(false);
    } finally {
      unmount();
    }
  });

  it("turning it on raises a feature_flag change plan that still needs one approval", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    window.history.replaceState({}, "", "/settings/safety?shell=cockpit#settings-approval-skip");
    const canonical = {
      ...awaitingLlamaApproval(llamaPlanFixture()),
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: { operation: "feature_flag" as const, flag: "settingsApprovalSkipEnabled" as const, enabled: true },
      },
      target: { ownerId: "runtime_settings", resourceId: "feature:settingsApprovalSkipEnabled", expectedRevision: 2 },
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
        features: { settingsApprovalSkipEnabled: true },
      });
      expect(container.textContent).toContain("Approval required");
      let link!: HTMLAnchorElement;
      await vi.waitFor(() => {
        link = container.querySelector<HTMLAnchorElement>('a[href^="/inbox?"]')!;
        expect(link).not.toBeNull();
      });
      expect(new URL(link.href).hash).toBe("#settings-approval-skip");
    } finally {
      unmount();
    }
  });
});
