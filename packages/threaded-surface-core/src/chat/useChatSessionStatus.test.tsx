import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStatus } from "./useChatSessionStatus";
const api = vi.hoisted(() => ({
  fetchChatSessionStatus: vi.fn(),
  stopChatFanout: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let current: ReturnType<typeof useChatSessionStatus>;
let renderer: ReactTestRenderer;
const notice = vi.fn();
function Harness({ sessionId = "one" }: { sessionId?: string }) {
  current = useChatSessionStatus({
    sessionId,
    workspaceId: "workspace",
    enabled: true,
    pushLocalNotice: notice,
  });
  return null;
}
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const status = (sessionId = "one") => ({
  sessionId,
  workspaceId: "workspace",
  generatedAt: "2026-09-12T12:00:00Z",
});
beforeEach(async () => {
  vi.clearAllMocks();
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});
describe("session status request ownership", () => {
  it.each(["success", "error"])(
    "keeps dismissal after a late %s",
    async (outcome) => {
      const read = pending<unknown>();
      api.fetchChatSessionStatus.mockReturnValueOnce(read.promise);
      let work!: Promise<void>;
      await act(async () => {
        work = current.refresh();
      });
      expect(current.panel.open).toBe(true);
      await act(async () => current.close());
      await act(async () => {
        if (outcome === "success") read.resolve(status());
        else read.reject(new Error("offline"));
        await work;
      });
      expect(current.panel.open).toBe(false);
      expect(current.panel.loading).toBe(false);
    },
  );
  it("ignores old reads after switching away and back to the same session", async () => {
    const read = pending<unknown>();
    api.fetchChatSessionStatus.mockReturnValueOnce(read.promise);
    let work!: Promise<void>;
    await act(async () => {
      work = current.refresh();
    });
    await act(async () => renderer.update(<Harness sessionId="two" />));
    await act(async () => renderer.update(<Harness />));
    await act(async () => {
      read.resolve(status());
      await work;
    });
    expect(current.panel.status).toBeNull();
    expect(current.panel.open).toBe(false);
  });
  it("uses only the newest read and rejects mismatched canonical scope", async () => {
    const old = pending<unknown>();
    api.fetchChatSessionStatus
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(status("wrong"));
    let work!: Promise<void>;
    await act(async () => {
      work = current.refresh();
    });
    await act(async () => current.refresh());
    expect(current.panel.error).toContain("different Chat scope");
    await act(async () => {
      old.resolve(status());
      await work;
    });
    expect(current.panel.status).toBeNull();
  });
  it("keeps stop requests single, preserves dismissal, and reports unavailable settlement", async () => {
    const stop = pending<unknown>();
    api.stopChatFanout.mockReturnValueOnce(stop.promise);
    api.fetchChatSessionStatus.mockRejectedValueOnce(new Error("offline"));
    let work!: Promise<void>;
    await act(async () => {
      work = current.stopFanout("fanout");
      void current.stopFanout("fanout");
      current.close();
    });
    await act(async () => {
      stop.resolve({ invocationId: "fanout", status: "cancelled" });
      await work;
    });
    expect(api.stopChatFanout).toHaveBeenCalledTimes(1);
    expect(current.panel.open).toBe(false);
    expect(current.panel.error).toContain(
      "canonical status could not be refreshed",
    );
  });
  it("never carries an old stop notice or error into another session", async () => {
    const stop = pending<unknown>();
    api.stopChatFanout.mockReturnValueOnce(stop.promise);
    let work!: Promise<void>;
    await act(async () => {
      work = current.stopFanout("fanout");
    });
    await act(async () => renderer.update(<Harness sessionId="two" />));
    await act(async () => {
      stop.resolve({ invocationId: "fanout", status: "cancelled" });
      await work;
    });
    expect(notice).not.toHaveBeenCalled();
    expect(current.panel).toMatchObject({
      open: false,
      error: null,
      status: null,
      loading: false,
    });
  });
  it("does not call a mismatched stop acknowledgement success", async () => {
    api.stopChatFanout.mockResolvedValueOnce({
      invocationId: "other",
      status: "cancelled",
    });
    await act(async () => current.stopFanout("fanout"));
    expect(notice).not.toHaveBeenCalled();
    expect(current.panel.error).toContain("did not confirm");
  });
});
