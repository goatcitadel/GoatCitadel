// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmRuntimeConfigResponse } from "@goatcitadel/mission-control-shared/api/client";
import { createEmptyLlmTransportDraft } from "@goatcitadel/mission-control-shared/components/LlmTransportFields";
import { buildChatGptOAuthProviderDraft } from "../helpers/provider-drafts";
import { __resetSettingsChangesForTests } from "../use-settings-change";
import { __resetProviderMutationStateForTests } from "./provider-mutation-state";
import { providerSaveInput } from "./provider-save-contract";
import { useProviderCodexSetup } from "./use-provider-codex-setup";

const api = vi.hoisted(() => ({ fetchLlmConfig: vi.fn(), patchSettings: vi.fn(), fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: () => false,
}));
const reload = vi.fn(async () => undefined),
  setNotice = vi.fn(),
  onSaved = vi.fn(),
  loadModelsForProvider = vi.fn(async () => []);
let root: Root, container: HTMLDivElement, hook: ReturnType<typeof useProviderCodexSetup>;
const initial = { revision: 7, providers: [], providerConfigs: [] } as unknown as LlmRuntimeConfigResponse;
function Probe() {
  hook = useProviderCodexSetup({
    config: initial,
    reload,
    loadModelsForProvider,
    setNotice,
    onSaved,
    viewIdentity: "oauth",
  });
  return null;
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSettingsChangesForTests();
  __resetProviderMutationStateForTests();
  container = document.createElement("div");
  root = createRoot(container);
  api.fetchLlmConfig.mockResolvedValue(initial);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetSettingsChangesForTests();
  __resetProviderMutationStateForTests();
});

describe("ChatGPT provider setup checkpoint", () => {
  it.each([true, false])("binds the profile's advanced revision to its original review (valid=%s)", async (valid) => {
    const draft = { provider: buildChatGptOAuthProviderDraft(), transport: createEmptyLlmTransportDraft() };
    const { providerId, request: _transport, ...profile } = providerSaveInput(draft);
    const receipt = {
      planId: "codex-plan",
      revision: 3,
      status: "awaiting_input",
      risk: "safe",
      summary: "Profile saved; OAuth still required.",
    };
    api.patchSettings.mockResolvedValue({ revision: 8, llm: initial, changePlanReceipt: receipt });
    api.fetchChangePlan.mockResolvedValue({
      ...receipt,
      kind: "provider_connection",
      phase: "input",
      origin: { workspaceId: "default", surface: "settings" },
      target: { ownerId: "provider_connection", resourceId: providerId, expectedRevision: 8 },
      request: { kind: "provider_connection", providerId, profile },
      intentHash: "a".repeat(64),
      evidenceRefs: ["provider_profile:openai-codex:settings_revision:8"],
      result: {
        providerProfileCheckpoint: {
          version: "provider_profile_checkpoint.v1",
          providerId,
          originalRevision: valid ? 7 : 6,
          appliedRevision: 8,
          intentHash: "a".repeat(64),
        },
      },
    });
    await act(async () => root.render(<Probe />));
    await act(async () => {
      await hook.add();
    });
    await act(async () => {
      await hook.refresh();
    });
    expect(api.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      llm: { upsertProvider: { providerId, ...profile } },
    });
    expect(api.fetchChangePlan).toHaveBeenCalledWith("codex-plan", { workspaceId: "default" });
    expect(hook.isPending()).toBe(true);
    if (valid) {
      expect(hook.change?.error).toBeUndefined();
      expect(hook.change?.plan?.target.expectedRevision).toBe(8);
      expect(hook.change?.receipt.status).toBe("awaiting_input");
    } else expect(hook.change?.error).toContain("evidence does not match");
    expect(onSaved).not.toHaveBeenCalled();
    expect(loadModelsForProvider).not.toHaveBeenCalled();
  });
});
