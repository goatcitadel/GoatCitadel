import {test} from "node:test";
import assert from "node:assert/strict";
import {createRemoteWorkerPostgresTestScope} from "./remote-worker-test-fixtures.js";
import {MemoryNoteRepository} from "./memory-note-repo.js";
import {MemoryRecallRepository} from "./memory-recall-repo.js";
import {SessionRepository} from "./session-repo.js";
import {ChatSessionMetaRepository} from "./chat-session-meta-repo.js";
import {KnowledgeRepository} from "./knowledge-repo.js";
import {ImprovementWatchEvidenceRepository} from "./improvement-watch-evidence-repo.js";
import {seedImprovementWatch,seedWatchSignal} from "./improvement-watch-evidence.test-support.js";
const connectionString=process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("PostgreSQL canonical notes retain one identity, exclude historical artifacts, and expose a regression beyond 2000 signals",{skip:!connectionString,timeout:240_000},async()=>{
  const scope=await createRemoteWorkerPostgresTestScope(connectionString!,"canonical_notes");
  try {
    const db=scope.db,notes=new MemoryNoteRepository(db),recall=new MemoryRecallRepository(db),now=new Date().toISOString();
    for(const sessionId of ["source","reader"]){new SessionRepository(db).upsert({sessionId,sessionKey:sessionId,kind:"dm",channel:"web",account:"operator",timestamp:now});const meta=new ChatSessionMetaRepository(db);meta.ensure(sessionId,now,"default");meta.patch(sessionId,{origin:"operator"});}
    const binding=notes.prepareWrite({sessionId:"source",namespace:"notes",title:"Notebook",trustLevel:"trusted_operator",upsert:true});
    const first=notes.write({binding,namespace:"notes",title:"Notebook",content:"The notebook is azure.",metadata:{},chunks:[{content:"The notebook is azure.",embedding:[1,0],embeddingMetadata:{provider:"remote",modelId:"fixture",dimensions:2,version:"1"}}],actorId:"operator",upsert:true});
    assert.equal(recall.listVectorPage({workspaceId:"default",sessionId:"reader"}).entries[0]?.sourceRef,first.itemId);
    assert.throws(()=>notes.prepareWrite({sessionId:"source",namespace:"notes",title:"Notebook",trustLevel:"trusted_operator",upsert:true}));
    const nextBinding=notes.prepareWrite({sessionId:"source",namespace:"notes",title:"Notebook",trustLevel:"trusted_operator",upsert:true,expectedItemId:first.itemId,expectedSourceHash:first.sourceHash});
    const next=notes.write({binding:nextBinding,namespace:"notes",title:"Notebook",content:"The notebook is green.",metadata:{},chunks:[{content:"The notebook is green.",embedding:[0,1],embeddingMetadata:{provider:"remote",modelId:"fixture",dimensions:2,version:"1"}}],actorId:"operator",upsert:true});
    assert.equal(next.itemId,first.itemId);assert.notEqual(next.sourceHash,first.sourceHash);
    const hits=recall.searchEligibleCorpus({workspaceId:"default",sessionId:"reader",query:"notebook"}).hits;
    assert.equal(hits.length,1);assert.equal(hits[0]?.sourceHash,next.sourceHash);
    assert.equal(recall.listEligibleMemoryItemSources({workspaceId:"default",sessionId:"reader"})[0]?.sourceHash,next.sourceHash);
    const vectors=recall.listVectorPage({workspaceId:"default",sessionId:"reader"}).entries;
    assert.equal(vectors.length,1);assert.deepEqual(vectors[0]?.vector,[0,1]);
    assert.deepEqual(new KnowledgeRepository(db).listDocuments("notes",100,{excludeMemory:true}),[]);
    db.prepare("UPDATE memory_items SET status='forgotten' WHERE item_id=?").run(first.itemId);
    assert.deepEqual(recall.searchEligibleCorpus({workspaceId:"default",sessionId:"reader",query:"notebook"}).hits,[]);
    seedImprovementWatch(db);
    db.transaction("immediate",()=>{for(let index=0;index<2100;index++)seedWatchSignal(db,`noise-${index}`,index%2?"neutral":"positive",{bound:false,occurredAt:new Date(Date.now()-30_000).toISOString()});});
    seedWatchSignal(db,"bound-regression","negative");
    const watch=new ImprovementWatchEvidenceRepository(db);
    assert.equal(watch.reconcile("watch").status,"alerting");assert.equal(watch.reconcile("watch").changed,false);
  } finally {await scope.teardown();}
});
