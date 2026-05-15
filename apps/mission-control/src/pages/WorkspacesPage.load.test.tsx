import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(),
  createWorkspace: vi.fn(),
  fetchGlobalGuidance: vi.fn(),
  fetchWorkspaceGuidance: vi.fn(),
  fetchWorkspaces: vi.fn(),
  restoreWorkspace: vi.fn(),
  updateGlobalGuidance: vi.fn(),
  updateWorkspaceGuidance: vi.fn(),
}));

vi.mock("../api/client", () => ({
  archiveWorkspace: apiMocks.archiveWorkspace,
  createWorkspace: apiMocks.createWorkspace,
  fetchGlobalGuidance: apiMocks.fetchGlobalGuidance,
  fetchWorkspaceGuidance: apiMocks.fetchWorkspaceGuidance,
  fetchWorkspaces: apiMocks.fetchWorkspaces,
  restoreWorkspace: apiMocks.restoreWorkspace,
  updateGlobalGuidance: apiMocks.updateGlobalGuidance,
  updateWorkspaceGuidance: apiMocks.updateWorkspaceGuidance,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: (signal: unknown) => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../components/ActionButton", () => ({
  ActionButton: (props: { label: string; onClick?: () => void; disabled?: boolean; danger?: boolean }) => (
    <button type="button" disabled={props.disabled} data-danger={props.danger} onClick={props.onClick}>
      {props.label}
    </button>
  ),
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCSelect: (props: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { WorkspacesPage } from "./WorkspacesPage";

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

function rendererText(renderer: ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON()).replace(/\s+/g, " ");
}

function findButton(renderer: ReactTestRenderer, label: string) {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && String(node.props.children).includes(label),
  )[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe("WorkspacesPage load discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchWorkspaces.mockResolvedValue({
      items: [
        {
          workspaceId: "default",
          name: "Default",
          slug: "default",
          description: "",
          lifecycleStatus: "active",
        },
        {
          workspaceId: "personal",
          name: "Personal",
          slug: "personal",
          description: "",
          lifecycleStatus: "active",
        },
      ],
    });
    apiMocks.fetchGlobalGuidance.mockResolvedValue({
      items: [
        {
          docType: "goatcitadel",
          content: "Global guidance",
          absolutePath: "F:/code/personal-ai/GOATCITADEL.md",
        },
      ],
    });
    apiMocks.fetchWorkspaceGuidance.mockResolvedValue({
      workspace: [
        {
          docType: "goatcitadel",
          content: "Workspace guidance",
          absolutePath: "F:/code/personal-ai/workspaces/default/GOATCITADEL.md",
        },
      ],
    });
    apiMocks.createWorkspace.mockResolvedValue({
      workspaceId: "research",
      name: "Research",
      slug: "research",
      description: "Research workspace",
      lifecycleStatus: "active",
    });
    apiMocks.archiveWorkspace.mockResolvedValue({
      workspaceId: "personal",
      name: "Personal",
      slug: "personal",
      description: "",
      lifecycleStatus: "archived",
    });
    apiMocks.restoreWorkspace.mockResolvedValue({
      workspaceId: "archived",
      name: "Archived",
      slug: "archived",
      description: "",
      lifecycleStatus: "active",
    });
    apiMocks.updateWorkspaceGuidance.mockResolvedValue({
      docType: "goatcitadel",
      content: "Updated workspace guidance",
      absolutePath: "F:/code/personal-ai/workspaces/default/GOATCITADEL.md",
    });
    apiMocks.updateGlobalGuidance.mockResolvedValue({
      docType: "goatcitadel",
      content: "Updated global guidance",
      absolutePath: "F:/code/personal-ai/GOATCITADEL.md",
    });
  });

  it("skips guidance refetch during background refresh and preserves unsaved editor drafts", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<WorkspacesPage activeWorkspaceId="default" onWorkspaceChange={() => undefined} />);
      });
      await flush();

      const editor = renderer.root.findByProps({ rows: 20 });
      await act(async () => {
        editor.props.onChange({ target: { value: "Unsaved workspace draft" } });
      });

      expect(apiMocks.fetchWorkspaces).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchGlobalGuidance).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchWorkspaceGuidance).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "system",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchWorkspaces).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchGlobalGuidance).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchWorkspaceGuidance).toHaveBeenCalledTimes(1);
      expect(renderer.root.findByProps({ rows: 20 }).props.value).toBe("Unsaved workspace draft");
    } finally {
      renderer.unmount();
    }
  });

  it("creates, archives, and restores workspaces through visible form actions", async () => {
    apiMocks.fetchWorkspaces.mockResolvedValue({
      items: [
        {
          workspaceId: "default",
          name: "Default",
          slug: "default",
          description: "",
          lifecycleStatus: "active",
        },
        {
          workspaceId: "personal",
          name: "Personal",
          slug: "personal",
          description: "",
          lifecycleStatus: "active",
        },
        {
          workspaceId: "archived",
          name: "Archived",
          slug: "archived",
          description: "",
          lifecycleStatus: "archived",
        },
      ],
    });
    const onWorkspaceChange = vi.fn();
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<WorkspacesPage activeWorkspaceId="default" onWorkspaceChange={onWorkspaceChange} />);
      });
      await flush();

      const nameInput = renderer.root.findByProps({ placeholder: "Personal" });
      const slugInput = renderer.root.findByProps({ placeholder: "personal" });
      const descriptionInput = renderer.root.findByProps({ rows: 4 });
      await act(async () => {
        nameInput.props.onChange({ target: { value: "Research" } });
        slugInput.props.onChange({ target: { value: "research" } });
        descriptionInput.props.onChange({ target: { value: "Research workspace" } });
      });

      await act(async () => {
        findButton(renderer, "Create workspace").props.onClick();
      });
      await flush();

      expect(apiMocks.createWorkspace).toHaveBeenCalledWith({
        name: "Research",
        slug: "research",
        description: "Research workspace",
      });
      expect(onWorkspaceChange).toHaveBeenCalledWith("research");
      expect(rendererText(renderer)).toContain("Workspace Research created.");

      await act(async () => {
        findButton(renderer, "Archive").props.onClick();
      });
      await flush();
      expect(apiMocks.archiveWorkspace).toHaveBeenCalledWith("personal");
      expect(rendererText(renderer)).toContain("Workspace Personal archived.");

      await act(async () => {
        findButton(renderer, "Restore").props.onClick();
      });
      await flush();
      expect(apiMocks.restoreWorkspace).toHaveBeenCalledWith("archived");
      expect(rendererText(renderer)).toContain("Workspace Archived restored.");
    } finally {
      renderer.unmount();
    }
  });

  it("saves workspace and global guidance only after editor changes", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<WorkspacesPage activeWorkspaceId="default" onWorkspaceChange={() => undefined} />);
      });
      await flush();

      const editor = renderer.root.findByProps({ rows: 20 });
      expect(editor.props.value).toBe("Workspace guidance");

      await act(async () => {
        editor.props.onChange({ target: { value: "Updated workspace guidance" } });
      });
      await act(async () => {
        findButton(renderer, "Save guidance").props.onClick();
      });
      await flush();

      expect(apiMocks.updateWorkspaceGuidance).toHaveBeenCalledWith(
        "default",
        "goatcitadel",
        "Updated workspace guidance",
      );
      expect(rendererText(renderer)).toContain("Saved goatcitadel guidance (workspace).");

      const scopeSelect = renderer.root.findAllByType("select")[0];
      await act(async () => {
        scopeSelect!.props.onChange({ target: { value: "global" } });
      });
      await flush();

      const globalEditor = renderer.root.findByProps({ rows: 20 });
      expect(globalEditor.props.value).toBe("Global guidance");
      await act(async () => {
        globalEditor.props.onChange({ target: { value: "Updated global guidance" } });
      });
      await act(async () => {
        findButton(renderer, "Save guidance").props.onClick();
      });
      await flush();

      expect(apiMocks.updateGlobalGuidance).toHaveBeenCalledWith("goatcitadel", "Updated global guidance");
      expect(rendererText(renderer)).toContain("Saved goatcitadel guidance (global).");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces workspace load errors with the empty-state refresh action", async () => {
    apiMocks.fetchWorkspaces.mockRejectedValueOnce(new Error("workspace list down"));
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<WorkspacesPage activeWorkspaceId="default" onWorkspaceChange={() => undefined} />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("workspace list down");
      expect(text).toContain("No workspaces are available yet");
      expect(text).toContain("Refresh workspaces");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces workspace action failures and falls back when archiving the active workspace", async () => {
    apiMocks.fetchWorkspaces.mockResolvedValue({
      items: [
        {
          workspaceId: "default",
          name: "Default",
          slug: "default",
          description: "",
          lifecycleStatus: "active",
        },
        {
          workspaceId: "personal",
          name: "Personal",
          slug: "personal",
          description: "",
          lifecycleStatus: "active",
        },
        {
          workspaceId: "archived",
          name: "Archived",
          slug: "archived",
          description: "",
          lifecycleStatus: "archived",
        },
      ],
    });
    apiMocks.createWorkspace.mockRejectedValueOnce(new Error("create failed"));
    apiMocks.archiveWorkspace.mockResolvedValueOnce({
      workspaceId: "personal",
      name: "Personal",
      slug: "personal",
      description: "",
      lifecycleStatus: "archived",
    });
    apiMocks.archiveWorkspace.mockRejectedValueOnce(new Error("archive failed"));
    apiMocks.restoreWorkspace.mockRejectedValueOnce(new Error("restore failed"));
    apiMocks.updateWorkspaceGuidance.mockRejectedValueOnce(new Error("save failed"));

    const onWorkspaceChange = vi.fn();
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<WorkspacesPage activeWorkspaceId="personal" onWorkspaceChange={onWorkspaceChange} />);
      });
      await flush();

      await act(async () => {
        findButton(renderer, "Archive").props.onClick();
      });
      await flush();
      expect(onWorkspaceChange).toHaveBeenCalledWith("default");
      expect(rendererText(renderer)).toContain("Workspace Personal archived.");

      renderer.unmount();
      await act(async () => {
        renderer = create(<WorkspacesPage activeWorkspaceId="personal" onWorkspaceChange={onWorkspaceChange} />);
      });
      await flush();
      apiMocks.archiveWorkspace.mockRejectedValueOnce(new Error("archive failed"));
      await act(async () => {
        findButton(renderer, "Archive").props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("archive failed");

      await act(async () => {
        findButton(renderer, "Restore").props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("restore failed");

      await act(async () => {
        renderer.root.findByProps({ placeholder: "Personal" }).props.onChange({ target: { value: "Broken" } });
      });
      await act(async () => {
        findButton(renderer, "Create workspace").props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("create failed");

      await act(async () => {
        renderer.root.findByProps({ rows: 20 }).props.onChange({ target: { value: "Unsaved failing guidance" } });
      });
      await act(async () => {
        findButton(renderer, "Save guidance").props.onClick();
      });
      await flush();
      expect(rendererText(renderer)).toContain("save failed");
    } finally {
      renderer.unmount();
    }
  });
});
