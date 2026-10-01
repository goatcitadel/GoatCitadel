// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { LlamaCppSetupFlow } from "./LlamaCppSetupFlow";
import { LlamaSetupSettings } from "@next/cockpit/areas/settings/LlamaSetupSettings";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetLlamaSetupForTests, type LlamaSetupChange } from "../llama-setup-state";
import { awaitingLlamaApproval, deferredLlama, llamaPlanFixture, llamaProjectionFixture } from "../llama-setup.test-support";
const api = vi.hoisted(() => ({
  fetchLlamaCppSetup: vi.fn(),
  previewLlmModels: vi.fn(),
  stageLlamaCppManagedSelection: vi.fn(),
  createChangePlan: vi.fn(),
  confirmChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  testLlamaCppChat: vi.fn(),
  fetchApprovalReplay: vi.fn(),
  respondToChangePlan: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "fixture-gateway",
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@next/cockpit/app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate }) }));
const roots: ReturnType<typeof createRoot>[] = [];
let plan: ChangePlanRecord;
beforeEach(() => {
  vi.resetAllMocks();
  __resetLlamaSetupForTests();
  __resetSessionDraftsForTests();
  plan = llamaPlanFixture(undefined, "default");
  api.fetchLlamaCppSetup.mockResolvedValue(llamaProjectionFixture());
  api.previewLlmModels.mockResolvedValue({ source: "live", items: [{ id: "served-model" }] });
  api.stageLlamaCppManagedSelection.mockResolvedValue({
    selectionId: "selection-1",
    modelId: "Local Model.gguf",
    alias: "Local-Model",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  api.createChangePlan.mockImplementation(async (input: { request: { change: LlamaSetupChange } }) => {
    plan = llamaPlanFixture(input.request.change, "default");
    return structuredClone(plan);
  });
  api.fetchChangePlan.mockImplementation(async () => structuredClone(plan));
  api.confirmChangePlan.mockImplementation(async () => {
    plan = awaitingLlamaApproval(plan);
    return structuredClone(plan);
  });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  __resetSessionDraftsForTests();
  __resetLlamaSetupForTests();
});
async function mount(native = false, workspaceId: string | undefined = "default") {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      native ? (
        <LlamaSetupSettings workspaceId={workspaceId} />
      ) : (
        <LlamaCppSetupFlow
          workspaceId={workspaceId!}
          route={{ area: "settings", section: "onboarding", theme: "dark" }}
          navigate={navigate}
        />
      ),
    ),
  );
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
  const click = async (label: string) => {
    expect(button(label), label).toBeTruthy();
    await act(async () => button(label).click());
  };
  return { root, host, button, click };
}
describe("classic and native llama.cpp setup", () => {
  it.each([false, true])(
    "reviews external setup and hands approval to its existing owner (native=%s)",
    async (native) => {
      const view = await mount(native);
      expect(view.button("Finish setup").disabled).toBe(true);
      api.previewLlmModels.mockResolvedValueOnce({ source: "error_fallback", items: [{ id: "template-alias" }] });
      await view.click("Check server");
      expect(view.host.textContent).toContain("template aliases are not selectable");
      expect(view.button("Finish setup").disabled).toBe(true);
      await view.click("Check server");
      await view.click("Finish setup");
      expect(document.body.textContent).toContain("Host paths remain with the Gateway");
      expect(api.createChangePlan).not.toHaveBeenCalled();
      await view.click("Keep current llama.cpp setup");
      expect(api.createChangePlan).not.toHaveBeenCalled();
      await view.click("Finish setup");
      await view.click("Prepare reviewed setup");
      expect(api.confirmChangePlan).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain("Awaiting confirmation");
      await view.click("Review recorded setup");
      await view.click("Confirm reviewed setup plan");
      expect(view.host.textContent).toContain("Awaiting approval");
      expect(view.button("Approve and apply")).toBeUndefined();
      if (native) {
        const link = view.host.querySelector<HTMLAnchorElement>('a[aria-label="Open approval details"]');
        expect(link?.getAttribute("href")).toBe("/ops/approvals?approvalId=approval-1&shell=classic");
        expect(navigate).not.toHaveBeenCalled();
      } else {
        await view.click("Open approval details");
        expect(navigate).toHaveBeenCalledWith({ area: "ops", section: "approvals", approvalId: "approval-1", theme: "dark" });
      }
      expect(api.respondToChangePlan).not.toHaveBeenCalled();
      if (native) expect(view.button("Check server").className).not.toContain("mc-next-button");
    },
  );
  it.each([false, true])(
    "retains an unverified model across a shell remount before and after saved evidence loads (native=%s)",
    async (native) => {
      const view = await mount(native);
      const endpoint = "http://127.0.0.1:9090/v1";
      const input = view.host.querySelector<HTMLInputElement>('input[type="url"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, endpoint);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await view.click("Check server");
      expect(api.previewLlmModels).toHaveBeenCalledExactlyOnceWith({ providerId: "llamacpp", baseUrl: endpoint });
      expect(view.host.querySelector<HTMLSelectElement>("select")?.value).toBe("served-model");
      expect(view.button("Finish setup").disabled).toBe(false);
      await act(async () => view.root.render(null));

      const pending = deferredLlama<ReturnType<typeof llamaProjectionFixture>>();
      api.fetchLlamaCppSetup.mockReturnValueOnce(pending.promise);
      const returned = await mount(!native);
      const select = returned.host.querySelector<HTMLSelectElement>("select")!;
      expect(returned.host.textContent).toContain("Loading setup evidence");
      expect(select.value).toBe("served-model");
      expect(select.selectedOptions[0]?.textContent).toContain("not currently verified");
      expect(select.selectedOptions[0]?.disabled).toBe(true);
      expect(returned.host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(endpoint);
      expect(returned.button("Finish setup").disabled).toBe(true);
      expect(api.previewLlmModels).toHaveBeenCalledTimes(1);

      // The saved owner still points elsewhere; waiting for that GET cannot verify the draft endpoint.
      await act(async () => pending.resolve(llamaProjectionFixture()));
      expect(returned.host.textContent).not.toContain("Loading setup evidence");
      expect(select.value).toBe("served-model");
      expect(select.selectedOptions[0]?.disabled).toBe(true);
      expect(returned.host.textContent).toContain("The selected model is retained but is not in the current verified catalog.");
      expect(returned.host.textContent).toContain("Unsaved llama.cpp setup draft");
      expect(returned.button("Finish setup").disabled).toBe(true);
      expect(api.previewLlmModels).toHaveBeenCalledTimes(1);
      expect(api.createChangePlan).not.toHaveBeenCalled();
      expect(api.confirmChangePlan).not.toHaveBeenCalled();
      expect(api.stageLlamaCppManagedSelection).not.toHaveBeenCalled();
      expect(api.testLlamaCppChat).not.toHaveBeenCalled();

      await returned.click("Check server");
      expect(api.previewLlmModels).toHaveBeenLastCalledWith({ providerId: "llamacpp", baseUrl: endpoint });
      expect(api.previewLlmModels).toHaveBeenCalledTimes(2);
      expect(select.value).toBe("served-model");
      expect(select.selectedOptions[0]?.disabled).toBe(false);
      expect(returned.button("Finish setup").disabled).toBe(false);
      expect(returned.host.textContent).not.toContain("not in the current verified catalog");
      expect(api.createChangePlan).not.toHaveBeenCalled();
    },
  );
  it("stages managed files only after review and sends no host paths in the plan", async () => {
    const view = await mount();
    await act(async () => view.host.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click());
    const select = view.host.querySelector("select")!;
    await act(async () => {
      select.value = "Local Model.gguf";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.click("Finish setup");
    expect(api.stageLlamaCppManagedSelection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Managed setup can start llama-server");
    await view.click("Prepare reviewed setup");
    expect(api.stageLlamaCppManagedSelection).toHaveBeenCalledWith({
      workspaceId: "default",
      modelId: "Local Model.gguf",
    });
    const request = api.createChangePlan.mock.calls[0]![0];
    expect(request.request.change).toEqual({
      operation: "llama_cpp_setup",
      managementMode: "managed",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "Local-Model",
      selectionId: "selection-1",
      autoStart: true,
    });
    expect(JSON.stringify(request)).not.toMatch(/commandPath|modelPath/);
  });
  it("restores owner-backed completion separately from an unexecuted Chat test", async () => {
    const projection = llamaProjectionFixture();
    plan = {
      ...plan,
      revision: 6,
      status: "completed",
      phase: "terminal",
      requiredAction: undefined,
      result: { summary: "llama.cpp served-model is selected for Chat." },
    };
    api.fetchLlamaCppSetup.mockResolvedValue({
      ...projection,
      settingsRevision: 10,
      chatRoute: { providerId: "llamacpp", model: "served-model", thinkingLevel: "off" },
      recentPlan: { planId: plan.planId, revision: 6, status: "completed" },
    });
    const view = await mount();
    expect(view.host.querySelector<HTMLSelectElement>("select")?.value).toBe("served-model");
    expect(view.host.textContent).toContain("Completed");
    expect(view.host.textContent).toContain("has not been proven by setup alone");
    await view.click("Send test message");
    expect(document.body.textContent).toContain("hidden diagnostic Chat in workspace default");
    await view.click("Do not send a diagnostic");
    expect(api.testLlamaCppChat).not.toHaveBeenCalled();
  });
  it("withholds native controls without explicit workspace", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<LlamaSetupSettings />));
    expect(host.textContent).toContain("Select a workspace");
    expect(api.fetchLlamaCppSetup).not.toHaveBeenCalled();
    expect(host.querySelector("input")).toBeNull();
  });
});
