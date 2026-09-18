import { __resetSessionDraftsForTests } from "../../library/session-drafts";
// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord, OnboardingState } from "@goatcitadel/contracts";
import { GuidedModelSetup } from "./GuidedModelSetup";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  models: vi.fn(),
  plans: vi.fn(),
  create: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: mocks.catalog,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChangePlans: mocks.plans,
  createChangePlan: mocks.create,
  completeOnboarding: mocks.complete,
  cancelChangePlan: vi.fn(),
  completeChangePlanProviderOAuth: vi.fn(),
  confirmChangePlan: vi.fn(),
  pollChangePlanProviderOAuth: vi.fn(),
  respondToChangePlan: vi.fn(),
  startChangePlanProviderOAuth: vi.fn(),
  submitChangePlanProviderSecret: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: () => null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanCard", () => ({
  ChatChangePlanCard: () => null,
}));

const roots: ReturnType<typeof createRoot>[] = [];
beforeEach(() => {
  __resetSessionDraftsForTests();
  vi.resetAllMocks();
  mocks.models.mockResolvedValue(["test-model"]);
  mocks.plans.mockResolvedValue({ items: [] });
  mocks.create.mockImplementation(async (input) => ({
    planId: "plan-1",
    status: "awaiting_confirmation",
    origin: { workspaceId: "default" },
    request: input.request,
  }));
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
async function mount(status = "ready", reload = vi.fn(async () => {})) {
  mocks.catalog.mockReturnValue({
    providers: [
      {
        providerId: "test",
        label: "Test provider",
        hasApiKey: true,
        authReadiness: { status },
        defaultModel: "test-model",
      },
    ],
    config: { defaultThinkingLevel: "standard" },
    loadModelsForProvider: mocks.models,
    loading: false,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const navigate = vi.fn();
  const notice = vi.fn();
  const render = (workspaceId: string) =>
    root.render(
      <GuidedModelSetup
        workspaceId={workspaceId}
        onboarding={{ settings: { llm: { activeProviderId: "test", activeModel: "test-model" } } } as OnboardingState}
        route={{ area: "settings", section: "onboarding", theme: "dark" }}
        navigate={navigate}
        reloadOnboarding={reload}
        setNotice={notice}
      />,
    );
  await act(async () => render("default"));
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);
  return {
    host,
    button,
    navigate,
    notice,
    reload,
    changeWorkspace: async (workspaceId: string) => { await act(async () => render(workspaceId)); },
    unmount: async () => {
      roots.splice(roots.indexOf(root), 1);
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("guided first model setup", () => {
  it("requires connection when a saved default has missing or rejected credentials", async () => {
    const view = await mount("missing");
    expect(view.button("Enter Chat")).toBeUndefined();
    await act(async () => view.button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ request: { kind: "provider_connection", providerId: "test" } }),
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("requires model confirmation after changing the saved effort", async () => {
    const view = await mount();
    expect(view.button("Enter Chat")).toBeDefined();
    const effort = [...view.host.querySelectorAll("select")].find((select) => select.value === "standard")!;
    await act(async () => {
      effort.value = "extended";
      effort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(view.button("Enter Chat")).toBeUndefined();
    await act(async () => view.button("Confirm model")!.click());
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          kind: "installation_default_model",
          providerId: "test",
          model: "test-model",
          thinkingLevel: "extended",
        },
      }),
    );
  });
  it("refreshes onboarding before navigation and preserves a failed refresh as an error", async () => {
    const reload = vi.fn(async () => {
      throw new Error("State refresh failed");
    });
    const view = await mount("ready", reload);
    await act(async () => view.button("Enter Chat")!.click());
    expect(mocks.complete).toHaveBeenCalledWith("operator");
    expect(view.navigate).not.toHaveBeenCalled();
    expect(view.notice).toHaveBeenCalledWith({ tone: "error", message: "State refresh failed" });
  });
  it.each(["unmount", "workspace change"])("ignores late Chat entry after %s", async (interruption) => {
    let resolve!: () => void;
    mocks.complete.mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    const view = await mount();
    await act(async () => view.button("Enter Chat")!.click());
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    if (interruption === "unmount") await view.unmount();
    else await view.changeWorkspace("other-workspace");
    await act(async () => resolve());
    expect(view.reload).not.toHaveBeenCalled();
    expect(view.navigate).not.toHaveBeenCalled();
    expect(view.notice).not.toHaveBeenCalled();
    if (interruption === "workspace change") expect(view.button("Enter Chat")?.disabled).toBe(false);
  });
  it("does not navigate when the screen closes during the onboarding refresh", async () => {
    let resolve!: () => void;
    const reload = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const view = await mount("ready", reload);
    await act(async () => view.button("Enter Chat")!.click());
    expect(reload).toHaveBeenCalledTimes(1);
    await view.unmount();
    await act(async () => resolve());
    expect(view.navigate).not.toHaveBeenCalled();
  });
  it.each(["receipt", "error"])("ignores a prior workspace's late plan %s", async (outcome) => {
    let resolve!: (value: ChangePlanRecord) => void;
    let reject!: (reason: Error) => void;
    mocks.create.mockReturnValueOnce(new Promise<ChangePlanRecord>((done, fail) => { resolve = done; reject = fail; }));
    const view = await mount("missing");
    await act(async () => view.button("Connect provider")!.click());
    await view.changeWorkspace("other-workspace");
    await act(async () => {
      if (outcome === "error") reject(new Error("Old workspace failure"));
      else resolve({ planId: "old-plan", status: "awaiting_confirmation", origin: { workspaceId: "default" },
        request: { kind: "provider_connection", providerId: "test" } } as ChangePlanRecord);
    });
    expect(view.host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => view.button("Connect provider")!.click());
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "other-workspace" }));
  });
  it("retains effort through unmount and catalog reload and does not duplicate a pending setup plan", async () => {
    const view = await mount();
    const effort = [...view.host.querySelectorAll("select")].find((select) => select.value === "standard")!;
    await act(async () => {
      effort.value = "extended";
      effort.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.unmount();
    const reopened = await mount();
    expect([...reopened.host.querySelectorAll("select")].some((select) => select.value === "extended")).toBe(true);
    await act(async () => reopened.button("Confirm model")!.click());
    await act(async () => reopened.button("Confirm model")!.click());
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
  it("shows model-catalog failures without an unhandled rejection", async () => {
    mocks.models.mockRejectedValue(new Error("Catalog unavailable"));
    const view = await mount();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe("Catalog unavailable");
    expect(view.host.textContent).toContain("Not yet verified");
  });
});
