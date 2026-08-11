import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecentCrossProjectSession } from "@goatcitadel/contracts";
import { useCrossProjectRecentSessions } from "./useCrossProjectRecentSessions.js";
import { useRefreshSubscription } from "./useRefreshSubscription.js";

const apiMocks = vi.hoisted(() => ({
  fetchCrossProjectRecentSessions: vi.fn(),
}));

vi.mock("../api/chat.js", () => ({
  fetchCrossProjectRecentSessions: apiMocks.fetchCrossProjectRecentSessions,
}));

// Mirror the mocking pattern from useApprovalQueue.test.tsx: the test runs in
// the node env without a DOM, so window timers are unavailable. The real
// refresh subscription is exercised in useRefreshSubscription.test.tsx.
vi.mock("./useRefreshSubscription.js", () => ({
  useRefreshSubscription: vi.fn(),
}));

type HookValue = ReturnType<typeof useCrossProjectRecentSessions>;

function session(sessionId: string, lastActivityAt: string): RecentCrossProjectSession {
  return {
    sessionId,
    projectId: "project-1",
    projectLabel: "Project One",
    title: null,
    sessionKey: `agent:main:${sessionId}`,
    mode: "chat",
    lastActivityAt,
    lifecycleStatus: "active",
  };
}

function recents(items: RecentCrossProjectSession[]) {
  return {
    items,
    workspaceId: "workspace-1",
    generatedAt: "2026-04-22T00:00:00.000Z",
  };
}

function Harness({ onValue }: { onValue: (value: HookValue) => void }) {
  const value = useCrossProjectRecentSessions("workspace-1");
  onValue(value);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("useCrossProjectRecentSessions", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest: HookValue | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    latest = null;
    apiMocks.fetchCrossProjectRecentSessions.mockResolvedValue(
      recents([session("session-refresh", "2026-04-22T00:05:00.000Z")]),
    );
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it("keeps loading truthful when a refresh load commits before the initial load resolves (MCSHARED-011)", async () => {
    // Pins the guard shape that keeps this hook immune to the stuck-loading
    // interleaving fixed in useOpsRuntimeSnapshot (MCSHARED-006) and
    // useMemoryOperatorSnapshot (MCSHARED-009): the refresh-bus path here is
    // the SAME load() whose sequence-guarded `finally` clears `loading`, so the
    // last-started load always clears the flag even when it bumps
    // `loadSequenceRef` past a still-inflight initial load.
    const stalledInitial = deferred<ReturnType<typeof recents>>();
    apiMocks.fetchCrossProjectRecentSessions.mockReturnValueOnce(stalledInitial.promise);

    await act(async () => {
      renderer = create(
        <Harness
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await flush();
    expect(latest?.loading).toBe(true);
    expect(latest?.items).toEqual([]);

    const refreshCallback = vi.mocked(useRefreshSubscription).mock.calls.at(-1)?.[1];
    expect(refreshCallback).toBeDefined();
    await act(async () => {
      await refreshCallback?.({
        topic: "projects",
        reason: "fallback_poll",
        source: "test",
        eventType: "fallback_poll",
        timestamp: Date.now(),
      });
    });
    await flush();

    // The refresh load superseded the initial load and committed: loading must
    // be cleared by the refresh load's own guarded finally.
    expect(latest?.loading).toBe(false);
    expect(latest?.error).toBeNull();
    expect(latest?.items.map((item) => item.sessionId)).toEqual(["session-refresh"]);

    // The superseded initial load settling later must stay a no-op.
    await act(async () => {
      stalledInitial.resolve(recents([session("session-initial", "2026-04-22T00:00:00.000Z")]));
      await Promise.resolve();
    });
    expect(latest?.loading).toBe(false);
    expect(latest?.items.map((item) => item.sessionId)).toEqual(["session-refresh"]);
  });
});
