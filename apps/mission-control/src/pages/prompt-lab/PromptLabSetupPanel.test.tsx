import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PromptLabSetupPanel } from "./PromptLabSetupPanel";

vi.mock("../../components/ActionButton", () => ({
  ActionButton: ({
    label,
    pending,
    disabled,
    onClick,
  }: {
    label: string;
    pending?: boolean;
    disabled?: boolean;
    onClick: () => void;
  }) => (
    <button type="button" disabled={Boolean(disabled || pending)} onClick={onClick}>
      {pending ? `${label} pending` : label}
    </button>
  ),
}));

vi.mock("../../components/ChatModelPicker", () => ({
  ChatModelPicker: ({
    providers,
    providerId,
    model,
    disabled,
    onChangeProvider,
    onChangeModel,
  }: {
    providers: Array<{ providerId: string; label: string; models: string[] }>;
    providerId: string;
    model: string;
    disabled?: boolean;
    onChangeProvider: (providerId: string) => void;
    onChangeModel: (model: string) => void;
  }) => (
    <div data-testid="model-picker" data-disabled={disabled} data-provider-count={providers.length}>
      <select
        aria-label="provider"
        value={providerId}
        disabled={disabled}
        onChange={(event) => onChangeProvider(event.target.value)}
      >
        {providers.map((provider) => (
          <option key={provider.providerId} value={provider.providerId}>
            {provider.label}
          </option>
        ))}
      </select>
      <input
        aria-label="model"
        value={model}
        disabled={disabled}
        onChange={(event) => onChangeModel(event.target.value)}
      />
    </div>
  ),
}));

function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => textOf(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return textOf((node as { children?: unknown }).children);
  }
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function button(renderer: ReactTestRenderer, label: string) {
  const match = renderer.root.findAllByType("button").find((node) => textOf(node).includes(label));
  if (!match) {
    throw new Error(`Button not found: ${label}`);
  }
  return match;
}

function renderSetup(overrides: Partial<React.ComponentProps<typeof PromptLabSetupPanel>> = {}) {
  const props: React.ComponentProps<typeof PromptLabSetupPanel> = {
    importText: "",
    importing: false,
    packs: [
      {
        packId: "pack-a",
        name: "Release readiness",
        testCount: 3,
      },
      {
        packId: "pack-b",
        name: "Operator truth",
        testCount: 2,
      },
    ],
    selectedPackId: "pack-a",
    providerOptions: [
      {
        providerId: "openai",
        label: "OpenAI",
        models: ["gpt-5.1"],
      },
    ],
    selectedProviderId: "openai",
    selectedModel: "gpt-5.1",
    reuseLastModel: false,
    autoScoreOnRun: true,
    lastSuccessfulModel: null,
    selectedRunModel: {
      providerId: "openai",
      model: "gpt-5.1",
    },
    benchmarkTestCodes: "TEST-01",
    benchmarkProvidersInput: "openai/gpt-5.1",
    benchmarkActive: true,
    benchmarkPending: false,
    benchmarkStopping: false,
    benchmarkRunId: "bench-1",
    regressionPending: false,
    regressionRunId: "reg-1",
    regressionStatus: {
      run: {
        regressionRunId: "reg-1",
        status: "completed",
      },
      results: [{ resultId: "result-1" }],
    },
    running: false,
    onImportTextChange: vi.fn(),
    onImport: vi.fn(),
    onSelectedPackIdChange: vi.fn(),
    onSelectedProviderIdChange: vi.fn(),
    onSelectedModelChange: vi.fn(),
    onReuseLastModelChange: vi.fn(),
    onAutoScoreOnRunChange: vi.fn(),
    onBenchmarkTestCodesChange: vi.fn(),
    onBenchmarkProvidersInputChange: vi.fn(),
    onRunBenchmark: vi.fn(),
    onCancelBenchmark: vi.fn(),
    onRefreshBenchmark: vi.fn(),
    onRunRegression: vi.fn(),
    onRefreshRegression: vi.fn(),
    ...overrides,
  };
  return {
    props,
    renderer: create(<PromptLabSetupPanel {...props} />),
  };
}

