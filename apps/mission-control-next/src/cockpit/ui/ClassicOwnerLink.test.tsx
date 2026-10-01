// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassicOwnerLink } from "./ClassicOwnerLink";
import { useSessionDraft, __resetSessionDraftsForTests } from "../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../features/native-routes/library/use-form-dirty";
import { Dialog } from "./Dialog";
import { SHELL_NAVIGATION_EVENTS } from "../../app/shell-transition";
const open = vi.hoisted(() => vi.fn());
vi.mock("../../shell-preference", () => ({ switchShell: open, writeShellPreference: vi.fn() }));
vi.mock("./Dialog", () => ({ Dialog: () => null }));
let renderer: ReactTestRenderer;
beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  window.history.replaceState(null, "", "/work?shell=cockpit");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  vi.clearAllMocks();
});
describe("explicit classic owner navigation", () => {
  it("keeps the Inbox shortcut on the real anchor and preserves modified clicks", async () => {
    open.mockResolvedValue("cancelled");
    await act(async () => {
      renderer = create(<ClassicOwnerLink href="/ops/approvals?approvalId=a%2Fb&shell=classic"
        scope="workspace-a:approval-a" label="Open in Approvals" inboxOwner />);
    });
    const link = renderer.root.findByType("a");
    expect(link.props.href).toBe("/ops/approvals?approvalId=a%2Fb&shell=classic");
    expect(link.props["data-inbox-owner"]).toBe("");
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const preventDefault = vi.fn();
      await act(async () => link.props.onClick({ button: 0, preventDefault, ...modifiers }));
      expect(preventDefault).not.toHaveBeenCalled();
    }
    expect(open).not.toHaveBeenCalled();
    await act(async () => link.props.onClick({ button: 0, preventDefault: vi.fn() }));
    expect(open).toHaveBeenCalledWith("classic", expect.objectContaining({ href: link.props.href, isCurrent: expect.any(Function), signal: expect.any(AbortSignal) }));
  });

  it("cancels a pending import when record scope leaves and returns", async () => {
    let resolve!: (value: string) => void;
    open.mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
    const view = (scope: string) => <ClassicOwnerLink href="/ops/runtime?shell=classic" scope={scope} label="Runtime" />;
    await act(async () => { renderer = create(view("workspace-a:run-a")); });
    await act(async () => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() }));
    const options = open.mock.calls[0]![1];
    await act(async () => { renderer.update(view("workspace-b:run-b")); });
    await act(async () => { renderer.update(view("workspace-a:run-a")); });
    expect(options.isCurrent()).toBe(false);
    expect(options.signal.aborted).toBe(true);
    await act(async () => resolve("cancelled"));
  });
  it("keeps card children and an explicit accessible link name, replacing children while opening", async () => {
    let resolve!: (value: string) => void;
    open.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      renderer = create(
        <ClassicOwnerLink
          href="/settings/runtime?shell=classic"
          scope="installation"
          label="Open runtime diagnostics"
          className="owner-card"
          openingLabel="Opening runtime diagnostics…"
        >
          <strong>Runtime</strong>
          <span>Inspect process evidence</span>
        </ClassicOwnerLink>,
      );
    });
    let link = renderer.root.findByType("a");
    expect(link.props.className).toBe("owner-card");
    expect(link.props["aria-label"]).toBe("Open runtime diagnostics");
    expect(link.findByType("strong").children).toEqual(["Runtime"]);
    await act(async () => link.props.onClick({ button: 0, preventDefault: vi.fn() }));
    link = renderer.root.findByType("a");
    expect(link.children).toEqual(["Opening runtime diagnostics…"]);
    expect(link.props["aria-label"]).toBe("Opening runtime diagnostics…");
    await act(async () => resolve("cancelled"));
  });
  it("cancels an import when its owner URL changes in the same scope", async () => {
    let resolve!: (value: string) => void;
    open.mockImplementation(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      renderer = create(
        <ClassicOwnerLink href="/settings/runtime?shell=classic" scope="installation" label="Runtime diagnostics" />,
      );
    });
    await act(async () => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() }));
    const options = open.mock.calls[0]![1];
    expect(options.isCurrent()).toBe(true);
    await act(async () =>
      renderer.update(
        <ClassicOwnerLink href="/settings/access?shell=classic" scope="installation" label="Access diagnostics" />,
      ),
    );
    expect(options.isCurrent()).toBe(false);
    expect(options.signal.aborted).toBe(true);
    await act(async () => resolve("cancelled"));
  });

  it.each(SHELL_NAVIGATION_EVENTS)("closes the exact pending draft review on %s and preserves the draft", async (event) => {
    let draft!: ReturnType<typeof useSessionDraft<{ name: string }>>;
    function View() {
      draft = useSessionDraft("classic-link-draft", { name: "Saved" }, 1, { label: "Owner draft" });
      return <ClassicOwnerLink href="/ops/approvals?approvalId=exact&shell=classic" scope="workspace-a" label="Approvals" />;
    }
    open.mockResolvedValue("cancelled");
    await act(async () => { renderer = create(<View />); });
    await act(async () => draft.setValue({ name: "Unsaved" }));
    await act(async () => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() }));
    expect(renderer.root.findByType(Dialog).props.open).toBe(true);
    const keep = renderer.root.findByType(Dialog).props.children[1].props.children[1].props.onClick;
    await act(async () => {
      window.history.replaceState(null, "", "/work?shell=cockpit#other");
      window.dispatchEvent(new Event(event));
      window.history.replaceState(null, "", "/work?shell=cockpit");
      window.dispatchEvent(new Event(event));
    });
    expect(renderer.root.findByType(Dialog).props.open).toBe(false);
    await act(async () => keep());
    expect(open).not.toHaveBeenCalled();
    expect(draft.value.name).toBe("Unsaved");
    expect(draft.isDirty).toBe(true);
  });

  it.each(["scope", "navigation"])("clears obsolete opening feedback on %s without admitting a duplicate import", async (change) => {
    let resolve!: (value: string) => void;
    open.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    open.mockResolvedValue("cancelled");
    const view = (scope: string) => <ClassicOwnerLink href="/settings/access?shell=classic" scope={scope} label="Access" />;
    await act(async () => { renderer = create(view("a")); });
    const click = () => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() });
    await act(async () => click());
    const options = open.mock.calls[0]![1];
    expect(renderer.root.findByType("a").props["aria-disabled"]).toBe(true);
    if (change === "scope") {
      await act(async () => renderer.update(view("b")));
      await act(async () => renderer.update(view("a")));
    } else await act(async () => { window.dispatchEvent(new Event("popstate")); });
    expect(options.isCurrent()).toBe(false);
    expect(options.signal.aborted).toBe(true);
    expect(renderer.root.findByType("a").props["aria-label"]).toBe("Access");
    expect(renderer.root.findByType("a").props["aria-disabled"]).toBeUndefined();
    await act(async () => click());
    expect(open).toHaveBeenCalledOnce();
    await act(async () => resolve("cancelled"));
    await act(async () => click());
    expect(open).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByType("a").props["aria-disabled"]).toBeUndefined();
  });

  it("clears prior failure feedback when scope leaves and returns", async () => {
    open.mockRejectedValueOnce(new Error("old view failed"));
    open.mockResolvedValue("cancelled");
    const view = (scope: string) => <ClassicOwnerLink href="/settings/access?shell=classic" scope={scope} label="Access" errorLabel="Access failed" />;
    await act(async () => { renderer = create(view("a")); });
    await act(async () => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() }));
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual(["Access failed"]);
    await act(async () => renderer.update(view("b")));
    await act(async () => renderer.update(view("a")));
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    await act(async () => renderer.root.findByType("a").props.onClick({ button: 0, preventDefault: vi.fn() }));
    expect(open).toHaveBeenCalledTimes(2);
  });
});
