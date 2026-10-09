// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";
import type { ChatChangePlanActionDialogProps } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import {
  useProviderModelCatalog,
  type ProviderModelCatalogOption,
} from "@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetCredentialInputsForTests } from "../../../features/native-routes/settings/credential-input-owner";
import { __resetProviderConnectionAttemptsForTests, readProviderConnectionAttempt } from "./provider-connection-state";
import { ProviderConnectionSettings } from "./ProviderConnectionSettings";
import { freshReadsActive } from "@goatcitadel/mission-control-shared/api/fresh-reads";

const api = vi.hoisted(() => ({
  createChangePlan: vi.fn(),
  fetchChangePlan: vi.fn(),
  fetchLlmConfig: vi.fn(),
  fetchProviderSecretStatus: vi.fn(),
  confirmChangePlan: vi.fn(),
  submitChangePlanProviderSecret: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
// Each owner write reports the attempt it dispatched, as the real capture would for these Gateway routes.
const attempts = vi.hoisted(() => ({
  paths: [] as string[],
  read: vi.fn(),
  installation: undefined as string | undefined,
  /** Overrides the connected installation, so a test can switch Gateway mid-check. */
  connected: undefined as string | undefined,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>();
  return {
    ...original,
    getGatewayApiBaseUrl: () => attempts.connected ?? original.getGatewayApiBaseUrl(),
    captureMutationAttempt: (dispatch: () => Promise<unknown>, onAttempt: (attempt: unknown) => void) => {
      const path = attempts.paths.shift();
      if (path)
        onAttempt({
          attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
          method: "POST",
          path,
          ...(attempts.installation ? { installation: attempts.installation } : {}),
        });
      return dispatch();
    },
  };
});
vi.mock("@goatcitadel/mission-control-shared/api/mutation-attempts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMutationAttempt: attempts.read,
}));
const switchShellMock = vi.hoisted(() => vi.fn<typeof import("../../../shell-preference").switchShell>());
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: switchShellMock,
}));
vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: vi.fn(),
}));
let dialog: ChatChangePlanActionDialogProps;
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: (props: ChatChangePlanActionDialogProps) => {
    dialog = props;
    return null;
  },
}));

const provider: ProviderModelCatalogOption = {
  providerId: "provider-a",
  label: "Provider A",
  baseUrl: "https://old.example.test/v1",
  sanitizedEndpointIdentity: "https://old.example.test",
  apiStyle: "openai-responses",
  authMode: "api-key",
  defaultModel: "model-a",
  models: ["model-a"],
  hasApiKey: true,
};
let catalog: ReturnType<typeof useProviderModelCatalog>;
let root: Root;
let container: HTMLDivElement;
let currentPlan: ChangePlanRecord;
const render = () => act(async () => root.render(<ProviderConnectionSettings />));
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
const config = (revision = 4, baseUrl = provider.baseUrl) => ({
  revision,
  activeProviderId: provider.providerId,
  activeModel: "model-a",
  providers: [{ ...provider, baseUrl }],
  providerConfigs: [{ ...provider, baseUrl, apiKeyEnv: "PROVIDER_TEST_KEY" }],
});