describe("PromptLabSetupPanel", () => {
  it("routes import, pack, model, scoring, and benchmark changes through callbacks", () => {
    const { props, renderer } = renderSetup();

    act(() => {
      renderer.root.findAllByType("textarea")[0]?.props.onChange({ target: { value: "# pack" } });
      button(renderer, "Import").props.onClick();
      button(renderer, "Operator truth").props.onClick();
      renderer.root.findByProps({ "aria-label": "provider" }).props.onChange({ target: { value: "openai" } });
      renderer.root.findByProps({ "aria-label": "model" }).props.onChange({ target: { value: "gpt-5.2" } });
      renderer.root
        .findAllByType("input")
        .find((node) => node.props.type === "checkbox")
        ?.props.onChange({
          target: { checked: true },
        });
      renderer.root
        .findAllByType("input")
        .filter((node) => node.props.type === "checkbox")[1]
        ?.props.onChange({
          target: { checked: false },
        });
      renderer.root.findAllByType("textarea")[1]?.props.onChange({ target: { value: "TEST-02\nTEST-03" } });
      renderer.root.findAllByType("textarea")[2]?.props.onChange({ target: { value: "glm/glm-5" } });
      button(renderer, "Start benchmark").props.onClick();
      button(renderer, "Stop benchmark").props.onClick();
      button(renderer, "Refresh benchmark").props.onClick();
      button(renderer, "Run replay regression").props.onClick();
      button(renderer, "Refresh regression").props.onClick();
    });

    expect(props.onImportTextChange).toHaveBeenCalledWith("# pack");
    expect(props.onImport).toHaveBeenCalledTimes(1);
    expect(props.onSelectedPackIdChange).toHaveBeenCalledWith("pack-b");
    expect(props.onSelectedProviderIdChange).toHaveBeenCalledWith("openai");
    expect(props.onSelectedModelChange).toHaveBeenCalledWith("gpt-5.2");
    expect(props.onReuseLastModelChange).toHaveBeenCalledWith(true);
    expect(props.onAutoScoreOnRunChange).toHaveBeenCalledWith(false);
    expect(props.onBenchmarkTestCodesChange).toHaveBeenCalledWith("TEST-02\nTEST-03");
    expect(props.onBenchmarkProvidersInputChange).toHaveBeenCalledWith("glm/glm-5");
    expect(props.onRunBenchmark).toHaveBeenCalledTimes(1);
    expect(props.onCancelBenchmark).toHaveBeenCalledTimes(1);
    expect(props.onRefreshBenchmark).toHaveBeenCalledTimes(1);
    expect(props.onRunRegression).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRegression).toHaveBeenCalledTimes(1);
    const normalizedText = textOf(renderer.root).replace(/\s+/g, " ");
    expect(normalizedText).toContain("Requested model for new runs: openai/gpt-5.1");
    expect(normalizedText).toContain("Replay regression:");
    expect(normalizedText).toContain("results: 1");
  });

  it("renders reuse-last-model copy and disables run controls when inputs are unavailable", () => {
    const { renderer } = renderSetup({
      selectedPackId: null,
      providerOptions: [],
      selectedProviderId: "",
      selectedModel: "",
      reuseLastModel: true,
      autoScoreOnRun: false,
      lastSuccessfulModel: {
        providerId: "local",
        model: "llama.cpp",
      },
      selectedRunModel: null,
      benchmarkActive: false,
      benchmarkRunId: null,
      regressionRunId: null,
      regressionStatus: null,
      running: true,
    });

    expect(textOf(renderer.root)).toContain("New runs will reuse the last successful request: local/llama.cpp");
    expect(renderer.root.findByProps({ "data-testid": "model-picker" }).props["data-disabled"]).toBe(true);
    expect(button(renderer, "Start benchmark").props.disabled).toBe(true);
    expect(button(renderer, "Stop benchmark").props.disabled).toBe(true);
    expect(button(renderer, "Refresh benchmark").props.disabled).toBe(true);
    expect(button(renderer, "Run replay regression").props.disabled).toBe(true);
    expect(button(renderer, "Refresh regression").props.disabled).toBe(true);
    expect(textOf(renderer.root)).not.toContain("Replay regression:");
  });
});
