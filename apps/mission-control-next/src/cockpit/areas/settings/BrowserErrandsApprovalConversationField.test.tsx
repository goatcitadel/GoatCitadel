// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessagingOverview } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import {
  awaitingLlamaApproval,
  llamaPlanFixture,
} from "../../../features/native-routes/settings/llama-setup.test-support";
import {
  BrowserErrandsApprovalConversationField,
  errandApprovalConversationOptions,
} from "./BrowserErrandsApprovalConversationField";

const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchChatMessaging: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({
  fetchApproval: () => new Promise(() => undefined),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchSettings: api.fetchSettings,
  patchSettings: api.patchSettings,
  fetchChangePlan: api.fetchChangePlan,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));

const conversation = (sessionId: string, title: string, kind: "direct" | "group", own: boolean) => ({
  sessionId,
  title,
  kind,
  own,
  lastActivityAt: "2026-11-02T10:00:00.000Z",
});

const OVERVIEW: ChatMessagingOverview = {
  workspaceId: "default",
  channels: [
    {
      connectionId: "conn-telegram",
      channelKey: "telegram",
      label: "Telegram",
      status: "on",
      conversations: [
        conversation("session-own-dm", "Me", "direct", true),
        conversation("session-friend", "Sam", "direct", false),
        conversation("session-team", "Team", "group", false),
      ],
    },
    {
      connectionId: "conn-slack",
      channelKey: "slack",
      label: "Slack",
      status: "on",
      conversations: [conversation("session-slack-me", "Me at work", "direct", true)],
    },
  ],
};

const settingsAt = (revision: number, approvalSessionId?: string) => ({
  revision,
  features: {},
  browserErrands: approvalSessionId ? { approvalSessionId } : {},
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
          <BrowserErrandsApprovalConversationField workspaceId="default" />
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

const picker = (container: HTMLElement) => container.querySelector<HTMLSelectElement>("select")!;
const optionLabels = (container: HTMLElement) =>
  [...picker(container).querySelectorAll("option")].map((option) => option.textContent);

function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

afterEach(() => {
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
});

describe("where waiting browser errand approvals go", () => {
  it("lists only the operator's own direct conversations, with None", () => {
    expect(errandApprovalConversationOptions(OVERVIEW)).toEqual([
      { sessionId: "session-own-dm", label: "Telegram · Me" },
      { sessionId: "session-slack-me", label: "Slack · Me at work" },
    ]);
    expect(errandApprovalConversationOptions(undefined)).toEqual([]);
  });

  it("shows the picker with None, the own conversations and the help", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2));
    api.fetchChatMessaging.mockResolvedValue(OVERVIEW);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(optionLabels(container)).toContain("Telegram · Me"));
      expect(optionLabels(container)).toEqual(["None", "Telegram · Me", "Slack · Me at work"]);
      expect(picker(container).value).toBe("");
      expect(container.textContent).toContain(
        "When you're away from the PC, errand approvals go here and to your phone if you haven't answered in 30 seconds.",
      );
    } finally {
      unmount();
    }
  });

  it("selecting a conversation and saving creates its change plan", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2));
    api.fetchChatMessaging.mockResolvedValue(OVERVIEW);
    const base = awaitingLlamaApproval(llamaPlanFixture());
    const canonical = {
      ...base,
      revision: 1,
      summary: "Approval required",
      origin: { workspaceId: "default", surface: "settings" as const },
      request: {
        kind: "runtime_configuration" as const,
        change: {
          operation: "browser_errand_approval_conversation" as const,
          config: { approvalSessionId: "session-own-dm" },
        },
      },
      target: { ownerId: "runtime_settings", resourceId: "browser_errand_approval_conversation", expectedRevision: 2 },
    };
    api.patchSettings.mockResolvedValue({ ...settingsAt(2), changePlanReceipt: canonical });
    api.fetchChangePlan.mockResolvedValue(canonical);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(optionLabels(container)).toContain("Telegram · Me"));
      await act(async () => choose(picker(container), "session-own-dm"));
      expect(container.textContent).toContain("Unsaved draft: Telegram · Me");
      await act(async () => {
        [...container.querySelectorAll("button")].find((item) => item.textContent === "Save conversation")!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(api.patchSettings).toHaveBeenLastCalledWith({
        expectedRevision: 2,
        browserErrandApprovalSessionId: "session-own-dm",
      });
      expect(container.textContent).toContain("Approval required");
    } finally {
      unmount();
    }
  });

  it("clears the pick by saving None", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(3, "session-own-dm"));
    api.fetchChatMessaging.mockResolvedValue(OVERVIEW);
    api.patchSettings.mockResolvedValue(settingsAt(4));
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(picker(container).value).toBe("session-own-dm"));
      await act(async () => choose(picker(container), ""));
      await act(async () => {
        [...container.querySelectorAll("button")].find((item) => item.textContent === "Save conversation")!.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(api.patchSettings).toHaveBeenLastCalledWith({ expectedRevision: 3, browserErrandApprovalSessionId: null });
    } finally {
      unmount();
    }
  });

  it("keeps a saved conversation that Messaging no longer lists selectable", async () => {
    api.fetchSettings.mockResolvedValue(settingsAt(2, "session-elsewhere"));
    api.fetchChatMessaging.mockResolvedValue(OVERVIEW);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() => expect(picker(container).value).toBe("session-elsewhere"));
      expect(optionLabels(container)).toContain("A conversation not listed here");
    } finally {
      unmount();
    }
  });

  it("shows a Gateway without the setting as unreported", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 2, features: {} });
    api.fetchChatMessaging.mockResolvedValue(OVERVIEW);
    const { container, unmount } = await mount();
    try {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("GoatCitadel did not report where errand approvals go"),
      );
      expect(container.querySelector("select")).toBeNull();
    } finally {
      unmount();
    }
  });
});
