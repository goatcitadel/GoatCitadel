import React from "react";
import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type StreamEvent = {
  eventId: string;
  eventType: string;
  source: string;
  timestamp: string;
  payload: Record<string, unknown>;
};

const streamState = vi.hoisted(() => ({
  onEvent: null as null | ((event: StreamEvent) => void),
  onStateChange: null as null | ((state: string) => void),
  close: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  fetchAgents: vi.fn(),
  fetchOperators: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchRealtimeEvents: vi.fn(),
  connectEventStream: vi.fn((onEvent: (event: StreamEvent) => void, onStateChange?: (state: string) => void) => {
    streamState.onEvent = onEvent;
    streamState.onStateChange = onStateChange ?? null;
    onStateChange?.("open");
    return streamState.close;
  }),
}));

vi.mock("../api/client", () => ({
  fetchAgents: apiMocks.fetchAgents,
  fetchApprovals: apiMocks.fetchApprovals,
  fetchOperators: apiMocks.fetchOperators,
  fetchRealtimeEvents: apiMocks.fetchRealtimeEvents,
  connectEventStream: apiMocks.connectEventStream,
}));

vi.mock("../components/OfficeCanvas", () => ({
  OfficeCanvas: ({
    onSelect,
    selectedEntityId,
  }: {
    onSelect: (entityId: string) => void;
    selectedEntityId: string;
  }) => (
    <button type="button" onClick={() => onSelect("qa")}>
      Office canvas selected {selectedEntityId}
    </button>
  ),
}));

import { OfficePage } from "./OfficePage";

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

function installDocumentStub(visibilityState = "visible") {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const documentStub = {
    get visibilityState() {
      return visibilityState;
    },
    setVisibilityState(nextState: string) {
      visibilityState = nextState;
    },
    addEventListener: (name: string, handler: (event?: unknown) => void) => {
      const next = listeners.get(name) ?? [];
      next.push(handler);
      listeners.set(name, next);
    },
    removeEventListener: (name: string, handler: (event?: unknown) => void) => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((candidate) => candidate !== handler),
      );
    },
    dispatchEvent: (event: { type: string }) => {
      for (const handler of listeners.get(event.type) ?? []) {
        handler(event);
      }
      return true;
    },
  };
  vi.stubGlobal("document", documentStub);
  return documentStub;
}

function installWindowStub() {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  const mediaListeners = new Set<(event: { matches: boolean }) => void>();
  const windowStub = {
    localStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    matchMedia: () => ({
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_event: string, handler: (event: { matches: boolean }) => void) => {
        mediaListeners.add(handler);
      },
      removeEventListener: (_event: string, handler: (event: { matches: boolean }) => void) => {
        mediaListeners.delete(handler);
      },
      dispatchEvent: () => true,
    }),
    addEventListener: (name: string, handler: (event?: unknown) => void) => {
      const next = listeners.get(name) ?? [];
      next.push(handler);
      listeners.set(name, next);
    },
    removeEventListener: (name: string, handler: (event?: unknown) => void) => {
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter((candidate) => candidate !== handler),
      );
    },
    dispatchEvent: (event: { type: string }) => {
      for (const handler of listeners.get(event.type) ?? []) {
        handler(event);
      }
      return true;
    },
  };
  vi.stubGlobal("window", windowStub);
  return windowStub;
}

function installAssetFetchStub(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets/office/asset-manifest.json")) {
        return new Response(
          JSON.stringify({
            models: [
              { id: "central-operator", label: "Operator", path: "/assets/operator.glb", includedInRepo: true },
              { id: "goat-subagent", label: "Goat Subagent", path: "/assets/goat.glb", includedInRepo: true },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch,
  );
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    agentId: "agent-qa",
    roleId: "qa",
    status: "active",
    name: "QA",
    title: "Verification Lead",
    summary: "Checks work before handoff.",
    specialties: ["Regression"],
    defaultTools: ["shell.exec"],
    aliases: ["qa"],
    isBuiltin: true,
    editable: false,
    lifecycleStatus: "active",
    sessionCount: 2,
    activeSessions: 1,
    runtimeAgentId: "runtime-qa",
    lastUpdatedAt: "2026-05-15T16:00:00.000Z",
    createdAt: "2026-05-15T15:00:00.000Z",
    updatedAt: "2026-05-15T16:00:00.000Z",
    ...overrides,
  };
}

function event(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    eventId: "evt-qa",
    eventType: "activity_logged",
    source: "chat",
    timestamp: "2026-05-15T16:01:00.000Z",
    payload: {
      activity: { agentId: "runtime-qa", message: "QA verified the latest handoff." },
      taskId: "task-loop40",
      sessionId: "session-loop40",
    },
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: "approval-loop40",
    kind: "tool.invoke",
    riskLevel: "high",
    status: "pending",
    createdAt: "2026-05-15T16:01:30.000Z",
    ...overrides,
  };
}

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
    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
    }
  });
}

