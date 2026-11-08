// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let TimerPanel: typeof import("./DeferredChatLeaves").DeferredChatTimerPanel;
const load = vi.hoisted(() => vi.fn<() => Promise<void>>());

let root: Root;
let host: HTMLDivElement;
const onClose = vi.fn();
const onCreate = vi.fn();
const panel: ComponentProps<typeof TimerPanel>["panel"] = {
  open: false,
  busy: false,
  error: null,
  dueAt: "",
  timezone: "UTC",
  message: "",
  notificationRuleId: "",
  cancelOnNextReply: false,
  rules: [],
  timers: [],
  onDueAtChange: vi.fn(),
  onTimezoneChange: vi.fn(),
  onMessageChange: vi.fn(),
  onNotificationRuleChange: vi.fn(),
  onCancelOnNextReplyChange: vi.fn(),
  onCancelTimer: vi.fn(),
  onClose,
  onCreate,
};

beforeEach(async () => {
  vi.resetModules();
  load.mockReset();
  vi.doMock("../../../features/threaded-surface/ChatTimerPanel", async () => {
    await load();
    return { ChatTimerPanel: () => <p>Ready timer controls</p> };
  });
  onClose.mockClear();
  onCreate.mockClear();
  TimerPanel = (await import("./DeferredChatLeaves")).DeferredChatTimerPanel;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.doUnmock("../../../features/threaded-surface/ChatTimerPanel");
});

const render = (open: boolean) => act(async () => root.render(<TimerPanel panel={{ ...panel, open }} />));
const close = () => document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
const settleImports = () => act(async () => { await vi.dynamicImportSettled(); });

it("keeps the timer code cold when closed and honors dismissal during loading", async () => {
  let release!: () => void;
  load.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  await render(false);
  await settleImports();
  expect(load).not.toHaveBeenCalled();

  await render(true);
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Loading timer controls");
  await act(async () => close().click());
  expect(onClose).toHaveBeenCalledOnce();
  await render(false);
  release();
  await settleImports();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toBe("");
  expect(onCreate).not.toHaveBeenCalled();

  await render(true);
  expect(host.textContent).toContain("Ready timer controls");
  expect(load).toHaveBeenCalledOnce();
});

it("keeps import failures local and allows the timer to close without dispatching", async () => {
  load.mockRejectedValueOnce(new Error("private fixture failure"));
  await render(true);
  await settleImports();
  const alert = document.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("The timer could not load");
  expect(alert?.textContent).not.toContain("private fixture failure");
  await act(async () => close().click());
  expect(onClose).toHaveBeenCalledOnce();
  expect(onCreate).not.toHaveBeenCalled();
});
