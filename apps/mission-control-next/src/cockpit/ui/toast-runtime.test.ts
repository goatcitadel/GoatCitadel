import { beforeEach, expect, it, vi } from "vitest";
import type { toast } from "sonner";
import { requestCockpitToast, attachCockpitToastHost, subscribeCockpitToastRuntime, cockpitToastRuntimeRequested, resetCockpitToastRuntimeForTests } from "./toast-runtime";
beforeEach(resetCockpitToastRuntimeForTests);
const runtime = () => vi.fn().mockReturnValue("fixture-toast") as unknown as typeof toast;
it("retains the first notification until the cold host is subscribed", () => {
  const loaded = vi.fn(), show = runtime(); const unsubscribe = subscribeCockpitToastRuntime(loaded);
  expect(cockpitToastRuntimeRequested()).toBe(false);
  requestCockpitToast(toast => toast("First notification"), () => true);
  expect(loaded).toHaveBeenCalledOnce(); expect(show).not.toHaveBeenCalled();
  const dispose = attachCockpitToastHost(show); expect(show).toHaveBeenCalledExactlyOnceWith("First notification");
  dispose(); unsubscribe();
});
it("rechecks scope and preference custody after the renderer loads", () => {
  let current = true; const show = runtime();
  requestCockpitToast(toast => toast("Old workspace"), () => current); current = false;
  const dispose = attachCockpitToastHost(show); expect(show).not.toHaveBeenCalled();
  requestCockpitToast(toast => toast("Current workspace"), () => true); expect(show).toHaveBeenCalledExactlyOnceWith("Current workspace");
  dispose();
});
it("does not let an older host cleanup retire a newer host", () => {
  const old = runtime(), current = runtime();const disposeOld = attachCockpitToastHost(old), disposeCurrent = attachCockpitToastHost(current);
  disposeOld(); requestCockpitToast(toast => toast("New host"), () => true);
  expect(old).not.toHaveBeenCalled();expect(current).toHaveBeenCalledExactlyOnceWith("New host");disposeCurrent();
});
it("does not load the renderer for an invalidated delivery", () => {
  requestCockpitToast(() => { throw new Error("Must not dispatch"); }, () => false);
  expect(cockpitToastRuntimeRequested()).toBe(false);
});
it("preserves later retained notifications if one delivery fails", () => {
  const show = runtime();requestCockpitToast(() => { throw new Error("Fixture delivery failed"); }, () => true);
  requestCockpitToast(toast => toast("Next item"), () => true);const dispose = attachCockpitToastHost(show);
  expect(show).toHaveBeenCalledExactlyOnceWith("Next item");dispose();
});
