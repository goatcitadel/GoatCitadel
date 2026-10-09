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
  LlamaSetupSettings: ({ workspaceId }: { workspaceId?: string }) => <p>Native llama setup for {workspaceId}</p>,
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
  await vi.waitFor(() => expect(container.textContent).toContain("Configured for a first send"));
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
    owner = { ...owner, setupReadiness: { ...owner.setupReadiness!, items: owner.setupReadiness!.items.map((item) => item.id === "provider" ? { ...item, detail: "Check release evidence before public readiness claims" } : item) } };
    await render();
    expect(container.textContent).not.toContain("before public readiness claims");
    expect(container.textContent).not.toContain("Connection verified");
    expect(container.textContent).toContain("Send a Chat message after setup to check the first answer");
  });
  it("continues with an existing ready model without opening provider editors", async () => {
    await render();
    expect(button("Continue to safety").disabled).toBe(false);
    await click("Continue to safety");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Set your safety posture");
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });
  it("does not continue when the fresh model read loses readiness", async () => {
    await render();
    owner = { ...owner, setupReadiness: { ...owner.setupReadiness!, items: owner.setupReadiness!.items.map((item) => item.id === "provider" ? { ...item, status: "blocked" as const } : item) } };
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
    expect(container.querySelector("#first-run-finish-prerequisite")?.textContent).toContain("Wait for the Gateway");
    expect(api.completeOnboarding).toHaveBeenCalledTimes(1);
    owner = { ...owner, completed: true, completedAt: "2026-09-30T12:00:00.000Z", completedBy: "operator" };
    await act(async () => response.resolve({ state: owner, appliedAt: owner.completedAt! }));
  });
  it("connects through the guided model owner and moves on to safety when the model is ready", async () => {
    await render();
    expect(container.textContent).not.toContain("Guided model owner ready");
    await click("Connect a provider");
    expect(button("Guided model owner ready")).toBeDefined();
    expect(guided.rendered).toHaveBeenCalledWith(expect.objectContaining({ enterChatLabel: "Continue to safety" }));
    await click("Advanced: edit provider profiles");
    expect(api.navigate).toHaveBeenCalledWith("/settings/models?shell=cockpit#providers");
    await click("Guided model owner ready");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Set your safety posture");
    expect(button("Open Chat")).toBeUndefined();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });

  it("still offers the local llama.cpp setup", async () => {
    await render();
    await click("Configure llama.cpp");
    expect(container.textContent).toContain("Native llama setup for workspace-a");
  });
  it("requires fresh safety review then exact owner completion before Chat", async () => {
    await render();
    expect(button("Finish setup and open Chat").disabled).toBe(true);
    expect(container.querySelector("#first-run-finish-prerequisite")?.textContent).toContain("Review the current approval rule");
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
    expect(container.textContent).toContain("Your first provider-backed Chat response is recorded");
    expect(button("Finish setup and open Chat")).toBeUndefined();
  });
});
