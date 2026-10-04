// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";

const guided = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock("../../../features/native-routes/settings/sections/GuidedModelSetup", () => ({
  GuidedModelSetup: (props: object) => {
    guided.rendered(props);
    return null;
  },
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: undefined }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));

let root: Root, container: HTMLDivElement;
const onboarding = onboardingFixture();
const reloadOnboarding = async () => {};
const onEnterChat = () => {};
const mountGuided = (enterChatLabel?: string) =>
  act(async () => {
    root.render(
      <CockpitGuidedModelSetup
        onboarding={onboarding}
        reloadOnboarding={reloadOnboarding}
        onEnterChat={onEnterChat}
        enterChatLabel={enterChatLabel}
      />,
    );
  });
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("shared guided model setup", () => {
  it("passes the host's wiring and its own button label to the guided owner", async () => {
    await mountGuided("Continue to safety");
    expect(guided.rendered).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        onboarding,
        reloadOnboarding,
        onEnterChat,
        enterChatLabel: "Continue to safety",
      }),
    );
  });
  it("leaves the guided owner's own button text when the host gives no label", async () => {
    await mountGuided();
    expect(guided.rendered.mock.lastCall?.[0].enterChatLabel).toBeUndefined();
  });
});
