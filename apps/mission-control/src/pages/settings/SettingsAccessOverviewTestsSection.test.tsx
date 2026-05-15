import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { SettingsAccessSection, type SettingsAccessSectionProps } from "./SettingsAccessSection";
import { SettingsOverviewSection } from "./SettingsOverviewSection";
import { SettingsSectionNav } from "./SettingsSectionNav";
import { SettingsTestsSection, type SettingsTestsSectionProps } from "./SettingsTestsSection";

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
      <h2>{title}</h2>
      <p>{subtitle}</p>
      {children}
    </section>
  ),
}));

vi.mock("../../components/FieldHelp", () => ({
  FieldHelp: ({ children, className }: { children?: React.ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}));

vi.mock("../../components/StatusChip", () => ({
  StatusChip: ({ children, tone }: { children?: React.ReactNode; tone?: string }) => (
    <span data-tone={tone}>{children}</span>
  ),
}));

vi.mock("../../components/ui", () => ({
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  GCSwitch: (props: {
    id?: string;
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
    label?: string;
    disabled?: boolean;
  }) => (
    <button
      id={props.id}
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange(!props.checked)}
    >
      {props.label ?? "Toggle setting"}
    </button>
  ),
}));

function collectText(node: unknown): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  if (typeof node === "object" && "children" in node) {
    return ((node as { children?: unknown[] }).children ?? []).map((child) => collectText(child)).join(" ");
  }
  return "";
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function hostById(renderer: ReactTestRenderer, id: string, type?: string): ReactTestInstance {
  const node = renderer.root
    .findAll((candidate) => typeof candidate.type === "string" && candidate.props.id === id)
    .find((candidate) => !type || candidate.type === type);
  if (!node) {
    throw new Error(`Host node not found: ${id}`);
  }
  return node;
}

function buttonByText(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = renderer.root
    .findAllByType("button")
    .find((node) => collectText(node).replace(/\s+/g, " ").includes(label));
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function baseAccessProps(overrides: Partial<SettingsAccessSectionProps> = {}): SettingsAccessSectionProps {
  return {
    authMode: "token",
    onAuthModeChange: vi.fn(),
    allowLoopbackBypass: false,
    onAllowLoopbackBypassChange: vi.fn(),
    authStorageMode: "session",
    onAuthStorageModeChange: vi.fn(),
    authToken: "token-1",
    onAuthTokenChange: vi.fn(),
    basicUsername: "",
    onBasicUsernameChange: vi.fn(),
    basicPassword: "",
    onBasicPasswordChange: vi.fn(),
    tokenConfigured: true,
    basicConfigured: false,
    onSaveAuth: vi.fn(),
    blockSaves: false,
    deviceGrants: [],
    deviceGrantBusyId: null,
    onRevokeDeviceGrant: vi.fn(),
    ...overrides,
  };
}

function baseTestsProps(overrides: Partial<SettingsTestsSectionProps> = {}): SettingsTestsSectionProps {
  return {
    chatPromptPresetId: "smoke",
    onChatPromptPresetIdChange: vi.fn(),
    chatPromptPresets: [
      { id: "smoke", label: "Smoke", prompt: "Say ready." },
      { id: "memory", label: "Memory", prompt: "Summarize memory truth." },
    ],
    chatPrompt: "Say ready.",
    onChatPromptChange: vi.fn(),
    chatUseMemory: false,
    onChatUseMemoryChange: vi.fn(),
    chatResponse: "",
    onTestChat: vi.fn(),
    ...overrides,
  };
}

describe("settings section components", () => {
  it("renders overview truth with fallback provider/model and posture chips", () => {
    const renderer = create(
      <SettingsOverviewSection
        environment="desktop"
        workspaceDir="F:\\code\\personal-ai"
        deploymentProfile="remote_hardened"
        authMode="none"
        activeProviderId=""
        fallbackProviderId="llamacpp"
        activeModel=""
        fallbackModel="llama-3.2"
        allowLoopbackBypass
      />,
    );

    const text = rendererText(renderer);
    expect(text).toContain("Current settings");
    expect(text).toContain("desktop");
    expect(text).toContain("remote_hardened");
    expect(text).toContain("Local-trusted auth");
    expect(text).toContain("llamacpp");
    expect(text).toContain("llama-3.2");
    expect(text).toContain("Loopback bypass on");
    expect(renderer.root.findAllByProps({ "data-tone": "warning" }).length).toBeGreaterThanOrEqual(2);
  });

  it("renders overview success and muted posture branches for configured providers", () => {
    const trusted = create(
      <SettingsOverviewSection
        environment="production"
        workspaceDir="F:\\code\\trusted"
        deploymentProfile="trusted_local"
        authMode="token"
        activeProviderId="openai"
        fallbackProviderId="llamacpp"
        activeModel="gpt-5.4"
        fallbackModel="llama-3.2"
        allowLoopbackBypass={false}
      />,
    );
    const local = create(
      <SettingsOverviewSection
        environment="local"
        workspaceDir="F:\\code\\local"
        deploymentProfile="local_dev"
        authMode="basic"
        activeProviderId=""
        fallbackProviderId=""
        activeModel=""
        fallbackModel=""
        allowLoopbackBypass={false}
      />,
    );

    expect(rendererText(trusted)).toContain("token auth");
    expect(rendererText(trusted)).toContain("Loopback bypass off");
    expect(rendererText(trusted)).toContain("openai");
    expect(rendererText(trusted)).toContain("gpt-5.4");
    expect(trusted.root.findAllByProps({ "data-tone": "success" }).length).toBeGreaterThanOrEqual(2);
    expect(rendererText(local)).toContain("basic auth");
    expect(rendererText(local)).toContain("No active provider");
    expect(rendererText(local)).toContain("not set");
    expect(local.root.findAllByProps({ "data-tone": "muted" }).length).toBeGreaterThanOrEqual(1);
  });

  it("renders settings navigation and dispatches target section ids", () => {
    const onNavigate = vi.fn();
    const renderer = create(
      <SettingsSectionNav
        onNavigate={onNavigate}
        sections={[
          { id: "settings-overview", label: "Overview", description: "Current gateway state" },
          { id: "settings-access", label: "Access", description: "Auth controls" },
        ]}
      />,
    );

    expect(rendererText(renderer)).toContain("Forge Sections");
    act(() => {
      buttonByText(renderer, "Overview").props.onClick();
      buttonByText(renderer, "Access").props.onClick();
    });

    expect(onNavigate).toHaveBeenNthCalledWith(1, "settings-overview");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "settings-access");
  });

  it("renders token access controls, stores credential preference, and revokes active device grants", () => {
    const props = baseAccessProps({
      deviceGrants: [
        {
          grantId: "grant-active",
          requestId: "request-active",
          actorId: "operator",
          deviceLabel: "Desktop Console",
          deviceType: "desktop",
          platform: "Windows",
          grantedBy: "owner",
          createdAt: "2026-05-14T00:00:00.000Z",
          lastUsedAt: undefined,
          expiresAt: undefined,
          revokedAt: undefined,
          metadata: {},
        },
      ],
    });
    const renderer = create(<SettingsAccessSection {...props} />);

    const text = rendererText(renderer);
    expect(text).toContain("Gateway Access");
    expect(text).toContain("token configured: yes");
    expect(text).toContain("basic configured: no");
    expect(text).toContain("Desktop Console");
    expect(text).toContain("last seen: never");
    expect(text).toContain("expires: no TTL");

    act(() => {
      hostById(renderer, "authMode", "select").props.onChange({ target: { value: "basic" } });
      hostById(renderer, "allowLoopbackBypassToggle", "button").props.onClick();
      hostById(renderer, "authRememberMeToggle", "button").props.onClick();
      hostById(renderer, "authToken", "input").props.onChange({ target: { value: "next-token" } });
      buttonByText(renderer, "Save Access Control").props.onClick();
      buttonByText(renderer, "Revoke device").props.onClick();
    });

    expect(props.onAuthModeChange).toHaveBeenCalledWith("basic");
    expect(props.onAllowLoopbackBypassChange).toHaveBeenCalledWith(true);
    expect(props.onAuthStorageModeChange).toHaveBeenCalledWith("persistent");
    expect(props.onAuthTokenChange).toHaveBeenCalledWith("next-token");
    expect(props.onSaveAuth).toHaveBeenCalledTimes(1);
    expect(props.onRevokeDeviceGrant).toHaveBeenCalledWith("grant-active");
  });

  it("renders basic access controls, disabled saves, and revoked/busy grant states", () => {
    const props = baseAccessProps({
      authMode: "basic",
      authStorageMode: "persistent",
      basicUsername: "operator",
      basicPassword: "secret",
      blockSaves: true,
      deviceGrantBusyId: "grant-busy",
      deviceGrants: [
        {
          grantId: "grant-revoked",
          requestId: "request-revoked",
          actorId: "operator",
          deviceLabel: "Old Phone",
          deviceType: "mobile",
          platform: undefined,
          grantedBy: "owner",
          createdAt: "2026-05-14T00:00:00.000Z",
          lastUsedAt: "2026-05-14T01:00:00.000Z",
          expiresAt: "2026-06-14T00:00:00.000Z",
          revokedAt: "2026-05-15T00:00:00.000Z",
          metadata: {},
        },
        {
          grantId: "grant-busy",
          requestId: "request-busy",
          actorId: "operator",
          deviceLabel: "Tablet",
          deviceType: "tablet",
          platform: "Android",
          grantedBy: "owner",
          createdAt: "2026-05-14T00:00:00.000Z",
          lastUsedAt: undefined,
          expiresAt: undefined,
          revokedAt: undefined,
          metadata: {},
        },
      ],
    });
    const renderer = create(<SettingsAccessSection {...props} />);

    expect(buttonByText(renderer, "Save Access Control").props.disabled).toBe(true);
    expect(buttonByText(renderer, "Revoked").props.disabled).toBe(true);
    expect(buttonByText(renderer, "Revoking...").props.disabled).toBe(true);

    act(() => {
      hostById(renderer, "basicUsername", "input").props.onChange({ target: { value: "admin" } });
      hostById(renderer, "basicPassword", "input").props.onChange({ target: { value: "next-secret" } });
      hostById(renderer, "authRememberMeToggle", "button").props.onClick();
    });

    expect(props.onBasicUsernameChange).toHaveBeenCalledWith("admin");
    expect(props.onBasicPasswordChange).toHaveBeenCalledWith("next-secret");
    expect(props.onAuthStorageModeChange).toHaveBeenCalledWith("session");
    expect(rendererText(renderer)).toContain("revoked:");
  });

  it("renders empty device grants without credential persistence controls for local-trusted auth", () => {
    const props = baseAccessProps({
      authMode: "none",
      tokenConfigured: false,
      basicConfigured: true,
    });
    const renderer = create(<SettingsAccessSection {...props} />);

    const text = rendererText(renderer);
    expect(text).toContain("No approved device grants yet.");
    expect(text).toContain("token configured: no");
    expect(text).toContain("basic configured: yes");
    expect(renderer.root.findAllByProps({ id: "authRememberMeToggle" })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ id: "authToken" })).toHaveLength(0);
  });

  it("updates prompt preset, custom prompt, memory toggle, and test action", () => {
    const props = baseTestsProps({ chatResponse: "Ready from provider." });
    const renderer = create(<SettingsTestsSection {...props} />);

    expect(rendererText(renderer)).toContain("LLM Test (Unified Routing)");
    expect(rendererText(renderer)).toContain("Ready from provider.");

    act(() => {
      hostById(renderer, "chatPromptPreset", "select").props.onChange({ target: { value: "memory" } });
      renderer.root.findByType("textarea").props.onChange({ target: { value: "custom prompt" } });
      hostById(renderer, "chatUseMemory", "button").props.onClick();
      buttonByText(renderer, "Run Test Prompt").props.onClick();
    });

    expect(props.onChatPromptPresetIdChange).toHaveBeenCalledWith("memory");
    expect(props.onChatPromptChange).toHaveBeenCalledWith("Summarize memory truth.");
    expect(props.onChatPromptChange).toHaveBeenCalledWith("custom prompt");
    expect(props.onChatUseMemoryChange).toHaveBeenCalledWith(true);
    expect(props.onTestChat).toHaveBeenCalledTimes(1);
  });

  it("keeps a custom prompt untouched when the custom preset is selected", () => {
    const props = baseTestsProps({ chatPromptPresetId: "custom", chatPrompt: "custom prompt" });
    const renderer = create(<SettingsTestsSection {...props} />);

    act(() => {
      hostById(renderer, "chatPromptPreset", "select").props.onChange({ target: { value: "custom" } });
    });

    expect(props.onChatPromptPresetIdChange).toHaveBeenCalledWith("custom");
    expect(props.onChatPromptChange).not.toHaveBeenCalled();
    expect(rendererText(renderer)).not.toContain("Ready from provider.");
  });
});
