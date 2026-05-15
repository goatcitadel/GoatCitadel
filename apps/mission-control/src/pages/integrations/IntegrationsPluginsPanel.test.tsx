import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsPluginsPanel, type IntegrationsPluginEntry } from "./IntegrationsPluginsPanel";

function plugin(overrides: Partial<IntegrationsPluginEntry> = {}): IntegrationsPluginEntry {
  return {
    pluginId: "plugin-slack",
    label: "Slack Adapter",
    source: "npm:@goat/slack",
    sourceMetadata: {
      type: "package",
      display: "@goat/slack",
      packageName: "@goat/slack",
      packageVersion: "1.2.3",
      integrityStatus: "verified",
    },
    trustWarnings: [{ code: "remote-code", severity: "warn", message: "Runs remote code." }],
    theme: {
      accentColor: "#14b8a6",
      dashboardVariant: "compact",
    },
    version: "1.2.3",
    capabilities: ["messages", "approvals"],
    enabled: true,
    updatedAt: "2026-03-10T18:00:00.000Z",
    ...overrides,
  };
}

function buildProps(overrides: Partial<React.ComponentProps<typeof IntegrationsPluginsPanel>> = {}) {
  return {
    plugins: [plugin()],
    pluginSource: "templates/integration-plugins/reference-integration-plugin/",
    onPluginSourceChange: vi.fn(),
    onInstallPlugin: vi.fn(),
    onTogglePlugin: vi.fn(),
    pluginBusyId: null,
    ...overrides,
  };
}

describe("IntegrationsPluginsPanel", () => {
  it("renders empty state and install busy copy", async () => {
    const props = buildProps({ plugins: [], pluginBusyId: "install" });
    const renderer = create(<IntegrationsPluginsPanel {...props} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Plugin Adapters");
    expect(text).toContain("No plugins installed.");
    expect(text).toContain("Installing...");

    const input = renderer.root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "file:///adapter" } });
    });
    const installButton = renderer.root
      .findAllByType("button")
      .find((button) => button.props.children === "Installing...");
    await act(async () => {
      installButton?.props.onClick?.();
    });

    expect(props.onPluginSourceChange).toHaveBeenCalledWith("file:///adapter");
    expect(props.onInstallPlugin).toHaveBeenCalledTimes(1);
  });

  it("renders plugin source, trust, theme, capabilities, and toggle states", async () => {
    const props = buildProps();
    const renderer = create(<IntegrationsPluginsPanel {...props} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Slack Adapter");
    expect(text).toContain("@goat/slack");
    expect(text).toContain("package");
    expect(text).toContain("verified");
    expect(text).toContain("remote-code");
    expect(text).toContain("Theme:");
    expect(text).toContain("compact");
    expect(text).toContain("messages, approvals");
    expect(text).toContain("enabled");
    expect(text).toContain("Disable");

    const button = renderer.root.findAllByType("button").find((candidate) => candidate.props.children === "Disable");
    await act(async () => {
      button?.props.onClick?.();
    });

    expect(props.onTogglePlugin).toHaveBeenCalledWith("plugin-slack", true);
  });

  it("falls back for unknown plugin source, empty capabilities, and disabled busy copy", () => {
    const renderer = create(
      <IntegrationsPluginsPanel
        {...buildProps({
          plugins: [
            plugin({
              pluginId: "plugin-local",
              label: "Local Adapter",
              source: undefined,
              sourceMetadata: undefined,
              trustWarnings: [],
              theme: {},
              capabilities: [],
              enabled: false,
            }),
          ],
          pluginBusyId: "plugin-local",
        })}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Unknown source");
    expect(text).toContain("unknown");
    expect(text).toContain("-");
    expect(text).toContain("disabled");
    expect(text).toContain("Enabling...");
  });
});
