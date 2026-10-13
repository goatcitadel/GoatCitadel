import { afterEach, expect, it, vi } from "vitest";
import { beginStartupReadWindow, fetchStartupRead, type StartupReadScope } from "./startup-reads";
const scope: StartupReadScope = { installation: "http://gateway.example", accessRevision: 7, caller: "operator-a", callerRevision: 4 };
const init = (signal?: AbortSignal): RequestInit => ({ method: "GET", headers: { Authorization: "Bearer fixture-operator", "x-goatcitadel-correlation-id": "read-one", "x-goatcitadel-origin-surface": "chat" }, ...(signal ? {signal} : {}) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {"content-type":"application/json"} });
const result = (value: unknown, status=200) => ({status, bodyText: JSON.stringify(value), headers: {"content-type":"application/json"}});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("uses one GET for parallel authorized startup reads and preserves independent responses", async () => {
 const fetch = vi.fn().mockResolvedValue(json({items:[result({revision:2}), result({error:"Missing"},404)]})); vi.stubGlobal("fetch",fetch); beginStartupReadWindow(scope);
 const one=fetchStartupRead(scope.installation+"/api/v1/settings",init(),scope,()=>true); const two=fetchStartupRead(scope.installation+"/api/v1/approvals/missing",init(),scope,()=>true);
 const responses=await Promise.all([one,two]); expect(fetch).toHaveBeenCalledOnce(); expect(fetch.mock.calls[0][1].method).toBe("GET"); const request = new URL(fetch.mock.calls[0][0]); expect(request.pathname).toBe("/api/v1/startup-reads"); expect(request.search).not.toContain("fixture-operator"); expect(responses.map(r=>r.status)).toEqual([200,404]); expect(await responses[0]!.json()).toEqual({revision:2}); expect(await responses[1]!.json()).toEqual({error:"Missing"});
});
it.each([404,405])("falls back to original GET routes only when the older runtime lacks the transport (%s)", async status => {
 const fetch=vi.fn().mockResolvedValueOnce(json({error:"missing route"},status)).mockResolvedValue(json({ok:true}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 await Promise.all(["settings","agents"].map(path=>fetchStartupRead(scope.installation+"/api/v1/"+path,init(),scope,()=>true)));expect(fetch).toHaveBeenCalledTimes(3);expect(fetch.mock.calls.slice(1).map(call=>new URL(call[0]).pathname)).toEqual(["/api/v1/settings","/api/v1/agents"]);
});
it.each([401,403])("does not retry original routes after an authorization rejection (%s)", async status => {
 const fetch=vi.fn().mockResolvedValue(json({error:"Access denied"},status));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 const responses=await Promise.all(["settings","agents"].map(path=>fetchStartupRead(scope.installation+"/api/v1/"+path,init(),scope,()=>true)));expect(fetch).toHaveBeenCalledOnce();expect(responses.map(r=>r.status)).toEqual([status,status]);
});
it("fences changed caller custody before any queued dispatch", async () => {
 const fetch=vi.fn();vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);let current=true;
 const pending=fetchStartupRead(scope.installation+"/api/v1/settings",init(),scope,()=>current);const rejected=expect(pending).rejects.toMatchObject({name:"AbortError"});current=false;await rejected;expect(fetch).not.toHaveBeenCalled();
});
it("cancels one queued reader without cancelling another reader", async () => {
 const fetch=vi.fn().mockResolvedValue(json({ok:true}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);const controller=new AbortController();
 const cancelled=fetchStartupRead(scope.installation+"/api/v1/settings",init(controller.signal),scope,()=>true);const rejected=expect(cancelled).rejects.toMatchObject({name:"AbortError"});const kept=fetchStartupRead(scope.installation+"/api/v1/agents",init(),scope,()=>true);controller.abort();await rejected;expect(await(await kept).json()).toEqual({ok:true});expect(fetch).toHaveBeenCalledOnce();expect(new URL(fetch.mock.calls[0][0]).pathname).toBe("/api/v1/agents");
});
it("separates authority generations and sends mutations outside aggregation", async () => {
 const fetch=vi.fn().mockResolvedValue(json({ok:true}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 await Promise.all([fetchStartupRead(scope.installation+"/api/v1/settings",init(),{...scope,callerRevision:5},()=>true),fetchStartupRead(scope.installation+"/api/v1/settings",{...init(),method:"POST",body:"{}"},scope,()=>true)]);expect(fetch).toHaveBeenCalledTimes(2);expect(fetch.mock.calls.every(call=>!new URL(call[0]).pathname.includes("startup-reads"))).toBe(true);
});
it("rejects malformed envelopes and secret-bearing response headers", async () => {
 const fetch=vi.fn().mockResolvedValue(json({items:[{...result({}),headers:{"set-cookie":"private"}},result({})]}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 const results=await Promise.allSettled(["settings","agents"].map(path=>fetchStartupRead(scope.installation+"/api/v1/"+path,init(),scope,()=>true)));expect(results.every(value=>value.status==="rejected" && value.reason.kind==="protocol")).toBe(true);expect(fetch).toHaveBeenCalledOnce();
});

it("keeps no-content results and separately retrieves an oversized canonical response", async () => {
 const fetch=vi.fn().mockResolvedValueOnce(json({items:[{status:204,bodyText:"",headers:{}},{status:409,bodyText:"",headers:{},directReadRequired:true}]})).mockResolvedValueOnce(json({large:"complete"}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 const values=await Promise.all(["settings","agents"].map(path=>fetchStartupRead(scope.installation+"/api/v1/"+path,init(),scope,()=>true)));expect(values[0]!.status).toBe(204);expect(await values[0]!.text()).toBe("");expect(await values[1]!.json()).toEqual({large:"complete"});expect(fetch).toHaveBeenCalledTimes(2);
});
it("evicts all read results after settlement and expires the startup window", async () => {
 vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });const fetch=vi.fn().mockImplementation(async () => json({items:[result({}),result({})]}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 const read=()=>Promise.all(["settings","agents"].map(path=>fetchStartupRead(scope.installation+"/api/v1/"+path,init(),scope,()=>true)));await read();await read();expect(fetch).toHaveBeenCalledTimes(2);
 vi.advanceTimersByTime(10001);fetch.mockImplementation(async () => json({plain:true}));await read();expect(fetch).toHaveBeenCalledTimes(4);expect(fetch.mock.calls.slice(2).every(call=>!new URL(call[0]).pathname.includes("startup-reads"))).toBe(true);
});

it("preserves canonical activity, expiry and surface query parameters within one read packet", async () => {
 const fetch=vi.fn().mockResolvedValue(json({items:[result({}),result({}),result({})]}));vi.stubGlobal("fetch",fetch);beginStartupReadWindow(scope);
 const paths=["/api/v1/chat/sessions?workspaceId=w1&includeActivity=true", "/api/v1/capabilities/autonomy-grants?includeExpired=false", "/api/v1/agentic/runs?surface=chat&workspaceId=w1"];
 await Promise.all(paths.map(path=>fetchStartupRead(scope.installation+path,init(),scope,()=>true)));expect(fetch).toHaveBeenCalledOnce();const request=new URL(fetch.mock.calls[0][0]);expect(JSON.parse(request.searchParams.get("reads")!).map((row:{path:string})=>row.path)).toEqual(paths);
});
