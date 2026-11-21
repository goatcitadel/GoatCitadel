import {evaluateImprovementWatch,type ImprovementActivationWatchStatus,type PromptPackImprovementWatchBinding} from "@goatcitadel/contracts";
import type {DatabaseClient} from "./db.js";
interface WatchRow {activation_id:string;candidate_id:string;revision_id:string;applied_change_hash:string;status:string;watch_status:ImprovementActivationWatchStatus;watch_started_at:string|null;watch_ends_at:string|null;watch_signal_target:number;watch_signal_count:number;positive_signal_count:number;regression_count:number;watch_evidence_version:number;watch_evidence_complete:number}
interface SignalRow {signal_id:string;origin:string;outcome:string;metadata_json:string|null;occurred_at:string}
/** Recounts immutable canonical signal identities, so duplicate delivery and
 * concurrent observers cannot inflate evidence. No heuristic traffic-to-success conversion. */
export class ImprovementWatchEvidenceRepository {
  public constructor(private readonly db:DatabaseClient){}
  public captureForWork(input:{workspaceId:string;fingerprint:string;capability:string;capturedAt:string}):PromptPackImprovementWatchBinding[]{
    const rows=this.db.prepare(`SELECT a.activation_id,a.revision_id,a.applied_change_hash FROM improvement_activations a
      JOIN improvement_candidates c ON c.candidate_id=a.candidate_id AND c.current_revision_id=a.revision_id
      JOIN improvement_candidate_revisions r ON r.revision_id=a.revision_id AND r.candidate_id=c.candidate_id AND r.change_hash=a.applied_change_hash
      WHERE c.workspace_id=? AND c.fingerprint=? AND a.status='active' AND a.watch_status IN ('watching','stable','insufficient_evidence')
        AND a.watch_started_at<=? AND a.watch_ends_at>=? ORDER BY a.activation_id LIMIT 2`).all<{activation_id:string;revision_id:string;applied_change_hash:string}>(input.workspaceId,input.fingerprint,input.capturedAt,input.capturedAt);
    if(rows.length!==1||!/^[a-f0-9]{64}$/u.test(rows[0]!.applied_change_hash))return [];
    const row=rows[0]!;return [{...input,activationId:row.activation_id,revisionId:row.revision_id,changeHash:row.applied_change_hash}];
  }
  public listForSignal(signalId:string):string[]{
    return this.db.prepare(`SELECT a.activation_id FROM improvement_activations a JOIN improvement_candidates c ON c.candidate_id=a.candidate_id JOIN improvement_signals s ON s.signal_id=? AND s.workspace_id=c.workspace_id AND s.fingerprint=c.fingerprint WHERE a.status='active' AND a.watch_status IN ('watching','stable','alerting','insufficient_evidence') ORDER BY a.activation_id LIMIT 100`).all<{activation_id:string}>(signalId).map(row=>row.activation_id);
  }
  public reconcile(activationId:string) {
    return this.db.transaction("immediate",()=>{
      // Candidate before activation matches the governed mutation owner. Take
      // its exclusive lock now; two SHARE-to-UPDATE upgrades during recovery deadlock.
      const initial=this.db.prepare("SELECT candidate_id FROM improvement_activations WHERE activation_id=?").get<{candidate_id:string}>(activationId);
      if(!initial) return {changed:false,status:undefined,shouldRestore:false};
      const candidate=this.db.prepare(`SELECT workspace_id,fingerprint,current_revision_id FROM improvement_candidates WHERE candidate_id=?${this.db.dialect==="postgres" ? " FOR UPDATE":""}`).get<{workspace_id:string;fingerprint:string;current_revision_id:string|null}>(initial.candidate_id);
      const row=this.db.prepare(`SELECT * FROM improvement_activations WHERE activation_id=?${this.db.dialect==="postgres" ? " FOR UPDATE":""}`).get<WatchRow>(activationId);
      if(!row || row.status!=="active" || !["watching","stable","alerting","insufficient_evidence"].includes(row.watch_status)) return {changed:false,status:row?.watch_status,shouldRestore:false};
      const now=(this.db.dialect==="postgres" ? this.db.prepare("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now"):this.db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")).get<{now:string}>()!.now;
      const fullChangeHash=/^[a-f0-9]{64}$/u.test(row.applied_change_hash);
      const complete=Boolean(candidate && candidate.current_revision_id===row.revision_id && row.watch_started_at && fullChangeHash);
      const rows=complete ? this.readSignals({workspaceId:candidate!.workspace_id,fingerprint:candidate!.fingerprint,from:row.watch_started_at!,through:row.watch_ends_at && row.watch_ends_at<now ? row.watch_ends_at:now}) : [];
      let positive=0,regressions=0,matched=0;
      const observations=new Map<string,{positive:boolean;negative:boolean}>();
      for(const signal of rows) {
        if(!["runtime","evaluation"].includes(signal.origin)) continue;
        let metadata:Record<string,unknown>;
        try{metadata=JSON.parse(signal.metadata_json ?? "{}");}catch{continue;}
        const binding=metadata?.improvementWatchRevision as {activationId?:unknown;revisionId?:unknown;changeHash?:unknown;capturedAt?:unknown}|undefined;
        if(binding?.activationId!==row.activation_id || binding.revisionId!==row.revision_id || binding.changeHash!==row.applied_change_hash || typeof binding.capturedAt!=="string" || !Number.isFinite(Date.parse(binding.capturedAt)) || Date.parse(binding.capturedAt)<Date.parse(row.watch_started_at!) || Date.parse(binding.capturedAt)>Date.parse(signal.occurred_at)) continue;
        const work=metadata.observedWork as {currentRunId?:unknown;baselineRunId?:unknown}|undefined;
        const key=typeof work?.currentRunId==="string"&&typeof work.baselineRunId==="string" ? `work:${JSON.stringify([work.currentRunId,work.baselineRunId])}`:`signal:${signal.signal_id}`;
        const observation=observations.get(key) ?? {positive:false,negative:false};
        if(signal.outcome==="positive")observation.positive=true;if(signal.outcome==="negative")observation.negative=true;observations.set(key,observation);
      }
      matched=observations.size;for(const observation of observations.values()){if(observation.negative)regressions++;else if(observation.positive)positive++;}
      const deadlineReached=Boolean(row.watch_ends_at && row.watch_ends_at<=now);
      let status=evaluateImprovementWatch({deadlineReached,positiveSignalCount:positive,requiredPositiveSignals:row.watch_signal_target,regressionCount:regressions});
      if(!complete && status!=="alerting") status=deadlineReached || status==="stable" ? "insufficient_evidence":"watching";
      const changed=row.watch_status!==status || row.positive_signal_count!==positive || row.watch_signal_count!==matched || row.regression_count!==regressions || row.watch_evidence_version!==1 || row.watch_evidence_complete!==(complete?1:0);
      if(changed) this.db.prepare(`UPDATE improvement_activations SET watch_status=@status,positive_signal_count=@positive,watch_signal_count=@matched,regression_count=@regressions,watch_evidence_version=1,watch_evidence_complete=@complete,stable_at=CASE WHEN @status='stable' THEN COALESCE(stable_at,@now) ELSE stable_at END,updated_at=@now WHERE activation_id=@activationId AND status='active'`).run({status,positive,matched,regressions,complete:complete?1:0,now,activationId});
      return {changed,status,shouldRestore:status==="alerting"};
    });
  }
  /** Bounded keyset reads drain the watch window; unrelated traffic cannot hide a later regression. */
  private *readSignals(input:{workspaceId:string;fingerprint:string;from:string;through:string}):Generator<SignalRow> {
    let afterAt=input.from,afterId="";
    while(true){
      const page=this.db.prepare(`SELECT signal_id,origin,outcome,metadata_json,occurred_at FROM improvement_signals
        WHERE workspace_id=@workspaceId AND fingerprint=@fingerprint AND occurred_at>=@from AND occurred_at<=@through
          AND origin IN ('runtime','evaluation') AND outcome IN ('positive','negative')
          AND (occurred_at>@afterAt OR (occurred_at=@afterAt AND signal_id>@afterId))
        ORDER BY occurred_at,signal_id LIMIT 500`).all<SignalRow>({...input,afterAt,afterId});
      for(const signal of page)yield signal;
      if(page.length<500)return;
      const last=page.at(-1)!;afterAt=last.occurred_at;afterId=last.signal_id;
    }
  }
}
