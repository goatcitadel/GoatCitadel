// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VirtuosoMockContext } from "react-virtuoso";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WindowedRecordList, type WindowedRecordListHandle } from "./WindowedRecordList";
let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const rows = Array.from({ length: 150 }, (_, i) => ({ id: "row-" + i, title: "Record " + i }));
it("keeps 100 rows as a semantic list and windows 101+ without discarding records", async () => {
  const handle = createRef<WindowedRecordListHandle>();
  async function render(count: number) { await act(async () => root.render(<VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
    <WindowedRecordList items={rows.slice(0, count)} itemKey={(row) => row.id} label="Records" listRef={handle}>
      {(row) => <button type="button">{row.title}</button>}
    </WindowedRecordList></VirtuosoMockContext.Provider>)); }
  await render(100); expect(host.querySelector("ul")?.children).toHaveLength(100);
  await render(150);
  await act(async () => { await import("react-virtuoso"); });
  expect(host.querySelector('ul')?.getAttribute("aria-label")).toBe("Records");
  expect(host.querySelectorAll("[data-record-key]").length).toBeLessThan(100);
  expect(host.querySelector('li')?.getAttribute("aria-setsize")).toBe("150");
  const scroller = host.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
  Object.defineProperties(scroller, { offsetHeight: { value: 300 }, scrollHeight: { value: 6000 } });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
  vi.spyOn(scroller, "scrollTo").mockImplementation((options) => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0; scroller.dispatchEvent(new Event("scroll")); });
  await act(async () => { handle.current!.focusRecord("row-149"); });
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Record 149"));
  expect(document.activeElement?.closest('li')?.getAttribute("aria-posinset")).toBe("150");
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Record 0"));
});
it("keeps editing keys in their input and moves record focus only through explicit list navigation", async () => {
  await act(async () => root.render(<WindowedRecordList items={rows.slice(0, 2)} itemKey={(row) => row.id} label="Editable records">
    {(row) => <><button type="button">{row.title}</button><input aria-label={row.title + " input"} /></>}
  </WindowedRecordList>));
  const input = host.querySelector("input")!; input.focus();
  await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement).toBe(input);
  const first = host.querySelector("button")!; first.focus();
  await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(document.activeElement?.textContent).toBe("Record 1");
});

it.each([0, 1, 99, 100])("keeps %s records semantic, bounded and keyboard navigable without a virtual scroller", async (count) => {
  const handle = createRef<WindowedRecordListHandle>();
  await act(async () => root.render(<WindowedRecordList items={rows.slice(0, count)} itemKey={row => row.id} label="Short records" bounded className="h-full min-h-0" listRef={handle}>
    {row => <button type="button" aria-current={row.id === "row-0" ? "page" : undefined}>{row.title}</button>}
  </WindowedRecordList>));
  expect(host.querySelector("ul")?.children).toHaveLength(count);
  expect(host.querySelector('[data-virtuoso-scroller]')).toBeNull();
  expect(host.firstElementChild?.className).toContain("h-full min-h-0 overflow-y-auto");
  if (!count) return;
  const first = host.querySelector("button")!; first.focus();
  expect(first.getAttribute("aria-current")).toBe("page");
  await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  expect(document.activeElement?.textContent).toBe("Record " + (count - 1));
  expect(document.activeElement?.closest("li")?.getAttribute("aria-setsize")).toBe(String(count));
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  expect(document.activeElement?.textContent).toBe("Record 0");
});
it("windows 1000 records and preserves exact selected-record focus through Home, End and Arrow navigation", async () => {
  const large = Array.from({ length: 1000 }, (_, i) => ({ id: "large-" + i, title: "Large record " + i }));
  const handle = createRef<WindowedRecordListHandle>();
  await act(async () => root.render(<VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
    <WindowedRecordList items={large} itemKey={row => row.id} label="Large records" bounded listRef={handle}>
      {row => <button type="button" aria-current={row.id === "large-999" ? "page" : undefined}>{row.title}</button>}
    </WindowedRecordList>
  </VirtuosoMockContext.Provider>));
  await act(async () => { await import("react-virtuoso"); });
  expect(host.querySelectorAll("[data-record-key]").length).toBeLessThan(100);
  expect(host.querySelector("li")?.getAttribute("aria-setsize")).toBe("1000");
  const scroller = host.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
  Object.defineProperties(scroller, { offsetHeight: { value: 300 }, scrollHeight: { value: 40000 } });
  vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
  vi.spyOn(scroller, "scrollTo").mockImplementation(options => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0; scroller.dispatchEvent(new Event("scroll")); });
  await act(async () => { handle.current!.focusRecord("large-999"); });
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Large record 999"));
  expect(document.activeElement?.getAttribute("aria-current")).toBe("page");
  expect(document.activeElement?.closest("li")?.getAttribute("aria-posinset")).toBe("1000");
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Large record 998"));
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })); });
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Large record 0"));
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Large record 999"));
});
it("retains semantic row identity, focused selection and scroll position through canonical short-list refresh", async () => {
  const handle = createRef<WindowedRecordListHandle>(), selected = rows.slice(0, 100);
  const render = () => root.render(<WindowedRecordList items={selected.map(row => ({ ...row }))} itemKey={row => row.id} label="Selected records" bounded listRef={handle}>
    {row => <button type="button" aria-current={row.id === "row-80" ? "page" : undefined}>{row.title}</button>}
  </WindowedRecordList>);
  await act(async () => render());
  const scroller = host.firstElementChild as HTMLElement;
  const selectedButton = host.querySelector<HTMLButtonElement>('[aria-current="page"]')!;
  const reveal = vi.spyOn(selectedButton, "scrollIntoView");
  await act(async () => { handle.current!.focusRecord("row-80"); });
  expect(reveal).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" });
  scroller.scrollTop = 220;
  await act(async () => render());
  expect(host.querySelector('[aria-current="page"]')).toBe(selectedButton);
  expect(document.activeElement).toBe(selectedButton); expect(scroller.scrollTop).toBe(220);
});

