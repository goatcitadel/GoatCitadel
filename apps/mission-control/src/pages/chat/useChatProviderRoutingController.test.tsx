import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { useChatProviderRoutingController } from "./useChatProviderRoutingController";

let latest: ReturnType<typeof useChatProviderRoutingController> | null = null;

function Harness(props: {
  draft?: string;
  onLoadModels?: (providerId: string) => Promise<string[]>;
}) {
  const [draft, setDraft] = useState(props.draft ?? "/mcp connect alpha");
  latest = useChatProviderRoutingController({
    runtimeLlmConfig: {
      activeProviderId: "openai",
      activeModel: "gpt-5.4-mini",
    } as any,
    runtimeProviderCatalog: [
      {
        providerId: "openai",
        label: "OpenAI",
        defaultModel: "gpt-5.4-mini",
        hasApiKey: true,
        models: ["gpt-5.4-mini"],
      },
    ],
    getCachedModels: vi.fn(() => ["gpt-5.4-mini"]),
    loadModelsForProvider: props.onLoadModels ?? vi.fn(async () => ["gpt-5.4-mini"]),
    prefs: {
      providerId: "openai",
      model: "gpt-5.4-mini",
    } as any,
    settings: {
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5.4-mini",
      },
    } as any,
    draft,
    commandCatalog: [
      {
        command: "/help",
        usage: "/help",
        description: "Show help",
      },
    ],
    installedSkills: [],
    mcpServers: [
      {
        serverId: "alpha",
        label: "Alpha Server",
        status: "connected",
      },
    ] as any,
    mcpTemplates: [],
  });

  return <button type="button" onClick={() => setDraft("/help")}>reset</button>;
}

describe("useChatProviderRoutingController", () => {
  it("loads provider models and builds command suggestions from provider-adjacent state", async () => {
    const onLoadModels = vi.fn(async () => ["gpt-5.4-mini"]);
    await act(async () => {
      create(<Harness onLoadModels={onLoadModels} />);
    });

    expect(onLoadModels).toHaveBeenCalledWith("openai");
    expect(latest?.selectedProviderId).toBe("openai");
    expect(latest?.selectedModel).toBe("gpt-5.4-mini");
    expect(latest?.commandSuggestions[0]).toMatchObject({
      command: "/mcp connect alpha",
    });
  });

  it("resets the highlighted command suggestion when the draft changes", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness draft="/mcp connect alpha" />);
    });

    act(() => {
      latest?.setCommandIndex(3);
    });
    expect(latest?.commandIndex).toBe(3);

    await act(async () => {
      renderer.root.findByType("button").props.onClick();
    });

    expect(latest?.commandIndex).toBe(0);
  });

  it("falls back cleanly when runtime settings are missing llm defaults", async () => {
    function PartialSettingsHarness() {
      latest = useChatProviderRoutingController({
        runtimeLlmConfig: null,
        runtimeProviderCatalog: [
          {
            providerId: "openai",
            label: "OpenAI",
            defaultModel: "gpt-5.4-mini",
            hasApiKey: true,
            models: ["gpt-5.4-mini"],
          },
        ],
        getCachedModels: vi.fn(() => ["gpt-5.4-mini"]),
        loadModelsForProvider: vi.fn(async () => ["gpt-5.4-mini"]),
        prefs: null,
        settings: {} as any,
        draft: "",
        commandCatalog: [],
        installedSkills: [],
        mcpServers: [],
        mcpTemplates: [],
      });

      return null;
    }

    await act(async () => {
      create(<PartialSettingsHarness />);
    });

    expect(latest?.selectedProviderId).toBeUndefined();
    expect(latest?.selectedProviderLabel).toBe("Provider auto");
    expect(latest?.selectedModelLabel).toBe("Model auto");
  });
});
