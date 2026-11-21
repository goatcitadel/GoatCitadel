import {useEffect,useRef,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import type {TraceMemoryCandidateRecord} from "@goatcitadel/contracts";
import {fetchTurnLearningReceipt} from "@goatcitadel/mission-control-shared/api/chat-learning";
import {fetchTraceMemoryCandidate,editTraceMemoryCandidate,promoteTraceMemoryCandidate,rejectTraceMemoryCandidate} from "@goatcitadel/mission-control-shared/api/memory";
import {getGatewayApiBaseUrl} from "@goatcitadel/mission-control-shared/api/client-core";
import {describeApiError} from "@goatcitadel/mission-control-shared/api/describe-api-error";
import {useUiPreferences} from "@goatcitadel/mission-control-shared/state/ui-preferences";
import {subscribeRefresh} from "@goatcitadel/mission-control-shared/state/refresh-bus";
import {Button} from "../../ui/Button";
import {ChatLearningReceipt} from "./ChatLearningReceipt";
import {useProjectAccess} from "../../../features/native-routes/projects/use-project-access";
type Props={sessionId:string;turnId:string;workspaceId:string;readOnly?:boolean};
export function ChatLearningReceiptControl(props:Props){
  const {activeWorkspaceId,activeCitadelId}=useUiPreferences();
  const access=useProjectAccess(props.workspaceId),identity=JSON.stringify([getGatewayApiBaseUrl(),access.identity,activeWorkspaceId,activeCitadelId,props.workspaceId,props.sessionId,props.turnId]);
  if(activeWorkspaceId && activeWorkspaceId!==props.workspaceId)return null;
  return <LearningForTurn key={identity} identity={identity} {...props}/>;
}
function LearningForTurn({sessionId,workspaceId,turnId,readOnly,identity}:Props&{identity:string}){
  const [open,setOpen]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState<string>();
  const query=useQuery({queryKey:["chat","learning-receipt",identity],queryFn:()=>fetchTurnLearningReceipt(sessionId,turnId,workspaceId),enabled:open,staleTime:0});
  const mounted=useRef(true),lock=useRef(false);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{if(!open)return;const unsub=(["memory","skills","system"] as const).map(topic=>subscribeRefresh(topic,()=>void query.refetch()));return()=>unsub.forEach(callback=>callback());},[open,query.refetch]);
  async function run(candidate:TraceMemoryCandidateRecord,action:"promote"|"reject"|"edit",content?:string){
    if(lock.current || readOnly || !candidate.reviewHash)return;lock.current=true;setPending(true);setError(undefined);
    try{
      const fresh=await fetchTraceMemoryCandidate(candidate.candidateId,{workspaceId});
      if(!mounted.current)return;
      if(fresh.workspaceId!==workspaceId || fresh.status!=="proposed" || fresh.reviewHash!==candidate.reviewHash)throw new Error("The lesson changed after review. Refresh before deciding.");
      const review={workspaceId,expectedReviewHash:candidate.reviewHash};
      if(action==="edit")await editTraceMemoryCandidate(candidate.candidateId,{...review,proposedInsight:content!});
      else if(action==="promote")await promoteTraceMemoryCandidate(candidate.candidateId,review);
      else await rejectTraceMemoryCandidate(candidate.candidateId,review);
      if(mounted.current)await query.refetch();
    }catch(cause){if(mounted.current){setError(`${describeApiError(cause).summary} Refresh to inspect the recorded outcome.`);await query.refetch();}throw cause;}
    finally{lock.current=false;if(mounted.current)setPending(false);}
  }
  return <details className="min-w-0 rounded border border-line-subtle p-3 text-sm" onToggle={event=>{if(event.target===event.currentTarget)setOpen(event.currentTarget.open);}}><summary className="cursor-pointer font-medium text-fg-secondary">Memory and learning</summary><div className="min-w-0 space-y-3 pt-3">
    {open && query.isPending ? <p role="status">Reading learning receipts…</p>:null}
    {open && query.data ? <ChatLearningReceipt receipt={query.data} pending={pending} readOnly={readOnly} error={error} onDecision={(candidate,action)=>{void run(candidate,action).catch(()=>{
      // The decision failure is already surfaced by run().
    });}} onEdit={(candidate,content)=>run(candidate,"edit",content)}/>:null}
    {query.error ? <p role="alert">{describeApiError(query.error).summary}</p>:null}
    {open ? <Button size="sm" variant="secondary" disabled={pending || query.isFetching} onClick={()=>void query.refetch()}>Refresh learning receipt</Button>:null}
  </div></details>;
}
