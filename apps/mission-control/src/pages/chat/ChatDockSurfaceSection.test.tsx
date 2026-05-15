import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../components/chat/ChatPlanningPill", () => ({
  ChatPlanningPill: ({ planningMode, effectiveToolAutonomy }: any) => (
    <p>
      planning:{planningMode}:{effectiveToolAutonomy}
    </p>
  ),
}));

vi.mock("../../components/ChatModelPicker", () => ({
  ChatModelPicker: ({ providerId, model, disabled, onChangeProvider, onChangeModel }: any) => (
    <div>
      model-picker:{providerId ?? "auto"}:{model ?? "auto"}:{disabled ? "disabled" : "enabled"}
      <button type="button" disabled={disabled} onClick={() => onChangeProvider("anthropic")}>
        change-provider
      </button>
      <button type="button" disabled={disabled} onClick={() => onChangeModel("claude-4-opus")}>
        change-model
      </button>
    </div>
  ),
}));

vi.mock("../../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      <div>{primary}</div>
      <div>{secondary}</div>
    </div>
  ),
}));

vi.mock("../../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      <h3>{title}</h3>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ children, tone }: { children?: React.ReactNode; tone?: string }) => (
    <span>
      chip:{tone}:{children}
    </span>
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: ({ value, disabled, onChange, options }: any) => (
    <button type="button" disabled={disabled} onClick={() => onChange(options.at(-1)?.value)}>
      select:{value}
    </button>
  ),
  GCSwitch: ({ checked, disabled, onCheckedChange }: any) => (
    <button type="button" disabled={disabled} onClick={() => onCheckedChange(!checked)}>
      switch:{checked ? "on" : "off"}
    </button>
  ),
}));

import { ChatDockSurfaceSection } from "./ChatDockSurfaceSection";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

function findButton(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => matchesText(instanceText(button), label));
}

function findButtons(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").filter((button) => matchesText(instanceText(button), label));
}

function matchesText(actual: string, expected: string): boolean {
  const compactActual = actual.replace(/\s+/g, "");
  const compactExpected = expected.replace(/\s+/g, "");
  return actual.includes(expected) || compactActual.includes(compactExpected);
}

function modePreset(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Fast chat with transparent controls.",
    teamBehaviorLabel: "Solo",
    teamBehaviorSummary: "One assistant answers directly.",
    allowsDynamicTeamGrowth: false,
    growthPolicyLabel: "Manual team",
    growthPolicySummary: "Specialists stay opt-in.",
    ...overrides,
  } as any;
}

