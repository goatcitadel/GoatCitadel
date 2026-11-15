// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardingState } from "@goatcitadel/contracts";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { ChatConversationStarters } from "./ChatConversationStarters";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchOnboardingState: vi.fn() }));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchOnboardingState).mockResolvedValue({ ...onboardingFixture(), completed: true });
});
afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  client.clear();
});
const configureModelsHref = () =>
  [...container.querySelectorAll("a")].find((a) => a.textContent === "Configure models")?.getAttribute("href");
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
async function mount(overrides = {}) {
  container = document.createElement("div");
  document.body.append(container);
  const textarea = document.createElement("textarea");
  textarea.id = "cockpit-chat-draft";
  container.append(textarea);
  const host = document.createElement("div");
  container.append(host);
  root = createRoot(host);
  const props = { draft: "", historicalReadOnly: false, sending: false, onDraftChange: vi.fn(), ...overrides };
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ChatConversationStarters props={props} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => vi.dynamicImportSettled());
  return props;
}
describe("conversation starters", () => {
  it("fills a draft and focuses its composer without sending", async () => {
    const props = await mount();
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Plan a change"))!;
    act(() => button.click());
    expect(props.onDraftChange).toHaveBeenCalledWith(
      "Help me plan a change. Ask what I want to achieve and what context I can share.",
    );
    expect(document.activeElement?.id).toBe("cockpit-chat-draft");
    expect(container.querySelector('a[href^="/library/knowledge"]')).not.toBeNull();
  });
  it("lists the starters as plain secondary buttons, not bordered cards (CH-N23)", async () => {
    await mount();
    const list = container.querySelector('ul[aria-label="Starting prompts"]')!;
    expect(list).not.toBeNull();
    expect(list.className).not.toContain("grid");
    const buttons = [...list.querySelectorAll("li > button")];
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Explain this project",
      "Plan a change",
      "Draft or summarize",
    ]);
    for (const button of buttons) expect(button.className).not.toMatch(/\brounded-lg\b/);
  });
  it("sends Configure models to Get started while setup is unfinished", async () => {
    vi.mocked(fetchOnboardingState).mockResolvedValue({ ...onboardingFixture(), completed: false });
    await mount();
    await settle();
    expect(configureModelsHref()).toBe("/settings/first-run");
  });
  it("sends Configure models to the model settings once setup is finished", async () => {
    await mount();
    await settle();
    expect(configureModelsHref()).toBe("/settings/models");
  });
  it.each([
    ["not read yet", () => new Promise<OnboardingState>(() => {})],
    ["unreadable", () => Promise.reject(new Error("Gateway unavailable"))],
  ])("never sends Configure models to setup while setup is %s", async (_name, read) => {
    vi.mocked(fetchOnboardingState).mockImplementation(read);
    await mount();
    await settle();
    expect(configureModelsHref()).toBe("/settings/models");
  });
  it.each([{ draft: "keep this" }, { historicalReadOnly: true }, { sending: true }])(
    "never overwrites or starts work in a restricted state %o",
    async (overrides) => {
      const props = await mount(overrides);
      expect(container.querySelector("button")).toBeNull();
      expect(props.onDraftChange).not.toHaveBeenCalled();
    },
  );
});
