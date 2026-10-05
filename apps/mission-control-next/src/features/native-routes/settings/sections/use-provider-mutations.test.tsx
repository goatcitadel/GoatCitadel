// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmProviderConfig } from "@goatcitadel/contracts";
import type { LlmRuntimeConfigResponse } from "@goatcitadel/mission-control-shared/api/client";
import { useProviderProfileEditor } from "./use-provider-profile-editor";
import { useProviderRouting } from "./use-provider-routing";
import { useProviderCredentials } from "./use-provider-credentials";
import { __resetProviderMutationStateForTests, isProviderPrecommitConflict } from "./provider-mutation-state";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../library/use-form-dirty";
import { __resetSettingsChangesForTests } from "../use-settings-change";
import type { ProviderCatalog } from "./provider-section-types";

const api = vi.hoisted(() => ({
  fetchLlmConfig: vi.fn(),
  fetchSettings: vi.fn(),
  patchSettings: vi.fn(),
  updateProviderTransport: vi.fn(),
  fetchProviderSecretStatus: vi.fn(),
  saveProviderSecret: vi.fn(),
  deleteProviderSecret: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const savedProvider: LlmProviderConfig = {
  providerId: "fixture",
  label: "Fixture",
  baseUrl: "http://127.0.0.1:9999/v1",
  apiStyle: "openai-chat-completions",
  defaultModel: "model-a",
  apiKeyEnv: "FIXTURE_API_KEY",
};
const providerSummary: LlmRuntimeConfigResponse["providers"][number] = {
  providerId: "fixture",
  label: "Fixture",
  baseUrl: "http://127.0.0.1:9999/v1",
  apiStyle: "openai-chat-completions",
  defaultModel: "model-a",
  hasApiKey: true,
  apiKeySource: "env",
};
const provider: ProviderCatalog["providers"][number] = {
  ...providerSummary,
  sanitizedEndpointIdentity: savedProvider.baseUrl,
  models: ["model-a", "model-b"],
  modelProbeState: "ready",
  modelProbeSource: "live",
  modelRefreshStatus: "fresh",
};
let config: LlmRuntimeConfigResponse;
let view: string;
let root: Root, container: HTMLDivElement;
let profile: ReturnType<typeof useProviderProfileEditor>,
  routing: ReturnType<typeof useProviderRouting>,
  credentials: ReturnType<typeof useProviderCredentials>;
const reload = vi.fn(async (): Promise<void> => undefined),
  onSaved = vi.fn(),
  setNotice = vi.fn(),
  loadModelsForProvider = vi.fn(async () => []);
function Probe() {
  profile = useProviderProfileEditor({
    config,
    reload,
    loadModelsForProvider,
    selectedProviderId: "fixture",
    selectedProvider: provider,
    selectedProviderConfig: config.providerConfigs?.[0],
    editorMode: "selected",
    detailView: view,
    setNotice,
    onSaved,
  });
  routing = useProviderRouting({ config, providers: [provider], reload, active: view === "routing", setNotice });
  credentials = useProviderCredentials({
    config,
    reload,
    selectedProviderId: "fixture",
    detailView: view,
    credentialEditorOpen: true,
    currentEditor: profile.currentEditor,
    setNotice,
  });
  return null;
}
const render = () =>
  act(async () => {
    root.render(<Probe />);
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const conflict = (marker?: "committed" | "mutationCommitted", nested = false) => ({
  status: 409,
  body: {
    code: "STATE_CONFLICT",
    ...(marker && !nested ? { [marker]: true } : {}),
    details: { expectedRevision: 7, currentRevision: 8, ...(marker && nested ? { [marker]: true } : {}) },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  __resetProviderMutationStateForTests();
  __resetSettingsChangesForTests();
  __resetSessionDraftsForTests();
  config = {
    revision: 7,
    activeProviderId: "fixture",
    activeModel: "model-a",
    providers: [providerSummary],
    providerConfigs: [{ ...savedProvider }],
  };
  view = "editor";
  api.fetchLlmConfig.mockImplementation(async () => config);
  api.fetchSettings.mockImplementation(async () => ({ revision: config.revision, llm: config }));
  api.fetchProviderSecretStatus.mockResolvedValue({ providerId: "fixture", hasSecret: true, source: "env" });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected network in provider owner test"))),
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

describe("shared provider mutation ownership", () => {
  it("withholds a preflight save after navigating away and back", async () => {
    await render();
    await act(async () => profile.setProviderDraft((draft) => ({ ...draft, label: "Retained" })));
    const read = deferred<LlmRuntimeConfigResponse>();
    api.fetchLlmConfig.mockReturnValueOnce(read.promise);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = profile.handleSaveProvider();
    });
    view = "trust";
    await render();
    view = "editor";
    await render();
    await act(async () => {
      read.resolve(config);
      await saving;
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(profile.providerDraft.label).toBe("Retained");
    expect(profile.mutation.uncertain).toBeUndefined();
  });
  it("binds dispatch to the reviewed revision and locks duplicate and cross-shell owner actions", async () => {
    const pending = deferred<unknown>();
    api.patchSettings.mockReturnValue(pending.promise);
    await render();
    await act(async () => profile.setProviderDraft((draft) => ({ ...draft, label: "Updated" })));
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = profile.handleSaveProvider();
    });
    await act(async () => {
      await profile.handleSaveProvider();
      await routing.persistRouting("fixture", "model-b");
    });
    expect(api.patchSettings).toHaveBeenCalledOnce();
    expect(api.patchSettings.mock.calls[0]![0].expectedRevision).toBe(7);
    config = { ...config, revision: 8, providerConfigs: [{ ...savedProvider, label: "Updated" }] };
    await act(async () => {
      pending.resolve({ revision: 8, llm: config });
      await saving;
    });
    expect(onSaved).toHaveBeenCalledWith("fixture");
    expect(profile.mutation.uncertain).toBeUndefined();
  });
  it("retains an ambiguous dispatch lock after unmount and blocks routing and credential deletion too", async () => {
    api.patchSettings.mockRejectedValue(new Error("Lost reply"));
    await render();
    await act(async () => {
      await profile.handleSaveProvider();
    });
    expect(profile.mutation.uncertain).toBeTruthy();
    await act(async () => root.render(<p>Different route</p>));
    await render();
    await act(async () => {
      await profile.handleSaveProvider();
      await routing.persistRouting("fixture", "model-b");
      credentials.setPendingDeleteSecret({ providerId: "fixture", label: "Fixture" });
    });
    expect(api.patchSettings).toHaveBeenCalledOnce();
    expect(credentials.pendingDeleteSecret).toBeNull();
    expect(api.deleteProviderSecret).not.toHaveBeenCalled();
  });
  it.each([
    ["committed", false],
    ["mutationCommitted", false],
    ["committed", true],
    ["mutationCommitted", true],
  ] as const)("never retries a %s conflict marker nested=%s", async (marker, nested) => {
    api.patchSettings.mockRejectedValue(conflict(marker, nested));
    await render();
    await act(async () => {
      await profile.handleSaveProvider();
    });
    expect(profile.mutation.uncertain).toBeTruthy();
    expect(isProviderPrecommitConflict(conflict(marker, nested), 7)).toBe(false);
  });
  it("keeps an exact precommit revision conflict retryable without claiming a saved profile", async () => {
    api.patchSettings.mockRejectedValue(conflict());
    await render();
    await act(async () => {
      await profile.handleSaveProvider();
    });
    expect(profile.mutation.uncertain).toBeUndefined();
    expect(onSaved).not.toHaveBeenCalled();
    expect(isProviderPrecommitConflict(conflict(), 7)).toBe(true);
  });
  it.each(["profile", "routing", "credential", "removal"] as const)(
    "does not publish an old %s conflict after reload and away/back navigation",
    async (kind) => {
      view = kind === "routing" ? "routing" : kind === "profile" ? "editor" : "trust";
      await render();
      if (kind === "credential") await act(async () => credentials.setSecretValue("synthetic-fixture-value"));
      if (kind === "removal")
        await act(async () => credentials.setPendingDeleteSecret({ providerId: "fixture", label: "Fixture" }));
      api.patchSettings.mockRejectedValue(conflict());
      api.saveProviderSecret.mockRejectedValue(conflict());
      api.deleteProviderSecret.mockRejectedValue(conflict());
      const refreshing = deferred<void>();
      reload.mockReturnValueOnce(refreshing.promise);
      let saving!: Promise<unknown>;
      await act(async () => {
        saving =
          kind === "profile"
            ? profile.handleSaveProvider()
            : kind === "routing"
              ? routing.persistRouting("fixture", "model-b")
              : kind === "credential"
                ? credentials.handleSaveSecret()
                : credentials.handleDeleteSecret();
      });
      expect(reload).toHaveBeenCalledOnce();
      const original = view;
      view = "other";
      await render();
      view = original;
      await render();
      setNotice.mockClear();
      await act(async () => {
        refreshing.resolve();
        await saving;
      });
      expect(setNotice).not.toHaveBeenCalled();
      expect(profile.mutation.uncertain).toBeUndefined();
    },
  );
  it("does not dispatch credential deletion using a revision newer than the reviewed removal", async () => {
    view = "trust";
    await render();
    await act(async () => credentials.setPendingDeleteSecret({ providerId: "fixture", label: "Fixture" }));
    config = { ...config, revision: 8 };
    await render();
    await act(async () => {
      await credentials.handleDeleteSecret();
    });
    expect(api.deleteProviderSecret).not.toHaveBeenCalled();
    expect(credentials.pendingDeleteSecret?.revision).toBe(7);
  });
  it("uses the separate transport owner with CAS and verifies canonical readback", async () => {
    await render();
    await act(async () =>
      profile.setProviderTransportDraft((draft) => ({ ...draft, headersJson: '{"X-Fixture":"reviewed"}' })),
    );
    api.updateProviderTransport.mockImplementation(async () => {
      config = { ...config, revision: 8, providerConfigs: [{ ...savedProvider }] };
      return {
        ...config,
        providerTransportReceipt: {
          version: "llm.provider_transport_receipt.v1",
          providerId: "fixture",
          expectedRevision: 7,
          appliedRevision: 8,
          acceptedHeaderNames: ["X-Fixture"],
        },
      };
    });
    await act(async () => {
      await profile.handleSaveProvider();
    });
    expect(api.patchSettings).not.toHaveBeenCalled();
    expect(api.updateProviderTransport).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      providerId: "fixture",
      request: { headers: { "X-Fixture": "reviewed" }, auth: undefined, proxy: undefined, tls: undefined },
    });
    expect(onSaved).toHaveBeenCalledWith("fixture");
    expect(profile.mutation.uncertain).toBeUndefined();
    expect(profile.providerTransportDraft.headersJson).not.toContain("reviewed");
  });
  it("keeps transport outcome unknown when canonical readback differs", async () => {
    await render();
    await act(async () =>
      profile.setProviderTransportDraft((draft) => ({ ...draft, headersJson: '{"X-Fixture":"reviewed"}' })),
    );
    api.updateProviderTransport.mockResolvedValue({
      ...config,
      revision: 8,
      providerTransportReceipt: {
        version: "llm.provider_transport_receipt.v1",
        providerId: "fixture",
        expectedRevision: 7,
        appliedRevision: 8,
        acceptedHeaderNames: ["X-Fixture"],
      },
    });
    await act(async () => {
      await profile.handleSaveProvider();
    });
    expect(profile.mutation.uncertain).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });
  it.each(["missing", "foreign", "wrong-header", "wrong-revision"])(
    "retains uncertainty for a %s transport attestation after an acknowledged PATCH",
    async (kind) => {
      await render();
      await act(async () =>
        profile.setProviderTransportDraft((draft) => ({ ...draft, headersJson: '{"X-Fixture":"reviewed"}' })),
      );
      api.updateProviderTransport.mockImplementation(async () => {
        config = { ...config, revision: 8 };
        return {
          ...config,
          ...(kind === "missing"
            ? {}
            : {
                providerTransportReceipt: {
                  version: "llm.provider_transport_receipt.v1",
                  providerId: kind === "foreign" ? "other" : "fixture",
                  expectedRevision: kind === "wrong-revision" ? 6 : 7,
                  appliedRevision: 8,
                  acceptedHeaderNames: kind === "wrong-header" ? ["X-Other"] : ["X-Fixture"],
                },
              }),
        };
      });
      await act(async () => {
        await profile.handleSaveProvider();
      });
      expect(profile.mutation.uncertain).toBeTruthy();
      expect(onSaved).not.toHaveBeenCalled();
      await act(async () => root.render(<p>Elsewhere</p>));
      await render();
      await act(async () => {
        await profile.handleSaveProvider();
      });
      expect(api.updateProviderTransport).toHaveBeenCalledOnce();
    },
  );
  it("keeps routing unknown if the acknowledged owner values differ", async () => {
    api.patchSettings.mockResolvedValue({
      revision: 8,
      llm: { activeProviderId: "fixture", activeModel: "wrong-model" },
    });
    view = "routing";
    await render();
    await act(async () => {
      await routing.persistRouting("fixture", "model-b");
    });
    expect(routing.mutation.uncertain).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
