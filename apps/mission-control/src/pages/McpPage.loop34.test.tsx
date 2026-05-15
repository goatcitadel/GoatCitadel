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

vi.mock("../api/client", () => apiMocks);

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
  ActionButton: ({
    label,
    disabled,
    pending,
    onClick,
  }: {
    label: string;
    disabled?: boolean;
    pending?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled || pending} onClick={onClick}>
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
  HelpHint: ({ label }: { label?: string }) => <span>{label}</span>,
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
      <option value="http">http</option>
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
  }: {
    selected?: { label: string; status: string } | null;
    selectedDiagnostic?: { status: string };
    onToggleConnection: () => Promise<void>;
    onStartOAuth: () => Promise<void>;
    onDelete: () => void;
    onHealthCheck: () => Promise<void>;
    onSavePolicy: () => Promise<void>;
  }) => (
    <div>
      <p>Selected server: {selected?.label ?? "none"}</p>
      <p>Selected status: {selected?.status ?? "none"}</p>
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
      <button type="button" onClick={() => void onSavePolicy()}>
        Save policy
      </button>
    </div>
  ),
}));

vi.mock("./mcp/McpApprovalInboxPanel", () => ({
  McpApprovalInboxPanel: ({
    inboxItems,
    inboxError,
    onRefresh,
    onResolve,
  }: {
    inboxItems: Array<{ inboxItemId: string; title?: string }>;
    inboxError?: string | null;
    onRefresh: () => Promise<void>;
    onResolve: (item: { inboxItemId: string; title?: string }, decision: "approve" | "reject") => Promise<void>;
  }) => (
    <div>
      <p>Approval inbox panel {inboxItems.length}</p>
      {inboxError ? <p>{inboxError}</p> : null}
      <button type="button" onClick={() => void onRefresh()}>
        Refresh inbox
      </button>
      <button type="button" onClick={() => void onResolve(inboxItems[0] ?? { inboxItemId: "inbox-1" }, "reject")}>
        Reject inbox
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

const connectedServer = {
  serverId: "server-connected",
  label: "Connected Filesystem",
  transport: "stdio",
  status: "connected",
  enabled: true,
  category: "development",
  trustTier: "restricted",
  costTier: "free",
  authType: "oauth2",
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
  ...connectedServer,
  serverId: "server-inbox",
  label: "Approval Inbox",
  transport: "http",
  url: "goatcitadel://approval-inbox",
  authType: "none",
};

describe("McpPage loop 34 edge behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
    apiMocks.fetchMcpServers.mockResolvedValue({ items: [connectedServer, approvalInboxServer] });
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
          installed: true,
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
          templateId: "playwright",
          label: "Playwright",
          description: "Browser checks",
          transport: "stdio",
          command: "npx playwright-mcp",
          args: [],
          authType: "none",
          installed: false,
          enabledByDefault: false,
          category: "browser",
          trustTier: "restricted",
          costTier: "free",
          policy: {
            requireFirstToolApproval: true,
            redactionMode: "basic",
            allowedToolPatterns: [],
            blockedToolPatterns: [],
          },
        },
      ],
    });
    apiMocks.fetchMcpTemplateDiscovery.mockResolvedValue({
      items: [
        { templateId: "filesystem", label: "Filesystem", installed: true, readiness: "ready", dependencyChecks: [] },
        { templateId: "playwright", label: "Playwright", installed: false, readiness: "ready", dependencyChecks: [] },
      ],
    });
    apiMocks.fetchConnectorRecords.mockResolvedValue({ items: [] });
    apiMocks.fetchMcpTools.mockResolvedValue({
      items: [{ serverId: "server-connected", toolName: "fs.read", enabled: true, updatedAt: "2026-05-15T00:00:00Z" }],
    });
    apiMocks.createMcpServer.mockResolvedValue({ ok: true });
    apiMocks.connectMcpServer.mockResolvedValue({ ok: true });
    apiMocks.disconnectMcpServer.mockRejectedValue(new Error("disconnect failed"));
    apiMocks.deleteMcpServer.mockRejectedValue(new Error("delete failed"));
    apiMocks.updateMcpServerPolicy.mockRejectedValue(new Error("policy failed"));
    apiMocks.startMcpOAuth.mockRejectedValue(new Error("oauth failed"));
    apiMocks.runMcpServerHealthCheck.mockResolvedValue({
      connectorType: "mcp_server",
      connectorId: "server-connected",
      status: "warn",
      checks: [{ key: "connect", status: "warn", message: "slow" }],
      checkedAt: "2026-05-15T00:00:00Z",
    });
    apiMocks.invokeMcpTool.mockResolvedValue({ ok: true, output: {} });
  });

  it("keeps installed templates disabled and supports guarded manual HTTP registration", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      const installedButton = renderer.root
        .findAllByType("button")
        .find((node) => instanceText(node).includes("Installed"));
      expect(installedButton?.props.disabled).toBe(true);

      await click(renderer, "Add Server");
      expect(apiMocks.createMcpServer).not.toHaveBeenCalled();

      await act(async () => {
        renderer.root.findByProps({ id: "mcpTransport" }).props.onChange("http");
      });
      expect(renderer.root.findByProps({ id: "mcpUrl" })).toBeTruthy();

      await act(async () => {
        renderer.root.findByProps({ id: "mcpLabel" }).props.onChange({ target: { value: "Remote diagnostics" } });
        renderer.root.findByProps({ id: "mcpUrl" }).props.onChange({ target: { value: "https://mcp.example/stream" } });
      });
      await click(renderer, "Add Server");

      expect(apiMocks.createMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "Remote diagnostics",
          transport: "http",
          url: "https://mcp.example/stream",
          command: undefined,
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("surfaces selected-server action failures and delete confirmation failures without clearing selection", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      await click(renderer, "Toggle connection");
      expect(rendererText(renderer)).toContain("disconnect failed");

      await click(renderer, "OAuth");
      expect(rendererText(renderer)).toContain("oauth failed");

      await click(renderer, "Save policy");
      expect(rendererText(renderer)).toContain("policy failed");

      await click(renderer, "Health check");
      expect(rendererText(renderer)).toContain("Diagnostic warn");

      await click(renderer, "Delete selected");
      expect(rendererText(renderer)).toContain("Delete MCP Server");
      await click(renderer, "Delete", 1);
      expect(apiMocks.deleteMcpServer).toHaveBeenCalledWith("server-connected");
      expect(rendererText(renderer)).toContain("delete failed");
      expect(rendererText(renderer)).toContain("Selected server: Connected Filesystem");
    } finally {
      renderer.unmount();
    }
  });

  it("renders approval-inbox load and resolve errors from the internal MCP server", async () => {
    apiMocks.invokeMcpTool
      .mockResolvedValueOnce({ ok: false, error: "inbox list failed" })
      .mockResolvedValueOnce({ ok: false, error: "reject failed" });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      await click(renderer, "Approval Inbox");
      expect(rendererText(renderer)).toContain("Approval inbox panel 0");
      expect(rendererText(renderer)).toContain("inbox list failed");

      await click(renderer, "Reject inbox");
      expect(rendererText(renderer)).toContain("reject failed");
      expect(apiMocks.invokeMcpTool).toHaveBeenCalledWith({
        serverId: "server-inbox",
        toolName: "goatcitadel.approval.remote_action_inbox.resolve",
        arguments: {
          inboxItemId: "inbox-1",
          decision: "reject",
          resolvedBy: "mission-control:mcp",
        },
      });
    } finally {
      renderer.unmount();
    }
  });
});
