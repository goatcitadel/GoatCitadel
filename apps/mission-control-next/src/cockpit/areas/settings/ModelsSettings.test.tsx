// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { ModelsSettings } from "./ModelsSettings";
import { clearAllDirty, setSectionDirty } from "../../../features/native-routes/library/use-form-dirty";
import { prepareReadyDialogFixture } from "../../../test/ready-dialog-fixture";

prepareReadyDialogFixture();

const api = vi.hoisted(() => ({ fetchOnboardingState: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: undefined }),
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate }) }));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("./ProviderCatalogSettings", () => ({ ProviderCatalogSettings: () => <p>Expert catalog owner</p> }));
vi.mock("./ProviderConnectionSettings", () => ({
  ProviderConnectionSettings: () => <p>Standalone connection editor</p>,
}));
vi.mock("./ProviderManagementSettings", () => ({ ProviderManagementSettings: () => <p>One provider page</p> }));
vi.mock("./ProviderRoutingSettings", () => ({ ProviderRoutingSettings: () => null }));
vi.mock("./ProviderAdviceSettings", () => ({ ProviderAdviceSettings: () => null }));
// Like the real owner after a completed change: it reports the result, then re-reads onboarding.
vi.mock("./CockpitGuidedModelSetup", () => ({
  CockpitGuidedModelSetup: ({
    onNoticeChange,
    reloadOnboarding,
    onEnterChat,
    enterChatLabel = "Enter Chat",
    showReadinessNote,
  }: {
    onNoticeChange?: (notice: string | null) => void;
    reloadOnboarding: () => Promise<void>;
    onEnterChat: () => void;
    enterChatLabel?: string;
    showReadinessNote?: boolean;
  }) => (
    <>
      <button type="button" data-show-readiness-note={String(showReadinessNote)} onClick={onEnterChat}>
        {enterChatLabel}
      </button>
      <button type="button" onClick={() => onNoticeChange?.("Change applied and verified.")}>
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
  navigate.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  clearAllDirty();
});

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ModelsSettings />
      </QueryClientProvider>,
    ),
  );
  await settleUntil(() => button("Report change") !== undefined || container.textContent!.includes("unavailable"));
}

describe("Models settings", () => {
  it.each([
    "provider:system:test",
    "provider-secret:system:test",
    "provider-endpoint:system:test",
    "provider-routing:system",
    `caller-scope:${JSON.stringify(["verified-caller", "provider-endpoint:system:test"])}`,
  ])("shows guided setup first, mounts experts on expansion and guards dirty %s collapse", async (key) => {
    api.fetchOnboardingState.mockResolvedValue(onboardingFixture());
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ModelsSettings />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() => button("Report change") !== undefined);
    expect(container.textContent).not.toContain("Expert catalog owner");
    const expand = button("Advanced provider configuration")!;
    expect(expand).toBeDefined();
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    await act(async () => expand.click());
    expect(container.textContent).toContain("Expert catalog owner");
    expect(container.textContent!.indexOf("Chat model")).toBeLessThan(
      container.textContent!.indexOf("Expert catalog owner"),
    );
    setSectionDirty(key, true, "Provider profile");
    await act(async () => expand.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Provider profile");
    await act(async () =>
      [...document.querySelectorAll("button")].find((item) => item.textContent === "Cancel")!.click(),
    );
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Expert catalog owner");
    await act(async () => expand.click());
    await act(async () =>
      [...document.querySelectorAll("button")].find((item) => item.textContent === "Discard changes")!.click(),
    );
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Expert catalog owner");
    setSectionDirty("unrelated:editor", true, "Other editor");
    await act(async () => expand.click());
    await act(async () => expand.click());
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
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
  it("mounts one provider page first and no standalone connection editor beside it", async () => {
    api.fetchOnboardingState.mockResolvedValue(onboardingFixture());
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ModelsSettings />
        </QueryClientProvider>,
      ),
    );
    await settleUntil(() => button("Report change") !== undefined);
    await act(async () => button("Advanced provider configuration")!.click());
    const text = container.textContent!;
    expect(text).toContain("One provider page");
    expect(text).not.toContain("Standalone connection editor");
    expect(text.indexOf("One provider page")).toBeLessThan(text.indexOf("Expert catalog owner"));
  });
  it("shows one setup status instead of a second step list, linking to Get started", async () => {
    api.fetchOnboardingState.mockResolvedValue({ ...onboardingFixture(), completed: false });
    await render();
    expect(container.querySelector('[aria-label="Model setup steps"]')).toBeNull();
    expect(container.querySelector('[data-show-readiness-note="true"]')).not.toBeNull();
    expect(container.textContent).toContain(
      "Setup isn't finished. After you confirm a model here, Get started asks for your safety settings and a test message.",
    );
    expect(container.querySelector('a[href="/settings/first-run"]')?.textContent).toBe("Open setup");
  });
  it.each([
    ["pending", "Setup is recorded. Send a test message in Chat to verify the first answer."],
    ["verified", "Setup is done and your first Chat answer is verified."],
  ])("says what is left once setup is finished and the first answer is %s", async (status, sentence) => {
    api.fetchOnboardingState.mockResolvedValue({
      ...onboardingFixture(),
      completed: true,
      firstTask: { status, checkedAt: "2026-09-30T00:00:00.000Z" },
    });
    await render();
    expect(container.textContent).toContain(sentence);
    expect(container.querySelector('a[href="/settings/first-run"]')).toBeNull();
    expect(button("Enter Chat")).toBeDefined();
    await act(async () => button("Enter Chat")!.click());
    expect(navigate).toHaveBeenCalledWith("/chat");
  });
  it("shows no setup status while setup has not been read", async () => {
    api.fetchOnboardingState.mockRejectedValue(new Error("Gateway unavailable"));
    await render();
    expect(container.textContent).toContain("Model setup unavailable");
    expect(container.textContent).not.toContain("Setup isn't finished");
    expect(container.textContent).not.toContain("Setup is recorded");
    expect(container.textContent).not.toContain("Setup is done");
  });
  it("continues setup, not Chat, after the model step while setup is unfinished", async () => {
    api.fetchOnboardingState.mockResolvedValue({ ...onboardingFixture(), completed: false });
    await render();
    await act(async () => button("Continue setup")!.click());
    expect(navigate).toHaveBeenCalledWith("/settings/first-run");
  });
});
