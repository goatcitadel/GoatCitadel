// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { ClaudeCliWarmContinuationControl } from "./ClaudeCliWarmContinuationControl";
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

const COPY =
  "When a tool step continues the previous one exactly, keeps that turn's Claude Code process running instead of starting a new one; any other step still starts a new one. Tools still run in GoatCitadel. Experimental and on by default. Turn it off to start a new Claude Code process for every tool step.";

const settingsAt = (revision: number, flags: { bridge?: boolean; warm?: boolean }) => ({
  revision,
  features: {
    ...(flags.bridge === undefined ? {} : { claudeCliToolBridgeEnabled: flags.bridge }),
    ...(flags.warm === undefined ? {} : { claudeCliWarmContinuationEnabled: flags.warm }),
  },
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
          <ClaudeCliWarmContinuationControl />
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

async function toggleAndSave(container: HTMLElement) {
  await act(async () => checkbox(container).click());
  await act(async () => {
    [...container.querySelectorAll("button")].find((item) => item.textContent === "Save setting")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("cockpit Claude Code CLI warm continuation setting", () => {
  it("the control shows the exact copy and an explicitly saved Off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, { bridge: true, warm: false }));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect(container.textContent).toContain(COPY);
      expect(container.textContent).toContain("Experimental and on by default.");
      expect(container.textContent).toContain("Turn it off to start a new Claude Code process for every tool step.");
      expect(checkbox(container).checked).toBe(false);
      expect(checkbox(container).disabled).toBe(false);
      expect(container.textContent).not.toContain("Unsaved draft");
    } finally {
      unmount();
    }
  });

  it("it is disabled while the tool bridge is off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, { bridge: false, warm: false }));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect(checkbox(container).disabled).toBe(true);
      const note = document.getElementById(checkbox(container).getAttribute("aria-describedby")!)!;
      expect(note.textContent).toContain("Turn on “Let the Claude Code CLI use GoatCitadel tools” first.");
      expect(container.textContent).toContain(COPY);
      await act(async () => checkbox(container).click());
      expect(checkbox(container).checked).toBe(false);
      expect(api.patchSettings).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  it("warm On, bridge Off: can still be turned off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, { bridge: false, warm: true }));
    const base = awaitingLlamaApproval(llamaPlanFixture());
    const canonical = {
      ...base,
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: {
          operation: "feature_flag" as const,
          flag: "claudeCliWarmContinuationEnabled" as const,
          enabled: false,
        },
      },
      target: {
        ownerId: "runtime_settings",
        resourceId: "feature:claudeCliWarmContinuationEnabled",
        expectedRevision: 2,
      },
    };
    api.patchSettings.mockResolvedValue({
      ...settingsAt(2, { bridge: false, warm: true }),
      changePlanReceipt: canonical,
    });
    api.fetchChangePlan.mockResolvedValue(canonical);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
      expect(checkbox(container).checked).toBe(true);
      expect(checkbox(container).disabled).toBe(false);
      const note = document.getElementById(checkbox(container).getAttribute("aria-describedby")!)!;
      expect(note.textContent).toContain("Turn on “Let the Claude Code CLI use GoatCitadel tools” first.");
      await toggleAndSave(container);
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 2,
        features: { claudeCliWarmContinuationEnabled: false },
      });
      expect(container.textContent).toContain("Approval required");
    } finally {
      unmount();
    }
  });

  it("toggling raises a feature_flag change plan for claudeCliWarmContinuationEnabled", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, { bridge: true, warm: false }));
    window.history.replaceState({}, "", "/settings/models?source=cli&shell=cockpit#claude-cli-warm-continuation");
    const base = awaitingLlamaApproval(llamaPlanFixture());
    const canonical = {
      ...base,
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: {
          operation: "feature_flag" as const,
          flag: "claudeCliWarmContinuationEnabled" as const,
          enabled: true,
        },
      },
      target: {
        ownerId: "runtime_settings",
        resourceId: "feature:claudeCliWarmContinuationEnabled",
        expectedRevision: 2,
      },
    };
    api.patchSettings.mockResolvedValue({
      ...settingsAt(2, { bridge: true, warm: false }),
      changePlanReceipt: canonical,
    });
    api.fetchChangePlan.mockResolvedValue(canonical);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      await toggleAndSave(container);
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 2,
        features: { claudeCliWarmContinuationEnabled: true },
      });
      expect(container.textContent).toContain("Approval required");
      expect(container.textContent).toContain("draft remains unsaved");
      expect(container.textContent).not.toContain("Setting saved.");
      expect(checkbox(container).disabled).toBe(true);
      let link!: HTMLAnchorElement;
      await vi.waitFor(() => {
        link = container.querySelector<HTMLAnchorElement>('a[href^="/inbox?"]')!;
        expect(link).not.toBeNull();
      });
      const target = new URL(link.href);
      expect(target.searchParams.get("approvalId")).toBe("approval-1");
      expect(target.searchParams.get("workspaceId")).toBe("default");
      expect(target.searchParams.get("source")).toBe("cli");
      expect(target.hash).toBe("#claude-cli-warm-continuation");
    } finally {
      unmount();
    }
  });

  it("shows a missing flag as unreported instead of off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, { bridge: true }));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("GoatCitadel did not report this setting"));
      expect(container.textContent).not.toContain("Current: Off");
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(api.patchSettings).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
