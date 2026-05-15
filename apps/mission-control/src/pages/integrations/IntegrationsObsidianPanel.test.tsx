import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsObsidianPanel } from "./IntegrationsObsidianPanel";

function buildProps(overrides: Partial<React.ComponentProps<typeof IntegrationsObsidianPanel>> = {}) {
  return {
    obsidianEnabled: false,
    onObsidianEnabledChange: vi.fn(),
    obsidianVaultPath: "F:\\AI Obsidian\\AI Info",
    onObsidianVaultPathChange: vi.fn(),
    obsidianMode: "read_append" as const,
    onObsidianModeChange: vi.fn(),
    obsidianAllowedSubpaths: "GoatCitadel",
    onObsidianAllowedSubpathsChange: vi.fn(),
    obsidianBusy: null,
    onSaveObsidianConfig: vi.fn(),
    onTestObsidian: vi.fn(),
    obsidianStatus: null,
    obsidianQuery: "",
    onObsidianQueryChange: vi.fn(),
    onSearchObsidian: vi.fn(),
    obsidianSearchResults: [],
    obsidianInboxRequest: "",
    onObsidianInboxRequestChange: vi.fn(),
    onCaptureObsidianInbox: vi.fn(),
    ...overrides,
  };
}

describe("IntegrationsObsidianPanel", () => {
  it("renders disabled defaults and wires configuration controls", async () => {
    const props = buildProps();
    const renderer = create(<IntegrationsObsidianPanel {...props} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Obsidian (Preferred Local Notes Path)");
    expect(text).toContain("Obsidian is currently disabled");
    expect(text).toContain("Save Obsidian config");
    expect(text).toContain("Test connection");

    const switchButton = renderer.root.findByProps({ role: "switch" });
    const select = renderer.root.findByType("select");
    const inputs = renderer.root.findAllByType("input");
    const buttons = renderer.root.findAllByType("button");

    await act(async () => {
      switchButton.props.onClick();
      inputs[0]?.props.onChange({ target: { value: "D:\\Vault" } });
      select.props.onChange({ target: { value: "read_only" } });
      inputs[1]?.props.onChange({ target: { value: "GoatCitadel,Inbox" } });
      buttons.find((button) => button.props.children === "Save Obsidian config")?.props.onClick?.();
      buttons.find((button) => button.props.children === "Test connection")?.props.onClick?.();
    });

    expect(props.onObsidianEnabledChange).toHaveBeenCalledWith(true);
    expect(props.onObsidianVaultPathChange).toHaveBeenCalledWith("D:\\Vault");
    expect(props.onObsidianModeChange).toHaveBeenCalledWith("read_only");
    expect(props.onObsidianAllowedSubpathsChange).toHaveBeenCalledWith("GoatCitadel,Inbox");
    expect(props.onSaveObsidianConfig).toHaveBeenCalledTimes(1);
    expect(props.onTestObsidian).toHaveBeenCalledTimes(1);
  });

  it("renders reachable status, search results, and quick operation actions", async () => {
    const props = buildProps({
      obsidianEnabled: true,
      obsidianStatus: {
        enabled: true,
        vaultPath: "F:\\AI Obsidian\\AI Info",
        allowedSubpaths: ["GoatCitadel"],
        vaultReachable: true,
        mode: "read_append",
        checkedAt: "2026-03-10T18:00:00.000Z",
        lastOperationAt: "2026-03-10T18:05:00.000Z",
      },
      obsidianQuery: "Prompt Lab",
      obsidianSearchResults: [
        {
          relativePath: "GoatCitadel/Prompt Lab.md",
          title: "Prompt Lab",
          snippet: "Score failures",
          score: 0.9,
        },
      ],
      obsidianInboxRequest: "Investigate score failures",
    });
    const renderer = create(<IntegrationsObsidianPanel {...props} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Vault reachable");
    expect(text).toContain("Last operation");
    expect(text).toContain("GoatCitadel/Prompt Lab.md");
    expect(text).toContain("Score failures");

    const inputs = renderer.root.findAllByType("input");
    const buttons = renderer.root.findAllByType("button");
    await act(async () => {
      inputs[2]?.props.onChange({ target: { value: "Approvals" } });
      buttons.find((button) => button.props.children === "Search")?.props.onClick?.();
      inputs[3]?.props.onChange({ target: { value: "Capture this" } });
      buttons.find((button) => button.props.children === "Capture to Obsidian inbox")?.props.onClick?.();
    });

    expect(props.onObsidianQueryChange).toHaveBeenCalledWith("Approvals");
    expect(props.onSearchObsidian).toHaveBeenCalledTimes(1);
    expect(props.onObsidianInboxRequestChange).toHaveBeenCalledWith("Capture this");
    expect(props.onCaptureObsidianInbox).toHaveBeenCalledTimes(1);
  });

  it("renders unreachable and busy/error branches", () => {
    const renderer = create(
      <IntegrationsObsidianPanel
        {...buildProps({
          obsidianBusy: "capture",
          obsidianStatus: {
            enabled: true,
            vaultPath: "F:\\AI Obsidian\\AI Info",
            allowedSubpaths: ["GoatCitadel"],
            vaultReachable: false,
            mode: "read_only",
            checkedAt: "2026-03-10T18:00:00.000Z",
            lastError: "Permission denied",
          },
        })}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Vault unreachable");
    expect(text).toContain("vault is not reachable");
    expect(text).toContain("Last Obsidian error:");
    expect(text).toContain("Permission denied");
    expect(text).toContain("No search results yet.");
    expect(text).toContain("Capturing...");
  });
});
