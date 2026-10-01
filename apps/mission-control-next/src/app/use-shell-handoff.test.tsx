// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useShellHandoff } from "./use-shell-handoff";
import * as clientCore from "@goatcitadel/mission-control-shared/api/client-core";
import { useDraftLeaveDialogState } from "../features/native-routes/library/DraftLeaveDialog";
import {
  useSessionDraft,
  __resetSessionDraftsForTests,
  hasSessionDraft,
} from "../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests, getDirtySectionKeys, useFormDirty } from "../features/native-routes/library/use-form-dirty";
const switchShell = vi.hoisted(() => vi.fn());
vi.mock("../shell-preference", () => ({ switchShell, writeShellPreference: vi.fn() }));
let renderer: ReactTestRenderer | undefined,
  handoff: ReturnType<typeof useShellHandoff>,
  draft: ReturnType<typeof useSessionDraft<{ name: string }>>,
  dialog: ReturnType<typeof useDraftLeaveDialogState>;
let saveDrafts = false;
const saveA = vi.fn<() => Promise<boolean>>(), saveB = vi.fn<() => Promise<boolean>>();
const discardA = vi.fn(), discardB = vi.fn();
function Probe({ scope = "workspace-a" }: { scope?: string }) {
  handoff = useShellHandoff(scope);
  dialog = useDraftLeaveDialogState(handoff.dialogProps);
  draft = useSessionDraft("handoff-draft", { name: "Saved" }, 1, { label: "Editor" });
  useFormDirty("handoff-save-a", saveDrafts, { onSave: saveA, onDiscard: discardA, keepDraft: true });
  useFormDirty("handoff-save-b", saveDrafts, { onSave: saveB, onDiscard: discardB, keepDraft: true });
  return null;
}
async function mount() {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  saveDrafts = false;
  saveA.mockResolvedValue(true);
  saveB.mockResolvedValue(true);
  switchShell.mockResolvedValue("opened");
  window.history.replaceState(null, "", "/settings/general?shell=classic");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  __resetSessionDraftsForTests();
  vi.restoreAllMocks();
});
it("waits for a real draft-leave decision and keeps the retained draft on explicit continuation", async () => {
  await mount();
  await act(async () => draft.setValue({ name: "Unsaved" }));
  await act(async () => handoff.request("cockpit"));
  expect(handoff.dialogProps.open).toBe(true);
  expect(switchShell).not.toHaveBeenCalled();
  await act(async () => handoff.dialogProps.onCancel());
  expect(switchShell).not.toHaveBeenCalled();
  await act(async () => handoff.request("cockpit"));
  await act(async () => handoff.dialogProps.onContinue());
  expect(switchShell).toHaveBeenCalledOnce();
  expect(hasSessionDraft("handoff-draft")).toBe(true);
});
it.each(["scope", "navigation"])(
  "does not reopen an obsolete draft continuation after %s away/back",
  async (change) => {
    await mount();
    await act(async () => draft.setValue({ name: "Unsaved" }));
    await act(async () => handoff.request("cockpit"));
    if (change === "scope") {
      await act(async () =>
        renderer!.update(
          <StrictMode>
            <Probe scope="workspace-b" />
          </StrictMode>,
        ),
      );
      await act(async () =>
        renderer!.update(
          <StrictMode>
            <Probe />
          </StrictMode>,
        ),
      );
    } else {
      window.history.replaceState(null, "", "/settings/runtime");
      window.dispatchEvent(new Event("goatcitadel:classic-location"));
      window.history.replaceState(null, "", "/settings/general?shell=classic");
    }
    await act(async () => handoff.dialogProps.onContinue());
    expect(switchShell).not.toHaveBeenCalled();
    expect(hasSessionDraft("handoff-draft")).toBe(true);
  },
);
it("suppresses duplicate requests and aborts a late entry after unmount", async () => {
  let finish!: (value: string) => void;
  switchShell.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await act(async () => {
    handoff.request("classic", { sessionId: "thread-a" });
    handoff.request("classic");
  });
  expect(switchShell).toHaveBeenCalledOnce();
  const options = switchShell.mock.calls[0]![1];
  expect(options.sessionId).toBe("thread-a");
  expect(options.isCurrent()).toBe(true);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(options.isCurrent()).toBe(false);
  expect(options.signal.aborted).toBe(true);
  await act(async () => finish("cancelled"));
});

it("shares the leave lifetime guard for native navigation after unmount", async () => {
  const navigate = vi.fn();
  await mount();
  await act(async () => draft.setValue({ name: "Unsaved" }));
  await act(async () => handoff.requestNavigation("/inbox?shell=cockpit", navigate));
  const continuation = handoff.dialogProps.onContinue;
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => renderer!.unmount());
  renderer = undefined;
  await act(async () => continuation());
  expect(navigate).not.toHaveBeenCalled();
  expect(switchShell).not.toHaveBeenCalled();
});

it("shows a native navigation failure through the existing feedback", async () => {
  await mount();
  const navigate = vi.fn(() => { throw new Error("Synthetic history failure"); });
  await act(async () => handoff.requestNavigation("/inbox?shell=cockpit", navigate));
  expect(navigate).toHaveBeenCalledExactlyOnceWith("/inbox?shell=cockpit");
  expect(handoff.error).toBe("The view could not open. Your current drafts are still available.");
  expect(switchShell).not.toHaveBeenCalled();
});

