// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { LlmRuntimeConfigResponse } from "@goatcitadel/mission-control-shared/api/client";
import { ProviderManagementSettings } from "./ProviderManagementSettings";
import { __resetProviderMutationStateForTests } from "../../../features/native-routes/settings/sections/provider-mutation-state";
import { __resetSettingsChangesForTests } from "../../../features/native-routes/settings/use-settings-change";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import {
  __resetFormDirtyRegistryForTests,
  getDirtySectionActions,
  getDirtySectionKeys,
} from "../../../features/native-routes/library/use-form-dirty";

const api = vi.hoisted(() => ({
  fetchLlmConfig: vi.fn(),
  patchSettings: vi.fn(),
  createChangePlan: vi.fn(),
  updateProviderTransport: vi.fn(),
  fetchSettings: vi.fn(),
  fetchProviderSecretStatus: vi.fn(),
  deleteProviderSecret: vi.fn(),
  fetchOpenAICodexOAuthStatus: vi.fn(),
  fetchChangePlan: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ ...api, isApiRequestError: () => false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "default" }),
}));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: vi.fn() }) }));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: () => null,
}));
const reload = vi.fn(async (): Promise<void> => undefined),
  loadModelsForProvider = vi.fn(async () => []);
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    config,
    providers: config.providers.map((provider) => ({
      ...provider,
      sanitizedEndpointIdentity: provider.baseUrl,
      models: ["model-a"],
      modelProbeSource: "live",
      modelProbeState: "ready",
      modelRefreshStatus: "fresh",
    })),
    loading: false,
    error: null,
    reload,
    loadModelsForProvider,
  }),
}));
let config: LlmRuntimeConfigResponse, root: Root, container: HTMLDivElement;
const saved = {
  providerId: "fixture",
  label: "Fixture",
  baseUrl: "http://127.0.0.1:9999/v1",
  apiStyle: "openai-chat-completions" as const,
  defaultModel: "model-a",
  apiKeyEnv: "FIXTURE_KEY",
};
const render = () =>
  act(async () => {
    root.render(<ProviderManagementSettings />);
  });
const button = (label: string) => [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
const click = (label: string) =>
  act(async () => {
    button(label).click();
  });
async function fill(label: string, value: string) {
  const field = [...container.querySelectorAll("label")]
    .find((node) => node.querySelector("span")?.textContent === label)
    ?.querySelector("input,textarea") as HTMLInputElement | HTMLTextAreaElement;
  if (!field) throw new Error(`Missing field ${label}`);
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetProviderMutationStateForTests();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  config = {
    revision: 7,
    activeProviderId: "fixture",
    activeModel: "model-a",
    providers: [{ ...saved, hasApiKey: true, apiKeySource: "env" }],
    providerConfigs: [{ ...saved }],
  };
  api.fetchLlmConfig.mockImplementation(async () => config);
  api.fetchSettings.mockImplementation(async () => ({ revision: config.revision, llm: config }));
  api.fetchProviderSecretStatus.mockResolvedValue({ providerId: "fixture", hasSecret: true, source: "env" });
  api.fetchOpenAICodexOAuthStatus.mockResolvedValue({ providerId: "openai-codex", available: true, connected: false });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected network in native provider test");
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetProviderMutationStateForTests();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.unstubAllGlobals();
});

