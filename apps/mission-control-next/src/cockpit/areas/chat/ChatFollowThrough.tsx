import type {FollowThroughAction,FollowThroughItem} from "@goatcitadel/contracts";
import {Button} from "../../ui/Button";
const labels:Record<FollowThroughItem["state"],string>={awaiting_review:"Your decision",upcoming:"Upcoming",quiet:"Quiet",waiting_on_you:"Waiting on you",running:"Running",completed:"Completed",failed:"Needs attention",unknown:"Outcome unknown",paused:"Paused",cancelled:"Cancelled"};
function when(value:string|undefined,zone:string){if(!value)return "Not scheduled";try{return new Date(value).toLocaleString(undefined,{timeZone:zone==="System timezone" ? undefined:zone,dateStyle:"medium",timeStyle:"short"});}catch{return "Time unavailable";}}
export function ChatFollowThrough({items,onAction,onOpenOwner,pending,error}:{items:FollowThroughItem[];onAction:(item:FollowThroughItem,action:FollowThroughAction)=>void|Promise<void>;onOpenOwner?:(href:string)=>void;pending?:boolean;error?:string}){
  function row(item:FollowThroughItem){return <li key={`${item.owner.kind}:${item.owner.ownerId}`} className="min-w-0 space-y-2 border-t border-line-subtle py-3 first:border-t-0">
    <p className="font-medium text-fg [overflow-wrap:anywhere]">{item.purpose} · {labels[item.state]}</p>
    <p>Next check: {when(item.nextCheckAt,item.timezone)} · {item.timezone}</p><p>Reports to: {item.delivery}</p>
    {item.lastOutcome ? <p>Last recorded outcome: {item.lastOutcome.replaceAll("_"," ")}</p>:null}
    {item.state==="unknown" ? <p role="status">No automatic resend. Inspect the recorded delivery before deciding what to do next.</p>:null}
    {item.reason ? <p>{item.reason}</p>:null}
    <div className="flex flex-wrap gap-2">{item.actions.map(action=><Button key={action.action} size="sm" disabled={pending} data-follow-through-action={`${item.owner.ownerId}:${action.action}`} onClick={()=>void onAction(item,action.action)}>{action.label}</Button>)}{onOpenOwner ? <Button size="sm" variant="secondary" onClick={()=>onOpenOwner(item.ownerHref)}>Open details</Button>:<a className="underline" href={item.ownerHref}>Open details</a>}</div>
    <details><summary className="cursor-pointer">Permissions and budget</summary><p>{item.permissionSummary}</p><p>{item.budgetSummary}</p></details>
  </li>;}
  const foreground=items.filter(item=>item.owner.kind==="schedule" || item.owner.kind==="commitment"),background=items.filter(item=>item.owner.kind==="heartbeat" || item.owner.kind==="proactive");
  return <section aria-label="Follow-through" className="min-w-0 space-y-2 text-sm text-fg-secondary">
    {error ? <p role="alert">{error}</p>:null}
    {foreground.length ? <ul className="min-w-0 list-none p-0">{foreground.map(row)}</ul>:<p>No accepted follow-ups or schedules are recorded for this conversation.</p>}
    {background.length ? <details><summary className="cursor-pointer font-medium">Background checks</summary><ul className="min-w-0 list-none p-0">{background.map(row)}</ul></details>:null}
  </section>;
}
