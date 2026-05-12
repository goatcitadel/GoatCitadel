import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatProviderRoutingController } from "./useChatProviderRoutingController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeProviderCatalog = [
  {
    providerId: "openai",
    label: "OpenAI",
    defaultModel: "gpt-image-1",
    hasApiKey: true,
    models: ["gpt-5.5"],
    capabilities: { imageGenerate: true, voiceInput: true, voiceOutput: true },
    modelProbeState: "ready",
    modelProbeCheckedAt: "2026-05-01T10:15:00.000Z",
  },
  {
    providerId: "local",
    label: "Local Runtime",
    baseUrl: "http://127.0.0.1:8080",
    hasApiKey: false,
    models: ["local-model"],
    modelProbeState: "error",
  },
  {
    providerId: "google",
    label: "Google",
    hasApiKey: false,
    models: ["gemini-3-pro-image-preview"],
    capabilities: { imageGenerate: true },
    modelProbeState: "fallback",
  },
];

const commandCatalog = [
  { command: "/model", usage: "/model <provider:model>", description: "Switch models" },
  { command: "/memory", usage: "/memory rebuild", description: "Refresh memory" },
];

let latest: ReturnType<typeof useChatProviderRoutingController> | null = null;
const loadModelsForProvider = vi.fn(async () => ["gpt-5.5"]);

function Harness(props: { draft: string; prefs?: Record<string, unknown> | null }) {
  latest = useChatProviderRoutingController({
    runtimeLlmConfig: { activeProviderId: "local", activeModel: "local-model" } as never,
    runtimeProviderCatalog,
    getCachedModels: (providerId) => (providerId === "openai" ? ["gpt-5.5", "gpt-image-2"] : []),
    loadModelsForProvider,
    prefs:
      props.prefs === undefined
        ? ({ sessionId: "session-1", providerId: "openai", model: "gpt-image-2" } as never)
        : (props.prefs as never),
    settings: { llm: { activeProviderId: "google", activeModel: "gemini-3-pro-image-preview" } } as never,
    draft: props.draft,
    commandCatalog: commandCatalog as never,
    installedSkills: [
      { skillId: "reviewer", name: "Code Reviewer", state: "enabled", tags: ["quality"] },
      { skillId: "writer", name: "Writer", state: "sleeping", tags: ["docs"] },
    ] as never,
    mcpServers: [{ serverId: "github", label: "GitHub", status: "connected" }] as never,
    mcpTemplates: [{ templateId: "figma", label: "Figma", installed: true }] as never,
  });
  return null;
}

describe("useChatProviderRoutingController", () => {
  beforeEach(() => {
    latest = null;
    loadModelsForProvider.mockClear();
  });

  it("derives provider routing labels, runtime state, and model-loading side effects", async () => {
    await act(async () => {
      create(<Harness draft="" />);
    });

    expect(latest!.selectedProviderId).toBe("openai");
    expect(latest!.selectedModel).toBe("gpt-image-2");
    expect(latest!.selectedProviderLabel).toBe("OpenAI");
    expect(latest!.selectionSource).toBe("session");
    expect(latest!.selectionSourceLabel).toBe("Selection: session");
    expect(latest!.runtimeStatus).toBe("reachable");
    expect(latest!.runtimeSummary).toContain("Remote provider ready");
    expect(latest!.runtimeTone).toBe("success");
    expect(latest!.providerOptions.find((provider) => provider.providerId === "local")?.disabled).toBe(false);
    expect(latest!.providerOptions.find((provider) => provider.providerId === "google")?.disabled).toBe(true);
    expect(loadModelsForProvider).toHaveBeenCalledWith("openai");
  });

  it("resets command index when draft changes and builds command, skill, and MCP suggestions", async () => {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness draft="/" />);
    });
    act(() => {
      latest!.setCommandIndex(1);
    });
    expect(latest!.commandIndex).toBe(1);

    await act(async () => {
      renderer.update(<Harness draft="/plan " />);
    });
    expect(latest!.commandIndex).toBe(0);
    expect(latest!.commandSuggestions.map((item) => item.command)).toEqual(["/plan on", "/plan off"]);

    await act(async () => {
      renderer.update(<Harness draft="$rev" />);
    });
    expect(latest!.commandSuggestions[0]).toMatchObject({
      command: "$reviewer",
      applyValue: "$reviewer",
    });

    await act(async () => {
      renderer.update(<Harness draft="/skill enable rev" />);
    });
    expect(latest!.commandSuggestions[0]?.command).toBe("/skill enable reviewer");

    await act(async () => {
      renderer.update(<Harness draft="/mcp connect git" />);
    });
    expect(latest!.commandSuggestions[0]?.command).toBe("/mcp connect github");

    await act(async () => {
      renderer.update(<Harness draft="/mcp add-template fig" />);
    });
    expect(latest!.commandSuggestions[0]).toMatchObject({
      command: "/mcp add-template figma",
      description: "Figma · installed",
    });
  });

  it("falls back to global routing when session prefs do not specify a provider", async () => {
    await act(async () => {
      create(<Harness draft="/mem" prefs={null} />);
    });

    expect(latest!.selectedProviderId).toBe("local");
    expect(latest!.selectedModel).toBe("local-model");
    expect(latest!.selectionSource).toBe("global");
    expect(latest!.runtimeStatus).toBe("unreachable");
    expect(latest!.commandSuggestions[0]?.command).toBe("/memory");
  });
});