describe("native provider owner composition", () => {
  it("keeps a lost keychain-plan response locked and never falls back to plaintext storage", async () => {
    api.createChangePlan.mockRejectedValue(new Error("Connection lost"));
    await render();
    await click("Add provider profile");
    await fill("Provider ID", "keychain-fixture");
    await fill("Provider base URL", "http://127.0.0.1:9999/v1");
    await click("Review provider profile");
    expect(container.textContent).toContain("OS keychain");
    await click("Apply reviewed provider profile");
    expect(api.createChangePlan).toHaveBeenCalledOnce();
    expect(api.createChangePlan.mock.calls[0]?.[0].request).toMatchObject({ credentialStorage: "keychain" });
    expect(api.createChangePlan.mock.calls[0]?.[0].request.credentialEnvVar).toBeUndefined();
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(button("Review provider profile").disabled).toBe(true);
    await act(async () => root.render(<p>Other page</p>));
    await render();
    expect(button("Add provider profile").disabled).toBe(true);
    expect(api.createChangePlan).toHaveBeenCalledOnce();
  });
  it("retains explicit plaintext custody across remount and submits only the reviewed public plan", async () => {
    let prepared: Record<string, unknown>;
    api.createChangePlan.mockImplementation(async (input) => {
      prepared = {
        planId: "new-plan",
        revision: 1,
        status: "awaiting_confirmation",
        kind: "provider_connection",
        intentHash: "a".repeat(64),
        origin: { workspaceId: "default", surface: "settings" },
        request: input.request,
        target: { ownerId: "provider_connection", resourceId: "new-fixture", expectedRevision: 7 },
        requiredAction: { kind: "confirmation", actionId: "confirm", actionNonce: "nonce", title: "Confirm profile" },
        summary: "Review public profile",
      };
      return prepared;
    });
    api.fetchChangePlan.mockImplementation(async () => prepared);
    await render();
    await click("Add provider profile");
    await fill("Provider ID", "new-fixture");
    await fill("Provider label", "New fixture");
    await fill("Provider base URL", "http://127.0.0.1:9999/v1");
    await fill("API key environment variable", "NEW_FIXTURE_KEY");
    const storage = [...container.querySelectorAll("label")]
      .find((node) => node.querySelector("span")?.textContent === "New credential storage")!
      .querySelector("select")!;
    await act(async () => {
      storage.value = "env";
      storage.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Review provider profile");
    expect(container.textContent).toContain("plaintext in this installation's environment file (NEW_FIXTURE_KEY)");
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(api.patchSettings).not.toHaveBeenCalled();
    await click("Apply reviewed provider profile");
    expect(api.createChangePlan).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "settings",
        workspaceId: "default",
        request: expect.objectContaining({
          providerId: "new-fixture",
          credentialStorage: "env",
          credentialEnvVar: "NEW_FIXTURE_KEY",
        }),
      }),
    );
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(config.revision).toBe(7);
    expect(button("Review required step")).toBeTruthy();
    await act(async () => root.render(<p>Other page</p>));
    await render();
    await click("Add provider profile");
    expect(container.textContent).toContain("plaintext");
    expect(container.textContent).toContain("NEW_FIXTURE_KEY");
    expect(button("Review provider profile").disabled).toBe(true);
    expect(api.createChangePlan).toHaveBeenCalledOnce();
  });
  it("names the provider selector independently of its option text", async () => {
    await render();
    const picker = container.querySelector<HTMLSelectElement>("select[aria-labelledby]")!;
    const label = document.getElementById(picker.getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("Manage provider");
    expect(picker.selectedOptions[0]?.textContent).toBe("Fixture");
  });
  it("reveals the pending owner step after a profile submission without claiming it saved", async () => {
    const requiredAction = {
      kind: "confirmation",
      actionId: "fixture-action",
      actionNonce: "fixture-nonce",
      title: "Confirm",
    };
    api.patchSettings.mockResolvedValue({
      revision: 7,
      llm: config,
      changePlanReceipt: {
        planId: "fixture-plan",
        revision: 1,
        status: "awaiting_confirmation",
        summary: "Review the provider plan",
        requiredAction,
      },
    });
    api.fetchChangePlan.mockResolvedValue({
      planId: "fixture-plan",
      summary: "Review the provider plan",
      revision: 1,
      status: "awaiting_confirmation",
      kind: "provider_connection",
      origin: { workspaceId: "default", surface: "settings" },
      request: {
        kind: "provider_connection",
        providerId: "fixture",
        profile: { ...saved, label: "Pending", providerId: undefined },
      },
      target: { ownerId: "provider_connection", resourceId: "fixture", expectedRevision: 7 },
      requiredAction,
    });
    await render();
    await click("Edit provider profile");
    await fill("Provider label", "Pending");
    await click("Review provider profile");
    await click("Apply reviewed provider profile");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain("Review the provider plan");
    expect(button("Review required step")).toBeTruthy();
    expect(container.textContent).not.toContain("Provider saved and confirmed");
    expect(config.revision).toBe(7);
  });
  it("binds bearer header and header scheme fields to the shared transport contract", async () => {
    await render();
    await click("Edit provider profile");
    const select = [...container.querySelectorAll("label")]
      .find((node) => node.querySelector("span")?.textContent === "Request auth mode")!
      .querySelector("select")!;
    await act(async () => {
      select.value = "bearer";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await fill("Request token environment variable", "FIXTURE_TRANSPORT_KEY");
    await fill("Request bearer header name", "X-Fixture-Bearer");
    await click("Review provider profile");
    expect(container.textContent).toContain("X-Fixture-Bearer");
    await click("Keep editing");
    const next = [...container.querySelectorAll("label")]
      .find((node) => node.querySelector("span")?.textContent === "Request auth mode")!
      .querySelector("select")!;
    await act(async () => {
      next.value = "header";
      next.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await fill("Request auth header name", "X-Fixture-Key");
    await fill("Request header environment variable", "FIXTURE_TRANSPORT_KEY");
    await fill("Request authorization scheme", "Token");
    await click("Review provider profile");
    expect(container.textContent).toContain("Token");
    expect(api.updateProviderTransport).not.toHaveBeenCalled();
  });
  it("requires review before profile dispatch and accepts only canonical saved values", async () => {
    api.patchSettings.mockImplementation(async () => {
      config = { ...config, revision: 8, providerConfigs: [{ ...saved, label: "Reviewed fixture" }] };
      return { revision: 8, llm: config };
    });
    await render();
    await click("Edit provider profile");
    await fill("Provider label", "Reviewed fixture");
    await click("Review provider profile");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Reviewed fixture");
    expect(api.patchSettings).not.toHaveBeenCalled();
    await click("Keep editing");
    expect(api.patchSettings).not.toHaveBeenCalled();
    await click("Review provider profile");
    await click("Apply reviewed provider profile");
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      llm: { upsertProvider: expect.objectContaining({ providerId: "fixture", label: "Reviewed fixture" }) },
    });
    expect(api.patchSettings.mock.calls[0]![0].llm.upsertProvider).not.toHaveProperty("request");
    expect(container.textContent).toContain("Provider saved and confirmed");
  });
  it("withholds a stale review without discarding the edited profile", async () => {
    await render();
    await click("Edit provider profile");
    await fill("Provider label", "Retained");
    await click("Review provider profile");
    config = { ...config, revision: 8 };
    await render();
    expect(container.textContent).toContain("This review is stale");
    expect(button("Apply reviewed provider profile").disabled).toBe(true);
    await click("Keep editing");
    expect(container.querySelector<HTMLInputElement>('input[aria-labelledby$="-label"]')?.value).toBe("Retained");
    expect(api.patchSettings).not.toHaveBeenCalled();
  });
  it("reviews transport separately and uses only its existing dedicated owner", async () => {
    api.updateProviderTransport.mockImplementation(async () => {
      config = {
        ...config,
        revision: 8,
        providerConfigs: [{ ...saved }],
      };
      return {
        ...config,
        providerTransportReceipt: {
          version: "llm.provider_transport_receipt.v1",
          providerId: saved.providerId,
          expectedRevision: 7,
          appliedRevision: 8,
          acceptedHeaderNames: ["X-Fixture"],
        },
      };
    });
    await render();
    await click("Edit provider profile");
    await fill("Extra request headers", '{"X-Fixture":"reviewed"}');
    await click("Review provider profile");
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Review provider transport");
    expect(api.updateProviderTransport).not.toHaveBeenCalled();
    await click("Apply reviewed transport");
    expect(api.updateProviderTransport).toHaveBeenCalledOnce();
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Transport accepted by the Gateway");
    expect(container.textContent).toContain("header values remain hidden");
  });
  it("retains an uncertain profile lock after remount", async () => {
    api.patchSettings.mockRejectedValue(new Error("Lost reply"));
    await render();
    await click("Edit provider profile");
    await fill("Provider label", "Retained");
    await click("Review provider profile");
    await click("Apply reviewed provider profile");
    await act(async () => root.render(<p>Other view</p>));
    await render();
    expect(container.textContent).toContain("Outcome uncertain");
    expect(button("Edit provider profile").disabled).toBe(true);
    expect(api.patchSettings).toHaveBeenCalledOnce();
  });
  it("cancels credential removal without dispatch and preserves the exact reviewed revision", async () => {
    await render();
    await click("Remove saved API credential");
    expect(container.textContent).toContain("Reviewed settings revision 7");
    await click("Keep credential");
    expect(api.deleteProviderSecret).not.toHaveBeenCalled();
    await click("Remove saved API credential");
    config = { ...config, revision: 8 };
    await render();
    expect(button("Request credential removal").disabled).toBe(true);
    expect(api.deleteProviderSecret).not.toHaveBeenCalled();
  });
  it("refreshes credential evidence after a settings revision and refuses a foreign status", async () => {
    await render();
    api.fetchProviderSecretStatus.mockResolvedValue({ providerId: "fixture", hasSecret: false, source: "none" });
    config = { ...config, revision: 8 };
    await render();
    expect(button("Remove saved API credential").disabled).toBe(true);
    expect(container.textContent).toContain("No stored API credential");
    api.fetchProviderSecretStatus.mockResolvedValue({ providerId: "foreign", hasSecret: true, source: "env" });
    config = { ...config, revision: 9 };
    await render();
    expect(button("Remove saved API credential").disabled).toBe(true);
    expect(container.textContent).toContain("Credential status did not identify the selected provider");
  });
  it("keeps profile review closed until the draft differs from the saved profile", async () => {
    await render();
    await click("Edit provider profile");
    expect(button("Review provider profile").disabled).toBe(true);
    await fill("Provider label", "Changed label");
    expect(button("Review provider profile").disabled).toBe(false);
  });
  it("keeps profile review closed while the edit would send the saved profile", async () => {
    await render();
    await click("Edit provider profile");
    // The save trims the label, so this sends exactly the saved profile.
    await fill("Provider label", "Fixture ");
    expect(button("Review provider profile").disabled).toBe(true);
    await fill("Provider label", "Fixture renamed");
    expect(button("Review provider profile").disabled).toBe(false);
  });
  it("settles a formatting-only draft when a leave dialog saves it, without sending it", async () => {
    await render();
    await click("Edit provider profile");
    await fill("Provider label", "Fixture ");
    // The cockpit-wide leave dialog's "Save and continue" calls the save owner the editor registered.
    const [key] = getDirtySectionKeys().filter((entry) => entry.startsWith("provider:"));
    expect(key).toBeDefined();
    let saved: boolean | undefined;
    await act(async () => {
      saved = await getDirtySectionActions(key!)?.onSave?.();
    });
    expect(saved).toBe(true);
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Nothing to save. The saved provider already matches.");
    expect(getDirtySectionKeys().filter((entry) => entry.startsWith("provider:"))).toEqual([]);
  });
});
