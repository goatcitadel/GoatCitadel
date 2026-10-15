// @vitest-environment happy-dom
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setGatewayCallerScope,
  notifyGatewayAccessChanged,
} from "@goatcitadel/mission-control-shared/api/access-scope";
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
    mocks.upsert.mockReset();
    mocks.upsert.mockImplementation(async (input) => input);
    setGatewayCallerScope("presence-test-operator");
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
    vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
      throw new Error("denied");
    });
    await act(async () => {
      renderer = create(createElement(Harness, { workspaceId: "one", sessionId: "s1" }));
    });
    const first = mocks.upsert.mock.calls.at(-1)![0];
    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ focused: false }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));
    await act(async () => {
      renderer!.update(createElement(Harness, { workspaceId: "two", sessionId: "s2" }));
    });
    expect(mocks.upsert.mock.calls.at(-2)![0]).toMatchObject({ workspaceId: "one", focused: false, visible: false });
    expect(mocks.upsert.mock.calls.at(-1)![0]).toMatchObject({ workspaceId: "two", sessionId: "s2" });
    expect(mocks.upsert.mock.calls.at(-1)![0].leaseId).not.toBe(first.leaseId);
    await act(async () => {
      renderer!.update(createElement(Harness, { workspaceId: "" }));
    });
    const count = mocks.upsert.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(90_000);
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(count);
  });

  it("updates one mounted lease when a conversation is selected or cleared, without an away write", async () => {
    await act(async () => {
      renderer = create(createElement(Harness, { workspaceId: "one" }));
    });
    const first = mocks.upsert.mock.calls[0]![0];
    await act(async () => {
      renderer!.update(createElement(Harness, { workspaceId: "one", sessionId: "s1" }));
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.upsert.mock.calls[1]![0]).toMatchObject({
      leaseId: first.leaseId,
      sessionId: "s1",
      focused: true,
      visible: true,
    });
    await act(async () => {
      renderer!.update(createElement(Harness, { workspaceId: "one" }));
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.upsert.mock.calls[2]![0]).not.toHaveProperty("sessionId");
    expect(mocks.upsert.mock.calls.every(([input]) => input.focused && input.visible)).toBe(true);
  });

  it("serializes a slow initial lease write before adopting the selected conversation", async () => {
    let finish!: () => void;
    mocks.upsert.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          finish = () => resolve(input);
        }),
    );
    await act(async () => {
      renderer = create(createElement(Harness, { workspaceId: "one", sessionId: "old" }));
    });
    await act(async () => {
      renderer!.update(createElement(Harness, { workspaceId: "one", sessionId: "new" }));
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.upsert.mock.calls[1]![0]).toMatchObject({
      sessionId: "new",
      leaseId: mocks.upsert.mock.calls[0]![0].leaseId,
    });
  });

  it.each(["caller", "access"])(
    "starts a distinct lease after %s custody changes and never retires the old lease through new authority",
    async (change) => {
      await act(async () => {
        renderer = create(createElement(Harness, { workspaceId: "one", sessionId: "s1" }));
      });
      const original = mocks.upsert.mock.calls[0]![0];
      await act(async () => {
        if (change === "caller") setGatewayCallerScope("replacement-operator");
        else notifyGatewayAccessChanged();
      });
      expect(mocks.upsert).toHaveBeenCalledTimes(2);
      expect(mocks.upsert.mock.calls[1]![0]).toMatchObject({ workspaceId: "one", sessionId: "s1", focused: true });
      expect(mocks.upsert.mock.calls[1]![0].leaseId).not.toBe(original.leaseId);
    },
  );

  it("keeps the same serialized lease usable after a failed write and still releases it", async () => {
    mocks.upsert.mockRejectedValueOnce(new Error("Fixture presence unavailable"));
    await act(async () => {
      renderer = create(createElement(Harness, { workspaceId: "one", sessionId: "s1" }));
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const original = mocks.upsert.mock.calls[0]![0];
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.upsert.mock.calls[1]![0]).toMatchObject({
      leaseId: original.leaseId,
      workspaceId: "one",
      sessionId: "s1",
      focused: true,
      visible: true,
    });
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.upsert.mock.calls[2]![0]).toMatchObject({
      leaseId: original.leaseId,
      workspaceId: "one",
      focused: false,
      visible: false,
    });
  });
});