it.each(["scope", "navigation", "installation", "unmount"])(
  "withholds captured draft save/discard/continue handlers after %s invalidates their review",
  async (change) => {
    const base = vi.spyOn(clientCore, "getGatewayApiBaseUrl").mockReturnValue("http://gateway-a");
    saveDrafts = true;
    await mount();
    await act(async () => handoff.request("classic"));
    const oldDialog = dialog, oldProps = handoff.dialogProps, oldNode = handoff.dialog;
    expect(oldProps.open).toBe(true);
    expect(oldNode.props.isCurrent).toBeTypeOf("function");
    const oldNodeIsCurrent = oldNode.props.isCurrent!;
    expect(oldNodeIsCurrent()).toBe(true);
    if (change === "scope") {
      await act(async () => renderer!.update(<StrictMode><Probe scope="workspace-b" /></StrictMode>));
      await act(async () => renderer!.update(<StrictMode><Probe /></StrictMode>));
    } else if (change === "navigation") {
      await act(async () => {
        window.history.replaceState(null, "", "/settings/general?shell=classic#other");
        window.dispatchEvent(new Event("hashchange"));
        window.history.replaceState(null, "", "/settings/general?shell=classic");
        window.dispatchEvent(new Event("popstate"));
      });
    } else if (change === "installation") base.mockReturnValue("http://gateway-b");
    else {
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
    expect(oldNodeIsCurrent()).toBe(false);
    await act(async () => {
      await oldDialog.saveAndContinue();
      oldDialog.discard();
      oldProps.onDiscard!();
      oldProps.onContinue();
      oldProps.onCancel();
    });
    expect(saveA).not.toHaveBeenCalled();
    expect(saveB).not.toHaveBeenCalled();
    expect(discardA).not.toHaveBeenCalled();
    expect(discardB).not.toHaveBeenCalled();
    expect(switchShell).not.toHaveBeenCalled();
    if (change !== "unmount") expect(getDirtySectionKeys()).toEqual(["handoff-save-a", "handoff-save-b"]);
    if (change === "scope" || change === "navigation") expect(handoff.dialogProps.open).toBe(false);
  },
);

it("does not let an old cancel or failed in-flight save alter a fresh review", async () => {
  let reject!: (error: Error) => void;
  saveDrafts = true;
  saveA.mockImplementationOnce(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
  await mount();
  await act(async () => handoff.request("classic"));
  const old = handoff.dialogProps;
  let saving!: Promise<void>;
  await act(async () => { saving = dialog.saveAndContinue(); });
  expect(saveA).toHaveBeenCalledOnce();
  await act(async () => {
    window.dispatchEvent(new Event("goatcitadel:cockpit-location"));
  });
  await act(async () => handoff.request("cockpit"));
  expect(handoff.dialogProps.open).toBe(true);
  await act(async () => {
    old.onCancel();
    reject(new Error("obsolete save failure"));
    await saving;
  });
  expect(handoff.dialogProps.open).toBe(true);
  expect(dialog.error).toBeNull();
  expect(saveB).not.toHaveBeenCalled();
  expect(switchShell).not.toHaveBeenCalled();
  await act(async () => dialog.saveAndContinue());
  expect(saveA).toHaveBeenCalledTimes(2);
  expect(saveB).toHaveBeenCalledOnce();
  expect(switchShell).toHaveBeenCalledExactlyOnceWith("cockpit", expect.any(Object));
});

it("stops between successful draft saves when the reviewed navigation is invalidated", async () => {
  let resolve!: (saved: boolean) => void;
  saveDrafts = true;
  saveA.mockImplementationOnce(() => new Promise<boolean>((done) => { resolve = done; }));
  await mount();
  await act(async () => handoff.request("classic"));
  let saving!: Promise<void>;
  await act(async () => { saving = dialog.saveAndContinue(); });
  await act(async () => { window.dispatchEvent(new Event("goatcitadel:classic-location")); });
  await act(async () => { resolve(true); await saving; });
  expect(saveA).toHaveBeenCalledOnce();
  expect(saveB).not.toHaveBeenCalled();
  expect(switchShell).not.toHaveBeenCalled();
  expect(handoff.dialogProps.open).toBe(false);
});


it.each(["installation", "scope", "navigation"])("rejects a retained transition request before admission after %s changes", async (change) => {
  const base = vi.spyOn(clientCore, "getGatewayApiBaseUrl").mockReturnValue("http://gateway-a");
  await mount();
  const retained = handoff.requestTransition, action = vi.fn();
  if (change === "installation") base.mockReturnValue("http://gateway-b");
  else if (change === "scope") {
    await act(async () => renderer!.update(<StrictMode><Probe scope="workspace-b" /></StrictMode>));
    await act(async () => renderer!.update(<StrictMode><Probe /></StrictMode>));
  } else {
    await act(async () => {
      window.history.replaceState(null, "", "/settings/runtime?shell=classic");
      window.dispatchEvent(new Event("goatcitadel:classic-location"));
      window.history.replaceState(null, "", "/settings/general?shell=classic");
      window.dispatchEvent(new Event("popstate"));
    });
  }
  await act(async () => retained(action));
  expect(action).not.toHaveBeenCalled();
  expect(switchShell).not.toHaveBeenCalled();
  expect(handoff.dialogProps.open).toBe(false);
});
