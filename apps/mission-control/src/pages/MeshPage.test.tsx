import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const refreshState = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void> | void),
  options: null as null | {
    enabled?: boolean;
    onFallbackStateChange?: (value: boolean) => void;
  },
}));

const apiMocks = vi.hoisted(() => ({
  fetchMeshLeases: vi.fn(),
  fetchMeshNodes: vi.fn(),
  fetchMeshReplicationOffsets: vi.fn(),
  fetchMeshSessionOwners: vi.fn(),
  fetchMeshStatus: vi.fn(),
}));

vi.mock("../api/client", () => ({
  fetchMeshLeases: apiMocks.fetchMeshLeases,
  fetchMeshNodes: apiMocks.fetchMeshNodes,
  fetchMeshReplicationOffsets: apiMocks.fetchMeshReplicationOffsets,
  fetchMeshSessionOwners: apiMocks.fetchMeshSessionOwners,
  fetchMeshStatus: apiMocks.fetchMeshStatus,
}));

vi.mock("../hooks/useRefreshSubscription", () => ({
  useRefreshSubscription: (
    _channel: string,
    callback: () => Promise<void> | void,
    options: typeof refreshState.options,
  ) => {
    refreshState.callback = callback;
    refreshState.options = options;
  },
}));

vi.mock("../components/FieldHelp", () => ({
  FieldHelp: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/HelpHint", () => ({
  HelpHint: ({ label, text }: { label?: string; text?: string }) => (
    <span>
      {label}
      {text}
    </span>
  ),
}));

vi.mock("../components/PageGuideCard", () => ({
  PageGuideCard: ({ what, when }: { what?: string; when?: string }) => (
    <section>
      {what}
      {when}
    </section>
  ),
}));

