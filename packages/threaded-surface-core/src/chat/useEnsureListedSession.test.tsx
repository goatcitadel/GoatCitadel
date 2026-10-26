import React, { useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord } from "@goatcitadel/contracts";
import type { ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import type { ChatHistoryView } from "./chat-session-data-bootstrap";
import { useEnsureListedSession } from "./useEnsureListedSession";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ fetchChatSessions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchChatSessions: (...args: unknown[]) => api.fetchChatSessions(...args),
}));

function record(sessionId: string, overrides: Partial<ChatSessionRecord> = {}): ChatSessionRecord {
  return {
    sessionId,
    title: sessionId,
    workspaceId: "workspace-1",
    scope: "mission",
    lifecycleStatus: "active",
    includeInHistory: true,
    ...overrides,
  } as ChatSessionRecord;
}

function channelRecord(sessionId: string): ChatSessionRecord {
  return record(sessionId, { scope: "external", channelConnectionId: "conn-1" });
}

type Latest = {
  ensure: (sessionId: string) => void;
  sessions: ChatSessionsResponse | null;
  setSessions: React.Dispatch<React.SetStateAction<ChatSessionsResponse | null>>;
};
let latest: Latest;

function Harness(props: {
  workspaceId?: string;
  historyView?: ChatHistoryView;
  initial?: ChatSessionsResponse | null;
}) {
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>(
    props.initial === undefined ? { items: [record("newest")] } : props.initial,
  );
  const ensure = useEnsureListedSession({
    workspaceId: props.workspaceId ?? "workspace-1",
    historyView: props.historyView ?? "active",
    surfaceMode: undefined,
    sessions,
    setSessions,
  });
  latest = { ensure, sessions, setSessions };
  return null;
}

async function mount(props: React.ComponentProps<typeof Harness> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<Harness {...props} />);
  });
  return renderer;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const ids = () => latest.sessions?.items.map((item) => item.sessionId);

describe("useEnsureListedSession", () => {
  beforeEach(() => {
    api.fetchChatSessions.mockReset();
  });

  it("reads a selected channel conversation outside the loaded page exactly, with scope all, and lists it", async () => {
    api.fetchChatSessions.mockResolvedValue({ items: [channelRecord("old-channel")] });
    const renderer = await mount();
    await act(async () => latest.ensure("old-channel"));
    await settle();
    expect(api.fetchChatSessions).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: "old-channel",
        workspaceId: "workspace-1",
        scope: "all",
        view: "active",
        mode: undefined,
        limit: 1,
        includeActivity: true,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(ids()).toEqual(["newest", "old-channel"]);
    await act(async () => renderer.unmount());
  });

  it("does not read a conversation the loaded list already holds", async () => {
    const renderer = await mount();
    await act(async () => latest.ensure("newest"));
    await settle();
    expect(api.fetchChatSessions).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  });

  it("lists nothing for a record that is not this workspace's visible conversation", async () => {
    api.fetchChatSessions.mockResolvedValue({ items: [record("foreign", { workspaceId: "workspace-2" })] });
    const renderer = await mount();
    await act(async () => latest.ensure("foreign"));
    await settle();
    expect(ids()).toEqual(["newest"]);
    await act(async () => renderer.unmount());
  });

  it("ignores a failed read: the list stays as it was and nothing is tried again by itself", async () => {
    api.fetchChatSessions.mockRejectedValue(new Error("offline"));
    const renderer = await mount();
    await act(async () => latest.ensure("old-channel"));
    await settle();
    expect(ids()).toEqual(["newest"]);
    expect(api.fetchChatSessions).toHaveBeenCalledOnce();
    await act(async () => renderer.unmount());
  });

  it("withholds a late record after the workspace changed", async () => {
    let resolveRead!: (value: ChatSessionsResponse) => void;
    api.fetchChatSessions.mockReturnValue(new Promise<ChatSessionsResponse>((resolve) => (resolveRead = resolve)));
    const renderer = await mount();
    await act(async () => latest.ensure("old-channel"));
    await act(async () =>
      renderer.update(<Harness workspaceId="workspace-2" initial={{ items: [record("other")] }} />),
    );
    await act(async () => {
      resolveRead({ items: [channelRecord("old-channel")] });
    });
    await settle();
    expect(ids()).toEqual(["newest"]);
    await act(async () => renderer.unmount());
  });

  it("aborts its read when the Chat unmounts", async () => {
    let signal: AbortSignal | undefined;
    api.fetchChatSessions.mockImplementation((_query: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    const renderer = await mount();
    await act(async () => latest.ensure("old-channel"));
    expect(signal?.aborted).toBe(false);
    await act(async () => renderer.unmount());
    expect(signal?.aborted).toBe(true);
  });
});
