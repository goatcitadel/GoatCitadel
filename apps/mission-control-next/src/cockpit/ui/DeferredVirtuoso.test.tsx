// @vitest-environment happy-dom
import { act, createRef, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
let useDeferredVirtuoso: typeof import("./DeferredVirtuoso").useDeferredVirtuoso;
const loader = vi.hoisted(() => ({ load: vi.fn<() => Promise<void>>() }));
const access = vi.hoisted(() => ({ callerRevision: 1, accessRevision: 1, gateway: "http://gateway-a" }));
vi.mock("@goatcitadel/mission-control-shared/api/access-scope", () => ({ getGatewayCallerScopeRevision: () => access.callerRevision, getGatewayAccessRevision: () => access.accessRevision, subscribeGatewayCallerScope: () => () => {}, subscribeGatewayAccessChange: () => () => {} }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ getGatewayApiBaseUrl: () => access.gateway }));
function row(owner: string) { return <div data-record-key="record-0"><details aria-label="Record detail"><summary>Details</summary>{owner}</details><button type="button">{owner}</button></div>; }
function Viewport({ needed, owner }: { needed: boolean; owner: string }) {
  const host = useRef<HTMLDivElement>(null);
  const { Virtuoso, virtualized, failure, retry } = useDeferredVirtuoso({ needed, host, attribute: "data-record-key", keys: ["record-0"], scopeKey: owner });
  return <><button type="button" id="outside">Outside</button><div ref={host} key={owner}>
    {virtualized && Virtuoso ? <Virtuoso data={[owner]} itemContent={(_index, item) => row(item)} /> : row(owner)}
    {failure ? <><p role="alert">Unavailable</p><button type="button" onClick={retry}>Retry windowing</button></> : null}
  </div></>;
}
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  vi.resetModules(); loader.load.mockReset().mockResolvedValue(undefined); Object.assign(access, { callerRevision: 1, accessRevision: 1, gateway: "http://gateway-a" });
  vi.doMock("react-virtuoso", async () => { await loader.load(); return { Virtuoso: ({ data, itemContent }: { data: string[]; itemContent: (index: number, item: string) => React.ReactNode }) => <div data-optional-viewport>{data.map((item, index) => <div key={item}>{itemContent(index, item)}</div>)}</div> }; });
  useDeferredVirtuoso = (await import("./DeferredVirtuoso")).useDeferredVirtuoso;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
function deferLoad() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); loader.load.mockImplementationOnce(() => promise); return resolve; }
it("keeps short viewports independent of optional loading and carries disclosure focus in both transition directions", async () => {
  const render = (needed: boolean) => root.render(<Viewport needed={needed} owner="workspace-a:session-a" />);
  await act(async () => render(false)); expect(loader.load).not.toHaveBeenCalled();
  const disclosure = host.querySelector("details")!; disclosure.open = true; disclosure.querySelector("summary")!.focus();
  await act(async () => render(true)); await vi.waitFor(() => expect(host.querySelector("[data-optional-viewport]")).not.toBeNull());
  expect(host.querySelector("[data-optional-viewport]")).not.toBeNull();
  expect(host.querySelector("details")!.open).toBe(true); expect(document.activeElement).toBe(host.querySelector("summary"));
  await act(async () => render(false));
  expect(host.querySelector("[data-optional-viewport]")).toBeNull();
  expect(host.querySelector("details")!.open).toBe(true); expect(document.activeElement).toBe(host.querySelector("summary"));
});
it.each(["caller-return", "access", "gateway", "record-owner"])("does not carry old focus or disclosures after %s changes during optional loading", async change => {
  const resolve = deferLoad();
  await act(async () => root.render(<Viewport needed owner="workspace-a:session-a" />));
  host.querySelector("details")!.open = true; host.querySelector("summary")!.focus();
  if (change === "caller-return") access.callerRevision += 2;
  if (change === "access") access.accessRevision++;
  if (change === "gateway") access.gateway = "http://gateway-b";
  await act(async () => root.render(<Viewport needed owner={change === "record-owner" ? "workspace-b:session-b" : "workspace-a:session-a"} />));
  const outside = host.querySelector<HTMLButtonElement>("#outside")!; outside.focus();
  if (change !== "record-owner") host.querySelector("details")!.open = false;
  await act(async () => resolve()); await vi.waitFor(() => expect(host.querySelector("[data-optional-viewport]")).not.toBeNull());
  expect(document.activeElement).toBe(outside); expect(host.querySelector("details")!.open).toBe(false);
});
it("retains the bounded visible viewport on load failure and allows an explicit successful retry", async () => {
  loader.load.mockRejectedValueOnce(new Error("fixture missing chunk"));
  await act(async () => root.render(<Viewport needed owner="workspace-a:session-a" />));
  expect(host.querySelector("[role=alert]")?.textContent).toBe("Unavailable");
  expect(host.querySelector("details")?.textContent).toContain("workspace-a:session-a");
  vi.doMock("react-virtuoso", () => ({ Virtuoso: ({ data, itemContent }: { data: string[]; itemContent: (index: number, item: string) => React.ReactNode }) => <div data-optional-viewport>{data.map((item, index) => <div key={item}>{itemContent(index, item)}</div>)}</div> }));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Retry windowing")!.click());
  await vi.waitFor(() => expect(host.querySelector("[data-optional-viewport]")).not.toBeNull()); expect(host.querySelector("[role=alert]")).toBeNull();
});

it("rejects queued focus and retained handles from an owner that left and returned while virtualization loaded", async () => {
  const resolve = deferLoad();
  vi.doMock("react-virtuoso", async () => { await loader.load(); return { Virtuoso: ({ data, itemContent }: { data: { id: string }[]; itemContent: (index: number, item: { id: string }) => React.ReactNode }) => <div data-optional-viewport>{data.slice(0, 3).map((item, index) => <div key={item.id}>{itemContent(index, item)}</div>)}</div> }; });
  const { WindowedRecordList } = await import("./WindowedRecordList");
  const handle = createRef<import("./WindowedRecordList").WindowedRecordListHandle>();
  const records = Array.from({ length: 1000 }, (_, index) => ({ id: "same-" + index }));
  const render = (owner: string) => root.render(<><button type="button" id="scope-outside">Outside scope</button>
    <WindowedRecordList items={records} itemKey={item => item.id} label="Scoped records" scopeKey={owner} listRef={handle}>
      {item => <button type="button">{item.id}</button>}
    </WindowedRecordList></>);
  await act(async () => render("workspace-a"));
  const retainedHandle = handle.current!;
  await act(async () => retainedHandle.focusRecord("same-999"));
  await act(async () => render("workspace-b"));
  await act(async () => render("workspace-a"));
  const outside = host.querySelector<HTMLButtonElement>("#scope-outside")!; outside.focus();
  await act(async () => retainedHandle.focusRecord("same-0"));
  expect(document.activeElement).toBe(outside);
  await act(async () => resolve()); await vi.waitFor(() => expect(host.querySelector("[data-optional-viewport]")).not.toBeNull());
  expect(document.activeElement).toBe(outside);
  await act(async () => handle.current!.focusRecord("same-0"));
  expect(document.activeElement?.textContent).toBe("same-0");
});
