import React from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionManagementPanel } from "./ChatSessionManagementPanel";

function buildProps(overrides: Partial<Parameters<typeof ChatSessionManagementPanel>[0]> = {}) {
  return {
    renameTitle: "Release thread",
    onRenameTitleChange: vi.fn(),
    folderName: "Launch",
    onFolderNameChange: vi.fn(),
    tagsValue: "qa,release",
    onTagsValueChange: vi.fn(),
    sending: false,
    sessionControlPending: null,
    pinned: false,
    archived: false,
    selectedSessionProjectValue: "none",
    projectOptions: [{ value: "none", label: "Unassigned" }],
    onRename: vi.fn(),
    onSaveOrganization: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleArchive: vi.fn(),
    onDelete: vi.fn(),
    onAssignProject: vi.fn(),
    onExportSnapshot: vi.fn(),
    ...overrides,
  } satisfies Parameters<typeof ChatSessionManagementPanel>[0];
}

describe("ChatSessionManagementPanel", () => {
  it("forwards title, folder, and tag edits from the form inputs", async () => {
    const props = buildProps();
    const renderer = create(<ChatSessionManagementPanel {...props} />);
    const inputs = renderer.root.findAllByType("input");
    expect(inputs).toHaveLength(3);
    const titleInput = inputs[0]!;
    const folderInput = inputs[1]!;
    const tagsInput = inputs[2]!;

    await act(async () => {
      titleInput.props.onChange({ target: { value: "Renamed thread" } });
      folderInput.props.onChange({ target: { value: "Ops" } });
      tagsInput.props.onChange({ target: { value: "qa,ship" } });
    });

    expect(props.onRenameTitleChange).toHaveBeenCalledWith("Renamed thread");
    expect(props.onFolderNameChange).toHaveBeenCalledWith("Ops");
    expect(props.onTagsValueChange).toHaveBeenCalledWith("qa,ship");
  });
});
