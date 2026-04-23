import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsNativePage } from "./SettingsNativePage";

const mocks = vi.hoisted(() => ({
  patchSettings: vi.fn(async () => ({})),
  saveProviderSecret: vi.fn(async () => ({
    providerId: "openai",
    hasSecret: true,
    source: "keychain",
  })),
  deleteProviderSecret: vi.fn(async () => ({
    providerId: "openai",
    hasSecret: false,
    source: "none",
  })),
  fetchProviderSecretStatus: vi.fn(async () => ({
    providerId: "openai",
    hasSecret: true,
    source: "keychain",
  })),
  loadModelsForProvider: vi.fn(async () => ["gpt-5.4-mini"]),
  reload: vi.fn(async () => undefined),
  providerCatalogState: {
    config: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    },
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        apiStyle: "openai-responses",
        models: ["gpt-5.4-mini"],
        hasApiKey: true,
        apiKeySource: "keychain",
        modelProbeState: "ready" as const,
        modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    loading: false,
    error: null as string | null,
  },
}));

vi.mock("@goatcitadel/mission-control-shared/api/client", async () => {
  const actual = await vi.importActual<typeof import("@goatcitadel/mission-control-shared/api/client")>(
    "@goatcitadel/mission-control-shared/api/client",
  );
  return {
    ...actual,
    patchSettings: mocks.patchSettings,
    saveProviderSecret: mocks.saveProviderSecret,
    deleteProviderSecret: mocks.deleteProviderSecret,
    fetchProviderSecretStatus: mocks.fetchProviderSecretStatus,
  };
});

vi.mock("@goatcitadel/mission-control-shared/hooks/useProviderModelCatalog", () => ({
  useProviderModelCatalog: () => ({
    ...mocks.providerCatalogState,
    loadModelsForProvider: mocks.loadModelsForProvider,
    reload: mocks.reload,
  }),
}));

function renderPage(): ReactTestRenderer {
  return create(
    <SettingsNativePage
      route={{ area: "settings", section: "providers", theme: "ops" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findInputByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.type === "input" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  )[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadModelsForProvider = vi.fn(async () => ["gpt-5.4-mini"]);
  mocks.reload = vi.fn(async () => undefined);
  mocks.providerCatalogState = {
    config: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
      providers: [],
      providerConfigs: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-responses",
          defaultModel: "gpt-5.4-mini",
        },
      ],
    },
    providers: [
      {
        providerId: "openai",
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
        apiStyle: "openai-responses",
        models: ["gpt-5.4-mini"],
        hasApiKey: true,
        apiKeySource: "keychain",
        modelProbeState: "ready" as const,
        modelProbeCheckedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    loading: false,
    error: null,
  };
});

describe("SettingsNativePage providers", () => {
  it("saves provider upserts through patchSettings", async () => {
    let renderer: ReactTestRenderer | null = null;

    await act(async () => {
      renderer = renderPage();
    });

    await act(async () => {
      findButton(renderer!.root, "New provider draft").props.onClick();
    });

    await act(async () => {
      findInputByPlaceholder(renderer!.root, "openai-compatible").props.onChange({
        target: { value: "local-gateway" },
      });
      findInputByPlaceholder(renderer!.root, "OpenAI-compatible").props.onChange({
        target: { value: "Local Gateway" },
      });
      findInputByPlaceholder(renderer!.root, "https://llm.example.test/v1").props.onChange({
        target: { value: "http://127.0.0.1:11434/v1" },
      });
      findInputByPlaceholder(renderer!.root, "gpt-5.4-mini").props.onChange({ target: { value: "llama3.2" } });
      findInputByPlaceholder(renderer!.root, "OPENAI_API_KEY").props.onChange({
        target: { value: "LOCAL_GATEWAY_API_KEY" },
      });
    });

    await act(async () => {
      findButton(renderer!.root, "Save provider").props.onClick();
    });

    expect(mocks.patchSettings).toHaveBeenCalledWith({
      llm: {
        upsertProvider: {
          providerId: "local-gateway",
          label: "Local Gateway",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiStyle: "openai-responses",
          defaultModel: "llama3.2",
          apiKeyEnv: "LOCAL_GATEWAY_API_KEY",
          request: undefined,
        },
      },
    });
  });

  it("supports forced model probes and secure secret save/delete flows", async () => {
    let renderer: ReactTestRenderer | null = null;
    const previousWindow = globalThis.window;
    const confirmSpy = vi.fn(() => true);
    Object.assign(globalThis, {
      window: {
        confirm: confirmSpy,
      },
    });

    try {
      await act(async () => {
        renderer = renderPage();
      });

      await act(async () => {
        findButton(renderer!.root, "Refresh models").props.onClick();
      });

      expect(mocks.loadModelsForProvider).toHaveBeenCalledWith("openai", { force: true });

      await act(async () => {
        findInputByPlaceholder(renderer!.root, "Paste a new API key to save").props.onChange({
          target: { value: "sk-test-secret" },
        });
      });

      await act(async () => {
        findButton(renderer!.root, "Save secret").props.onClick();
      });

      expect(mocks.saveProviderSecret).toHaveBeenCalledWith("openai", "sk-test-secret");

      await act(async () => {
        findButton(renderer!.root, "Delete secret").props.onClick();
      });

      expect(confirmSpy).toHaveBeenCalled();
      expect(mocks.deleteProviderSecret).toHaveBeenCalledWith("openai");
    } finally {
      Object.assign(globalThis, { window: previousWindow });
    }
  });
});
