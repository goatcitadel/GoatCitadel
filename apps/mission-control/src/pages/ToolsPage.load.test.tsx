import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | ((signal: unknown) => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  createToolGrant: vi.fn(),
  evaluateToolAccess: vi.fn(),
  fetchAgents: vi.fn(),
  fetchChatSessions: vi.fn(),
  fetchSettings: vi.fn(),
  fetchToolCatalog: vi.fn(),
  fetchToolGrants: vi.fn(),
  invokeTool: vi.fn(),
  patchSettings: vi.fn(),
  revokeToolGrant: vi.fn(),
}));

vi.mock("../api/client", () => ({
  createToolGrant: apiMocks.createToolGrant,
  evaluateToolAccess: apiMocks.evaluateToolAccess,
  fetchAgents: apiMocks.fetchAgents,
  fetchChatSessions: apiMocks.fetchChatSessions,
  fetchSettings: apiMocks.fetchSettings,
  fetchToolCatalog: apiMocks.fetchToolCatalog,
  fetchToolGrants: apiMocks.fetchToolGrants,
  invokeTool: apiMocks.invokeTool,
  patchSettings: apiMocks.patchSettings,
  revokeToolGrant: apiMocks.revokeToolGrant,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _topic: string,
    callback: (signal: unknown) => Promise<void> | void,
  ) => {
    refreshState.callback = callback;
  },
}));

vi.mock("../state/ui-preferences", () => ({
  useUiPreferences: () => ({
    mode: "advanced",
    showTechnicalDetails: true,
    setShowTechnicalDetails: () => undefined,
  }),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: () => <div>PageGuideCard</div>,
}));

vi.mock("../components/Panel", () => ({
  Panel: ({ children }: { children?: React.ReactNode }) => <section>{children}</section>,
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>{primary}{secondary}</div>
  ),
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: () => <div>CardSkeleton</div>,
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCCombobox: (props: {
    value: string;
    onChange: (value: string) => void;
    options?: Array<{ value: string; label: string }>;
  }) => (
    <input
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
      data-options={props.options?.length ?? 0}
    />
  ),
  GCSelect: (props: {
    id?: string;
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
  }) => (
    <select id={props.id} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

import { ToolsPage } from "./ToolsPage";

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  });
}

describe("ToolsPage load discipline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchToolCatalog.mockResolvedValue({
      items: [
        {
          toolName: "fs.list",
          category: "filesystem",
          description: "List files",
          pack: "core",
        },
      ],
    });
    apiMocks.fetchToolGrants.mockResolvedValue({ items: [] });
    apiMocks.fetchChatSessions.mockResolvedValue({
      items: [
        {
          sessionId: "sess-1",
          title: "Session 1",
          workspaceId: "default",
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    apiMocks.fetchAgents.mockResolvedValue({
      items: [
        {
          agentId: "operator",
          name: "Operator",
        },
      ],
    });
    apiMocks.fetchSettings.mockResolvedValue({
      defaultToolProfile: "standard",
    });
  });

  it("skips static scope-source fetches during background refresh", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<ToolsPage />);
      });
      await flush();

      expect(apiMocks.fetchToolCatalog).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchToolGrants).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchChatSessions).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
      expect(refreshState.callback).toBeTypeOf("function");

      await act(async () => {
        await refreshState.callback?.({
          topic: "tools",
          timestamp: Date.now(),
          reason: "test-refresh",
        });
      });
      await flush();

      expect(apiMocks.fetchToolCatalog).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchToolGrants).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchChatSessions).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(1);
      expect(apiMocks.fetchSettings).toHaveBeenCalledTimes(1);
    } finally {
      renderer.unmount();
    }
  });
});