vi.mock("../components/PageHeader", () => ({
  PageHeader: ({
    title,
    subtitle,
    hint,
    actions,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    hint?: React.ReactNode;
    actions?: React.ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <p>{hint}</p>
      {actions}
    </header>
  ),
}));

vi.mock("../components/Panel", () => ({
  Panel: ({
    title,
    subtitle,
    children,
    className,
  }: {
    title?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
  }) => (
    <section className={className}>
      {title ? <h2>{title}</h2> : null}
      {subtitle ? <p>{subtitle}</p> : null}
      {children}
    </section>
  ),
}));

vi.mock("../components/StatusChip", () => ({
  StatusChip: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../content/copy", () => ({
  pageCopy: {
    mesh: {
      title: "Mesh",
      subtitle: "Coordinate nodes.",
      guide: {
        what: "Understand cluster coordination.",
        when: "Use for multi-node installs.",
        mostCommonAction: "Check mesh health",
        actions: ["Check nodes", "Review leases"],
        terms: [],
      },
    },
  },
}));

import { MeshPage } from "./MeshPage";

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

async function flush(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

function setupMeshApi(
  overrides: {
    status?: Record<string, unknown>;
    nodes?: Array<Record<string, unknown>>;
    leases?: Array<Record<string, unknown>>;
    owners?: Array<Record<string, unknown>>;
    offsets?: Array<Record<string, unknown>>;
  } = {},
): void {
  apiMocks.fetchMeshStatus.mockResolvedValue({
    enabled: true,
    mode: "tailnet",
    localNodeId: "node-local",
    tailnetEnabled: true,
    nodesOnline: 2,
    activeLeases: 1,
    ownedSessions: 1,
    ...overrides.status,
  });
  apiMocks.fetchMeshNodes.mockResolvedValue({
    items: overrides.nodes ?? [
      {
        nodeId: "node-local",
        label: "Desktop Node",
        transport: "tailnet",
        status: "online",
        capabilities: ["chat"],
        joinedAt: "2026-05-14T10:00:00.000Z",
        lastSeenAt: "2026-05-14T10:05:00.000Z",
      },
      {
        nodeId: "node-remote",
        transport: "wan",
        status: "suspect",
        capabilities: [],
        joinedAt: "2026-05-14T09:00:00.000Z",
        lastSeenAt: "2026-05-14T10:04:00.000Z",
      },
    ],
  });
  apiMocks.fetchMeshLeases.mockResolvedValue({
    items: overrides.leases ?? [
      {
        leaseKey: "session:alpha",
        holderNodeId: "node-local",
        fencingToken: 42,
        expiresAt: "2026-05-14T10:10:00.000Z",
        updatedAt: "2026-05-14T10:05:00.000Z",
      },
    ],
  });
  apiMocks.fetchMeshSessionOwners.mockResolvedValue({
    items: overrides.owners ?? [
      {
        sessionId: "session-alpha",
        ownerNodeId: "node-local",
        epoch: 3,
        claimedAt: "2026-05-14T10:00:00.000Z",
        updatedAt: "2026-05-14T10:05:00.000Z",
      },
    ],
  });
  apiMocks.fetchMeshReplicationOffsets.mockResolvedValue({
    items: overrides.offsets ?? [
      {
        consumerNodeId: "node-local",
        sourceNodeId: "node-remote",
        lastReplicationId: "rep-99",
        updatedAt: "2026-05-14T10:05:00.000Z",
      },
      {
        consumerNodeId: "node-remote",
        sourceNodeId: "node-local",
        updatedAt: "2026-05-14T10:04:00.000Z",
      },
    ],
  });
}

describe("MeshPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshState.callback = null;
    refreshState.options = null;
    setupMeshApi();
  });

  it("renders the loading state while mesh telemetry is unresolved", async () => {
    apiMocks.fetchMeshStatus.mockReturnValue(new Promise(() => undefined));

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MeshPage />);
      });

      expect(rendererText(renderer)).toContain("Loading mesh telemetry...");
      expect(refreshState.options?.enabled).toBe(false);
    } finally {
      renderer.unmount();
    }
  });

  it("renders enabled cluster telemetry with nodes, leases, owners, and replication offsets", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MeshPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Mesh enabled");
      expect(text).toContain("2 nodes online");
      expect(text).toContain("tailnet");
      expect(text).toContain("OK - Mesh feature is enabled.");
      expect(text).toContain("OK - Tailnet routing is on");
      expect(text).toContain("Desktop Node");
      expect(text).toContain("node-remote");
      expect(text).toContain("session:alpha");
      expect(text).toContain("session-alpha");
      expect(text).toContain("rep-99");
      expect(text).toContain("Mesh is optional.");
      expect(refreshState.options?.enabled).toBe(true);
    } finally {
      renderer.unmount();
    }
  });

  it("renders disabled and empty mesh states as normal single-node operator truth", async () => {
    setupMeshApi({
      status: {
        enabled: false,
        mode: "lan",
        localNodeId: "solo-node",
        tailnetEnabled: false,
        nodesOnline: 0,
        activeLeases: -1,
        ownedSessions: 0,
      },
      nodes: [],
      leases: [],
      owners: [],
      offsets: [],
    });

    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MeshPage />);
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("Mesh disabled");
      expect(text).toContain("0 nodes online");
      expect(text).toContain("Needs setup - Mesh feature is enabled.");
      expect(text).toContain("Needs attention - At least one node is online.");
      expect(text).toContain("Optional - Tailnet routing is off");
      expect(text).toContain("Needs attention - Lease telemetry is reporting.");
      expect(text).toContain("No nodes discovered.");
      expect(text).toContain("No leases active.");
      expect(text).toContain("No claimed sessions.");
      expect(text).toContain("No replication offsets recorded.");
    } finally {
      renderer.unmount();
    }
  });

  it("shows degraded refresh and preserves existing telemetry when a background refresh fails", async () => {
    let renderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<MeshPage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Desktop Node");

      await act(async () => {
        refreshState.options?.onFallbackStateChange?.(true);
      });
      expect(rendererText(renderer)).toContain("Live updates degraded, checking periodically.");

      let rejectRefresh!: (error: Error) => void;
      apiMocks.fetchMeshStatus.mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectRefresh = reject;
        }),
      );
      let refreshPromise: Promise<void> | undefined;
      await act(async () => {
        refreshPromise = Promise.resolve(refreshState.callback?.());
        await Promise.resolve();
      });
      expect(rendererText(renderer)).toContain("Refreshing mesh status...");

      await act(async () => {
        rejectRefresh(new Error("mesh refresh failed"));
        await refreshPromise;
      });
      await flush();

      const text = rendererText(renderer);
      expect(text).toContain("mesh refresh failed");
      expect(text).toContain("Desktop Node");
    } finally {
      renderer.unmount();
    }
  });
});
