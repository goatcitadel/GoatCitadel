// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const load = vi.hoisted(() => ({ started: vi.fn<() => Promise<void>>() }));
const route=vi.hoisted(()=>({pathname:'/chat',search:'?sessionId=a',hash:'',area:'chat',navigate:vi.fn()}));
vi.mock('@tanstack/react-query',()=>({useQuery:()=>({data:{items:[]}})}));
vi.mock('@goatcitadel/mission-control-shared/state/ui-preferences',()=>({useUiPreferences:()=>({activeCitadelId:'personal',activeWorkspaceId:'default',themePreference:'light',setTheme:vi.fn()})}));
vi.mock('./use-cockpit-route',()=>({useCockpitRoute:()=>route}));
vi.mock('./use-cockpit-preload',()=>({useCockpitPreload:()=>vi.fn()}));
vi.mock('./use-cockpit-shell-switch',()=>({useCockpitShellSwitch:()=>({request:vi.fn(),feedback:null})}));
vi.mock('./use-health-digest',()=>({useHealthDigestStatus:()=>({tone:'done',phase:'ready',label:'Healthy'})}));
vi.mock('../data/use-operator-inbox',()=>({useOperatorInbox:()=>({data:undefined,isError:false})}));
vi.mock('./ScopeSwitcher',()=>({ScopeSwitcher:()=>null}));
vi.mock('./WorkRunningIndicator',()=>({WorkRunningIndicator:()=>null}));
vi.mock('../ui/Menu',()=>({Menu:({children}:{children:ReactNode})=><>{children}</>,MenuTrigger:({children}:{children:ReactNode})=><button type="button">{children}</button>,MenuContent:()=>null,MenuItem:()=>null}));
let root:Root,host:HTMLDivElement, Sidebar:typeof import('./Sidebar').Sidebar;
let pendingImport: Promise<typeof import("./CollapsedStreamIndicator")> | undefined;
vi.mock("./load-collapsed-stream-indicator", () => ({
  importCollapsedStreamIndicator() {
    pendingImport = load.started().then(() => import("./CollapsedStreamIndicator"));
    return pendingImport;
  },
}));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
beforeEach(async()=>{
 vi.resetModules();load.started.mockReset().mockResolvedValue(undefined);pendingImport=undefined;route.pathname='/chat';
 Sidebar=(await import('./Sidebar')).Sidebar;host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();});
async function render(collapsed:boolean){await act(async()=>root.render(<><button type="button" id="outside">Outside</button><Sidebar onOpenPalette={vi.fn()} streamState="open" replayRecovery collapsed={collapsed}/></>));}
const indicator=()=>host.querySelector<HTMLElement>('[role="img"][aria-label="Updates connected · Catching up"]')!;
it('does not request the leaf for the default expanded rail',async()=>{await render(false);expect(load.started).not.toHaveBeenCalled();expect(host.textContent).toContain('Updates connected · Catching up');});
it.each(['owned','moved','expanded','navigated'])('keeps fallback name, focusability and focus custody when %s',async mode=>{
 const held=gate();load.started.mockImplementationOnce(()=>held.promise);await render(true);
 expect(load.started).toHaveBeenCalledOnce();
 const fallback=indicator();expect(fallback).not.toBeNull();expect(fallback.tabIndex).toBe(0);expect(fallback.className).toContain('inline-flex');
 fallback.focus();if(mode==='moved')host.querySelector<HTMLButtonElement>('#outside')!.focus();
 if(mode==='expanded')await render(false);
 if(mode==='navigated'){route.pathname='/library';await render(true);}
 const focus = document.activeElement;
 await act(async () => {
   held.resolve();
   await pendingImport;
 });
 if (mode === "expanded") {
   expect(indicator()).toBeNull();
 } else {
   expect(indicator()?.hasAttribute("data-state")).toBe(true);
   expect(document.activeElement).toBe(mode === "owned" ? indicator() : focus);
 }
});

it('keeps the real leaf labelled, focusable, and backed by the existing Tooltip', async () => {
 const {CollapsedStreamIndicator}=await vi.importActual<typeof import('./CollapsedStreamIndicator')>('./CollapsedStreamIndicator');
 await act(async()=>root.render(<CollapsedStreamIndicator label="Updates connected · Catching up"><svg aria-hidden="true" className="size-4" /></CollapsedStreamIndicator>));
 const trigger=indicator();
 expect(trigger.tagName).toBe('SPAN');
 expect(trigger.tabIndex).toBe(0);
 expect(trigger.className).toBe('inline-flex rounded-sm');
 expect(trigger.getAttribute('data-state')).toBe('closed');
 expect(trigger.querySelector('svg')?.getAttribute('class')).toBe('size-4');
});
