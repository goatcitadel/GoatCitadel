import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteWorkerRegistryPage } from "@goatcitadel/contracts";
import { fetchRemoteWorkerRegistry } from "../api/remote-workers";
import { useRemoteWorkerRegistry } from "./useRemoteWorkerRegistry";
vi.mock("../api/remote-workers.js",()=>({fetchRemoteWorkerRegistry:vi.fn()}));
vi.mock("./useRefreshSubscription.js",()=>({useRefreshSubscription:vi.fn()}));
const fetchPage=vi.mocked(fetchRemoteWorkerRegistry);
let value:ReturnType<typeof useRemoteWorkerRegistry>, renderer:ReactTestRenderer;
function Harness({workspace="a"}:{workspace?:string}) { value=useRemoteWorkerRegistry(workspace); return null; }
function page(workspaceId:string,ids:string[],nextCursor?:string) { return {workspaceId,items:ids.map(workerId=>({workerId})),nextCursor,observedAt:"2026-09-12T12:00:00Z"} as RemoteWorkerRegistryPage; }
afterEach(async()=>{if(renderer)await act(async()=>renderer.unmount());fetchPage.mockReset();});
describe("worker registry continuation",()=>{
 it("loads the next cursor and refreshes all opened pages",async()=>{
  fetchPage.mockImplementation(async(scope,query)=>query?.cursor?page(scope,["b"]):page(scope,["a"],"next"));
  await act(async()=>{renderer=create(<Harness/>);});
  await act(async()=>value.loadMore());
  expect(value.page?.items.map(item=>item.workerId)).toEqual(["a","b"]);
  await act(async()=>value.reload());
  expect(value.page?.items.map(item=>item.workerId)).toEqual(["a","b"]);
  expect(fetchPage).toHaveBeenCalledTimes(4);
 });
 it("stops an older refresh from reading a third page after it is superseded", async () => {
  fetchPage
    .mockResolvedValueOnce(page("a", ["first"], "page-2"))
    .mockResolvedValueOnce(page("a", ["second"], "page-3"))
    .mockResolvedValueOnce(page("a", ["third"]));
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => value.loadMore());
  await act(async () => value.loadMore());

  fetchPage.mockClear();
  let finishPrevious!: (value: RemoteWorkerRegistryPage) => void;
  fetchPage
    .mockResolvedValueOnce(page("a", ["old first"], "old-page-2"))
    .mockImplementationOnce(() => new Promise((resolve) => { finishPrevious = resolve; }))
    .mockResolvedValueOnce(page("a", ["new first"], "new-page-2"))
    .mockResolvedValueOnce(page("a", ["new second"], "new-page-3"))
    .mockResolvedValueOnce(page("a", ["new third"]))
    .mockResolvedValueOnce(page("a", ["old third"]));

  let earlier!: Promise<void>;
  await act(async () => { earlier = value.reload(); });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  await act(async () => value.reload());
  await act(async () => {
    finishPrevious(page("a", ["old second"], "old-page-3"));
    await earlier;
  });

  expect(fetchPage.mock.calls.map(([, query]) => query?.cursor)).toEqual([
    undefined, "old-page-2", undefined, "new-page-2", "new-page-3",
  ]);
  expect(value.page?.items.map((item) => item.workerId)).toEqual(["new first", "new second", "new third"]);
 });
 it("retains loaded rows when continuation fails and ignores old workspace completion",async()=>{
  fetchPage.mockResolvedValueOnce(page("a",["a"],"next")).mockRejectedValueOnce(new Error("offline"));
  await act(async()=>{renderer=create(<Harness/>);});
  await act(async()=>value.loadMore());
  expect(value.page?.items[0]?.workerId).toBe("a"); expect(value.moreError).toContain("Additional workers are unavailable");
  let finish!:(value:RemoteWorkerRegistryPage)=>void;
  fetchPage.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValueOnce(page("b",["new"]));
  await act(async()=>{void value.loadMore();});
  await act(async()=>renderer.update(<Harness workspace="b"/>));
  await act(async()=>finish(page("a",["old"])));
  expect(value.page?.workspaceId).toBe("b"); expect(value.page?.items.map(item=>item.workerId)).toEqual(["new"]);
 });
});
