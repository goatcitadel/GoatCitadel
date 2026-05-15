import type { ChatMode, ChatSessionRecord } from "@goatcitadel/contracts";
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionSidebar } from "./ChatSessionSidebar";

vi.mock("../../components/chat/ChatSessionRail", () => ({
  ChatSessionRail: ({
    externalSessions,
    missionSessions,
    mode,
    onSelectSession,
    onSelectTag,
    renderSessionLabel,
    selectedSessionId,
    selectedTag,
  }: {
    externalSessions: Array<{ id: string; channel?: string | null }>;
    missionSessions: Array<{ id: string; projectName?: string | null }>;
    mode: ChatMode;
    onSelectSession: (sessionId: string, options?: { turnId?: string | null }) => void;
    onSelectTag: (tag: string | null) => void;
    renderSessionLabel: (sessionId: string) => string;
    selectedSessionId: string | null;
    selectedTag: string | null;
  }) => (
    <section data-testid="rail">
      <span>{`rail:${mode}:${selectedSessionId ?? "none"}:${selectedTag ?? "none"}`}</span>
      <span>{`mission:${missionSessions.map((session) => renderSessionLabel(session.id)).join("|")}`}</span>
      <span>{`external:${externalSessions.map((session) => session.channel ?? "external").join("|")}`}</span>
      <button type="button" onClick={() => onSelectSession("session-rail", { turnId: "turn-1" })}>
        Select rail session
      </button>
      <button type="button" onClick={() => onSelectTag("urgent")}>
        Select rail tag
      </button>
    </section>
  ),
}));

function session(id: string): ChatSessionRecord & { channel?: string | null; projectName?: string | null } {
  return {
    id,
    workspaceId: "workspace-1",
    title: `Session ${id}`,
    mode: "chat",
    status: "active",
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:00:00.000Z",
  } as unknown as ChatSessionRecord & { channel?: string | null; projectName?: string | null };
}

function renderSidebar(overrides: Partial<React.ComponentProps<typeof ChatSessionSidebar>> = {}): {
  props: React.ComponentProps<typeof ChatSessionSidebar>;
  renderer: ReactTestRenderer;
} {
  const props: React.ComponentProps<typeof ChatSessionSidebar> = {
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
    summaryTitle: "Mission workspace",
    summaryCopy: "Keep lightweight conversations close.",
    workspaceSummaryCards: [
      { label: "Chats", value: "1" },
      { label: "Projects", value: "2" },
      { label: "External threads", value: "3" },
    ],
    onToggleProjectCreate: vi.fn(),
    onCreateSession: vi.fn(),
    onSearchChange: vi.fn(),
    onProjectNameChange: vi.fn(),
    onProjectPathChange: vi.fn(),
    onCreateProject: vi.fn(),
    onHistoryViewChange: vi.fn(),
    onArchiveWorkspace: vi.fn(),
    onSelectProjectId: vi.fn(),
    onSelectFolderId: vi.fn(),
    onSelectTag: vi.fn(),
    onSelectSession: vi.fn(),
    renderSessionLabel: (sessionId: string) => `Label ${sessionId}`,
    ...overrides,
  };

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<ChatSessionSidebar {...props} />);
  });
  return { props, renderer };
}

function treeText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function renderedText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((child) => renderedText(child)).join("");
  }
  if (value && typeof value === "object" && "children" in value) {
    return renderedText((value as { children?: unknown }).children);
  }
  return "";
}

function textOf(node: ReactTestInstance): string {
  const children = node.props.children;
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children
      .map((child) => (typeof child === "string" || typeof child === "number" ? String(child) : ""))
      .join("");
  }
  return "";
}

function findButton(renderer: ReactTestRenderer, label: string): ReactTestInstance {
  const button = renderer.root.findAll((node) => node.type === "button" && textOf(node).includes(label)).at(0);
  expect(button).toBeDefined();
  return button!;
}

