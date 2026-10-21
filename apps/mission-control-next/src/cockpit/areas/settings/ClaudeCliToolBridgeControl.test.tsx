// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { ClaudeCliToolBridgeControl } from "./ClaudeCliToolBridgeControl";
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

const settingsAt = (revision: number, enabled?: boolean) => ({
  revision,
  features: enabled === undefined ? {} : { claudeCliToolBridgeEnabled: enabled },
});
const completedReceipt = (revision: number) => ({
  planId: `plan-bridge-${revision}`,
  status: "completed",
  revision: 3,
  summary: "Runtime feature flag updated.",
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
          <ClaudeCliToolBridgeControl />
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

describe("cockpit Claude Code CLI tool setting", () => {
  it("turns the flag on and back off through the settings features patch", async () => {
    let saved = settingsAt(2, false);
    api.fetchSettings.mockImplementation(async () => saved);
    api.patchSettings.mockImplementation(
      async (input: { expectedRevision: number; features: { claudeCliToolBridgeEnabled: boolean } }) => {
        saved = settingsAt(input.expectedRevision + 1, input.features.claudeCliToolBridgeEnabled);
        return { ...saved, changePlanReceipt: completedReceipt(saved.revision) };
      },
    );
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect(container.textContent).toContain("Experimental and on by default.");
      // Off stops offering tools to the CLI; the copy must not promise text-only turns.
      expect(container.textContent).toContain("Turn it off to stop offering GoatCitadel tools to the Claude Code CLI.");
      expect(container.textContent).not.toContain("text-only");
      // The help says where tools run, what it costs, and claims no sandbox or endorsement.
      const facts = document.getElementById(checkbox(container).getAttribute("aria-describedby")!)!;
      expect(facts.textContent).toContain("Tools run in GoatCitadel, not inside Claude Code.");
      expect(facts.textContent).toContain("separate claude -p run");
      expect(facts.textContent).toContain("counts more against your Claude subscription");
      expect(facts.textContent).toContain("not sandboxed");
      expect(facts.textContent).toContain("not an Anthropic feature");
      expect(checkbox(container).checked).toBe(false);

      await toggleAndSave(container);
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 2,
        features: { claudeCliToolBridgeEnabled: true },
      });
      await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
      expect(container.textContent).toContain("Change saved and confirmed.");
      expect(checkbox(container).checked).toBe(true);
      expect(container.textContent).not.toContain("Unsaved draft");

      await toggleAndSave(container);
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 3,
        features: { claudeCliToolBridgeEnabled: false },
      });
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      expect(checkbox(container).checked).toBe(false);
      expect(container.textContent).not.toContain("Unsaved draft");
      expect(api.patchSettings).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
    }
  });

  it("keeps the draft unsaved and links the exact approval while the change waits", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, false));
    window.history.replaceState({}, "", "/settings/models?source=cli&shell=cockpit#claude-cli-tool-bridge");
    const base = awaitingLlamaApproval(llamaPlanFixture());
    const canonical = {
      ...base,
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: { operation: "feature_flag" as const, flag: "claudeCliToolBridgeEnabled" as const, enabled: true },
      },
      target: { ownerId: "runtime_settings", resourceId: "feature:claudeCliToolBridgeEnabled", expectedRevision: 2 },
    };
    api.patchSettings.mockResolvedValue({ ...settingsAt(2, false), changePlanReceipt: canonical });
    api.fetchChangePlan.mockResolvedValue(canonical);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
      await toggleAndSave(container);
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
      expect(target.hash).toBe("#claude-cli-tool-bridge");
    } finally {
      unmount();
    }
  });

  it("shows a missing flag as unreported instead of off", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(container.textContent).toContain("Gateway did not report this setting"));
      expect(container.textContent).not.toContain("Current: Off");
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(api.patchSettings).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
