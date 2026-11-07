// @vitest-environment happy-dom
import { act,type ReactNode } from "react";
import { createRoot,type Root } from "react-dom/client";
import { beforeAll,beforeEach,afterEach,expect,it,vi } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname,resolve } from "node:path";
import type { ToolGrantRecord } from "@goatcitadel/contracts";
import { ToolGrantDetails } from "./ToolGrantDetails";
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const preferences=vi.hoisted(()=>({showTechnicalDetails:false,activeWorkspaceId:"workspace-owned",activeCitadelId:"personal"}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences",()=>({useUiPreferences:()=>preferences}));
vi.mock("../../data/use-workspace-name",()=>({useWorkspaceNameLookup:()=>()=>"Fixture workspace"}));
vi.mock("../../ui/Dialog",()=>({Dialog:({open,title,children}:{open:boolean;title:string;children:ReactNode})=>open?<section role="dialog" aria-label={title}>{children}</section>:null}));
const grant:ToolGrantRecord={grantId:"grant-owned",scope:"workspace",scopeRef:"workspace-owned",decision:"deny",toolPattern:"verification.tool",grantType:"ttl",createdBy:"fixture",createdAt:"2026-11-01T00:00:00.000Z"};
let root:Root,host:HTMLDivElement;
let inspect:((dialog:ReturnType<typeof bridge>,receipt:ToolGrantRecord,owner:{items:ToolGrantRecord[]})=>Promise<void>)|undefined;
beforeAll(()=>{
 let directory=process.cwd();let file:string|undefined;
 while(!file){const candidate=resolve(directory,"scripts/verification/lib/scenarios/cockpit-tool-grants-proof.mjs");if(existsSync(candidate)){file=candidate;break;}const parent=dirname(directory);if(parent===directory)throw new Error("Actual tool grants collector missing");directory=parent;}
 inspect=createRequire(file)(file).inspectRecordedToolGrantIdentity;
});
beforeEach(()=>{preferences.showTechnicalDetails=false;host=document.createElement("div");document.body.append(host);root=createRoot(host);vi.stubGlobal("fetch",vi.fn(async()=>{throw new Error("Unexpected owner request during read-only disclosure");}));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
async function render(){await act(async()=>root.render(<ToolGrantDetails grant={grant} onClose={()=>undefined} />));}
type DisclosureBridge={
 filter(options:{hasText:RegExp}):DisclosureBridge;count():Promise<number>;getAttribute(name:string):Promise<string|null>;
 locator(selector:string):DisclosureBridge;textContent():Promise<string|null>;click():Promise<void>;evaluate<T>(fn:(element:Element)=>T):Promise<T>;
};
function bridge(){
 const locate=(read:()=>Element[]):DisclosureBridge=>({
  filter({hasText}:{hasText:RegExp}){expect(hasText.test("Grant identity")).toBe(true);expect(hasText.test("Foreign Grant identity")).toBe(false);return locate(()=>read().filter(element=>hasText.test(element.textContent??"")));},
  async count(){return read().length;},
  async getAttribute(name:string){const nodes=read();if(nodes.length!==1)throw new Error("Ambiguous real disclosure");return nodes[0]!.getAttribute(name);},
  locator(selector:string){expect(selector).toBe("..");return locate(()=>read().map(element=>element.parentElement!).filter(Boolean));},
  async textContent(){return read()[0]?.textContent??null;},
  async click(){expect(read()).toHaveLength(1);await act(async()=>(read()[0] as HTMLElement).click());},
  async evaluate<T>(fn:(element:Element)=>T){expect(read()).toHaveLength(1);return fn(read()[0]!);},
 });
 return {locator(selector:string){expect(selector).toBe("details > summary");return locate(()=>[...host.querySelectorAll(selector)]);},getByText(){throw new Error("Outer-dialog rooted has locator is not a relative descendant contract");}};
}
function implementation(){if(typeof inspect!=="function")throw new Error("Actual recorded grant identity helper missing");return inspect;}
it("keeps identity absent with preference off and natively collapsed after explicit technical preference",async()=>{
 await render();expect(host.querySelector("details")).toBeNull();expect(host.textContent).not.toContain(grant.grantId);
 preferences.showTechnicalDetails=true;await render();const disclosure=host.querySelector("details")!;expect(disclosure.open).toBe(false);
 await act(async()=>disclosure.querySelector("summary")!.click());expect(disclosure.open).toBe(true);
 expect(disclosure.textContent).toContain(grant.grantId);expect(disclosure.textContent).toContain(grant.scopeRef);expect(fetch).not.toHaveBeenCalled();
});
it("actual helper reads exact dt/dd receipt identity from the real disclosed component without mutation",async()=>{
 preferences.showTechnicalDetails=true;await render();await implementation()(bridge(),grant,{items:[grant]});expect(host.querySelector("details")?.open).toBe(true);expect(fetch).not.toHaveBeenCalled();
});
it.each(["grant","scope"])("actual helper rejects the real component's %s substitution",async(field)=>{
 preferences.showTechnicalDetails=true;await render();const expected={...grant,...(field==="grant"?{grantId:"foreign-grant"}:{scopeRef:"foreign-workspace"})};
 await expect(implementation()(bridge(),expected,{items:[expected]})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
});
