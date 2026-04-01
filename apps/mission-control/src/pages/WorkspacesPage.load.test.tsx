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
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: unknown) => Promise<void> | void,
  ) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../components/ActionButton", () => ({
  ActionButton: (props: {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    danger?: boolean;
  }) => (
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
});
