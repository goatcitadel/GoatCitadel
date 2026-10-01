import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopNotifications } from "./use-desktop-notifications";

let current: ReturnType<typeof useDesktopNotifications>, renderer: ReactTestRenderer;
let permission: NotificationPermission;
const requestPermission = vi.fn(), notify = vi.fn(function Notification() {});
function Harness() { current = useDesktopNotifications(); return null; }
const events = new EventTarget();
beforeEach(() => {
  vi.resetAllMocks(); permission = "default";
  Object.defineProperty(notify, "permission", { configurable: true, get: () => permission });
  Object.assign(notify, { requestPermission });
  vi.stubGlobal("window", { Notification: notify, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) });
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => { if (renderer) await act(async () => renderer.unmount()); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { renderer = create(<Harness />); }); }

describe("shared desktop notification controls", () => {
  it("never requests permission or delivers a notification on mount", async () => {
    await mount(); expect(current.desktopPermission).toBe("default");
    expect(requestPermission).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
  });
  it("requests permission only once for an explicit concurrent click", async () => {
    let finish!: (value: NotificationPermission) => void;
    requestPermission.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); let request!: Promise<void>;
    await act(async () => { request = current.checkDesktopPermission(); void current.checkDesktopPermission(); });
    expect(requestPermission).toHaveBeenCalledOnce(); expect(current.checkingPermission).toBe(true);
    await act(async () => { permission = "granted"; finish(permission); await request; });
    expect(current.desktopPermission).toBe("granted"); expect(current.checkingPermission).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
  it("does not prompt again when the host already denied permission", async () => {
    permission = "denied"; await mount(); await act(async () => current.checkDesktopPermission());
    expect(requestPermission).not.toHaveBeenCalled(); expect(current.notificationFeedback).toContain("blocked");
  });
  it("reports an unsupported host without pretending the preference grants permission", async () => {
    delete (window as unknown as { Notification?: unknown }).Notification;
    await mount(); await act(async () => current.checkDesktopPermission());
    expect(current.desktopPermission).toBe("unsupported"); expect(current.notificationFeedback).toContain("unavailable");
  });
  it("rechecks host permission before an explicit test", async () => {
    permission = "granted"; await mount(); permission = "denied";
    await act(async () => current.sendTestNotification());
    expect(notify).not.toHaveBeenCalled(); expect(current.desktopPermission).toBe("denied");
  });
  it("requests an explicit test without claiming OS delivery", async () => {
    permission = "granted"; await mount(); await act(async () => current.sendTestNotification());
    expect(notify).toHaveBeenCalledOnce(); expect(current.notificationFeedback).toContain("requested");
  });
  it("refreshes permission when the host regains focus", async () => {
    await mount(); permission = "granted";
    await act(async () => { events.dispatchEvent(new Event("focus")); });
    expect(current.desktopPermission).toBe("granted"); expect(requestPermission).not.toHaveBeenCalled();
  });
  it("ignores an outstanding permission result after unmount", async () => {
    let finish!: (value: NotificationPermission) => void;
    requestPermission.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); let request!: Promise<void>;
    await act(async () => { request = current.checkDesktopPermission(); });
    await act(async () => renderer.unmount());
    await act(async () => { finish("granted"); await request; });
    expect(current.notificationFeedback).toBeNull(); expect(notify).not.toHaveBeenCalled();
  });
});
