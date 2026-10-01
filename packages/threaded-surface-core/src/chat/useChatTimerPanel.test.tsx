import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatTimerPanel } from "./useChatTimerPanel";

const api = vi.hoisted(() => ({
  fetchChatTimers: vi.fn(),
  fetchNotificationRules: vi.fn(),
  createChatTimer: vi.fn(),
  cancelChatTimer: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let current: ReturnType<typeof useChatTimerPanel>, renderer: ReactTestRenderer;
const notice = vi.fn();
function Harness({ sessionId = "one", workspaceId = "workspace", enabled = true } = {}) {
  current = useChatTimerPanel({
    selectedSessionId: sessionId,
    workspaceId,
    enabled,
    eventStreamState: "open",
    thread: null,
    pushLocalNotice: notice,
  });
  return null;
}
function pending<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const timer = (sessionId = "one", extra = {}) => ({
  timerId: "timer",
  sessionId,
  workspaceId: "workspace",
  revision: 1,
  dueAt: "2026-12-01T12:00:00.000Z",
  timezone: "UTC",
  message: "Reminder",
  cancelOnNextReply: false,
  status: "active",
  createdBy: "operator",
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  ...extra,
});
async function open() {
  await act(async () => current.openChatTimerPanel());
}
async function fill(message = "Reminder") {
  await act(async () => {
    current.chatTimerPanel!.onDueAtChange("2026-12-01T12:00");
    current.chatTimerPanel!.onTimezoneChange("UTC");
    current.chatTimerPanel!.onMessageChange(message);
  });
}
beforeEach(async () => {
  vi.resetAllMocks();
  api.fetchChatTimers.mockResolvedValue({ items: [] });
  api.fetchNotificationRules.mockResolvedValue({ items: [] });
  await act(async () => {
    renderer = create(<Harness />);
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});

describe("Chat timer async ownership", () => {
  it.each(["success", "error"])("ignores a late %s read after leaving and returning", async (outcome) => {
    const read = pending<unknown>();
    api.fetchChatTimers.mockReturnValue(read.promise);
    await open();
    await act(async () => renderer.update(<Harness sessionId="two" />));
    await act(async () => renderer.update(<Harness />));
    await act(async () => {
      if (outcome === "success") read.resolve({ items: [timer()] });
      else read.reject(new Error("old read"));
    });
    expect(current.chatTimerPanel!.timers).toEqual([]);
    expect(current.chatTimerPanel!.error).toBeNull();
    expect(current.chatTimerPanel!.open).toBe(false);
  });
  it("ignores a late read after the workspace changes", async () => {
    const read = pending<unknown>();
    api.fetchChatTimers.mockReturnValue(read.promise);
    await open();
    await act(async () => renderer.update(<Harness workspaceId="other" />));
    await act(async () => read.resolve({ items: [timer()] }));
    expect(current.chatTimerPanel!.timers).toEqual([]);
    expect(current.chatTimerPanel!.open).toBe(false);
  });
  it("rejects a foreign timer list before offering its actions", async () => {
    api.fetchChatTimers.mockResolvedValue({ items: [timer("foreign")] });
    await open();
    expect(current.chatTimerPanel!.timers).toEqual([]);
    expect(current.chatTimerPanel!.error).toContain("different Chat scope");
  });
  it.each(["success", "error"])("preserves the next conversation draft after a late create %s", async (outcome) => {
    const write = pending<unknown>();
    api.createChatTimer.mockReturnValue(write.promise);
    await open();
    await fill();
    await act(async () => current.chatTimerPanel!.onCreate());
    await act(async () => renderer.update(<Harness sessionId="two" />));
    await open();
    await fill("New conversation reminder");
    await act(async () => {
      if (outcome === "success") write.resolve({ item: timer() });
      else write.reject(new Error("old create"));
    });
    expect(current.chatTimerPanel!.open).toBe(true);
    expect(current.chatTimerPanel!.message).toBe("New conversation reminder");
    expect(current.chatTimerPanel!.busy).toBe(false);
    expect(current.chatTimerPanel!.error).toBeNull();
    expect(notice).not.toHaveBeenCalled();
  });
  it("does not dispatch a duplicate create before React publishes busy state", async () => {
    const write = pending<unknown>();
    api.createChatTimer.mockReturnValue(write.promise);
    await open();
    await fill();
    await act(async () => {
      current.chatTimerPanel!.onCreate();
      current.chatTimerPanel!.onCreate();
    });
    expect(api.createChatTimer).toHaveBeenCalledTimes(1);
    await act(async () => write.resolve({ item: timer() }));
    expect(current.chatTimerPanel!.open).toBe(false);
    expect(notice).toHaveBeenCalledOnce();
  });
  it("does not close a reopened editor from a dismissed create response", async () => {
    const write = pending<unknown>();
    api.createChatTimer.mockReturnValue(write.promise);
    await open();
    await fill();
    await act(async () => current.chatTimerPanel!.onCreate());
    await act(async () => current.chatTimerPanel!.onClose());
    await open();
    await fill("New draft");
    await act(async () => write.resolve({ item: timer() }));
    expect(current.chatTimerPanel!.open).toBe(true);
    expect(current.chatTimerPanel!.message).toBe("New draft");
    expect(notice).not.toHaveBeenCalled();
  });
  it("rejects a mismatched create receipt and preserves the draft", async () => {
    api.createChatTimer.mockResolvedValue({ item: timer("foreign") });
    await open();
    await fill();
    await act(async () => current.chatTimerPanel!.onCreate());
    expect(current.chatTimerPanel!.open).toBe(true);
    expect(current.chatTimerPanel!.message).toBe("Reminder");
    expect(current.chatTimerPanel!.error).toContain("different Chat scope");
    expect(notice).not.toHaveBeenCalled();
  });
  it("confirms the normalized content accepted by the Gateway", async () => {
    api.createChatTimer.mockResolvedValue({ item: timer() });
    await open();
    await fill("  Reminder  ");
    await act(async () => current.chatTimerPanel!.onTimezoneChange(" UTC "));
    await act(async () => current.chatTimerPanel!.onCreate());
    expect(api.createChatTimer).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ message: "Reminder", timezone: "UTC" }),
    );
    expect(notice).toHaveBeenCalledOnce();
  });
  it("cancels only the exact active revision and refreshes its recorded outcome", async () => {
    api.fetchChatTimers.mockResolvedValueOnce({ items: [timer()] });
    api.cancelChatTimer.mockResolvedValue({ item: timer("one", { revision: 2, status: "cancelled" }) });
    await open();
    api.fetchChatTimers.mockResolvedValue({ items: [timer("one", { revision: 2, status: "cancelled" })] });
    await act(async () => current.chatTimerPanel!.onCancelTimer("timer", 1));
    expect(api.cancelChatTimer).toHaveBeenCalledWith("one", "timer", 1);
    expect(current.chatTimerPanel!.timers[0]?.status).toBe("cancelled");
    expect(current.chatTimerPanel!.busy).toBe(false);
    expect(current.chatTimerPanel!.error).toBeNull();
  });
  it("withholds cancel for a timer outside the current owner list", async () => {
    await open();
    await act(async () => current.chatTimerPanel!.onCancelTimer("unknown", 1));
    expect(api.cancelChatTimer).not.toHaveBeenCalled();
  });
  it("does not refresh or change the next editor after a late cancellation", async () => {
    const write = pending<unknown>();
    api.cancelChatTimer.mockReturnValue(write.promise);
    api.fetchChatTimers.mockResolvedValueOnce({ items: [timer()] });
    await open();
    await act(async () => current.chatTimerPanel!.onCancelTimer("timer", 1));
    await act(async () => renderer.update(<Harness sessionId="two" />));
    await open();
    await fill("Next draft");
    const reads = api.fetchChatTimers.mock.calls.length;
    await act(async () => write.resolve({ item: timer("one", { revision: 2, status: "cancelled" }) }));
    expect(api.fetchChatTimers).toHaveBeenCalledTimes(reads);
    expect(current.chatTimerPanel!.message).toBe("Next draft");
    expect(current.chatTimerPanel!.error).toBeNull();
  });
});
