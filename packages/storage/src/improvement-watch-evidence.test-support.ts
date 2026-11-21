import type {DatabaseClient} from "./db.js";
import {ApprovalRepository} from "./approval-repo.js";
export function seedImprovementWatch(db:DatabaseClient){
  const now=new Date().toISOString(),start=new Date(Date.now()-60_000).toISOString(),end=new Date(Date.now()+60_000).toISOString();
  db.prepare("INSERT INTO improvement_candidates(candidate_id,workspace_id,kind,status,target_key,fingerprint,summary,current_revision_id,created_at,updated_at) VALUES ('candidate','default','routing_policy','approved','route','fingerprint','Fixture','revision',?,?)").run(now,now);
  db.prepare("INSERT INTO improvement_candidate_revisions(revision_id,candidate_id,candidate_ref_json,change_hash,created_at,created_by_actor_id,created_by_actor_type) VALUES ('revision','candidate','{}',?,?,'operator','operator')").run("a".repeat(64),now);
  const approval=new ApprovalRepository(db).create({kind:"improvement.activate",riskLevel:"caution",payload:{},preview:{}});
  db.prepare("INSERT INTO improvement_activations(activation_id,candidate_id,revision_id,approval_id,status,scope,activation_target_json,pre_activation_snapshot_json,applied_change_hash,watch_status,watch_started_at,watch_ends_at,watch_signal_target,created_at,updated_at,requested_by_actor_id,requested_by_actor_type) VALUES ('watch','candidate','revision',?,'active','workspace','{}','{}',?,'watching',?,?,5,?,?,'operator','operator')").run(approval.approvalId,"a".repeat(64),start,end,now,now);
}
export function seedWatchSignal(db:DatabaseClient,id:string,outcome:"positive"|"negative"|"neutral",options:{bound?:boolean;revision?:string;workspaceId?:string;occurredAt?:string}={}) {
  // These are already-settled fixture observations. Keep them in the past so
  // independent JS/SQLite clock resolution cannot exclude a just-inserted row.
  const now=options.occurredAt ?? new Date(Date.now()-10).toISOString();
  db.prepare(`INSERT INTO improvement_signals(signal_id,schema_version,source_service,source_type,source_id,source_event_id,idempotency_key,workspace_id,occurred_at,recorded_at,origin,signal_class,signal_kind,outcome,fingerprint,evidence_refs_json,metadata_json,created_at)
    VALUES (?, 'fixture-v1','fixture','evaluation',?,?,?, ?,?,?,'evaluation','evaluation','fixture',?,'fingerprint','[]',?,?)`).run(id,id,id,id,options.workspaceId ?? "default",now,now,outcome,JSON.stringify(options.bound===false ? {}:{improvementWatchRevision:{activationId:"watch",revisionId:options.revision ?? "revision",changeHash:"a".repeat(64),capturedAt:now}}),now);
}
