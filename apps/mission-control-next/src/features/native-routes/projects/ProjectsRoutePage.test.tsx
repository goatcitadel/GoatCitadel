import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMode, ChatProjectRecord, ChatSessionRecord } from "@goatcitadel/contracts";
import {
  archiveChatProject,
  createChatSession,
  createChatProject,
  fetchChatProjects,
  fetchChatSessions,
  updateChatProject,
} from "@goatcitadel/mission-control-shared/api/client";
import { deriveProjectHome, ProjectsRoutePage } from "./ProjectsRoutePage";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  archiveChatProject: vi.fn(),
  createChatSession: vi.fn(),
  createChatProject: vi.fn(),
  fetchChatProjects: vi.fn(),
  fetchChatSessions: vi.fn(),
  updateChatProject: vi.fn(),
}));

const mockedArchiveChatProject = vi.mocked(archiveChatProject);
const mockedCreateChatSession = vi.mocked(createChatSession);
const mockedCreateChatProject = vi.mocked(createChatProject);
const mockedFetchChatProjects = vi.mocked(fetchChatProjects);
const mockedFetchChatSessions = vi.mocked(fetchChatSessions);
const mockedUpdateChatProject = vi.mocked(updateChatProject);

function project(overrides: Partial<ChatProjectRecord>): ChatProjectRecord {
  return {
    projectId: "project-alpha",
    workspaceId: "default",
    name: "Alpha",
    description: "Primary project",
    workspacePath: "F:\\code\\personal-ai",
    lifecycleStatus: "active",
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    ...overrides,
  } as ChatProjectRecord;
}

function session(overrides: Partial<ChatSessionRecord> & { sessionId: string }): ChatSessionRecord {
  const { sessionId, ...rest } = overrides;
  return {
    sessionId,
    sessionKey: sessionId,
    workspaceId: "default",
    projectId: "project-alpha",
    mode: "chat",
    title: "Thread",
    lifecycleStatus: "active",
    tags: ["ready"],
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    lastActivityAt: "2026-05-01T12:05:00.000Z",
    ...rest,
  } as ChatSessionRecord;
}

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    route: { area: "projects", theme: "ops" },
    activeWorkspaceId: "default",
    activeWorkspaceName: "Default workspace",
    pendingApprovals: 0,
    navigate: vi.fn(),
    setActiveWorkspaceId: vi.fn(),
    ...overrides,
  } as any;
}

