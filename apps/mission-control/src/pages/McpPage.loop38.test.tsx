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
    confirmLabel,
    onCancel,
    onConfirm,
  }: {
    open?: boolean;
    title?: string;
    confirmLabel?: string;
    onCancel?: () => void;
    onConfirm?: () => void;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
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
    onDelete,
    onHealthCheck,
    onSavePolicy,
    onStartOAuth,
    onToggleConnection,
    setPolicyAllowed,
    setPolicyDirty,
    setPolicyNotes,
  }: {
    selected?: { label: string; status: string } | null;
    onDelete: () => void;
    onHealthCheck: () => Promise<void>;
    onSavePolicy: () => Promise<void>;
    onStartOAuth: () => Promise<void>;
    onToggleConnection: () => Promise<void>;
    setPolicyAllowed: (value: string) => void;
    setPolicyDirty: (value: boolean) => void;
    setPolicyNotes: (value: string) => void;
  }) => (
    <div>
      <p>Selected server: {selected?.label ?? "none"}</p>
      <p>Selected status: {selected?.status ?? "none"}</p>
      <button type="button" onClick={() => void onToggleConnection()}>
        Toggle selected MCP
      </button>
      <button type="button" onClick={() => void onStartOAuth()}>
        Start selected OAuth
      </button>
      <button type="button" onClick={onDelete}>
        Delete selected MCP
      </button>
      <button type="button" onClick={() => void onHealthCheck()}>
        Health selected MCP
      </button>
      <button
        type="button"
        onClick={() => {
          setPolicyAllowed("fs.read, browser.open");
          setPolicyNotes("loop 38 note");
          setPolicyDirty(true);
          void onSavePolicy();
        }}
      >
        Save selected policy
      </button>
    </div>
  ),
}));

vi.mock("./mcp/McpApprovalInboxPanel", () => ({
  McpApprovalInboxPanel: ({
    inboxItems,
    onRefresh,
    onResolve,
    setInboxFilterState,
  }: {
    inboxItems: Array<{ inboxItemId: string; title?: string }>;
    onRefresh: () => Promise<void>;
    onResolve: (item: { inboxItemId: string; title?: string }, decision: "approve" | "reject") => Promise<void>;
    setInboxFilterState: (value: string) => void;
  }) => (
    <div>
      <p>Approval inbox panel {inboxItems.length}</p>
      <button type="button" onClick={() => setInboxFilterState("all")}>
        Show all inbox
      </button>
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
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => instanceText(child)).join(" ");
  }
  if (!node || typeof node !== "object" || !("children" in node)) {
    return "";
  }
  return instanceText((node as { children?: unknown }).children);
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 10; index += 1) {
      await Promise.resolve();
    }
  });
}

