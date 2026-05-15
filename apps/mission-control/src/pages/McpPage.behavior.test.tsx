import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
}));

const apiMocks = vi.hoisted(() => ({
  connectMcpServer: vi.fn(),
  createMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  disconnectMcpServer: vi.fn(),
  fetchConnectorRecords: vi.fn(),
  fetchMcpServers: vi.fn(),
  fetchMcpTemplateDiscovery: vi.fn(),
  fetchMcpTemplates: vi.fn(),
  fetchMcpTools: vi.fn(),
  fetchSettings: vi.fn(),
  invokeMcpTool: vi.fn(),
  runMcpServerHealthCheck: vi.fn(),
  startMcpOAuth: vi.fn(),
  updateMcpServerPolicy: vi.fn(),
}));

vi.mock("../api/client", () => ({
  connectMcpServer: apiMocks.connectMcpServer,
  createMcpServer: apiMocks.createMcpServer,
  deleteMcpServer: apiMocks.deleteMcpServer,
  disconnectMcpServer: apiMocks.disconnectMcpServer,
  fetchConnectorRecords: apiMocks.fetchConnectorRecords,
  fetchMcpServers: apiMocks.fetchMcpServers,
  fetchMcpTemplateDiscovery: apiMocks.fetchMcpTemplateDiscovery,
  fetchMcpTemplates: apiMocks.fetchMcpTemplates,
  fetchMcpTools: apiMocks.fetchMcpTools,
  fetchSettings: apiMocks.fetchSettings,
  invokeMcpTool: apiMocks.invokeMcpTool,
  runMcpServerHealthCheck: apiMocks.runMcpServerHealthCheck,
  startMcpOAuth: apiMocks.startMcpOAuth,
  updateMcpServerPolicy: apiMocks.updateMcpServerPolicy,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (_topic: string, callback: () => Promise<void> | void) => {
    refreshState.callback = callback;
  },
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: <T,>({
    data = [],
    itemContent,
  }: {
    data?: T[];
    itemContent: (index: number, item: T) => React.ReactNode;
  }) => (
    <div>
      {data.map((item, index) => (
        <React.Fragment key={index}>{itemContent(index, item)}</React.Fragment>
      ))}
    </div>
  ),
}));

vi.mock("../components/ActionButton", () => ({
  ActionButton: ({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick?: () => void }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {label}
    </button>
  ),
}));

vi.mock("../components/CardSkeleton", () => ({
  CardSkeleton: () => <div>Loading MCP</div>,
}));

vi.mock("../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    message,
    confirmLabel,
    onConfirm,
    onCancel,
  }: {
    open?: boolean;
    title?: string;
    message?: string;
    confirmLabel?: string;
    onConfirm?: () => void;
    onCancel?: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <p>{message}</p>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel ?? "Confirm"}
        </button>
      </div>
    ) : null,
}));

vi.mock("../components/DataToolbar", () => ({
  DataToolbar: ({ primary, secondary }: { primary?: React.ReactNode; secondary?: React.ReactNode }) => (
    <div>
      {primary}
      {secondary}
    </div>
  ),
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: () => <span>help</span>,
}));

