import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SettingsRuntimeSection, type SettingsRuntimeSectionProps } from "./SettingsRuntimeSection";

function baseProps(overrides: Partial<SettingsRuntimeSectionProps> = {}): SettingsRuntimeSectionProps {
  return {
    deploymentProfile: "trusted_local",
    onDeploymentProfileChange: vi.fn(),
    profile: "standard",
    onProfileChange: vi.fn(),
    toolProfileOptions: [
      { value: "standard", label: "Standard" },
      { value: "autonomous", label: "Autonomous" },
    ],
    budgetMode: "balanced",
    onBudgetModeChange: vi.fn(),
    readAccessMode: "roots_only",
    onReadAccessModeChange: vi.fn(),
    readAccessModeOptions: [
      { value: "roots_only", label: "Trusted roots only" },
      { value: "approval_required", label: "Ask before outside-root reads" },
      { value: "full_disk", label: "Full disk read access" },
    ],
    allowlistPreset: "local",
    onAllowlistPresetChange: vi.fn(),
    allowlistPresets: [
      { id: "local", label: "Local hosts", hosts: ["127.0.0.1"] },
      { id: "providers", label: "Providers", hosts: ["api.openai.com"] },
    ],
    networkAllowlistText: "127.0.0.1\nlocalhost",
    onNetworkAllowlistTextChange: vi.fn(),
    firecrawlEnabled: false,
    onFirecrawlEnabledChange: vi.fn(),
    firecrawlDefaultReadBackend: "native",
    onFirecrawlDefaultReadBackendChange: vi.fn(),
    firecrawlDefaultReadBackendOptions: [
      { value: "native", label: "Native" },
      { value: "firecrawl", label: "Firecrawl" },
    ],
    firecrawlBaseUrl: "http://127.0.0.1:3002",
    onFirecrawlBaseUrlChange: vi.fn(),
    firecrawlApiKeyEnv: "FIRECRAWL_API_KEY",
    onFirecrawlApiKeyEnvChange: vi.fn(),
    firecrawlTimeoutMs: 20000,
    onFirecrawlTimeoutMsChange: vi.fn(),
    firecrawlFallbackToNative: true,
    onFirecrawlFallbackToNativeChange: vi.fn(),
    onSaveRuntime: vi.fn(),
    blockSaves: false,
    ...overrides,
  };
}

function byId(renderer: ReactTestRenderer, id: string) {
  return renderer.root.findByProps({ id });
}

function buttonByText(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((button) => button.children.includes(label));
}

function switchById(renderer: ReactTestRenderer, id: string) {
  const control = renderer.root.findAllByProps({ id }).find((node) => typeof node.props.onClick === "function");
  if (!control) {
    throw new Error(`Unable to find switch ${id}`);
  }
  return control;
}

describe("SettingsRuntimeSection", () => {
  it("renders runtime posture controls and wires control changes to callbacks", () => {
    const props = baseProps({ deploymentProfile: "remote_hardened" });
    const renderer = create(<SettingsRuntimeSection {...props} />);

    expect(renderer.root.findByProps({ id: "settings-runtime" }).props.className).toContain("settings-v2-section");
    expect(JSON.stringify(renderer.toJSON())).toContain("Hardened mode fails closed");
    const optionValues = renderer.root.findAllByType("option").map((option) => option.props.value);
    expect(optionValues).toEqual(expect.arrayContaining(["providers", "custom"]));

    act(() => {
      byId(renderer, "deploymentProfile").props.onChange("local_dev");
      byId(renderer, "budgetMode").props.onChange("power");
      byId(renderer, "readAccessMode").props.onChange("full_disk");
      byId(renderer, "allowlistPreset").props.onChange("custom");
      switchById(renderer, "firecrawlEnabled").props.onClick();
      byId(renderer, "firecrawlDefaultReadBackend").props.onChange("firecrawl");
      byId(renderer, "firecrawlBaseUrl").props.onChange({ target: { value: "http://127.0.0.1:9090" } });
      byId(renderer, "firecrawlApiKeyEnv").props.onChange({ target: { value: "ALT_FIRECRAWL_KEY" } });
      byId(renderer, "firecrawlTimeoutMs").props.onChange({ target: { value: "500" } });
      switchById(renderer, "firecrawlFallbackToNative").props.onClick();
      byId(renderer, "allowlist").props.onChange({ target: { value: "api.z.ai" } });
      buttonByText(renderer, "Save Runtime Controls")?.props.onClick();
    });

    expect(props.onDeploymentProfileChange).toHaveBeenCalledWith("local_dev");
    expect(props.onBudgetModeChange).toHaveBeenCalledWith("power");
    expect(props.onReadAccessModeChange).toHaveBeenCalledWith("full_disk");
    expect(props.onAllowlistPresetChange).toHaveBeenCalledWith("custom");
    expect(props.onFirecrawlEnabledChange).toHaveBeenCalledWith(true);
    expect(props.onFirecrawlDefaultReadBackendChange).toHaveBeenCalledWith("firecrawl");
    expect(props.onFirecrawlBaseUrlChange).toHaveBeenCalledWith("http://127.0.0.1:9090");
    expect(props.onFirecrawlApiKeyEnvChange).toHaveBeenCalledWith("ALT_FIRECRAWL_KEY");
    expect(props.onFirecrawlTimeoutMsChange).toHaveBeenCalledWith(1000);
    expect(props.onFirecrawlFallbackToNativeChange).toHaveBeenCalledWith(false);
    expect(props.onNetworkAllowlistTextChange).toHaveBeenCalledWith("api.z.ai");
    expect(props.onSaveRuntime).toHaveBeenCalledTimes(1);
  });

  it("supports custom tool profiles and disables saving when saves are blocked", () => {
    const props = baseProps({ profile: "custom-profile", blockSaves: true });
    const renderer = create(<SettingsRuntimeSection {...props} />);

    const customModeButton = buttonByText(renderer, "Custom");
    expect(customModeButton).toBeDefined();

    act(() => {
      customModeButton?.props.onClick();
    });

    const customInput = renderer.root
      .findAllByType("input")
      .find((input) => input.props.placeholder === "Custom tool profile");
    expect(customInput?.props.value).toBe("custom-profile");

    act(() => {
      customInput?.props.onChange({ target: { value: "repo-admin" } });
      byId(renderer, "firecrawlTimeoutMs").props.onChange({ target: { value: "" } });
    });

    expect(props.onProfileChange).toHaveBeenCalledWith("repo-admin");
    expect(props.onFirecrawlTimeoutMsChange).toHaveBeenCalledWith(20000);
    expect(buttonByText(renderer, "Save Runtime Controls")?.props.disabled).toBe(true);
  });
});
