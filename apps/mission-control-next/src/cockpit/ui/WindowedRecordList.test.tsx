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
