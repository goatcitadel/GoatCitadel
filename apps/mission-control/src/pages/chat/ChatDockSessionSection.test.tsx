import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatExternalBindingPanel } from "./ChatExternalBindingPanel";
import { ChatDockSessionSection } from "./ChatDockSessionSection";
import { ChatSessionManagementPanel } from "./ChatSessionManagementPanel";

function buildProps(overrides: Partial<Parameters<typeof ChatDockSessionSection>[0]> = {}) {
  return {
    selectedSession: {
      sessionId: "session-1",
      pinned: true,
      lifecycleStatus: "active",
      scope: "mission",
    } as any,
    renameTitle: "Release thread",
    onRenameTitleChange: vi.fn(),
    folderName: "Launch",
    onFolderNameChange: vi.fn(),
    tagsValue: "qa,release",
    onTagsValueChange: vi.fn(),
    sending: false,
    sessionControlPending: null,
    selectedSessionProjectValue: "project-1",
    projectOptions: [
      { value: "none", label: "Unassigned" },
      { value: "project-1", label: "Project One" },
    ],
    onRenameSession: vi.fn(async () => undefined),
    onSaveOrganization: vi.fn(async () => undefined),
    onTogglePinSession: vi.fn(async () => undefined),
    onToggleArchiveSession: vi.fn(async () => undefined),
    onDeleteSession: vi.fn(),
    onAssignProject: vi.fn(async () => undefined),
    onExportSnapshot: vi.fn(),
    binding: null,
    integrationConnectionId: "",
    onIntegrationConnectionIdChange: vi.fn(),
    integrationTarget: "",
    onIntegrationTargetChange: vi.fn(),
    onSaveExternalBinding: vi.fn(async () => undefined),
    ...overrides,
  } satisfies Parameters<typeof ChatDockSessionSection>[0];
}

describe("ChatDockSessionSection", () => {
  it("passes session control decisions through the management panel", async () => {
    const props = buildProps();
    const renderer = create(<ChatDockSessionSection {...props} />);

    const panel = renderer.root.findByType(ChatSessionManagementPanel);
    expect(panel.props.pinned).toBe(true);
    expect(panel.props.archived).toBe(false);

    panel.props.onRenameTitleChange("Renamed");
    panel.props.onFolderNameChange("Ops");
    panel.props.onTagsValueChange("release");
    panel.props.onDelete();
    panel.props.onExportSnapshot();

    await act(async () => {
      await panel.props.onRename();
      await panel.props.onSaveOrganization();
      await panel.props.onTogglePin();
      await panel.props.onToggleArchive();
      await panel.props.onAssignProject("project-2");
    });

    expect(props.onRenameTitleChange).toHaveBeenCalledWith("Renamed");
    expect(props.onFolderNameChange).toHaveBeenCalledWith("Ops");
    expect(props.onTagsValueChange).toHaveBeenCalledWith("release");
    expect(props.onDeleteSession).toHaveBeenCalledTimes(1);
    expect(props.onExportSnapshot).toHaveBeenCalledTimes(1);
    expect(props.onRenameSession).toHaveBeenCalledTimes(1);
    expect(props.onSaveOrganization).toHaveBeenCalledTimes(1);
    expect(props.onTogglePinSession).toHaveBeenCalledTimes(1);
    expect(props.onToggleArchiveSession).toHaveBeenCalledTimes(1);
    expect(props.onAssignProject).toHaveBeenCalledWith("project-2");
    expect(renderer.root.findAllByType(ChatExternalBindingPanel)).toHaveLength(0);
  });

  it("exposes external binding controls for writable external sessions", async () => {
    const props = buildProps({
      selectedSession: {
        sessionId: "external-session",
        pinned: false,
        lifecycleStatus: "archived",
        scope: "external",
      } as any,
      binding: { writable: true } as any,
      integrationConnectionId: "slack:workspace-a",
      integrationTarget: "#ops",
      sessionControlPending: "binding",
    });
    const renderer = create(<ChatDockSessionSection {...props} />);

    const managementPanel = renderer.root.findByType(ChatSessionManagementPanel);
    expect(managementPanel.props.pinned).toBe(false);
    expect(managementPanel.props.archived).toBe(true);

    const bindingPanel = renderer.root.findByType(ChatExternalBindingPanel);
    expect(bindingPanel.props.writable).toBe(true);
    expect(bindingPanel.props.pending).toBe(true);
    expect(bindingPanel.props.controlsDisabled).toBe(true);

    bindingPanel.props.onIntegrationConnectionIdChange("discord:guild-a");
    bindingPanel.props.onIntegrationTargetChange("triage");
    await act(async () => {
      await bindingPanel.props.onSaveBinding();
    });

    expect(props.onIntegrationConnectionIdChange).toHaveBeenCalledWith("discord:guild-a");
    expect(props.onIntegrationTargetChange).toHaveBeenCalledWith("triage");
    expect(props.onSaveExternalBinding).toHaveBeenCalledTimes(1);
  });
});
