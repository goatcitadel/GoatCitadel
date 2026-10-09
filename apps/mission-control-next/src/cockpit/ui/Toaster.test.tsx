// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { toast } from "sonner";
import { CockpitToaster } from "./Toaster";
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({useUiPreferences: () => ({theme:"dark"})}));
it("expands retained notification actions and promotes queued notifications after dismissal", async () => {
  const host=document.createElement("div");document.body.append(host);const root=createRoot(host);const open=vi.fn();
  try {
    await act(async()=>root.render(<CockpitToaster/>));
    await act(async()=> {for(let i=0;i<5;i++) toast("Owned notification "+i,{id:"owned-"+i,duration:Infinity,action:{label:"Open Inbox item",onClick:open}});await new Promise(resolve=>setTimeout(resolve,30));});
    const cards=[...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')];
    expect(cards).toHaveLength(5);
    expect(cards.filter(card=>card.dataset.visible==='true')).toHaveLength(3);
    expect(cards.every(card=>card.dataset.expanded==='true')).toBe(true);
    const front=cards.find(card=>card.dataset.front==='true')!;
    await act(async()=>front.querySelector<HTMLButtonElement>('[data-action]')!.click());
    expect(open).toHaveBeenCalledTimes(1);
    await act(async()=> {await new Promise(resolve=>setTimeout(resolve,250));});
    expect(document.querySelectorAll('[data-sonner-toast][data-visible="true"]')).toHaveLength(3);
    expect([...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')].every(card=>card.dataset.expanded==='true')).toBe(true);
  } finally {await act(async()=>{toast.dismiss();root.unmount();});host.remove();}
});