async function editEndpoint(value = "https://new.example.test/v1") {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function chooseEnvironment() {
  await act(async () => {
    const select = container.querySelectorAll("select")[1]!;
    select.value = "env";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  attempts.paths.length = 0;
  attempts.installation = undefined;
  attempts.connected = undefined;
  switchShellMock.mockResolvedValue("cancelled");
  catalog = {
    config: config() as NonNullable<ReturnType<typeof useProviderModelCatalog>["config"]>,
    providers: [{ ...provider }],
    loading: false,
    error: null,
    reload: vi.fn().mockResolvedValue(undefined),
    loadModelsForProvider: vi.fn(),
    getCachedModels: vi.fn(),
    getCachedModelProbe: vi.fn(),
  };
  vi.mocked(useProviderModelCatalog).mockImplementation(() => catalog);
  api.fetchLlmConfig.mockResolvedValue(config());
  api.fetchProviderSecretStatus.mockResolvedValue({
    providerId: provider.providerId,
    hasSecret: true,
    source: "keychain",
  });
  api.createChangePlan.mockImplementation(async ({ request }) => {
    currentPlan = {
      schemaVersion: 1,
      planId: "connection-plan",
      revision: 1,
      kind: "provider_connection",
      request: JSON.parse(canonicalJsonString(request)),
      origin: { surface: "settings", workspaceId: "default", actorId: "operator" },
      scope: "provider",
      phase: "authorization",
      adapter: { adapterId: "provider-connection", version: 3 },
      intentHash: "a".repeat(64),
      target: { ownerId: "provider_connection", resourceId: provider.providerId, expectedRevision: 4 },
      status: request.credentialAction ? "awaiting_input" : "awaiting_confirmation",
      title: "Update Provider A",
      summary: "Awaiting exact review",
      impact: "Updates the installation provider",
      risk: "caution",
      approvalRefs: [],
      evidenceRefs: [],
      rollbackRefs: [],
      createdAt: "2026-09-30T12:00:00Z",
      updatedAt: "2026-09-30T12:00:00Z",
      requiredAction: request.credentialAction
        ? {
            kind: "secure_input",
            actionId: "secret-action",
            actionNonce: "secret-nonce",
            targetId: provider.providerId,
            title: "Enter credential",
            expiresAt: "2099-01-01T00:00:00Z",
            fields: [{ fieldId: "credential", label: "Credential" }],
          }
        : {
            kind: "confirmation",
            actionId: "confirm-action",
            actionNonce: "confirm-nonce",
            title: "Confirm endpoint",
            confirmationText: "Apply the endpoint",
            purpose: "apply",
          },
    };
    return currentPlan;
  });
  api.fetchChangePlan.mockImplementation(async () => currentPlan);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetSessionDraftsForTests();
  __resetCredentialInputsForTests();
  __resetProviderConnectionAttemptsForTests();
});

describe("cockpit provider connection editing", () => {
  it("creates a secret-free endpoint plan and verifies the saved owner after exact confirmation", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    expect(api.createChangePlan).toHaveBeenCalledWith({
      workspaceId: "default",
      surface: "settings",
      request: {
        kind: "provider_connection",
        providerId: "provider-a",
        profile: { baseUrl: "https://new.example.test/v1" },
      },
      idempotencyKey: expect.stringMatching(/^provider-connection:[0-9a-f-]{36}$/),
    });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(dialog.contextNote).toContain("New endpoint: https://new.example.test/v1");
    expect(dialog.contextNote).toContain("configured credential");
    expect(button("Review endpoint change").disabled).toBe(true);
    api.confirmChangePlan.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "completed",
      requiredAction: undefined,
    });
    api.fetchLlmConfig.mockResolvedValue(config(5, "https://new.example.test/v1"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(api.confirmChangePlan).toHaveBeenCalledWith(
      "connection-plan",
      expect.objectContaining({ workspaceId: "default" }),
      { expectedRevision: 1, actionNonce: "confirm-nonce" },
    );
    expect(container.textContent).toContain("Current provider evidence confirms the saved change");
    expect(container.textContent).not.toContain("Unsaved endpoint draft");
  });

  it("blocks stale config before creating a plan and retains the endpoint draft", async () => {
    await render();
    await editEndpoint();
    api.fetchLlmConfig.mockResolvedValue(config(5));
    await click("Review endpoint change");
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Provider settings changed");
    expect(container.querySelector("input")?.value).toBe("https://new.example.test/v1");
  });

  it("preserves exact intent matching when the repository canonicalizes object key order", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    expect(dialog.plan?.requiredAction?.kind).toBe("confirmation");
    expect(Object.keys(dialog.plan!.request)).toEqual(["kind", "profile", "providerId"]);
    currentPlan = JSON.parse(canonicalJsonString(currentPlan));
    api.confirmChangePlan.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "completed",
      requiredAction: undefined,
    });
    api.fetchLlmConfig.mockResolvedValue(config(5, "https://new.example.test/v1"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(api.confirmChangePlan).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Current provider evidence confirms");
  });

  it("refuses credential-bearing public endpoint URLs", async () => {
    await render();
    await editEndpoint("https://new.example.test/v1?token=synthetic-value");
    await click("Review endpoint change");
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("without credentials, query parameters");
  });

  it("does not read back unsafe legacy endpoint values", async () => {
    catalog.providers = [{ ...provider, baseUrl: "https://old.example.test/v1?token=legacy-value" }];
    await render();
    expect(container.querySelector("input")?.value).toBe("");
    expect(container.innerHTML).not.toContain("legacy-value");
  });

  it("uses only the secure owner API for credential input and waits for confirmation", async () => {
    await render();
    await click("Replace API credential");
    expect(api.createChangePlan).toHaveBeenCalledWith({
      workspaceId: "default",
      surface: "settings",
      request: {
        kind: "provider_connection",
        providerId: "provider-a",
        credentialAction: "replace_api_key",
        credentialStorage: "keychain",
      },
      idempotencyKey: expect.stringMatching(/^provider-connection:[0-9a-f-]{36}$/),
    });
    api.submitChangePlanProviderSecret.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "awaiting_confirmation",
      requiredAction: {
        kind: "confirmation",
        actionId: "confirm",
        actionNonce: "nonce",
        title: "Confirm credential",
        confirmationText: "Promote credential",
      },
    });
    await act(async () => dialog.onSubmitSecureInput(dialog.plan!, { credential: "synthetic-test-credential" }));
    expect(api.submitChangePlanProviderSecret).toHaveBeenCalledWith(
      "connection-plan",
      expect.objectContaining({ workspaceId: "default" }),
      {
        expectedRevision: 1,
        actionId: "secret-action",
        actionNonce: "secret-nonce",
        apiKey: "synthetic-test-credential",
      },
    );
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(JSON.stringify(readProviderConnectionAttempt("provider-a"))).not.toContain("synthetic-test-credential");
    expect(container.textContent).not.toContain("saved change");
    expect(button("Replace API credential").disabled).toBe(true);
  });

  it("rechecks the current plan and blocks changed actions", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    const reviewed = dialog.plan!;
    currentPlan = { ...currentPlan, revision: 2 };
    await act(async () => dialog.onConfirm(reviewed));
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("instructions changed");
  });

  it("requires an explicit valid environment target and verifies that exact owner storage", async () => {
    await render();
    await chooseEnvironment();
    expect(container.textContent).toContain("plaintext in the installation's environment file");
    expect(container.querySelectorAll("input")[1]?.readOnly).toBe(true);
    await click("Replace API credential");
    expect(currentPlan.request).toEqual({
      kind: "provider_connection",
      providerId: "provider-a",
      credentialAction: "replace_api_key",
      credentialStorage: "env",
      credentialEnvVar: "PROVIDER_TEST_KEY",
    });
    api.submitChangePlanProviderSecret.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "awaiting_confirmation",
      requiredAction: {
        kind: "confirmation",
        actionId: "confirm",
        actionNonce: "nonce",
        title: "Confirm",
        confirmationText: "Save",
      },
    });
    await act(async () => dialog.onSubmitSecureInput(dialog.plan!, { credential: "synthetic-test-credential" }));
    currentPlan = readProviderConnectionAttempt("provider-a")!.plan!;
    await click("Review current step");
    api.confirmChangePlan.mockResolvedValue({
      ...currentPlan,
      revision: 3,
      status: "completed",
      requiredAction: undefined,
    });
    api.fetchLlmConfig.mockResolvedValue({
      ...config(5),
      providers: [{ ...provider, apiKeySource: "env", apiKeyRef: "PROVIDER_TEST_KEY" }],
    });
    api.fetchProviderSecretStatus.mockResolvedValue({
      providerId: provider.providerId,
      hasSecret: true,
      source: "env",
    });
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(container.textContent).toContain("Current provider evidence confirms the saved change");
    expect(JSON.stringify(readProviderConnectionAttempt("provider-a"))).not.toContain("synthetic-test-credential");
  });

  it("does not fall back from a failed keychain submission to an environment file", async () => {
    await render();
    await click("Replace API credential");
    api.submitChangePlanProviderSecret.mockRejectedValue(new Error("503 keychain unavailable"));
    await act(async () => dialog.onSubmitSecureInput(dialog.plan!, { credential: "synthetic-test-credential" }));
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
    expect(api.submitChangePlanProviderSecret).toHaveBeenCalledTimes(1);
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(container.querySelectorAll("select")[1]?.value).toBe("keychain");
    expect(readProviderConnectionAttempt("provider-a")?.request.credentialStorage).toBe("keychain");
    expect(container.textContent).toContain("outcome is uncertain");
  });

  it("blocks environment storage without a registered owner and when the owner changes before preparation", async () => {
    catalog.config = { ...catalog.config!, providerConfigs: [] };
    await render();
    await chooseEnvironment();
    expect(button("Replace API credential").disabled).toBe(true);
    expect(container.textContent).toContain("No environment variable is registered");
    catalog.config = config() as NonNullable<typeof catalog.config>;
    await render();
    api.fetchLlmConfig.mockResolvedValue({ ...config(), providerConfigs: [{ ...provider, apiKeyEnv: "OTHER_KEY" }] });
    await click("Replace API credential");
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(container.textContent).toContain("registered credential environment variable changed");
  });

  it("shows an owner rejection without claiming a saved credential", async () => {
    await render();
    await chooseEnvironment();
    await click("Replace API credential");
    api.submitChangePlanProviderSecret.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "manual_required",
      requiredAction: undefined,
      result: {
        summary: "Registered environment owner is reserved for runtime configuration.",
        failureCode: "adapter_failed",
      },
    });
    await act(async () => dialog.onSubmitSecureInput(dialog.plan!, { credential: "synthetic-test-credential" }));
    expect(container.textContent).toContain("Owner result: Registered environment owner is reserved");
    expect(container.textContent).not.toContain("Current provider evidence confirms");
  });

  it("blocks a current plan whose credential storage target changed", async () => {
    await render();
    await chooseEnvironment();
    await click("Replace API credential");
    const reviewed = dialog.plan!;
    currentPlan = {
      ...currentPlan,
      request: { ...currentPlan.request, credentialEnvVar: "OTHER_KEY" },
    } as ChangePlanRecord;
    await act(async () => dialog.onSubmitSecureInput(reviewed, { credential: "synthetic-test-credential" }));
    expect(api.submitChangePlanProviderSecret).not.toHaveBeenCalled();
    expect(container.textContent).toContain("instructions changed");
  });

  it("retains the reviewed plaintext target through navigation and both secure and confirmation steps", async () => {
    await render();
    await chooseEnvironment();
    await click("Replace API credential");
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelectorAll("select")[1]?.value).toBe("env");
    expect(container.querySelectorAll("input")[1]?.value).toBe("PROVIDER_TEST_KEY");
    expect(container.textContent).toContain("plaintext in the installation's environment file");
    await click("Review current step");
    expect(dialog.contextNote).toContain(
      "plaintext in this installation's environment file, variable PROVIDER_TEST_KEY",
    );
    api.submitChangePlanProviderSecret.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "awaiting_confirmation",
      requiredAction: {
        kind: "confirmation",
        actionId: "confirm",
        actionNonce: "nonce",
        title: "Confirm",
        confirmationText: "Save",
      },
    });
    await act(async () => dialog.onSubmitSecureInput(dialog.plan!, { credential: "synthetic-test-credential" }));
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await click("Review current step");
    expect(dialog.contextNote).toContain(
      "plaintext in this installation's environment file, variable PROVIDER_TEST_KEY",
    );
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });

  it("does not claim credential success when the configured storage reference differs", async () => {
    await render();
    await chooseEnvironment();
    await click("Replace API credential");
    api.submitChangePlanProviderSecret.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "completed",
      requiredAction: undefined,
    });
    api.fetchLlmConfig.mockResolvedValue({
      ...config(5),
      providers: [{ ...provider, apiKeySource: "env", apiKeyRef: "OTHER_KEY" }],
    });
    api.fetchProviderSecretStatus.mockResolvedValue({
      providerId: provider.providerId,
      hasSecret: true,
      source: "env",
    });
    await act(async () => dialog.onSubmitSecureInput(dialog.plan!, { credential: "synthetic-test-credential" }));
    expect(container.textContent).not.toContain("Current provider evidence confirms");
    expect(container.textContent).toContain("outcome is uncertain");
  });

  it("retains an unknown mutation lock across remounts and read-only refresh", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    const retained = readProviderConnectionAttempt("provider-a");
    await act(async () => {
      container
        .querySelector<HTMLAnchorElement>('a[href="/settings/providers?shell=classic&shellScope=visit"]')!
        .click();
    });
    expect(switchShellMock).not.toHaveBeenCalled();
    const keep = [...document.querySelectorAll("button")].find((item) => item.textContent === "Keep draft and close");
    expect(keep).toBeDefined();
    await act(async () => {
      keep!.click();
    });
    expect(switchShellMock).toHaveBeenCalledExactlyOnceWith(
      "classic",
      expect.objectContaining({
        href: "/settings/providers?shell=classic&shellScope=visit",
        isCurrent: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(switchShellMock.mock.calls[0]![1].isCurrent()).toBe(true);
    expect(readProviderConnectionAttempt("provider-a")).toBe(retained);
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await click("Refresh connection change");
    expect(container.textContent).toContain("outcome is uncertain");
    expect(button("Review endpoint change").disabled).toBe(true);
    expect(button("Review current step")).toBeUndefined();
    expect(api.confirmChangePlan).toHaveBeenCalledTimes(1);
  });

  it("settles a lost confirmation from the Gateway's attempt record and the canonical plan", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(container.textContent).toContain("outcome is uncertain");
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    currentPlan = { ...currentPlan, revision: 2, status: "completed", requiredAction: undefined };
    api.fetchLlmConfig.mockResolvedValue(config(5, "https://new.example.test/v1"));
    await click("Check outcome");
    expect(attempts.read).toHaveBeenCalledWith(
      "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b",
      "POST",
      "/api/v1/change-plans/:planId/confirmations",
    );
    expect(container.textContent).not.toContain("outcome is uncertain");
    expect(container.textContent).toContain("Current provider evidence confirms the saved change");
    expect(api.confirmChangePlan).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost plan creation by replaying the same plan key, never a new one", async () => {
    await render();
    await editEndpoint();
    attempts.paths.push("/api/v1/change-plans");
    const create = api.createChangePlan.getMockImplementation()!;
    api.createChangePlan.mockRejectedValueOnce(new Error("lost response"));
    await click("Review endpoint change");
    expect(container.textContent).toContain("outcome is uncertain");
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    api.createChangePlan.mockImplementation(create);
    await click("Check outcome");
    expect(api.createChangePlan).toHaveBeenCalledTimes(2);
    const [first, replay] = api.createChangePlan.mock.calls.map(([input]) => input);
    expect(replay).toEqual(first);
    expect(container.textContent).not.toContain("outcome is uncertain");
    expect(dialog.plan?.planId).toBe("connection-plan");
  });

  it("never replays a released plan creation and releases the lock without claiming nothing was created", async () => {
    await render();
    await editEndpoint();
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("lost response"));
    await click("Review endpoint change");
    attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
    await click("Check outcome");
    expect(api.createChangePlan).toHaveBeenCalledTimes(1);
    expect(readProviderConnectionAttempt("provider-a")).toBeUndefined();
    expect(container.textContent).toContain("released this change after an error");
    expect(container.textContent).toContain("Unsaved endpoint draft");
  });

  it("re-reads a released confirmation's plan as a retry gate, not as proof", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
    await click("Check outcome");
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(false);
    expect(container.textContent).toContain("Review its current step before acting again");
    expect(api.confirmChangePlan).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: "pending", claimExpired: false }, "still running"],
    [{ status: "pending", claimExpired: true }, "expired"],
    [{ status: "absent" }, "no record"],
  ])("keeps the connection lock for %o", async (record, message) => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    attempts.read.mockResolvedValue(record);
    await click("Check outcome");
    expect(container.textContent).toContain(message);
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(true);
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(1);
    expect(button("Check outcome").disabled).toBe(false);
  });

  it("keeps the connection lock when the attempt read fails", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    attempts.read.mockRejectedValue(new Error("API error 403: gateway-internal-detail"));
    await click("Check outcome");
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(true);
    expect(container.textContent).toContain("check failed");
    expect(container.textContent).not.toContain("gateway-internal-detail");
  });

  it("refuses to check a lost confirmation against a different Gateway installation", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.installation = "http://other-gateway.invalid";
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    await click("Check outcome");
    expect(attempts.read).not.toHaveBeenCalled();
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(true);
    expect(container.textContent).toContain("different Gateway");
  });
  it("never replays a lost create on a Gateway the operator switched to during the check", async () => {
    await render();
    await editEndpoint();
    attempts.installation = "http://gateway-a.invalid";
    attempts.connected = "http://gateway-a.invalid";
    attempts.paths.push("/api/v1/change-plans");
    api.createChangePlan.mockRejectedValueOnce(new Error("lost response"));
    await click("Review endpoint change");
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(true);
    api.createChangePlan.mockClear();
    attempts.read.mockImplementation(async () => {
      attempts.connected = "http://gateway-b.invalid";
      return { status: "completed", claimExpired: false };
    });
    await click("Check outcome");
    expect(api.createChangePlan).not.toHaveBeenCalled();
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(true);
    expect(container.textContent).toContain("different Gateway");
  });
  it("keeps a lost confirmation locked when the Gateway changes while its plan is re-read", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.installation = "http://gateway-a.invalid";
    attempts.connected = "http://gateway-a.invalid";
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
    api.fetchChangePlan.mockImplementation(async () => {
      attempts.connected = "http://gateway-b.invalid";
      return currentPlan;
    });
    await click("Check outcome");
    expect(readProviderConnectionAttempt("provider-a")?.uncertain).toBe(true);
    expect(container.textContent).toContain("different Gateway");
  });
  it.each([
    ["confirms", "https://new.example.test/v1"],
    ["disagrees", "https://other.example.test/v1"],
  ])(
    "keeps a lost confirmation checkable when the Gateway changes while the saved provider is read and it %s",
    async (_case, baseUrl) => {
      await render();
      await editEndpoint();
      await click("Review endpoint change");
      attempts.installation = "http://gateway-a.invalid";
      attempts.connected = "http://gateway-a.invalid";
      attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
      api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
      await act(async () => dialog.onConfirm(dialog.plan!));
      attempts.read.mockResolvedValue({ status: "completed", claimExpired: false });
      currentPlan = { ...currentPlan, revision: 2, status: "completed", requiredAction: undefined };
      api.fetchLlmConfig.mockImplementation(async () => {
        attempts.connected = "http://gateway-b.invalid";
        return config(5, baseUrl);
      });
      await click("Check outcome");
      const attempt = readProviderConnectionAttempt("provider-a");
      expect(attempt?.uncertain).toBe(true);
      expect(attempt?.transport).toBeDefined();
      expect(container.textContent).toContain("different Gateway");
      expect(container.textContent).not.toContain("Current provider evidence confirms the saved change");
    },
  );
  it("re-reads the plan fresh when settling a lost confirmation", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    attempts.paths.push("/api/v1/change-plans/connection-plan/confirmations");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    attempts.read.mockResolvedValue({ status: "failed", claimExpired: false });
    let fresh = false;
    api.fetchChangePlan.mockImplementation(async () => {
      fresh = freshReadsActive();
      return currentPlan;
    });
    await click("Check outcome");
    expect(fresh).toBe(true);
  });
  it("offers no outcome check for an attempt it could not identify", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    api.confirmChangePlan.mockRejectedValue(new Error("lost response"));
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(container.textContent).toContain("outcome is uncertain");
    expect(button("Check outcome")).toBeUndefined();
  });

  it("does not confirm a completed plan when the provider readback disagrees", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    api.confirmChangePlan.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "completed",
      requiredAction: undefined,
    });
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(container.textContent).toContain("outcome is uncertain");
    expect(container.textContent).not.toContain("Current provider evidence confirms");
  });

  it("accepts an owner revision advance after saving an endpoint that still needs a credential", async () => {
    await render();
    await editEndpoint();
    await click("Review endpoint change");
    api.confirmChangePlan.mockResolvedValue({
      ...currentPlan,
      revision: 2,
      status: "awaiting_input",
      evidenceRefs: ["provider_profile:provider-a:settings_revision:5"],
      result: {
        summary: "Profile saved; credential required",
        providerProfileCheckpoint: {
          version: "provider_profile_checkpoint.v1",
          providerId: "provider-a",
          originalRevision: 4,
          appliedRevision: 5,
          intentHash: currentPlan.intentHash,
        },
      },
      target: { ...currentPlan.target, expectedRevision: 5 },
      requiredAction: {
        kind: "secure_input",
        targetId: "provider-a",
        actionId: "secret",
        actionNonce: "nonce",
        expiresAt: "2099-01-01T00:00:00Z",
        title: "Enter credential",
      },
    });
    await act(async () => dialog.onConfirm(dialog.plan!));
    expect(container.textContent).not.toContain("outcome is uncertain");
    expect(button("Review current step").disabled).toBe(false);
    expect(readProviderConnectionAttempt("provider-a")?.plan?.target.expectedRevision).toBe(5);
  });
});
