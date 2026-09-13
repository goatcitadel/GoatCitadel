import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GCModal } from "./GCModal";

vi.mock("./dialog", () => ({
  Dialog: (props: any) => <section>{props.children}</section>,
  DialogContent: (props: any) => <article {...props} />,
  DialogHeader: (props: any) => <header>{props.children}</header>,
  DialogTitle: (props: any) => <h2>{props.children}</h2>,
  DialogDescription: (props: any) => <p>{props.children}</p>,
  DialogFooter: (props: any) => <footer>{props.children}</footer>,
}));
vi.mock("./button", () => ({ Button: (props: any) => <button {...props} /> }));
afterEach(() => vi.unstubAllGlobals());

describe("GCModal focus return", () => {
  it.each([true, false])("returns focus only to a connected opener (connected=%s)", (connected) => {
    class Element { isConnected = connected; focus = vi.fn(); }
    const opener = new Element();
    const doc = { activeElement: opener, body: new Element() };
    vi.stubGlobal("HTMLElement", Element);
    vi.stubGlobal("document", doc);
    const renderer = create(<GCModal open title="Review" onOpenChange={vi.fn()} />);
    const content = renderer.root.findByType("article");
    act(() => content.props.onOpenAutoFocus());
    doc.activeElement = new Element();
    const event = { preventDefault: vi.fn() };
    act(() => content.props.onCloseAutoFocus(event));
    expect(opener.focus).toHaveBeenCalledTimes(connected ? 1 : 0);
    expect(event.preventDefault).toHaveBeenCalledTimes(connected ? 1 : 0);
    if (connected) expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    renderer.unmount();
  });
});
