// @vitest-environment happy-dom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationPresenceLease } from "./useNotificationPresenceLease";

const mocks = vi.hoisted(() => ({ upsert: vi.fn(async (input) => input) }));

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  upsertNotificationPresence: mocks.upsert,
}));

function Harness({ workspaceId, sessionId }: { workspaceId: string; sessionId?: string }) {
  useNotificationPresenceLease(workspaceId, sessionId);
  return null;
}

describe("useNotificationPresenceLease", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    mocks.upsert.mockClear();
    window.sessionStorage.clear();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.restoreAllMocks();
  });

  it("publishes focused/visible leases and explicitly releases presence on cleanup", async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { workspaceId: "workspace-1", sessionId: "session-1" }));
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-1",
        sessionId: "session-1",
        focused: true,
        visible: true,
        ttlMs: 90_000,
      }),
    );
    act(() => renderer?.unmount());
    await Promise.resolve();
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1", focused: false, visible: false }),
    );
    renderer = undefined;
  });
  it("survives denied session storage and retires scopes while renewing focus and visibility", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => { throw new Error("denied"); });
    await act(async () => { renderer = create(createElement(Harness, {workspaceId: "one", sessionId: "s1"})); });
    const first = mocks.upsert.mock.calls.at(-1)![0];
    await act(async () => { vi.advanceTimersByTime(45_000); });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => { window.dispatchEvent(new Event("blur")); });
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.objectContaining({focused: false}));
    Object.defineProperty(document, "visibilityState", {configurable: true, value: "hidden"});
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.objectContaining({visible: false}));
    await act(async () => { renderer!.update(createElement(Harness, {workspaceId: "two", sessionId: "s2"})); });
    expect(mocks.upsert.mock.calls.at(-2)![0]).toMatchObject({workspaceId: "one", focused: false, visible: false});
    expect(mocks.upsert.mock.calls.at(-1)![0]).toMatchObject({workspaceId: "two", sessionId: "s2"});
    expect(mocks.upsert.mock.calls.at(-1)![0].leaseId).not.toBe(first.leaseId);
    await act(async () => { renderer!.update(createElement(Harness, {workspaceId: ""})); });
    const count = mocks.upsert.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(90_000); window.dispatchEvent(new Event("focus")); });
    expect(mocks.upsert).toHaveBeenCalledTimes(count);
  });

});
