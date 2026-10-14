// @vitest-environment happy-dom
import { StrictMode, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetFormDirtyRegistryForTests,
  getDirtySectionKeys,
  useFormDirty,
} from "../../../features/native-routes/library/use-form-dirty";
import { CitadelGovernanceLink } from "./CitadelGovernanceLink";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";

const open = vi.hoisted(() => vi.fn<typeof import("../../app/cockpit-history").commitCockpitNavigation>());
vi.mock("../../app/cockpit-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/cockpit-history")>()),
  commitCockpitNavigation: open,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "one", activeWorkspaceId: "workspace" }),
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));
let view: ReactTestRenderer | undefined;
const discard = vi.fn(),
  save = vi.fn();
function Harness({ scope = "one", dirty = false }: { scope?: string; dirty?: boolean }) {
  useFormDirty("citadel:two:edit", dirty, {
    label: "Citadel metadata",
    keepDraft: true,
    onDiscard: discard,
    onSave: save,
  });
  return <CitadelGovernanceLink activeCitadelId={scope} />;
}
async function render(scope = "one", dirty = false) {
  await act(async () => {
    const tree = (
      <StrictMode>
        <CockpitNavigationProvider>
          <Harness scope={scope} dirty={dirty} />
        </CockpitNavigationProvider>
      </StrictMode>
    );
    if (view) view.update(tree);
    else view = create(tree);
  });
}
const link = () => view!.root.findByType("a");
const button = (label: string) => {
  const found = view!.root.findAllByType("button").find((node) => node.children.join("") === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};
async function clickLink(extra = {}) {
  const event = { defaultPrevented: false, button: 0, preventDefault: vi.fn(), ...extra };
  await act(async () => link().props.onClick(event));
  return event;
}
async function click(label: string) {
  await act(async () => button(label).props.onClick());
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetFormDirtyRegistryForTests();
  window.history.replaceState(
    { retained: true },
    "",
    "/settings/citadel?keep=yes&citadelId=stale&workspaceId=stale&sessionId=carried&shell=cockpit#source",
  );
  open.mockReturnValue(true);
  save.mockResolvedValue(false);
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
  __resetFormDirtyRegistryForTests();
});

describe("native Citadel governance handoff", () => {
  it("opens the existing owner through the same-document transition", async () => {
    await render();
    const event = await clickLink();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledExactlyOnceWith(link().props.href);
    const target = new URL(link().props.href, window.location.origin);
    expect(target.pathname).toBe("/library/citadel-overview");
    expect(target.searchParams.get("citadelId")).toBe("one");
    expect(target.searchParams.get("workspaceId")).toBe("workspace");
    expect(target.searchParams.get("sessionId")).toBe("carried");
    expect(target.searchParams.get("keep")).toBe("yes");
    expect(target.searchParams.get("shell")).toBe("cockpit");
    expect(target.searchParams.has("shellScope")).toBe(false);
    expect(target.hash).toBe("#source");
    expect(window.history.state.retained).toBe(true);
  });
  it("keeps normal modified-click link behavior", async () => {
    await render();
    const event = await clickLink({ ctrlKey: true });
    expect(new URL(link().props.href, window.location.origin).searchParams.get("shell")).toBe("cockpit");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
  it("waits for a draft decision and cancellation preserves the dirty editor", async () => {
    await render("one", true);
    await clickLink();
    expect(open).not.toHaveBeenCalled();
    await click("Cancel");
    expect(getDirtySectionKeys()).toContain("citadel:two:edit");
    expect(discard).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await clickLink();
    await click("Keep draft and close");
    expect(open).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
    expect(getDirtySectionKeys()).toContain("citadel:two:edit");
  });
  it("requires the shared save owner to confirm before leaving", async () => {
    await render("one", true);
    await clickLink();
    await click("Save and continue");
    expect(save).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(getDirtySectionKeys()).toContain("citadel:two:edit");
    await click("Discard changes");
    expect(discard).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();
    expect(getDirtySectionKeys()).not.toContain("citadel:two:edit");
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
    await act(async () => {
      staleKeep();
      staleDiscard();
    });
    expect(open).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(getDirtySectionKeys()).toContain("citadel:two:edit");
  });
  it("holds one native draft review and rejects retained controls after its initiating view unmounts", async () => {
    await render("one", true);
    await clickLink();
    await clickLink();
    expect(view!.root.findAllByProps({ role: "dialog" })).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
    const staleKeep = button("Keep draft and close").props.onClick,
      staleDiscard = button("Discard changes").props.onClick;
    expect(getDirtySectionKeys()).toContain("citadel:two:edit");
    await act(async () => view!.unmount());
    view = undefined;
    await act(async () => {
      staleKeep();
      staleDiscard();
    });
    expect(open).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/settings/citadel");
  });
  it("reports a rejected native commit locally and permits a fresh current request", async () => {
    open.mockImplementationOnce(() => {
      throw new Error("Transition unavailable");
    });
    await render();
    await clickLink();
    expect(view!.root.findByProps({ role: "alert" }).children.join("")).toContain("drafts are still available");
    await clickLink();
    expect(open).toHaveBeenCalledTimes(2);
  });
});