vi.mock("../components/OperatorSplitLayout", () => ({
  OperatorSplitLayout: ({ primary, inspector }: { primary?: React.ReactNode; inspector?: React.ReactNode }) => (
    <div>
      {primary}
      {inspector}
    </div>
  ),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({
    title,
    subtitle,
    actions,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </header>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <section>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../components/ui", () => ({
  GCSelect: ({
    id,
    value,
    options,
    onChange,
  }: {
    id?: string;
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
  }) => (
    <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

vi.mock("../content/copy", () => ({
  pageCopy: {
    mcp: {
      title: "MCP",
      subtitle: "Manage MCP servers.",
    },
  },
}));

vi.mock("./mcp/McpSelectedServerPanel", () => ({
  McpSelectedServerPanel: ({
    selected,
    selectedDiagnostic,
    onToggleConnection,
    onStartOAuth,
    onDelete,
    onHealthCheck,
    onSavePolicy,
    setPolicyAllowed,
    setPolicyDirty,
  }: {
    selected?: { label: string } | null;
    selectedDiagnostic?: { status: string };
    onToggleConnection: () => Promise<void>;
    onStartOAuth: () => Promise<void>;
    onDelete: () => void;
    onHealthCheck: () => Promise<void>;
    onSavePolicy: () => Promise<void>;
    setPolicyAllowed: (value: string) => void;
    setPolicyDirty: (value: boolean) => void;
  }) => (
    <div>
      <p>Selected server: {selected?.label ?? "none"}</p>
      {selectedDiagnostic ? <p>Diagnostic {selectedDiagnostic.status}</p> : null}
      <button type="button" onClick={() => void onToggleConnection()}>
        Toggle connection
      </button>
      <button type="button" onClick={() => void onStartOAuth()}>
        OAuth
      </button>
      <button type="button" onClick={onDelete}>
        Delete selected
      </button>
      <button type="button" onClick={() => void onHealthCheck()}>
        Health check
      </button>
      <button
        type="button"
        onClick={() => {
          setPolicyAllowed("fs.*");
          setPolicyDirty(true);
          void onSavePolicy();
        }}
      >
        Save policy
      </button>
    </div>
  ),
}));

vi.mock("./mcp/McpApprovalInboxPanel", () => ({
  McpApprovalInboxPanel: ({
    inboxItems,
    onRefresh,
    onResolve,
  }: {
    inboxItems: Array<{ inboxItemId: string; title?: string }>;
    onRefresh: () => Promise<void>;
    onResolve: (item: { inboxItemId: string; title?: string }, decision: "approve" | "reject") => Promise<void>;
  }) => (
    <div>
      <p>Approval inbox panel {inboxItems.length}</p>
      <button type="button" onClick={() => void onRefresh()}>
        Refresh inbox
      </button>
      <button type="button" onClick={() => void onResolve(inboxItems[0] ?? { inboxItemId: "inbox-1" }, "approve")}>
        Approve inbox
      </button>
    </div>
  ),
}));

import { McpPage } from "./McpPage";

function collectText(node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | null): string {
  if (node == null) {
    return "";
  }
  if (typeof node === "string") {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map((child) => collectText(child)).join(" ");
  }
  return (node.children ?? []).map((child) => collectText(child as ReactTestRendererJSON | string | null)).join(" ");
}

function rendererText(renderer: ReactTestRenderer): string {
  return collectText(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function instanceText(node: unknown): string {
  if (typeof node === "string") {
    return node;
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return ((node as { children?: unknown[] }).children ?? []).map((child) => instanceText(child)).join(" ");
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

const filesystemServer = {
  serverId: "server-files",
  label: "Filesystem",
  transport: "stdio",
  status: "disconnected",
  enabled: true,
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  authType: "none",
  command: "npx filesystem",
  policy: {
    requireFirstToolApproval: true,
    redactionMode: "basic",
    allowedToolPatterns: ["fs.read"],
    blockedToolPatterns: [],
    notes: "repo only",
  },
};

const approvalInboxServer = {
  ...filesystemServer,
  serverId: "server-inbox",
  label: "Approval Inbox",
  transport: "http",
  status: "connected",
  url: "goatcitadel://approval-inbox",
};

describe("McpPage behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchSettings.mockResolvedValue({
      features: {
        connectorDiagnosticsV1Enabled: true,
      },
    });
    apiMocks.fetchMcpServers.mockResolvedValue({
      items: [
        filesystemServer,
        {
          ...filesystemServer,
          serverId: "server-hidden",
          label: "Remote Hidden",
          transport: "http",
          url: "https://remote.example/mcp",
        },
        approvalInboxServer,
      ],
    });
    apiMocks.fetchMcpTemplates.mockResolvedValue({
      items: [
        {
          templateId: "filesystem",
          label: "Filesystem",
          description: "Read files",
          transport: "stdio",
          command: "npx filesystem",
          args: ["."],
          authType: "none",
          installed: false,
          enabledByDefault: false,
          category: "development",
          trustTier: "restricted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
        {
          templateId: "approval-inbox",
          label: "Approval Inbox",
          description: "Remote approvals",
          transport: "http",
          url: "goatcitadel://approval-inbox",
          authType: "none",
          installed: true,
          enabledByDefault: true,
          category: "automation",
          trustTier: "trusted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: false,
            redactionMode: "off",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
        {
          templateId: "hidden-http",
          label: "Hidden HTTP",
          description: "Hidden remote",
          transport: "http",
          url: "https://remote.example/mcp",
          authType: "token",
          installed: false,
          enabledByDefault: false,
          category: "other",
          trustTier: "restricted",
          costTier: "unknown",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "strict",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
      ],
    });
    apiMocks.fetchMcpTemplateDiscovery.mockResolvedValue({
      items: [
        {
          templateId: "filesystem",
          label: "Filesystem",
          installed: false,
          readiness: "ready",
          dependencyChecks: [{ key: "node", status: "pass" }],
        },
        { templateId: "hidden-http", label: "Hidden HTTP", installed: false, readiness: "ready", dependencyChecks: [] },
      ],
    });
    apiMocks.fetchConnectorRecords.mockResolvedValue({
      items: [{ connectorId: "connector-files", sourceId: "server-files", connectorType: "mcp_server" }],
    });
    apiMocks.fetchMcpTools.mockResolvedValue({
      items: [
        {
          serverId: "server-files",
          toolName: "fs.read",
          description: "Read file",
          enabled: true,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    apiMocks.createMcpServer.mockResolvedValue({ ok: true });
    apiMocks.connectMcpServer.mockResolvedValue({ ok: true });
    apiMocks.disconnectMcpServer.mockResolvedValue({ ok: true });
    apiMocks.deleteMcpServer.mockResolvedValue({ ok: true });
    apiMocks.updateMcpServerPolicy.mockResolvedValue({ ok: true });
    apiMocks.startMcpOAuth.mockResolvedValue({ authorizeUrl: "https://auth.example/start" });
    apiMocks.runMcpServerHealthCheck.mockResolvedValue({
      connectorType: "mcp_server",
      connectorId: "server-files",
      status: "ok",
      checks: [{ key: "connect", status: "pass", message: "ok" }],
      checkedAt: "2026-04-01T00:00:00.000Z",
    });
    apiMocks.invokeMcpTool.mockResolvedValue({
      ok: true,
      output: {
        items: [{ inboxItemId: "inbox-1", title: "Approve deploy" }],
      },
    });
  });

  it("filters visible MCP adapters and drives create, policy, invoke, and inbox actions", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      let text = rendererText(renderer);
      expect(text).toContain("MCP");
      expect(text).toContain("2 servers");
      expect(text).toContain("Filesystem");
      expect(text).toContain("Approval Inbox");
      expect(text).not.toContain("Remote Hidden");
      expect(text).not.toContain("Hidden HTTP");
      expect(text).toContain("node:pass");
      expect(apiMocks.fetchMcpTools).toHaveBeenCalledWith("server-files");

      await click(renderer, "Add Filesystem");
      expect(apiMocks.createMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Filesystem", transport: "stdio" }),
      );

      await act(async () => {
        renderer.root.findByProps({ id: "mcpLabel" }).props.onChange({ target: { value: "Docs MCP" } });
        renderer.root.findByProps({ id: "mcpCommand" }).props.onChange({ target: { value: "npx docs-mcp" } });
      });
      await click(renderer, "Add Server");
      expect(apiMocks.createMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({ label: "Docs MCP", command: "npx docs-mcp" }),
      );

      await click(renderer, "Toggle connection");
      expect(apiMocks.connectMcpServer).toHaveBeenCalledWith("server-files");

      await click(renderer, "Health check");
      expect(apiMocks.runMcpServerHealthCheck).toHaveBeenCalledWith("server-files");

      await click(renderer, "Save policy");
      expect(apiMocks.updateMcpServerPolicy).toHaveBeenCalledWith(
        "server-files",
        expect.objectContaining({
          allowedToolPatterns: expect.arrayContaining(["fs.read"]),
        }),
      );

      await act(async () => {
        const inputs = renderer.root.findAllByType("input");
        inputs.find((node) => node.props.placeholder === "tool name")?.props.onChange({ target: { value: "fs.read" } });
        inputs
          .find((node) => node.props.placeholder === '{"query":"hello"}')
          ?.props.onChange({ target: { value: '{"path":"README.md"}' } });
      });
      await click(renderer, "Invoke Tool");
      expect(apiMocks.invokeMcpTool).toHaveBeenCalledWith({
        serverId: "server-files",
        toolName: "fs.read",
        arguments: { path: "README.md" },
      });

      await click(renderer, "Approval Inbox");
      await flush();
      text = rendererText(renderer);
      expect(text).toContain("Approval inbox panel");
      expect(apiMocks.invokeMcpTool).toHaveBeenCalledWith({
        serverId: "server-inbox",
        toolName: "goatcitadel.approval.remote_action_inbox.list",
        arguments: { state: "pending", limit: 50 },
      });

      await click(renderer, "Approve inbox");
      expect(apiMocks.invokeMcpTool).toHaveBeenCalledWith({
        serverId: "server-inbox",
        toolName: "goatcitadel.approval.remote_action_inbox.resolve",
        arguments: {
          inboxItemId: "inbox-1",
          decision: "approve",
          resolvedBy: "mission-control:mcp",
        },
      });
    } finally {
      renderer.unmount();
    }
  });

  it("shows the MCP loading skeleton while startup fetches are pending", async () => {
    apiMocks.fetchMcpServers.mockImplementationOnce(() => new Promise(() => undefined));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });

      expect(rendererText(renderer)).toContain("Loading MCP");
    } finally {
      renderer.unmount();
    }
  });

  it("renders empty MCP library and server states without hiding manual setup", async () => {
    apiMocks.fetchSettings.mockResolvedValueOnce({
      features: {
        connectorDiagnosticsV1Enabled: false,
      },
    });
    apiMocks.fetchMcpServers.mockResolvedValueOnce({ items: [] });
    apiMocks.fetchMcpTemplates.mockResolvedValueOnce({ items: [] });
    apiMocks.fetchConnectorRecords.mockResolvedValueOnce({ items: [] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("0 servers");
      expect(text).toContain("No templates available.");
      expect(text).toContain("Selected server: none");
      expect(text).toContain("Template discovery readiness is disabled right now.");
      expect(text).toContain("Add Server");
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces MCP startup load errors after the skeleton clears", async () => {
    apiMocks.fetchMcpServers.mockRejectedValueOnce(new Error("mcp-registry-down"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("mcp-registry-down");
      expect(text).toContain("No templates available.");
      expect(text).toContain("Selected server: none");
    } finally {
      renderer.unmount();
    }
  });

  it("handles refresh subscriptions, delete confirmation, invocation parse errors, and selected-server fallback", async () => {
    apiMocks.fetchMcpTools.mockRejectedValueOnce(new Error("Unknown MCP server: server-files")).mockResolvedValue({
      items: [
        {
          serverId: "server-inbox",
          toolName: "goatcitadel.approval.remote_action_inbox.list",
          description: "List approvals",
          enabled: true,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    });
    apiMocks.invokeMcpTool.mockResolvedValueOnce({
      ok: true,
      output: {
        items: [{ inboxItemId: "inbox-2", title: "Approve restart" }],
      },
    });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("That MCP server no longer exists.");
      expect(rendererText(renderer)).toContain("Selected server: Approval Inbox");

      await act(async () => {
        const inputs = renderer.root.findAllByType("input");
        inputs.find((node) => node.props.placeholder === "tool name")?.props.onChange({ target: { value: "fs.read" } });
        inputs
          .find((node) => node.props.placeholder === '{"query":"hello"}')
          ?.props.onChange({ target: { value: "{" } });
      });
      await click(renderer, "Invoke Tool");
      expect(rendererText(renderer)).toContain("Expected property name");

      await click(renderer, "Delete selected");
      expect(rendererText(renderer)).toContain("Delete MCP Server");
      await click(renderer, "Cancel");
      expect(apiMocks.deleteMcpServer).not.toHaveBeenCalled();

      await click(renderer, "Delete selected");
      await click(renderer, "Delete", 1);
      expect(apiMocks.deleteMcpServer).toHaveBeenCalledWith("server-inbox");

      apiMocks.fetchMcpTemplateDiscovery.mockRejectedValueOnce(new Error("discovery offline"));
      await act(async () => {
        await refreshState.callback?.();
      });
      await flush();

      expect(apiMocks.fetchMcpServers).toHaveBeenCalled();
      expect(rendererText(renderer)).toContain("discovery offline");
    } finally {
      renderer.unmount();
    }
  });
});