async function renderMeasuredFocusFixture() {
  const items = Array.from({ length: 1000 }, (_, i) => ({ id: "measured-" + i, title: "Measured record " + i }));
  const handle = createRef<WindowedRecordListHandle>();
  let currentItems = items, controlVersion = 0, showControl = true, controlLabel = "Measured record 999", owner = "workspace-a";
  const render = () => root.render(<VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 40 }}>
    <WindowedRecordList items={currentItems} itemKey={row => row.id} label="Measured focus records" scopeKey={owner} bounded listRef={handle}>
      {row => <>{showControl || row.id !== "measured-999" ? <button key={controlVersion} type="button" aria-label={row.id === "measured-999" ? controlLabel : row.title}>{row.title}</button> : null}<input aria-label={row.title + " details"} /></>}
    </WindowedRecordList>
  </VirtuosoMockContext.Provider>);
  await act(async () => render());
  await act(async () => { await import("react-virtuoso"); });
  const preparedScrollers = new WeakSet<HTMLElement>();
  const prepareScroller = () => {
    const scroller = host.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')!;
    expect(scroller).not.toBeNull();
    if (!preparedScrollers.has(scroller)) {
      Object.defineProperties(scroller, { offsetHeight: { value: 300 }, scrollHeight: { value: 40000 } });
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({ height: 300 } as DOMRect);
      vi.spyOn(scroller, "scrollTo").mockImplementation(options => { scroller.scrollTop = (options as ScrollToOptions).top ?? 0; scroller.dispatchEvent(new Event("scroll")); });
      preparedScrollers.add(scroller);
    }
    return scroller;
  };
  const scroller = prepareScroller();
  await act(async () => { handle.current!.focusRecord("measured-999"); });
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Measured record 999"));
  const focused = document.activeElement as HTMLButtonElement;
  const update = async (options: { visible?: boolean; replacement?: boolean; label?: string; removeRecord?: boolean; owner?: string } = {}) => {
    if (options.owner !== undefined) owner = options.owner;
    if (options.visible !== undefined) showControl = options.visible;
    if (options.replacement) controlVersion++;
    if (options.label !== undefined) controlLabel = options.label;
    if (options.removeRecord) currentItems = items.slice(0, -1);
    await act(async () => render());
    // Scope changes mount a new SDK scroller; give that DOM owner the same
    // deterministic geometry/scroll-event model as the original viewport.
    if (options.owner !== undefined) await vi.waitFor(() => prepareScroller());
  };
  return { items, handle, focused, scroller, update };
}
it("restores the same explicit current-owner record control after measured DOM replacement", async () => {
  const { focused, scroller, update } = await renderMeasuredFocusFixture();
  const top = scroller.scrollTop;
  await update({ visible: false });
  expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
  await update({ visible: true, replacement: true });
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Measured record 999"));
  expect(document.activeElement).not.toBe(focused);
  expect(document.activeElement?.closest("li")?.getAttribute("aria-posinset")).toBe("1000");
  expect(document.activeElement?.closest("li")?.getAttribute("aria-setsize")).toBe("1000");
  expect(scroller.scrollTop).toBe(top);
});
it("does not steal focus back from an outside control after a measured record replacement", async () => {
  const { focused, update } = await renderMeasuredFocusFixture();
  const outside = document.createElement("button"); outside.textContent = "Outside action"; document.body.append(outside);
  try {
    await act(async () => outside.focus());
    await update({ visible: false }); await update({ visible: true, replacement: true });
    expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(outside);
  } finally { outside.remove(); }
});
it("does not redirect another control in the same record after DOM replacement", async () => {
  const { focused, update } = await renderMeasuredFocusFixture();
  const input = focused.closest('[data-record-key]')!.querySelector("input")!;
  await act(async () => input.focus());
  await update({ visible: false }); await update({ visible: true, replacement: true });
  expect(document.activeElement).toBe(input); expect(input.value).toBe("");
});
it.each(["pointerdown", "wheel", "click", "keydown"])("cancels DOM-removal recovery for a real %s operator gesture", async type => {
  const { focused, scroller, update } = await renderMeasuredFocusFixture();
  await act(async () => scroller.dispatchEvent(type === "keydown" ? new KeyboardEvent(type, { key: "Tab", bubbles: true }) : new Event(type, { bubbles: true })));
  await update({ visible: false }); await update({ visible: true, replacement: true });
  expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
});
it("does not restore a different action matched by the previous generic selector", async () => {
  const { focused, update } = await renderMeasuredFocusFixture();
  await update({ visible: false }); await update({ visible: true, replacement: true, label: "Different record action" });
  expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
});
it("cancels focus recovery when the canonical requested record is removed", async () => {
  const { focused, update } = await renderMeasuredFocusFixture();
  await update({ removeRecord: true });
  expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
  expect(host.querySelector('[data-record-key="measured-999"]')).toBeNull();
});

