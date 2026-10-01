// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetFormDirtyRegistryForTests, getDirtySectionKeys, useFormDirty } from "../../../features/native-routes/library/use-form-dirty";
import { CitadelGovernanceLink } from "./CitadelGovernanceLink";

const open = vi.hoisted(() => vi.fn<typeof import("../../../shell-preference").switchShell>());
vi.mock("../../../shell-preference", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shell-preference")>()),
  switchShell: open,
}));
vi.mock("../../ui/Dialog", () => ({ Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
let view: ReactTestRenderer | undefined;
const discard = vi.fn(), save = vi.fn();
function Harness({ scope = "one", dirty = false }: { scope?: string; dirty?: boolean }) {
  useFormDirty("citadel:two:edit", dirty, { label: "Citadel metadata", keepDraft: true, onDiscard: discard, onSave: save });
  return <CitadelGovernanceLink activeCitadelId={scope} />;
}
async function render(scope = "one", dirty = false) {
  await act(async () => { const tree = <StrictMode><Harness scope={scope} dirty={dirty} /></StrictMode>; if (view) view.update(tree); else view = create(tree); });
}
const link = () => view!.root.findByType("a");
const button = (label: string) => {
  const found = view!.root.findAllByType("button").find(node => node.children.join("") === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};
async function clickLink(extra = {}) {
  const event = { defaultPrevented: false, button: 0, preventDefault: vi.fn(), ...extra };
  await act(async () => link().props.onClick(event)); return event;
}
async function click(label: string) { await act(async () => button(label).props.onClick()); }
beforeEach(() => {
  vi.clearAllMocks();
  __resetFormDirtyRegistryForTests();
  window.history.replaceState(null, "", "/settings/citadel?shell=cockpit");
  open.mockResolvedValue("cancelled");
  save.mockResolvedValue(false);
});
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; __resetFormDirtyRegistryForTests(); });

describe("native Citadel governance handoff", () => {
  it("opens the existing owner through the same-document transition", async () => {
    await render(); const event = await clickLink();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith("classic", expect.objectContaining({
      href: "/library/citadel-overview?shell=classic",
      isCurrent: expect.any(Function),
      signal: expect.any(AbortSignal),
    }));
    expect(open.mock.calls[0]![1].isCurrent()).toBe(true);
  });
  it("keeps normal modified-click link behavior", async () => {
    await render(); const event = await clickLink({ ctrlKey: true });
    expect(link().props.href).toBe("/library/citadel-overview?shell=classic"); expect(event.preventDefault).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("waits for a draft decision and cancellation preserves the dirty editor", async () => {
    await render("one", true); await clickLink(); expect(open).not.toHaveBeenCalled();
    await click("Cancel"); expect(getDirtySectionKeys()).toContain("citadel:two:edit"); expect(discard).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    await clickLink(); await click("Keep draft and close"); expect(open).toHaveBeenCalledOnce(); expect(discard).not.toHaveBeenCalled(); expect(getDirtySectionKeys()).toContain("citadel:two:edit");
  });
  it("requires the shared save owner to confirm before leaving", async () => {
    await render("one", true); await clickLink(); await click("Save and continue");
    expect(save).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled(); expect(getDirtySectionKeys()).toContain("citadel:two:edit");
    await click("Discard changes"); expect(discard).toHaveBeenCalledOnce(); expect(open).toHaveBeenCalledOnce(); expect(getDirtySectionKeys()).not.toContain("citadel:two:edit");
  });
  it("rejects a deferred draft decision after the active scope changes away and back", async () => {
    await render("one", true);
    await clickLink();
    expect(view!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    const staleKeep = button("Keep draft and close").props.onClick;
    const staleDiscard = button("Discard changes").props.onClick;
    await render("two", true);
    await render("one", true);
    expect(view!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    await act(async () => { staleKeep(); staleDiscard(); });
    expect(open).not.toHaveBeenCalled(); expect(discard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(getDirtySectionKeys()).toContain("citadel:two:edit");
  });
  it("admits one pending import and cancels it when its initiating view unmounts", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof open>>) => void;
    open.mockImplementation(() => new Promise(done => { resolve = done; }));
    await render(); await clickLink(); await clickLink(); expect(open).toHaveBeenCalledOnce();
    const options = open.mock.calls[0]![1]; expect(options.isCurrent()).toBe(true);
    await act(async () => view!.unmount()); view = undefined;
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(true); expect(options.isCurrent()).toBe(false);
    await act(async () => resolve("cancelled"));
  });
  it("reports a failed import locally and allows a new attempt", async () => {
    open.mockRejectedValueOnce(new Error("Chunk unavailable")); await render(); await clickLink();
    expect(view!.root.findByProps({ role: "alert" }).children.join("")).toContain("drafts are still available");
    await clickLink(); expect(open).toHaveBeenCalledTimes(2);
  });
});