async function renderPage(props = defaultProps()): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(<ProjectsRoutePage {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

function collectText(node: ReactTestInstance | unknown): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return (node as ReactTestInstance).children.map(collectText).join(" ");
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findInputByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) => node.type === "input" && String(node.props.placeholder ?? "").includes(placeholder),
  )[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function renderedText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function pageText(renderer: ReactTestRenderer): string {
  return collectText(renderer.root);
}

describe("ProjectsRoutePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedFetchChatProjects.mockResolvedValue({
      items: [
        project({ projectId: "project-alpha", name: "Alpha", description: "Primary project" }),
        project({
          projectId: "project-beta",
          name: "Beta",
          description: "",
          workspacePath: "F:\\code\\beta",
        }),
      ],
    } as any);
    mockedFetchChatSessions.mockResolvedValue({
      items: [
        session({
          sessionId: "chat-1",
          projectId: "project-alpha",
          mode: "chat",
          title: "",
          tags: [],
          lastActivityAt: "not-a-date",
        }),
        session({
          sessionId: "cowork-1",
          projectId: "project-alpha",
          mode: "cowork",
          title: "Cowork run",
          tags: ["plan", "qa"],
          lastActivityAt: "2026-05-01T12:10:00.000Z",
        }),
        session({
          sessionId: "code-1",
          projectId: "project-alpha",
          mode: "code",
          title: "Code run",
          lastActivityAt: undefined,
        }),
        session({
          sessionId: "fallback-1",
          projectId: "project-beta",
          mode: "unknown" as ChatMode,
          title: "Fallback mode",
          lastActivityAt: null as unknown as string,
        }),
        session({
          sessionId: "orphan-1",
          projectId: null as unknown as string,
          title: "Orphan thread",
        }),
      ],
    } as any);
    mockedCreateChatSession.mockResolvedValue({ sessionId: "new-code-session" } as any);
    mockedCreateChatProject.mockResolvedValue(project({ projectId: "project-created", name: "Created" }));
    mockedUpdateChatProject.mockResolvedValue(project({ projectId: "project-alpha", name: "Alpha renamed" }));
    mockedArchiveChatProject.mockResolvedValue(project({ projectId: "project-alpha", lifecycleStatus: "archived" }));
  });

  it("loads project containers, counts thread modes, and auto-selects the first project", async () => {
    const navigate = vi.fn();
    const renderer = await renderPage(defaultProps({ navigate }));

    expect(mockedFetchChatProjects).toHaveBeenCalledWith("active", 300, "default");
    expect(mockedFetchChatSessions).toHaveBeenCalledWith({
      workspaceId: "default",
      scope: "all",
      view: "all",
      includeHidden: true,
      limit: 1000,
    });
    expect(navigate).toHaveBeenCalledWith(
      { area: "projects", projectId: "project-alpha", theme: "ops" },
      { replace: true },
    );

    const text = pageText(renderer);
    expect(text).toContain("Project containers");
    expect(text).toContain("Project overview");
    expect(text).toContain("Continue Chat");
    expect(text).toContain("Continue Cowork");
    expect(text).toContain("Continue Code");
    expect(text).toContain("Alpha");
    expect(text).toContain("Chat 1");
    expect(text).toContain("Cowork 1");
    expect(text).toContain("Code 1");
    expect(text).toContain("chat-1");
    expect(text).toContain("No tags yet.");
    expect(text).toContain("Unknown");

    act(() => {
      findButton(renderer.root, "Beta").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({ area: "projects", projectId: "project-beta", theme: "ops" });

    act(() => {
      findButton(renderer.root, "Cowork run").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "cowork",
      sessionId: "cowork-1",
      projectId: "project-alpha",
      theme: "ops",
    });
  });

  it("selects explicit projects, starts sessions, and routes unknown modes through chat counts", async () => {
    const navigate = vi.fn();
    const renderer = await renderPage(
      defaultProps({ route: { area: "projects", projectId: "project-beta", theme: "neon" }, navigate }),
    );

    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-alpha" }), {
      replace: true,
    });
    const text = pageText(renderer);
    expect(text).toContain("Beta");
    expect(text).toContain("F:\\code\\beta");
    expect(text).toContain("Chat 1");
    expect(text).toMatch(/No\s+cowork\s+threads in this project\./);
    expect(text).toMatch(/No\s+code\s+threads in this project\./);

    act(() => {
      findButton(renderer.root, "Fallback mode").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "chat",
      sessionId: "fallback-1",
      projectId: "project-beta",
      theme: "neon",
    });

    await act(async () => {
      findButton(renderer.root, "New Code").props.onClick();
      await Promise.resolve();
    });
    expect(mockedCreateChatSession).toHaveBeenCalledWith(
      {
        workspaceId: "default",
        projectId: "project-beta",
        mode: "code",
        origin: "operator",
        title: "Code - Beta",
      },
      { originSurface: "code" },
    );
    expect(navigate).toHaveBeenCalledWith({
      area: "code",
      sessionId: "new-code-session",
      projectId: "project-beta",
      theme: "neon",
    });
  });

  it("derives a project home-base summary from source, sessions, and artifacts", () => {
    const home = deriveProjectHome(project({ workspacePath: "F:\\code\\alpha" }), [
      session({
        sessionId: "code-proof",
        mode: "code",
        generatedArtifacts: [{ artifactId: "artifact-1" } as any],
        lastActivityAt: "2026-05-02T12:05:00.000Z",
      }),
      session({ sessionId: "cowork-run", mode: "cowork", lastActivityAt: "2026-05-02T12:00:00.000Z" }),
      session({ sessionId: "chat-run", mode: "chat", lastActivityAt: "2026-05-02T11:00:00.000Z" }),
    ]);

    expect(home.latestByMode.code?.sessionId).toBe("code-proof");
    expect(home.latestByMode.cowork?.sessionId).toBe("cowork-run");
    expect(home.latestByMode.chat?.sessionId).toBe("chat-run");
    expect(home.artifactCount).toBe(1);
    expect(home.healthLabel).toBe("Ready to continue");
    expect(home.readiness.map((item) => [item.id, item.status])).toContainEqual(["artifacts", "ready"]);
  });

  it("creates, updates, archives, and routes project continuation actions", async () => {
    const navigate = vi.fn();
    const renderer = await renderPage(
      defaultProps({ route: { area: "projects", projectId: "project-alpha", theme: "ops" }, navigate }),
    );

    act(() => {
      findButton(renderer.root, "Continue Cowork").props.onClick();
    });
    expect(navigate).toHaveBeenCalledWith({
      area: "cowork",
      sessionId: "cowork-1",
      projectId: "project-alpha",
      theme: "ops",
    });

    act(() => {
      findInputByPlaceholder(renderer.root, "Release readiness").props.onChange({
        target: { value: "Created" },
      });
      findInputByPlaceholder(renderer.root, "Local project path").props.onChange({
        target: { value: "F:\\code\\created" },
      });
    });
    await act(async () => {
      findButton(renderer.root, "Create project").props.onClick();
      await Promise.resolve();
    });
    expect(mockedCreateChatProject).toHaveBeenCalledWith({
      workspaceId: "default",
      name: "Created",
      workspacePath: "F:\\code\\created",
      description: undefined,
    });
    expect(navigate).toHaveBeenCalledWith({ area: "projects", projectId: "project-created", theme: "ops" });

    const alphaNameInput = renderer.root.findAll(
      (node) => node.type === "input" && node.props.value === "Alpha",
    )[0];
    expect(alphaNameInput).toBeDefined();
    act(() => {
      alphaNameInput!.props.onChange({ target: { value: "Alpha renamed" } });
    });
    await act(async () => {
      findButton(renderer.root, "Save project").props.onClick();
      await Promise.resolve();
    });
    expect(mockedUpdateChatProject).toHaveBeenCalledWith(
      "project-alpha",
      expect.objectContaining({ name: "Alpha renamed", workspaceId: "default" }),
    );

    await act(async () => {
      findButton(renderer.root, "Archive project").props.onClick();
      await Promise.resolve();
    });
    expect(mockedArchiveChatProject).toHaveBeenCalledWith("project-alpha");
    expect(navigate).toHaveBeenCalledWith({ area: "projects", theme: "ops" }, { replace: true });
  });

  it("shows empty state, disables new-thread actions, and allows refresh recovery", async () => {
    mockedFetchChatProjects.mockResolvedValueOnce({ items: [] } as any);
    mockedFetchChatSessions.mockResolvedValueOnce({ items: [] } as any);
    mockedFetchChatProjects.mockResolvedValueOnce({ items: [project({ projectId: "project-recovered" })] } as any);
    mockedFetchChatSessions.mockResolvedValueOnce({ items: [] } as any);
    const navigate = vi.fn();
    const renderer = await renderPage(defaultProps({ navigate }));

    expect(renderedText(renderer)).toContain("No active projects found in this workspace.");
    expect(findButton(renderer.root, "New Chat").props.disabled).toBe(true);
    act(() => {
      findButton(renderer.root, "New Chat").props.onClick();
    });
    expect(mockedCreateChatSession).not.toHaveBeenCalled();

    await act(async () => {
      findButton(renderer.root, "Refresh").props.onClick();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).toContain("Alpha");
  });

  it("surfaces load and action failures without dropping existing project state", async () => {
    mockedCreateChatSession.mockRejectedValueOnce(new Error("session route failed"));
    const renderer = await renderPage(defaultProps({ route: { area: "projects", projectId: "project-alpha" } }));

    await act(async () => {
      findButton(renderer.root, "New Chat").props.onClick();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).toContain("session route failed");

    mockedFetchChatProjects.mockRejectedValueOnce("offline");
    await act(async () => {
      findButton(renderer.root, "Refresh").props.onClick();
      await Promise.resolve();
    });
    expect(renderedText(renderer)).toContain("Something went wrong.");
    expect(renderedText(renderer)).toContain("Alpha");
  });

  it("renders initial fetch failures from the native page frame", async () => {
    mockedFetchChatProjects.mockRejectedValueOnce(new Error("project catalog down"));

    const renderer = await renderPage(defaultProps());

    expect(renderedText(renderer)).toContain("project catalog down");
    expect(renderedText(renderer)).toContain("No active projects found in this workspace.");
  });

  it("ignores async project loads after the route unmounts", async () => {
    let resolveProjects: ((value: unknown) => void) | undefined;
    mockedFetchChatProjects.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProjects = resolve;
      }) as any,
    );
    mockedFetchChatSessions.mockResolvedValueOnce({ items: [] } as any);
    const navigate = vi.fn();
    let renderer: ReactTestRenderer | undefined;

    await act(async () => {
      renderer = create(<ProjectsRoutePage {...defaultProps({ navigate })} />);
      await Promise.resolve();
    });

    act(() => {
      renderer!.unmount();
    });
    await act(async () => {
      resolveProjects?.({ items: [project({ projectId: "late-project" })] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigate).not.toHaveBeenCalled();
  });
});