function buildProps(overrides: Partial<Parameters<typeof ChatDockSurfaceSection>[0]> = {}) {
  return {
    isChatSurface: true,
    isCoworkSurface: false,
    isCodeSurface: false,
    activeModePreset: modePreset(),
    planningMode: "off" as const,
    effectiveToolAutonomy: "manual" as const,
    codeModeNeedsProjectBinding: false,
    selectedProjectBindingCandidateId: undefined,
    selectedProjectBindingCandidateName: undefined,
    sending: false,
    sessionControlPending: null,
    providerOptions: [
      {
        providerId: "openai",
        label: "OpenAI",
        disabled: false,
        modelProbeState: "ready",
        isLocalRuntime: false,
      },
      {
        providerId: "anthropic",
        label: "Anthropic",
        disabled: false,
        modelProbeState: "fallback",
        isLocalRuntime: false,
      },
    ] as any,
    selectedProviderId: "openai",
    selectedModel: "gpt-5.1",
    streamEnabled: true,
    onStreamEnabledChange: vi.fn(),
    prefs: {
      thinkingLevel: "standard",
      webMode: "auto",
      orchestrationEnabled: true,
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
    } as any,
    selectedSessionId: "session-1",
    proactiveStatus: null,
    loadModelsForProvider: vi.fn(async () => []),
    getCachedModels: vi.fn(() => ["claude-4-sonnet"]),
    resolveProviderModelSelection: vi.fn(() => ({ model: "claude-4-sonnet" })),
    onPrefPatch: vi.fn(async () => undefined),
    onSuggestDelegation: vi.fn(async () => undefined),
    onTriggerProactive: vi.fn(async () => undefined),
    onProactivePolicyPatch: vi.fn(async () => undefined),
    onRunCodeDelegation: vi.fn(async () => undefined),
    onAssignProject: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ChatDockSurfaceSection", () => {
  it("renders code controls, project binding action, and forwards model and delegation changes", async () => {
    const props = buildProps({
      isChatSurface: false,
      isCodeSurface: true,
      codeModeNeedsProjectBinding: true,
      selectedProjectBindingCandidateId: "project-1",
      selectedProjectBindingCandidateName: "Mission Control",
      activeModePreset: modePreset({
        teamBehaviorLabel: "Coder",
        teamBehaviorSummary: "Code work stays scoped to a project.",
        growthPolicyLabel: "Review loop",
      }),
    });
    const renderer = create(<ChatDockSurfaceSection {...props} />);

    const text = rendererText(renderer);
    expect(text).toContain("Execution controls");
    expect(text).toContain("Code mode is unbound");
    expect(text).toContain("Bind Mission Control");
    expect(text).toContain("model-picker:");
    expect(text).toContain("openai");
    expect(text).toContain("gpt-5.1");
    expect(text).toContain("enabled");

    await act(async () => {
      await findButton(renderer, "Bind Mission Control")?.props.onClick();
      findButton(renderer, "change-provider")?.props.onClick();
      findButton(renderer, "change-model")?.props.onClick();
      findButtons(renderer, "select:standard")[0]?.props.onClick();
      findButtons(renderer, "select:auto")[0]?.props.onClick();
      findButtons(renderer, "switch:on")[0]?.props.onClick();
      findButtons(renderer, "switch:on")[1]?.props.onClick();
      await findButton(renderer, "Implement")?.props.onClick();
      await findButton(renderer, "Review")?.props.onClick();
      await findButton(renderer, "Test")?.props.onClick();
      await findButton(renderer, "Ship cycle")?.props.onClick();
    });

    expect(props.onAssignProject).toHaveBeenCalledWith("project-1");
    expect(props.loadModelsForProvider).toHaveBeenCalledWith("anthropic");
    expect(props.getCachedModels).toHaveBeenCalledWith("anthropic");
    expect(props.resolveProviderModelSelection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: expect.objectContaining({ providerId: "anthropic" }) }),
    );
    expect(props.onPrefPatch).toHaveBeenCalledWith({ providerId: "anthropic", model: "claude-4-sonnet" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ model: "claude-4-opus" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ thinkingLevel: "extended" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ webMode: "deep" });
    expect(props.onStreamEnabledChange).toHaveBeenCalledWith(false);
    expect(props.onPrefPatch).toHaveBeenCalledWith({ orchestrationEnabled: false });
    expect(props.onRunCodeDelegation).toHaveBeenCalledWith("implement");
    expect(props.onRunCodeDelegation).toHaveBeenCalledWith("review");
    expect(props.onRunCodeDelegation).toHaveBeenCalledWith("test");
    expect(props.onRunCodeDelegation).toHaveBeenCalledWith("ship");

    renderer.unmount();
  });

  it("keeps Cowork run settings collapsed until requested and then forwards policy actions", async () => {
    const props = buildProps({
      isChatSurface: false,
      isCoworkSurface: true,
      selectedProviderId: "local",
      providerOptions: [
        {
          providerId: "local",
          label: "Local llama",
          disabled: false,
          modelProbeState: "ready",
          isLocalRuntime: true,
        },
        {
          providerId: "anthropic",
          label: "Anthropic",
          disabled: false,
          modelProbeState: "fallback",
          isLocalRuntime: false,
        },
      ] as any,
      activeModePreset: modePreset({
        teamBehaviorLabel: "Workflow",
        growthPolicyLabel: "Dynamic team",
        allowsDynamicTeamGrowth: true,
      }),
      proactiveStatus: {
        mode: "suggest",
        retrievalMode: "layered",
        reflectionMode: "on",
      } as any,
    });
    const renderer = create(<ChatDockSurfaceSection {...props} />);

    expect(rendererText(renderer)).toContain("Session controls");
    expect(rendererText(renderer)).toContain("Local llama / gpt-5.1");
    expect(rendererText(renderer)).toContain("Runtime reachable");
    expect(rendererText(renderer)).not.toContain("Suggest delegation");

    act(() => {
      findButton(renderer, "Adjust run settings")?.props.onClick();
    });

    expect(rendererText(renderer)).toContain("Hide run settings");
    expect(rendererText(renderer)).toContain("Suggest delegation");

    await act(async () => {
      findButton(renderer, "change-provider")?.props.onClick();
      findButton(renderer, "change-model")?.props.onClick();
      findButtons(renderer, "select:standard")[0]?.props.onClick();
      findButtons(renderer, "select:auto")[0]?.props.onClick();
      findButtons(renderer, "select:suggest")[0]?.props.onClick();
      findButtons(renderer, "select:layered")[0]?.props.onClick();
      findButtons(renderer, "select:on")[0]?.props.onClick();
      await findButton(renderer, "Suggest delegation")?.props.onClick();
      await findButton(renderer, "Run proactive")?.props.onClick();
    });

    expect(props.onPrefPatch).toHaveBeenCalledWith({ providerId: "anthropic", model: "claude-4-sonnet" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ model: "claude-4-opus" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ thinkingLevel: "extended" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ webMode: "deep" });
    expect(props.onProactivePolicyPatch).toHaveBeenCalledWith({ proactiveMode: "auto_full" });
    expect(props.onProactivePolicyPatch).toHaveBeenCalledWith({ retrievalMode: "layered" });
    expect(props.onProactivePolicyPatch).toHaveBeenCalledWith({ reflectionMode: "on" });
    expect(props.onSuggestDelegation).toHaveBeenCalledTimes(1);
    expect(props.onTriggerProactive).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });

  it("renders chat toolbar controls and forwards lightweight preference changes", () => {
    const props = buildProps();
    const renderer = create(<ChatDockSurfaceSection {...props} />);

    expect(rendererText(renderer)).toContain("Surface controls");
    expect(rendererText(renderer)).toContain("Fast chat with transparent controls.");
    expect(rendererText(renderer)).toContain("One assistant answers directly.");
    expect(rendererText(renderer)).toContain("model-picker:");
    expect(rendererText(renderer)).toContain("openai");
    expect(rendererText(renderer)).toContain("gpt-5.1");
    expect(rendererText(renderer)).not.toContain("Run proactive");

    act(() => {
      findButton(renderer, "change-provider")?.props.onClick();
      findButton(renderer, "change-model")?.props.onClick();
      findButtons(renderer, "select:standard")[0]?.props.onClick();
      findButtons(renderer, "select:auto")[0]?.props.onClick();
    });

    expect(props.onPrefPatch).toHaveBeenCalledWith({ providerId: "anthropic", model: "claude-4-sonnet" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ model: "claude-4-opus" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ thinkingLevel: "extended" });
    expect(props.onPrefPatch).toHaveBeenCalledWith({ webMode: "deep" });

    renderer.unmount();
  });

  it.each([
    [undefined, "Runtime not checked"],
    [{ disabled: true }, "Provider setup required"],
    [{ modelProbeState: "ready", isLocalRuntime: false }, "Provider reachable"],
    [{ modelProbeState: "fallback", isLocalRuntime: false }, "Suggested models"],
    [{ modelProbeState: "empty", isLocalRuntime: true }, "Runtime degraded"],
    [{ modelProbeState: "empty", isLocalRuntime: false }, "Models unavailable"],
    [{ modelProbeState: "error", isLocalRuntime: true }, "Runtime unreachable"],
    [{ modelProbeState: "error", isLocalRuntime: false }, "Provider unreachable"],
    [{ modelProbeState: "unknown", isLocalRuntime: false }, "Runtime not checked"],
  ])("describes provider runtime state as %s", (providerState, expected) => {
    const provider = providerState
      ? {
          providerId: "provider-under-test",
          label: "Provider under test",
          disabled: false,
          isLocalRuntime: false,
          ...providerState,
        }
      : null;
    const renderer = create(
      <ChatDockSurfaceSection
        {...buildProps({
          isChatSurface: false,
          isCoworkSurface: true,
          selectedProviderId: provider ? "provider-under-test" : "missing",
          providerOptions: provider ? ([provider] as any) : [],
        })}
      />,
    );

    expect(rendererText(renderer)).toContain(expected);

    renderer.unmount();
  });
});