describe("ChatSessionSidebar", () => {
  it("renders the lightweight chat rail summary and forwards filter actions", () => {
    const { props, renderer } = renderSidebar({
      availableFolders: [{ folderId: "folder-1", name: "Research", count: 2 }],
      externalSessions: [{ ...session("external-1"), channel: "slack" }],
      missionSessions: [{ ...session("mission-1"), projectName: "Ops" }],
      selectedSessionId: "mission-1",
      selectedTag: "urgent",
      archiveWorkspaceEnabled: true,
    });

    const jsonText = treeText(renderer);
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Mission workspace");
    expect(text).toContain("Keep lightweight conversations close.");
    expect(text).toContain("1 chat • 2 projects • 3 external threads");
    expect(text).toContain("2 conversations across mission and external threads.");
    expect(text).toContain("Mission chats stay local unless a bound integration is explicitly in play.");
    expect(jsonText).toContain("rail:chat:mission-1:urgent");
    expect(jsonText).toContain("mission:Label mission-1");
    expect(jsonText).toContain("external:slack");

    act(() => {
      findButton(renderer, "Start chat").props.onClick();
      findButton(renderer, "Project").props.onClick();
      findButton(renderer, "Archived").props.onClick();
      findButton(renderer, "Unassigned").props.onClick();
      findButton(renderer, "No folder").props.onClick();
      findButton(renderer, "Research (2)").props.onClick();
      findButton(renderer, "Tag: #urgent").props.onClick();
      findButton(renderer, "Archive workspace chats").props.onClick();
      findButton(renderer, "Select rail session").props.onClick();
      findButton(renderer, "Select rail tag").props.onClick();
      renderer.root
        .findByProps({ placeholder: "Search conversations" })
        .props.onChange({ target: { value: "budget" } });
    });

    expect(props.onCreateSession).toHaveBeenCalledTimes(1);
    expect(props.onToggleProjectCreate).toHaveBeenCalledTimes(1);
    expect(props.onHistoryViewChange).toHaveBeenCalledWith("archived");
    expect(props.onSelectProjectId).toHaveBeenCalledWith("none");
    expect(props.onSelectFolderId).toHaveBeenCalledWith("none");
    expect(props.onSelectFolderId).toHaveBeenCalledWith("folder-1");
    expect(props.onSelectTag).toHaveBeenCalledWith(null);
    expect(props.onSelectTag).toHaveBeenCalledWith("urgent");
    expect(props.onArchiveWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onSelectSession).toHaveBeenCalledWith("session-rail", { turnId: "turn-1" });
    expect(props.onSearchChange).toHaveBeenCalledWith("budget");
  });

  it("uses compact non-chat summary cards and renders the project creation form", () => {
    const { props, renderer } = renderSidebar({
      mode: "cowork",
      showProjectCreate: true,
      creatingSession: true,
      projectName: "Launch plan",
      projectPath: "F:/code/personal-ai",
      historyView: "archived",
      selectedProjectId: "none",
      selectedFolderId: "none",
      missionSessions: [session("mission-1")],
      summaryCopy: "Hidden outside chat mode.",
      selectedTag: "blocked",
      archiveWorkspaceEnabled: true,
      archiveWorkspacePending: true,
    });

    const jsonText = treeText(renderer);
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Starting cowork...");
    expect(text).toContain("Hide project form");
    expect(text).toContain("Projects help keep orchestration grouped by objective.");
    expect(text).toContain("1 conversation across mission and external threads.");
    expect(text).toContain("Chats");
    expect(text).toContain("Projects");
    expect(jsonText).not.toContain("External threads");
    expect(jsonText).not.toContain("Hidden outside chat mode.");
    expect(text).toContain("Tag: #blocked");
    expect(text).toContain("Archiving...");

    act(() => {
      findButton(renderer, "Create project").props.onClick();
      renderer.root.findByProps({ placeholder: "New project name" }).props.onChange({ target: { value: "Ops board" } });
      renderer.root
        .findByProps({ placeholder: "Project path (optional)" })
        .props.onChange({ target: { value: "F:/work" } });
    });

    expect(props.onCreateProject).toHaveBeenCalledTimes(1);
    expect(props.onProjectNameChange).toHaveBeenCalledWith("Ops board");
    expect(props.onProjectPathChange).toHaveBeenCalledWith("F:/work");
  });

  it("renders code-mode empty and no-folder tag states without archive controls", () => {
    const { renderer } = renderSidebar({
      mode: "code",
      showProjectCreate: true,
      selectedTag: "repo",
      workspaceSummaryCards: [
        { label: "Repos", value: "1" },
        { label: "Branches", value: "1" },
        { label: "Artifacts", value: "7" },
      ],
      summaryCopy: "Hidden in code mode.",
      onArchiveWorkspace: undefined,
    });

    const jsonText = treeText(renderer);
    const text = renderedText(renderer.toJSON());
    expect(text).toContain("Start code session");
    expect(text).toContain("No conversations yet. Start a fresh session or bind one to a project.");
    expect(text).toContain("Project binding keeps code sessions precise and repo-aware.");
    expect(text).toContain("Repos");
    expect(text).toContain("Branches");
    expect(jsonText).not.toContain("Artifacts");
    expect(jsonText).not.toContain("Archive workspace chats");
    expect(jsonText).not.toContain("Hidden in code mode.");
    expect(text).toContain("Tag: #repo");
  });
});
