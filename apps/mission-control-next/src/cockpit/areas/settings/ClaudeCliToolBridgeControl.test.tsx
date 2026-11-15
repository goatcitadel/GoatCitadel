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

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchChangePlans: vi.fn(),
}));
// The in-place approval dialog reads its approval; these tests cover the save, so the read never settles.
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: () => new Promise(() => undefined),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  fetchChangePlans: api.fetchChangePlans,
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
      expect(facts.textContent).toContain("starts a new claude -p run");
      // Process reuse is conditional, matching the warm continuation switch below it.
      expect(facts.textContent).toContain("unless Claude Code CLI: reuse one process between tool steps is on");
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
      await vi.waitFor(() => expect(container.textContent).toContain("GoatCitadel did not report this setting"));
      expect(container.textContent).not.toContain("Current: Off");
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      expect(api.patchSettings).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });

  describe("a save that does not apply cleanly", () => {
    const planConflict = {
      status: 409,
      kind: "http",
      body: {
        code: "WRITE_CONFLICT",
        details: { resourceKind: "change_plan", resourceId: "plan-waiting", currentRevision: 2 },
      },
    };
    const waitingPlan = (planId: string, approvalId: string, enabled: boolean) => ({
      ...awaitingLlamaApproval(llamaPlanFixture()),
      planId,
      title: "Turn off Claude Code CLI: reuse one process between tool steps",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: { operation: "feature_flag" as const, flag: "claudeCliToolBridgeEnabled" as const, enabled },
      },
      target: { ownerId: "runtime_settings", resourceId: "feature:claudeCliToolBridgeEnabled", expectedRevision: 2 },
      requiredAction: { kind: "approval" as const, approvalId, title: "Approve", approvalLabel: "Approve" },
    });
    const buttons = (container: HTMLElement) => [...container.querySelectorAll("button")];
    const buttonsAndLinks = (container: HTMLElement) =>
      [...container.querySelectorAll("button, a")].map((entry) => entry.textContent);
    const saveButton = (container: HTMLElement) =>
      buttons(container).find((item) => item.textContent === "Save setting")!;

    it("reopens the waiting change instead of saying settings changed elsewhere", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockResolvedValue(waitingPlan("plan-waiting", "approval-waiting", false));
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("One change to this setting is already waiting for your approval."),
        );
        expect(container.textContent).not.toContain("Settings changed elsewhere");
        expect(container.textContent).toContain("Unsaved draft: Off");
        // Saving again would only meet the same conflict.
        expect(saveButton(container).disabled).toBe(true);
        expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-waiting", { workspaceId: "default" });
      } finally {
        unmount();
      }
    });

    it("opens the waiting change even when its value differs from the draft", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, false));
      api.patchSettings.mockRejectedValue(planConflict);
      // The waiting change turns the setting off; the draft being saved turns it on.
      api.fetchChangePlan.mockResolvedValue(waitingPlan("plan-waiting", "approval-waiting", false));
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: Off"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("One change to this setting is already waiting for your approval."),
        );
        expect(container.textContent).toContain("Unsaved draft: On");
        expect(api.patchSettings).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
    });

    it("points to Inbox when the waiting change cannot be read", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockRejectedValue(new Error("offline"));
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("One change to this setting is already waiting."),
        );
        expect(buttonsAndLinks(container)).toContain("Open Inbox to approve it.");
      } finally {
        unmount();
      }
    });

    it("keeps the old copy for a conflict that is not a waiting change", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue({
        status: 409,
        kind: "http",
        body: { code: "STATE_CONFLICT", details: { expectedRevision: 4, currentRevision: 5 } },
      });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("Settings changed elsewhere"));
        expect(container.textContent).not.toContain("already waiting");
      } finally {
        unmount();
      }
    });

    it("shows a plain refusal as not saved and does not lock the page", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue({ status: 422, kind: "http", body: { error: "That setting is managed." } });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("Not saved."));
        expect(container.textContent).not.toContain("uncertain");
        expect(checkbox(container).disabled).toBe(false);
        expect(api.fetchChangePlans).not.toHaveBeenCalled();
      } finally {
        unmount();
      }
    });

    it("reconciles a lost answer by reading the saved value and lifts the lock", async () => {
      api.fetchSettings
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValue(settingsAt(5, false));
      api.patchSettings.mockRejectedValue({ status: 503, kind: "http", body: {} });
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("Setting saved."));
        expect(saveButton(container).disabled).toBe(true); // a clean draft, not a lock
        expect(checkbox(container).disabled).toBe(false);
        expect(container.textContent).not.toContain("Save outcome is uncertain");
        expect(api.patchSettings).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
    });

    it("finds the change a lost answer queued and leads to its approval", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockResolvedValue({ items: [waitingPlan("plan-lost", "approval-lost", false)] });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("One change to this setting is already waiting for your approval."),
        );
        expect(checkbox(container).disabled).toBe(false);
        expect(saveButton(container).disabled).toBe(true);
        expect(api.patchSettings).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
    });

    it("says plainly when a lost answer turns out not to be saved", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain(
            "Your change was not saved. Your draft is kept, so you can save it again.",
          ),
        );
        expect(container.textContent).toContain("Unsaved draft: Off");
        expect(saveButton(container).disabled).toBe(false);
      } finally {
        unmount();
      }
    });

    it("keeps saving paused and offers Check again while the Gateway still doesn't answer", async () => {
      api.fetchSettings
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockRejectedValue(new Error("Failed to fetch"));
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("GoatCitadel didn't answer, so this save isn't confirmed yet."),
        );
        expect(container.textContent).not.toContain("was not saved");
        expect(checkbox(container).disabled).toBe(true);
        const again = buttons(container).find((entry) => entry.textContent === "Check again");
        expect(again).toBeDefined();

        // The Gateway answers on the next check, and the change turns out to have been saved.
        api.fetchSettings.mockResolvedValue(settingsAt(5, false));
        api.fetchChangePlans.mockResolvedValue({ items: [] });
        await act(async () => again!.click());
        await vi.waitFor(() => expect(container.textContent).toContain("Setting saved."));
        expect(checkbox(container).disabled).toBe(false);
        expect(api.patchSettings).toHaveBeenCalledTimes(1);
      } finally {
        unmount();
      }
    });

    it("keeps the lock when the open changes cannot be read, though the settings can", async () => {
      api.fetchSettings
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockRejectedValue(new Error("Failed to fetch"));
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("isn't confirmed yet"));
        expect(container.textContent).not.toContain("was not saved");
        expect(checkbox(container).disabled).toBe(true);
      } finally {
        unmount();
      }
    });

    it("calls a change that finished between the two reads saved, never not saved", async () => {
      api.fetchSettings
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValue(settingsAt(5, false));
      api.patchSettings.mockRejectedValue({ status: 503, kind: "http", body: {} });
      // The plans read still lists the change as being applied; by the settings read it has finished.
      api.fetchChangePlans.mockResolvedValue({
        items: [{ ...waitingPlan("plan-late", "approval-late", false), status: "applying", requiredAction: undefined }],
      });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("Setting saved."));
        expect(container.textContent).not.toContain("was not saved");
        expect(container.textContent).not.toContain("being applied");
        // The open changes are read before the saved value, so a finishing change shows up as the saved value.
        const afterWrite = api.fetchSettings.mock.invocationCallOrder[2]!;
        expect(api.fetchChangePlans.mock.invocationCallOrder[0]).toBeLessThan(afterWrite);
      } finally {
        unmount();
      }
    });

    it("keeps the lock when the settings read fails after the open changes were read", async () => {
      api.fetchSettings
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockRejectedValue(new Error("Failed to fetch"));
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("isn't confirmed yet"));
        expect(container.textContent).not.toContain("was not saved");
        expect(checkbox(container).disabled).toBe(true);
      } finally {
        unmount();
      }
    });

    it("keeps the lock when the Gateway reports no usable value instead of calling it not saved", async () => {
      api.fetchSettings
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValueOnce(settingsAt(4, true))
        .mockResolvedValue(settingsAt(5));
      api.patchSettings.mockRejectedValue(new Error("Failed to fetch"));
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("isn't confirmed yet"));
        expect(container.textContent).not.toContain("was not saved");
      } finally {
        unmount();
      }
    });

    it("shows nothing misleading when the named change finished before it was looked up", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting", false),
        status: "completed",
      });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(api.fetchChangePlan).toHaveBeenCalled());
        await act(async () => undefined);
        expect(container.textContent).not.toContain("already waiting");
        expect(container.textContent).not.toContain("Open Inbox");
        expect(container.textContent).not.toContain("Settings changed elsewhere");
        // The draft is kept and nothing blocks saving it again.
        expect(container.textContent).toContain("Unsaved draft: Off");
        expect(saveButton(container).disabled).toBe(false);
      } finally {
        unmount();
      }
    });

    it("uses the ordinary conflict copy when the named change is not a Settings change", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting", false),
        origin: { workspaceId: "default", surface: "chat" },
      });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("Settings changed elsewhere"));
        expect(container.textContent).not.toContain("already waiting");
      } finally {
        unmount();
      }
    });

    it("clears the waiting notice on Refresh once the change was decided elsewhere, and saving works again", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockResolvedValue(waitingPlan("plan-waiting", "approval-waiting", false));
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("One change to this setting is already waiting for your approval."),
        );
        expect(saveButton(container).disabled).toBe(true);

        // Denied in Inbox: the plan is finished and the setting did not change.
        api.fetchChangePlan.mockResolvedValue({
          ...waitingPlan("plan-waiting", "approval-waiting", false),
          status: "cancelled",
        });
        await act(async () =>
          buttons(container)
            .find((entry) => entry.textContent === "Refresh")!
            .click(),
        );
        await vi.waitFor(() => expect(container.textContent).not.toContain("already waiting"));
        expect(saveButton(container).disabled).toBe(false);
      } finally {
        unmount();
      }
    });

    it("says a change the operator must review is waiting for review, with a link", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting", false),
        status: "awaiting_confirmation",
        requiredAction: { kind: "confirmation", actionId: "a", actionNonce: "n", title: "Confirm" },
      });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain("One change to this setting is waiting for your review."),
        );
        expect(container.textContent).not.toContain("being applied");
        expect(buttonsAndLinks(container)).toContain("Open Inbox to review it.");
      } finally {
        unmount();
      }
    });

    it("says a change really being applied is being applied", async () => {
      api.fetchSettings.mockResolvedValue(settingsAt(4, true));
      api.patchSettings.mockRejectedValue(planConflict);
      api.fetchChangePlan.mockResolvedValue({
        ...waitingPlan("plan-waiting", "approval-waiting", false),
        status: "applying",
        requiredAction: undefined,
      });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() =>
          expect(container.textContent).toContain(
            "One change to this setting is still being applied. Refresh in a moment to see it.",
          ),
        );
        expect(container.textContent).not.toContain("waiting for your review");
      } finally {
        unmount();
      }
    });

    it("is not fooled by a change that finishes after the open changes were read", async () => {
      // The settings still hold the old value until the open changes have been read; afterwards they hold the new one.
      let written = false;
      api.fetchSettings.mockImplementation(async () =>
        written && api.fetchChangePlans.mock.calls.length > 0 ? settingsAt(5, false) : settingsAt(4, true),
      );
      api.patchSettings.mockImplementation(async () => {
        written = true;
        throw { status: 503, kind: "http", body: {} };
      });
      api.fetchChangePlans.mockResolvedValue({ items: [] });
      const { container, unmount } = await mount();
      try {
        await vi.waitFor(() => expect(container.textContent).toContain("Current: On"));
        await toggleAndSave(container);
        await vi.waitFor(() => expect(container.textContent).toContain("Setting saved."));
        expect(container.textContent).not.toContain("was not saved");
      } finally {
        unmount();
      }
    });
  });
});
