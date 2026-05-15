import React, { createRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ThreadedSurfacePage, formatRelativeTime, getArchiveActionLabel } from "./ThreadedSurfacePage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function baseProps(overrides: Record<string, unknown> = {}) {
  const noop = vi.fn();
  return {
    messageMode: "chat",
    sessionRailOpen: false,
    onSessionRailOpenChange: noop,
    dockOpen: false,
    onDockOpenChange: noop,
    activeSessionSurfaceProps: null,
    workflowPanel: null,
    contextDockProps: null,
    emptyStateProps: {
      mode: "chat",
      sessionCount: 0,
      projectCount: 0,
      workspaceName: "Default",
      approvalsCount: 0,
      onCreateSession: noop,
      onOpenCowork: noop,
      onOpenCode: noop,
      onOpenTasks: noop,
      onOpenApprovals: noop,
    },
    dropTargetProps: {
      isDragActive: false,
      fileInputRef: createRef<HTMLInputElement>(),
      onAttachFiles: noop,
      onUploadFiles: noop,
      onDragEnter: noop,
      onDragOver: noop,
      onDragLeave: noop,
      onDrop: noop,
    },
    sessionRail: {
      mode: "chat",
      showProjectCreate: false,
      creatingSession: false,
      search: "",
      projectName: "",
      projectPath: "",
      historyView: "active",
      selectedProjectId: "all",
      availableFolders: [],
      selectedFolderId: "all",
      selectedTag: null,
      missionSessions: [],
      externalSessions: [],
      selectedSessionId: null,
      summaryTitle: "Chat",
      summaryCopy: "No sessions",
      workspaceSummaryCards: [],
      onToggleProjectCreate: noop,
      onCreateSession: noop,
      onSearchChange: noop,
      onProjectNameChange: noop,
      onProjectPathChange: noop,
      onCreateProject: noop,
      onHistoryViewChange: noop,
      onSelectProjectId: noop,
      onSelectFolderId: noop,
      onSelectTag: noop,
      onSelectSession: noop,
      renderSessionLabel: (sessionId: string) => sessionId,
    },
    ...overrides,
  } as any;
}

describe("ThreadedSurfacePage loop 30 branch matrix", () => {
  it("formats archive action and relative time labels", () => {
    expect(getArchiveActionLabel("archived", false)).toBe("Restore");
    expect(getArchiveActionLabel("active", false)).toBe("Archive");
    expect(getArchiveActionLabel("active", true)).toBe("Archiving...");
    expect(getArchiveActionLabel("archived", true)).toBe("Restoring...");
    expect(formatRelativeTime()).toBe("Recent");
    expect(formatRelativeTime("bad-date")).toBe("Recent");
    expect(formatRelativeTime(new Date().toISOString())).toBe("1m ago");
  });

  it("renders drop-target and empty-state branches without an active session", () => {
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <ThreadedSurfacePage
          surface="chat"
          input={baseProps({
            dropTargetProps: { ...baseProps().dropTargetProps, isDragActive: true },
          })}
        />,
      );
    });
    const text = JSON.stringify(renderer!.toJSON());
    expect(text).toContain("Drop files to start a thread with attachments");
    expect(text).toContain("Start ");
    expect(text).toContain("chat");
    renderer!.unmount();
  });
});