it("recovers exact record focus after a real virtual range removes and reintroduces its DOM row", async () => {
  const { focused, scroller } = await renderMeasuredFocusFixture();
  const end = scroller.scrollTop;
  await act(async () => scroller.scrollTo({ top: 0, behavior: "auto" }));
  await vi.waitFor(() => expect(host.querySelector('[data-record-key="measured-999"]')).toBeNull());
  expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
  await act(async () => scroller.scrollTo({ top: end, behavior: "auto" }));
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Measured record 999"));
  expect(document.activeElement).not.toBe(focused);
  expect(document.activeElement?.closest("li")?.getAttribute("aria-posinset")).toBe("1000");
  expect(host.querySelectorAll("[data-record-key]").length).toBeLessThan(100);
});
it("rejects removed-control recovery and retained handles after the record owner leaves and returns", async () => {
  const { handle, focused, update } = await renderMeasuredFocusFixture(), retainedHandle = handle.current!;
  await update({ visible: false });
  await update({ owner: "workspace-b" }); await update({ owner: "workspace-a" });
  await update({ visible: true, replacement: true });
  await act(async () => retainedHandle.focusRecord("measured-0"));
  expect(focused.isConnected).toBe(false); expect(document.activeElement).toBe(document.body);
  await act(async () => handle.current!.focusRecord("measured-999"));
  await vi.waitFor(() => expect(document.activeElement?.getAttribute("aria-label")).toBe("Measured record 999"));
});

it("preserves operator focus that moves before a queued explicit record request commits", async () => {
  const { handle } = await renderMeasuredFocusFixture();
  const first = document.createElement("button"), next = document.createElement("button");
  first.textContent = "First outside action"; next.textContent = "Chosen outside action"; document.body.append(first, next);
  try {
    await act(async () => first.focus());
    await act(async () => { handle.current!.focusRecord("measured-0"); next.focus(); });
    expect(document.activeElement).toBe(next);
  } finally { first.remove(); next.remove(); }
});
