// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlamaCppSetupFlow } from "./LlamaCppSetupFlow";

const api = vi.hoisted(() => ({
  fetchLlamaCppSetup: vi.fn(),
  previewLlmModels: vi.fn(),
  stageLlamaCppManagedSelection: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  resolveApproval: vi.fn(),
  testLlamaCppChat: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const roots: ReturnType<typeof createRoot>[] = [];
const projection = {
  settingsRevision: 8,
  managementMode: "external",
  baseUrl: "http://127.0.0.1:8080/v1",
  runtime: { healthy: true },
  ownership: "external",
  binary: { found: true, label: "llama-server.exe" },
  models: [{ modelId: "Local Model.gguf", label: "Local Model.gguf", source: "filesystem" }],
  catalog: { status: "fresh", modelIds: ["served-model"] },
  chatRoute: { providerId: "openai", model: "old-model", thinkingLevel: "standard" },
};
beforeEach(() => {
  vi.resetAllMocks();
  api.fetchLlamaCppSetup.mockResolvedValue(projection);
  api.previewLlmModels.mockResolvedValue({ source: "live", items: [{ id: "served-model" }] });
  api.stageLlamaCppManagedSelection.mockResolvedValue({ selectionId: "selection-1", alias: "Local-Model" });
  api.createChangePlan.mockResolvedValue({
    planId: "plan-1",
    revision: 1,
    requiredAction: { kind: "confirmation", actionNonce: "nonce-1" },
  });
  api.confirmChangePlan.mockResolvedValue({
    planId: "plan-1",
    revision: 3,
    createdAt: "2026-09-27T17:00:00.000Z",
    origin: { workspaceId: "default" },
    status: "awaiting_approval",
    summary: "Use the selected server and model.",
    impact: "Change Chat default after runtime verification.",
    requiredAction: { kind: "approval", approvalId: "approval-1" },
  });
  api.fetchChangePlan.mockResolvedValue({
    planId: "plan-1",
    revision: 3,
    createdAt: "2026-09-27T17:00:00.000Z",
    origin: { workspaceId: "default" },
    status: "awaiting_approval",
    requiredAction: { kind: "approval", approvalId: "approval-1" },
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      <LlamaCppSetupFlow
        workspaceId="default"
        route={{ area: "settings", section: "onboarding", theme: "dark" }}
        navigate={navigate}
      />,
    ),
  );
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === label) as HTMLButtonElement;
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  return { host, button, click, navigate };
}

describe("LlamaCppSetupFlow", () => {
  it("restores the completed setup, current URL, and live Chat model after reopening", async () => {
    api.fetchLlamaCppSetup.mockResolvedValueOnce({
      ...projection,
      baseUrl: "http://127.0.0.1:9901/v1",
      chatRoute: { providerId: "llamacpp", model: "served-model", thinkingLevel: "off" },
      recentPlan: { planId: "plan-done", revision: 6, status: "completed" },
    });
    api.fetchChangePlan.mockResolvedValueOnce({
      planId: "plan-done",
      revision: 6,
      status: "completed",
      result: { summary: "llama.cpp served-model is selected for Chat." },
    });
    const view = await mount();
    expect(view.host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe("http://127.0.0.1:9901/v1");
    expect(view.host.querySelector<HTMLSelectElement>("select")?.value).toBe("served-model");
    expect(view.host.textContent).toContain("Completed");
  });

  it("keeps an edited URL when the initial setup projection arrives late", async () => {
    let finishLoad!: (value: typeof projection) => void;
    api.fetchLlamaCppSetup.mockReturnValueOnce(
      new Promise((resolve) => {
        finishLoad = resolve;
      }),
    );
    const view = await mount();
    const url = view.host.querySelector<HTMLInputElement>('input[type="url"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(url, "http://127.0.0.1:9900/v1");
      url.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => finishLoad(projection));
    expect(url.value).toBe("http://127.0.0.1:9900/v1");
  });

  it("keeps a newly submitted approval when an older setup lookup finishes late", async () => {
    api.fetchLlamaCppSetup.mockResolvedValueOnce({
      ...projection,
      recentPlan: { planId: "plan-old", revision: 6, status: "completed" },
    });
    let resolveOldPlan!: (value: unknown) => void;
    api.fetchChangePlan.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOldPlan = resolve;
      }),
    );
    const view = await mount();
    await view.click("Check server");
    await view.click("Finish setup");
    expect(view.host.textContent).toContain("Awaiting approval");
    await act(async () =>
      resolveOldPlan({
        planId: "plan-old",
        revision: 6,
        createdAt: "2026-09-27T16:00:00.000Z",
        origin: { workspaceId: "default" },
        status: "completed",
      }),
    );
    expect(view.host.textContent).toContain("Awaiting approval");
    expect(view.button("Approve and apply")).toBeTruthy();
  });

  it("accepts only live external models, then reviews and approves one plan inline", async () => {
    const view = await mount();
    expect(view.button("Finish setup").disabled).toBe(true);
    api.previewLlmModels.mockResolvedValueOnce({ source: "error_fallback", items: [{ id: "template-alias" }] });
    await view.click("Check server");
    expect(view.host.textContent).toContain("template aliases are not selectable");
    expect(view.button("Finish setup").disabled).toBe(true);
    api.previewLlmModels.mockResolvedValueOnce({
      source: "live",
      catalogStatus: "stale",
      items: [{ id: "last-known-model" }],
    });
    await view.click("Check server");
    expect(view.button("Finish setup").disabled).toBe(true);
    api.previewLlmModels.mockResolvedValueOnce({ source: "live", items: [] });
    await view.click("Check server");
    expect(view.host.textContent).toContain("model list is empty");
    expect(view.button("Finish setup").disabled).toBe(true);
    await view.click("Check server");
    const model = view.host.querySelector("select")!;
    await act(async () => {
      model.value = "served-model";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.click("Finish setup");
    expect(api.createChangePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          kind: "runtime_configuration",
          change: expect.objectContaining({
            operation: "llama_cpp_setup",
            managementMode: "external",
            model: "served-model",
          }),
        },
      }),
    );
    expect(api.confirmChangePlan).toHaveBeenCalledTimes(1);
    expect(view.host.textContent).toContain("Awaiting approval");
    await view.click("Approve and apply");
    expect(api.resolveApproval).toHaveBeenCalledWith("approval-1", "approve");
  });

  it("stages managed files by opaque id and never sends host paths in the plan", async () => {
    const view = await mount();
    const radios = view.host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    await act(async () => {
      radios[1]!.click();
    });
    const model = view.host.querySelector("select")!;
    await act(async () => {
      model.value = "Local Model.gguf";
      model.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.click("Finish setup");
    expect(api.stageLlamaCppManagedSelection).toHaveBeenCalledWith({
      workspaceId: "default",
      modelId: "Local Model.gguf",
    });
    const request = api.createChangePlan.mock.calls[0]![0];
    expect(request.request.change).toMatchObject({
      managementMode: "managed",
      selectionId: "selection-1",
      model: "Local-Model",
      autoStart: true,
    });
    expect(JSON.stringify(request)).not.toContain("C:\\");
  });
});
