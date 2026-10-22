// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingState } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingFixture } from "../../../features/native-routes/settings/onboarding.test-support";
import { gatewayAuthSettingsFixture } from "../../../features/native-routes/settings/gateway-auth.test-support";
import { __resetOnboardingAttemptsForTests } from "../../../features/native-routes/settings/onboarding-completion-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { __resetApprovalModeUncertaintyForTests } from "./approval-mode-state";
import { FirstRunArea } from "./FirstRunArea";

const api = vi.hoisted(() => ({
  fetchOnboardingState: vi.fn(),
  completeOnboarding: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  fetchChangePlan: vi.fn(),
  navigate: vi.fn(),
  workspace: "workspace-a",
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: api.workspace }),
}));
const guided = vi.hoisted(() => ({ rendered: vi.fn() }));
vi.mock("./CockpitGuidedModelSetup", () => ({
  CockpitGuidedModelSetup: (props: { onEnterChat: () => void; enterChatLabel?: string }) => {
    guided.rendered(props);
    return (
      <button type="button" onClick={props.onEnterChat}>
        Guided model owner ready
      </button>
    );
  },
}));
vi.mock("./LlamaSetupSettings", () => ({
  LlamaSetupSettings: () => <p>Native llama setup editor</p>,
}));
vi.mock("./FirstRunDemo", () => ({
  FirstRunDemo: ({ workspaceId }: { workspaceId: string }) => <p>Local demo for {workspaceId}</p>,
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: api.navigate }) }));
let owner: OnboardingState, root: Root, container: HTMLDivElement, queryClient: QueryClient;
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
async function click(label: string) {
  await act(async () => button(label).click());
}
async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <FirstRunArea />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('nav[aria-label="Setup steps"]')).not.toBeNull());
}
async function safety() {
  await act(async () =>
    [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Step 2"))!.click(),
  );
  await vi.waitFor(() => expect(button("Keep current rule").disabled).toBe(false));
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
beforeEach(() => {
  vi.resetAllMocks();
  api.workspace = "workspace-a";
  owner = onboardingFixture();
  api.fetchOnboardingState.mockImplementation(async () => structuredClone(owner));
  api.fetchSettings.mockImplementation(async () => ({
    ...gatewayAuthSettingsFixture(),
    revision: owner.settings.revision,
    toolApprovalMode: owner.settings.toolApprovalMode,
  }));
  api.completeOnboarding.mockImplementation(async () => {
    owner = { ...owner, completed: true, completedAt: "2026-09-30T12:00:00.000Z", completedBy: "operator" };
    return { state: structuredClone(owner) };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
  __resetOnboardingAttemptsForTests();
  __resetSessionDraftsForTests();
  __resetSettingsChangesForTests();
  __resetApprovalModeUncertaintyForTests();
});

describe("native first-run setup", () => {
  it("keeps release-engineering readiness prose out of the first-answer model step", async () => {
    owner = {
      ...owner,
      setupReadiness: {
        ...owner.setupReadiness!,
        items: owner.setupReadiness!.items.map((item) =>
          item.id === "provider" ? { ...item, detail: "Check release evidence before public readiness claims" } : item,
        ),
      },
    };
    await render();
    expect(container.textContent).not.toContain("before public readiness claims");
    expect(container.textContent).not.toContain("Connection verified");
    expect(container.textContent).toContain("Send a Chat message after setup to check the first answer");
  });
  it("continues with an existing ready model without opening provider editors", async () => {
    await render();
    expect(button("Continue to safety").disabled).toBe(false);
    await click("Continue to safety");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Choose your safety settings");
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
  it("does not continue when the fresh model read loses readiness", async () => {
    await render();
    owner = {
      ...owner,
      setupReadiness: {
        ...owner.setupReadiness!,
        items: owner.setupReadiness!.items.map((item) =>
          item.id === "provider" ? { ...item, status: "blocked" as const } : item,
        ),
      },
    };
    await click("Continue to safety");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Choose a model");
    expect(button("Continue to safety").disabled).toBe(true);
    expect(container.querySelector("#first-run-finish-prerequisite")?.textContent).toContain("Connect a provider");
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
  it("explains pending completion and prevents a duplicate Finish", async () => {
    await render();
    await safety();
    await click("Keep current rule");
    const response = deferred<{ state: OnboardingState; appliedAt: string }>();
    api.completeOnboarding.mockReturnValueOnce(response.promise);
    await click("Finish setup and open Chat");
    expect(button("Confirming setup…").disabled).toBe(true);
    expect(container.querySelector("#first-run-finish-prerequisite")?.textContent).toContain("Wait for GoatCitadel");
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    owner = { ...owner, completed: true, completedAt: "2026-09-30T12:00:00.000Z", completedBy: "operator" };
    await act(async () => response.resolve({ state: owner, appliedAt: owner.completedAt! }));
  });
  it("connects through the guided model owner and moves on to safety when the model is ready", async () => {
    await render();
    expect(container.textContent).not.toContain("Guided model owner ready");
    await click("Use a cloud provider");
    expect(button("Guided model owner ready")).toBeDefined();
    expect(guided.rendered).toHaveBeenCalledWith(
      expect.objectContaining({ enterChatLabel: "Continue to safety", showSteps: false }),
    );
    await click("Advanced: edit provider profiles");
    expect(api.navigate).toHaveBeenCalledWith("/settings/models#providers");
    await click("Guided model owner ready");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Choose your safety settings");
    expect(button("Open Chat")).toBeUndefined();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });

  it("points to the one llama.cpp owner instead of mounting another copy (ST-08)", async () => {
    await render();
    const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "Models › Local AI")!;
    expect(link.getAttribute("href")).toBe("/settings/models#local-ai");
    expect(container.textContent).toContain("To run a local model instead, llama.cpp setup is on");
    expect(container.textContent).not.toContain("Native llama setup editor");
  });
  it("requires fresh safety review then exact owner completion before Chat", async () => {
    await render();
    expect(button("Finish setup and open Chat").disabled).toBe(true);
    expect(container.querySelector("#first-run-finish-prerequisite")?.textContent).toContain(
      "Review the current approval rule",
    );
    // The always-present prerequisite describes the disabled button; it is not a live region.
    expect(button("Finish setup and open Chat").getAttribute("aria-describedby")).toBe("first-run-finish-prerequisite");
    expect(container.querySelector("#first-run-finish-prerequisite")?.hasAttribute("role")).toBe(false);
    await safety();
    await click("Keep current rule");
    expect(api.fetchOnboardingState).toHaveBeenCalledTimes(2);
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(button("Finish setup and open Chat").disabled).toBe(false);
    await click("Finish setup and open Chat");
    expect(api.completeOnboarding).toHaveBeenCalledExactlyOnceWith("operator");
    expect(api.fetchOnboardingState).toHaveBeenCalledTimes(4);
    expect(api.navigate).toHaveBeenCalledExactlyOnceWith("/chat");
  });
  it("keeps completion disabled for a changed draft and never permits prompt skipping", async () => {
    await render();
    await safety();
    await click("Keep current rule");
    const select = container.querySelector("select")!;
    expect(select.querySelector<HTMLOptionElement>('option[value="bypass"]')!.disabled).toBe(true);
    await act(async () => {
      select.value = "approve_risky";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(button("Finish setup and open Chat").disabled).toBe(true);
    expect(button("Keep current rule").disabled).toBe(true);
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
  it("does not accept a late safety read after moving away and back", async () => {
    await render();
    await safety();
    const read = deferred<OnboardingState>();
    api.fetchOnboardingState.mockReturnValueOnce(read.promise);
    await act(async () => button("Keep current rule").click());
    await act(async () =>
      [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Step 1"))!.click(),
    );
    await act(async () =>
      [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Step 2"))!.click(),
    );
    await act(async () => read.resolve(owner));
    expect(button("Finish setup and open Chat").disabled).toBe(true);
  });
  it("withholds cached setup authority when its owner refresh fails", async () => {
    await render();
    api.fetchOnboardingState.mockRejectedValueOnce(new Error("owner unavailable"));
    await click("Refresh checks");
    await vi.waitFor(() => expect(container.textContent).toContain("Setup state unavailable"));
    expect(container.textContent).not.toContain("Configured for a first send");
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
  it("preserves an uncertain completion lock after a native remount", async () => {
    api.completeOnboarding.mockRejectedValue(new Error("response lost"));
    await render();
    await safety();
    await click("Keep current rule");
    await click("Finish setup and open Chat");
    expect(container.textContent).toContain("Setup completion is uncertain");
    await act(async () => root.render(null));
    await render();
    expect(container.textContent).toContain("Setup completion is uncertain");
    expect(button("Finish setup and open Chat").disabled).toBe(true);
    expect(api.navigate).not.toHaveBeenCalled();
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
  });
  it("shows only canonical first-task verification after returning from Chat", async () => {
    owner = {
      ...owner,
      completed: true,
      completedAt: "2026-09-30T00:00:00.000Z",
      completedBy: "operator",
      firstTask: {
        status: "verified",
        checkedAt: "2026-09-30T00:00:00.000Z",
        completedAt: "2026-09-30T00:00:00.000Z",
        sessionId: "s",
        turnId: "t",
        providerId: "provider-a",
        model: "model-a",
      },
    };
    await render();
    const steps = container.querySelectorAll('nav[aria-label="Setup steps"] button');
    expect(steps[1]?.textContent).toContain("Done");
    expect(steps[2]?.textContent).toContain("Done");
    await act(async () => (steps[2] as HTMLButtonElement).click());
    expect(container.textContent).toContain("Your first Chat answer is recorded");
    expect(button("Finish setup and open Chat")).toBeUndefined();
  });
  it("opens a recorded setup on the test message, with finished steps collapsed to summaries (VR-05)", async () => {
    owner = { ...owner, completed: true, completedAt: "2026-09-30T00:00:00.000Z", completedBy: "operator" };
    await render();
    const steps = [...container.querySelectorAll('nav[aria-label="Setup steps"] button')];
    expect(steps.map((step) => step.getAttribute("aria-current"))).toEqual([null, null, "step"]);
    expect(steps[0]?.textContent).toContain("DoneChoose a modelmodel-a · Provider A");
    expect(steps[1]?.textContent).toContain("Tool approval:");
    expect(steps[2]?.textContent).toContain("Current");
    expect(steps.map((step) => step.textContent)).not.toContainEqual(expect.stringContaining("Open"));
    expect(button("Continue to safety")).toBeUndefined();
    expect(container.textContent).not.toContain("Setup is already recorded");
    const primaries = [...container.querySelectorAll("button")].filter((item) => item.className.includes("bg-accent"));
    expect(primaries.map((item) => item.textContent)).toEqual(["Open Chat to send a test message"]);
    // The primary sits in the action row beside Refresh checks (ST-N04).
    expect(button("Open Chat to send a test message")!.parentElement).toBe(button("Refresh checks")!.parentElement);
    await click("Open Chat to send a test message");
    expect(api.navigate).toHaveBeenCalledExactlyOnceWith("/chat");
  });
  it("explains why the test message waits for setup (ST-18)", async () => {
    await render();
    await act(async () =>
      [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Step 3"))!.click(),
    );
    const send = button("Send a test message");
    expect(send.disabled).toBe(true);
    expect(document.getElementById(send.getAttribute("aria-describedby")!)?.textContent).toContain(
      "Finish setup first",
    );
  });
  it("offers a cloud provider and the demo first, as one flat stepper (ST-03)", async () => {
    await render();
    const choices = [...container.querySelectorAll('[role="group"][aria-label="How to start"] button')];
    expect(choices.map((item) => item.textContent)).toEqual(["Use a cloud provider", "Try the demo"]);
    expect(button("Explore sample records")).toBeUndefined();
    await click("Try the demo");
    expect(container.textContent).toContain("Local demo for workspace-a");
    await click("Use a cloud provider");
    expect(container.textContent).not.toContain("Local demo for workspace-a");
    expect(guided.rendered).toHaveBeenLastCalledWith(expect.objectContaining({ showSteps: false }));
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("lists the steps as a flat ordered list, not a card grid (ST-R05)", async () => {
    await render();
    const list = container.querySelector('nav[aria-label="Setup steps"] ol');
    expect(list).not.toBeNull();
    for (const step of list!.querySelectorAll("button")) expect(step.className).not.toMatch(/rounded-lg|bg-raised/);
  });
  it("Exit setup returns to Settings › Models › Get started (ST-N23)", async () => {
    await render();
    await click("Exit setup");
    expect(api.navigate).toHaveBeenCalledWith("/settings/models#onboarding");
  });
  it("names the setup page Get started, as the header link and the tab do (ST-N05)", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Get started");
  });
});
