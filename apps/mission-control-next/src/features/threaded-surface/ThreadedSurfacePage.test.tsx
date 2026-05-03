import React from "react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadedSurfacePage } from "./ThreadedSurfacePage";

function buildInput() {
  const noop = vi.fn();
  return {
    messageMode: "cowork",
    sessionRailOpen: true,
    onSessionRailOpenChange: noop,
    dockOpen: false,
    onDockOpenChange: noop,
    activeSessionSurfaceProps: null,
    workflowPanel: null,
    contextDockProps: null,
    emptyStateProps: {
      mode: "cowork",
      sessionCount: 1,
      projectCount: 0,
      workspaceName: "Default workspace",
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
      mode: "cowork",
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
      missionSessions: [
        {
          sessionId: "parent-1",
          sessionKey: "mission:operator:parent",
          scope: "mission",
          mode: "cowork",
          includeInHistory: true,
          title: "Main Cowork run",
          pinned: false,
          lifecycleStatus: "active",
          channel: "mission",
          account: "operator",
          updatedAt: "2026-05-03T16:00:00.000Z",
          lastActivityAt: "2026-05-03T16:00:00.000Z",
          tokenTotal: 0,
          costUsdTotal: 0,
        },
        {
          sessionId: "child-1",
          sessionKey: "mission:operator:child",
          scope: "mission",
          mode: "cowork",
          includeInHistory: true,
          title: "Delegate · Work",
          pinned: false,
          lifecycleStatus: "active",
          channel: "mission",
          account: "operator",
          updatedAt: "2026-05-03T16:01:00.000Z",
          lastActivityAt: "2026-05-03T16:01:00.000Z",
          tokenTotal: 0,
          costUsdTotal: 0,
          delegationParent: {
            parentSessionId: "parent-1",
            runId: "run-1",
            stepId: "step-1",
            role: "worker",
            label: "Work",
            index: 0,
          },
        },
      ],
      externalSessions: [],
      selectedSessionId: "parent-1",
      summaryTitle: "Cowork",
      summaryCopy: "Runs",
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
  };
}

describe("ThreadedSurfacePage", () => {
  it("hides delegated child sessions under a collapsed parent by default", () => {
    const markup = renderToStaticMarkup(<ThreadedSurfacePage surface="cowork" input={buildInput() as any} />);

    expect(markup).toContain("Main Cowork run");
    expect(markup).toContain("Expand delegated chats");
    expect(markup).not.toContain("Delegate · Work");
  });
});