async function click(renderer: ReactTestRenderer, label: string): Promise<void> {
  const button = renderer.root.findAll(
    (node) => node.type === "button" && instanceText(node).replace(/\s+/g, " ").includes(label),
  )[0];
  if (!button) {
    throw new Error(`Button not found: ${label}`);
  }
  await act(async () => {
    button.props.onClick();
  });
  await flush();
}

describe("OfficePage loop 40 behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T16:02:00.000Z"));
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    streamState.onEvent = null;
    streamState.onStateChange = null;
    streamState.close.mockClear();
    installDocumentStub();
    installWindowStub();
    installAssetFetchStub();
    apiMocks.fetchAgents.mockResolvedValue({ items: [agent()] });
    apiMocks.fetchOperators.mockResolvedValue({
      items: [
        {
          operatorId: "operator-1",
          sessionCount: 3,
          activeSessions: 1,
          lastActivityAt: "2026-05-15T16:01:45.000Z",
        },
      ],
    });
    apiMocks.fetchApprovals.mockResolvedValue({ items: [approval()] });
    apiMocks.fetchRealtimeEvents.mockResolvedValue({ items: [event()] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("drives lab navigation, canvas selection, visibility refresh, hidden interval skip, and stream resync", async () => {
    const documentStub = installDocumentStub();
    const onOpenLab = vi.fn();
    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OfficePage onOpenLab={onOpenLab} />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Stream live");
      expect(rendererText(renderer)).toContain("1 approvals");

      await act(async () => {
        vi.advanceTimersByTime(130);
      });
      await flush();

      await click(renderer, "Pixel Lab");
      expect(onOpenLab).toHaveBeenCalledTimes(1);

      await click(renderer, "Office canvas selected");
      expect(rendererText(renderer)).toContain("Verification Lead");
      expect(rendererText(renderer)).toContain("QA verified the latest handoff.");

      documentStub.setVisibilityState("hidden");
      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      await flush();
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(1);

      documentStub.setVisibilityState("visible");
      await act(async () => {
        document.dispatchEvent({ type: "visibilitychange" } as Event);
      });
      await flush();
      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(2);
      expect(apiMocks.fetchRealtimeEvents).toHaveBeenCalledTimes(1);

      act(() => {
        streamState.onStateChange?.("error");
        streamState.onEvent?.(
          event({
            eventId: "evt-stream-approval",
            eventType: "approval_created",
            source: "approval",
            payload: { kind: "shell.exec", approvalId: "approval-stream" },
          }),
        );
      });
      await flush();
      expect(rendererText(renderer)).toContain("Stream resyncing");

      await act(async () => {
        vi.advanceTimersByTime(20_000);
      });
      await flush();

      expect(apiMocks.fetchAgents).toHaveBeenCalledTimes(3);
      expect(apiMocks.fetchApprovals).toHaveBeenCalledTimes(3);
      expect(streamState.close).not.toHaveBeenCalled();
    } finally {
      renderer.unmount();
    }

    expect(streamState.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the page interactive when startup snapshot fails without a browser window", async () => {
    installDocumentStub();
    vi.stubGlobal("window", undefined);
    apiMocks.fetchAgents.mockRejectedValueOnce(new Error("office snapshot unavailable"));

    let renderer: ReactTestRenderer = create(<div />);
    try {
      await act(async () => {
        renderer = create(<OfficePage />);
      });
      await flush();

      expect(rendererText(renderer)).toContain("Command feed degraded.");
      expect(rendererText(renderer)).toContain("office snapshot unavailable");
      expect(rendererText(renderer)).toContain("Stream live");
      expect(rendererText(renderer)).toContain("Scene ready");
      expect(rendererText(renderer)).toContain("Office canvas selected operator");
    } finally {
      renderer.unmount();
    }
  });
});