async function click(renderer: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[occurrence];
  if (!button) {
    const labels = renderer.root.findAllByType("button").map((node) => instanceText(node).replace(/\s+/g, " ").trim());
    throw new Error(`Button not found: ${label}. Buttons: ${labels.join(" | ")}`);
  }
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

async function selectValue(renderer: ReactTestRenderer, id: string, value: string): Promise<void> {
  await act(async () => {
    const control = renderer.root.findAllByType("select").find((node) => node.props.id === id);
    if (!control) {
      throw new Error(`Select not found: ${id}`);
    }
    control.props.onChange({ target: { value } });
  });
  await flush();
}

const fileServer = {
  serverId: "server-files",
  label: "Filesystem",
  transport: "stdio",
  status: "disconnected",
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

const inboxServer = {
  ...fileServer,
  serverId: "server-inbox",
  label: "Approval Inbox",
  transport: "http",
  status: "connected",
  authType: "none",
  url: "goatcitadel://approval-inbox",
};

const templatePolicy = {
  requireFirstToolApproval: true,
  redactionMode: "basic",
  allowedToolPatterns: [],
  blockedToolPatterns: [],
};

describe("McpPage loop 38 behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    apiMocks.fetchSettings.mockResolvedValue({ features: { connectorDiagnosticsV1Enabled: true } });
    apiMocks.fetchMcpServers.mockResolvedValue({ items: [fileServer, inboxServer] });
    apiMocks.fetchMcpTemplates.mockResolvedValue({
      items: [
        {
          templateId: "zeta",
          label: "Zeta Server",
          description: "Non-featured utility",
          transport: "stdio",
          command: "npx zeta-mcp",
          args: ["--safe"],
          authType: "token",
          installed: false,
          enabledByDefault: true,
          category: "automation",
          trustTier: "trusted",
          costTier: "mixed",
          policy: templatePolicy,
        },
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
          policy: templatePolicy,
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
        {
          templateId: "zeta",
          label: "Zeta Server",
          installed: false,
          readiness: "missing_config",
          dependencyChecks: [{ key: "token", status: "fail" }],
        },
      ],
    });
    apiMocks.fetchConnectorRecords.mockResolvedValue({ items: [] });
    apiMocks.fetchMcpTools.mockResolvedValue({
      items: [{ serverId: "server-files", toolName: "fs.read", enabled: true, updatedAt: "2026-05-15T00:00:00Z" }],
    });
    apiMocks.createMcpServer.mockResolvedValue({ ok: true });
    apiMocks.connectMcpServer.mockResolvedValue({ ok: true });
    apiMocks.disconnectMcpServer.mockResolvedValue({ ok: true });
    apiMocks.deleteMcpServer.mockResolvedValue({ ok: true });
    apiMocks.startMcpOAuth.mockResolvedValue({ authorizeUrl: "https://auth.example/start" });
    apiMocks.runMcpServerHealthCheck.mockRejectedValue(new Error("health offline"));
    apiMocks.updateMcpServerPolicy.mockResolvedValue({ ok: true });
    apiMocks.invokeMcpTool.mockResolvedValue({
      ok: true,
      output: { items: [{ inboxItemId: "inbox-1", title: "Approve deploy" }] },
    });
  });

  it("drives template-library add, manual selector choices, OAuth success, and health failure states", async () => {
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("token:fail");

      await click(renderer, "Add Template", 1);
      expect(apiMocks.createMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "Zeta Server",
          transport: "stdio",
          command: "npx zeta-mcp",
          args: ["--safe"],
          enabled: true,
          category: "automation",
          trustTier: "trusted",
          costTier: "mixed",
        }),
      );

      await selectValue(renderer, "mcpAuth", "token");
      await selectValue(renderer, "mcpCategory", "creative");
      await selectValue(renderer, "mcpTrustTier", "trusted");
      await selectValue(renderer, "mcpCostTier", "paid");
      await act(async () => {
        renderer.root.findByProps({ id: "mcpLabel" }).props.onChange({ target: { value: "Creative MCP" } });
        renderer.root.findByProps({ id: "mcpCommand" }).props.onChange({ target: { value: "npx creative-mcp" } });
      });
      await click(renderer, "Add Server");
      expect(apiMocks.createMcpServer).toHaveBeenLastCalledWith(
        expect.objectContaining({
          label: "Creative MCP",
          command: "npx creative-mcp",
          authType: "token",
          category: "creative",
          trustTier: "trusted",
          costTier: "paid",
        }),
      );

      await click(renderer, "Start selected OAuth");
      expect(rendererText(renderer)).toContain("Open OAuth URL: https://auth.example/start");

      await click(renderer, "Health selected MCP");
      expect(rendererText(renderer)).toContain("health offline");

      await click(renderer, "Save selected policy");
      expect(apiMocks.updateMcpServerPolicy).toHaveBeenCalledWith(
        "server-files",
        expect.objectContaining({
          allowedToolPatterns: ["fs.read"],
          notes: "repo only",
        }),
      );
    } finally {
      renderer.unmount();
    }
  });

  it("keeps null selected-server callbacks guarded and handles refresh and inbox refresh paths", async () => {
    apiMocks.fetchMcpServers.mockResolvedValueOnce({ items: [] });
    apiMocks.fetchMcpTools.mockResolvedValue({ items: [] });

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Selected server: none");
      await click(renderer, "Toggle selected MCP");
      await click(renderer, "Start selected OAuth");
      await click(renderer, "Delete selected MCP");
      await click(renderer, "Health selected MCP");
      await click(renderer, "Save selected policy");
      expect(apiMocks.connectMcpServer).not.toHaveBeenCalled();
      expect(apiMocks.startMcpOAuth).not.toHaveBeenCalled();
      expect(apiMocks.runMcpServerHealthCheck).not.toHaveBeenCalled();
      expect(apiMocks.updateMcpServerPolicy).not.toHaveBeenCalled();

      apiMocks.fetchMcpServers.mockRejectedValueOnce(new Error("background refresh failed"));
      await act(async () => {
        await refreshState.callback?.();
      });
      await flush();
      expect(rendererText(renderer)).toContain("background refresh failed");

      apiMocks.fetchMcpServers.mockResolvedValue({ items: [inboxServer] });
      await act(async () => {
        await refreshState.callback?.();
      });
      await flush();

      expect(rendererText(renderer)).toContain("Approval inbox panel");
      await click(renderer, "Show all inbox");
      expect(apiMocks.invokeMcpTool).toHaveBeenCalledWith({
        serverId: "server-inbox",
        toolName: "goatcitadel.approval.remote_action_inbox.list",
        arguments: { limit: 50 },
      });

      await click(renderer, "Refresh inbox");
      expect(apiMocks.invokeMcpTool).toHaveBeenLastCalledWith({
        serverId: "server-inbox",
        toolName: "goatcitadel.approval.remote_action_inbox.list",
        arguments: { limit: 50 },
      });
    } finally {
      renderer.unmount();
    }
  });

  it("clears tools when the selected server disappears without a fallback", async () => {
    apiMocks.fetchMcpServers.mockResolvedValueOnce({ items: [fileServer] });
    apiMocks.fetchMcpTools.mockRejectedValueOnce(new Error("Unknown MCP server: server-files"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<McpPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("That MCP server no longer exists.");
      expect(rendererText(renderer)).toContain("Selected server: none");
      expect(rendererText(renderer)).toContain("Select a server to inspect and invoke tools.");
    } finally {
      renderer.unmount();
    }
  });
});
