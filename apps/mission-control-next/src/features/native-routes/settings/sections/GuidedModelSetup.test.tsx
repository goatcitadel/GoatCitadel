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
async function mount(
  status = "ready",
  reload = vi.fn(async () => {}),
  provider: {
    providerId?: string;
    label?: string;
    baseUrl?: string;
    defaultModel?: string;
    capabilities?: object;
  } = {},
) {
  mocks.catalog.mockReturnValue({
    providers: [
      {
        providerId: "test",
        label: "Test provider",
        hasApiKey: true,
        authReadiness: { status },
        defaultModel: "test-model",
        ...provider,
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
        onboarding={
          {
            settings: { llm: { activeProviderId: provider.providerId ?? "test", activeModel: "test-model" } },
          } as OnboardingState
        }
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
    changeWorkspace: async (workspaceId: string) => {
      await act(async () => render(workspaceId));
    },
    unmount: async () => {
      roots.splice(roots.indexOf(root), 1);
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const LLAMA_CPP = {
  providerId: "llamacpp",
  label: "llama.cpp",
  baseUrl: "http://127.0.0.1:8080/v1",
  defaultModel: "gemma-4-local",
  hasApiKey: false,
  localCostPosture: "zero_cost_local_runtime",
  capabilities: { reasoning: false },
};

async function mountFirstRun(providers: object[], activeProviderId = "") {
  mocks.catalog.mockReturnValue({
    providers,
    config: { defaultThinkingLevel: "standard" },
    loadModelsForProvider: mocks.models,
    loading: false,
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      <GuidedModelSetup
        workspaceId={`first-run-${activeProviderId || "none"}`}
        onboarding={{ settings: { llm: { activeProviderId, activeModel: "" } } } as OnboardingState}
        route={{ area: "settings", section: "onboarding", theme: "dark" }}
        navigate={vi.fn()}
        reloadOnboarding={vi.fn(async () => {})}
        setNotice={vi.fn()}
      />,
    ),
  );
  const button = (name: string) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);
  return { host, button };
}

describe("first-run readiness truth", () => {
  it("does not silently preselect an unverified local runtime for a new user", async () => {
    const view = await mountFirstRun([
      { ...LLAMA_CPP, modelProbeState: "not_checked" },
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        hasApiKey: false,
      },
    ]);
    const providerSelect = view.host.querySelector("select")!;
    expect(providerSelect.value).toBe("");
    expect(providerSelect.options[0]?.textContent).toBe("Choose a provider or local runtime");
    expect(view.host.querySelector(".mc-next-settings-wizard-step.complete")).toBeNull();
    expect(view.host.textContent).toContain("Not chosen");
    expect(mocks.models).not.toHaveBeenCalled();
  });

  it("shows an unreachable local runtime as not verified and re-checks its endpoint", async () => {
    const view = await mountFirstRun(
      [
        {
          ...LLAMA_CPP,
          modelProbeState: "fallback",
          modelProbeSource: "error_fallback",
          modelProbeWarning: "llama.cpp runtime is disabled in assistant config",
        },
      ],
      "llamacpp",
    );
    expect(view.host.querySelector(".mc-next-settings-wizard-step.complete")).toBeNull();
    expect(view.host.textContent).toContain("Not verified");
    expect(view.host.textContent).toContain("llama.cpp runtime is disabled in assistant config");
    expect(view.button("Confirm model")).toBeUndefined();
    await act(async () => view.button("Check connection")!.click());
    expect(mocks.models).toHaveBeenCalledWith("llamacpp", { force: true });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("marks a local runtime connected only after its endpoint answers a live probe", async () => {
    mocks.models.mockResolvedValue(["gemma-4-local"]);
    const view = await mountFirstRun(
      [{ ...LLAMA_CPP, modelProbeState: "ready", modelProbeSource: "live" }],
      "llamacpp",
    );
    const firstStep = view.host.querySelector(".mc-next-settings-wizard-step");
    expect(firstStep?.classList.contains("complete")).toBe(true);
    expect(firstStep?.textContent).toContain("llama.cpp answered at http://127.0.0.1:8080/v1.");
    await act(async () => view.button("Confirm model")!.click());
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          kind: "installation_default_model",
          providerId: "llamacpp",
          model: "gemma-4-local",
          thinkingLevel: "off",
        },
      }),
    );
  });
});

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
  it("submits Off effort and guides setup for a local runtime without reasoning support", async () => {
    mocks.models.mockResolvedValue(["gemma-4-local"]);
    const view = await mount("missing", undefined, {
      providerId: "llamacpp",
      label: "llama.cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      defaultModel: "gemma-4-local",
      capabilities: { reasoning: false },
    });
    expect(view.host.textContent).toContain("Start llama.cpp before connecting");
    expect(view.host.textContent).toContain("does not report reasoning effort");
    const effort = [...view.host.querySelectorAll("select")].find((select) => select.value === "off")!;
    expect([...effort.options].map((option) => option.value)).toEqual(["off"]);
    await view.unmount();
    const ready = await mount("ready", undefined, {
      providerId: "llamacpp",
      label: "llama.cpp",
      baseUrl: "http://127.0.0.1:8080/v1",
      defaultModel: "gemma-4-local",
      capabilities: { reasoning: false },
    });
    const modelSelect = [...ready.host.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "gemma-4-local"),
    )!;
    await act(async () => {
      modelSelect.value = "gemma-4-local";
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => ready.button("Confirm model")!.click());
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          kind: "installation_default_model",
          providerId: "llamacpp",
          model: "gemma-4-local",
          thinkingLevel: "off",
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
    mocks.complete.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
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
    const reload = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
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
    mocks.create.mockReturnValueOnce(
      new Promise<ChangePlanRecord>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const view = await mount("missing");
    await act(async () => view.button("Connect provider")!.click());
    await view.changeWorkspace("other-workspace");
    await act(async () => {
      if (outcome === "error") reject(new Error("Old workspace failure"));
      else
        resolve({
          planId: "old-plan",
          status: "awaiting_confirmation",
          origin: { workspaceId: "default" },
          request: { kind: "provider_connection", providerId: "test" },
        } as ChangePlanRecord);
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
