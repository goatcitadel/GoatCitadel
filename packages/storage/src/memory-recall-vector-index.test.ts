import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryRecallVectorIndex } from "./memory-recall-vector-index.js";
import type { MemoryEmbeddingProfile } from "@goatcitadel/contracts";

const profile:MemoryEmbeddingProfile = {profileId:"fixture-real",provider:"remote",modelId:"real-fixture",dimensions:2,version:"1",status:"active",source:"request"};
const metadata = {provider:profile.provider,modelId:profile.modelId,dimensions:2,version:"1"};
test("ranks every current note chunk but returns one canonical item at its best score",async()=>{
  const index=new MemoryRecallVectorIndex();const scope={workspaceId:"A",generation:1,profile};
  try {
    await index.begin(scope);await index.append({...scope,entries:[
      {sourceType:"memory_item",sourceRef:"note",vectorRef:"chunk-1",vector:[1,0],metadata},
      {sourceType:"memory_item",sourceRef:"note",vectorRef:"chunk-2",vector:[0,1],metadata},
    ]});await index.seal(scope);
    for(const vector of [[1,0],[0,1]]){const result=await index.search({...scope,vector,limit:40});assert.equal(result.hits.length,1);assert.equal(result.hits[0]?.sourceRef,"note");assert.equal(result.hits[0]?.score,1);assert.equal(result.indexedCount,1);}
  } finally {await index.close();}
});
test("worker-owned exact cosine normalizes real compatible vectors and rejects stale, pseudo and incompatible profiles",async () => {
  const index = new MemoryRecallVectorIndex({maxEntries:10_000});
  try {
    await index.begin({workspaceId:"A",generation:3,profile});
    await index.append({workspaceId:"A",generation:3,profile,entries:[
      {sourceType:"knowledge_chunk",sourceRef:"parallel",vector:[8,0],metadata},
      {sourceType:"knowledge_chunk",sourceRef:"diagonal",vector:[1,1],metadata},
      {sourceType:"knowledge_chunk",sourceRef:"orthogonal",vector:[0,2],metadata},
      {sourceType:"knowledge_chunk",sourceRef:"wrong-model",vector:[1,0],metadata:{...metadata,modelId:"other"}},
      {sourceType:"knowledge_chunk",sourceRef:"invalid",vector:[NaN,0],metadata},
    ]});
    await index.seal({workspaceId:"A",generation:3,profile});
    const result = await index.search({workspaceId:"A",generation:3,profile,vector:[3,0],limit:2});
    assert.equal(result.status,"ready");
    assert.deepEqual(result.hits.map(hit => hit.sourceRef),["parallel","diagonal"]);
    assert.ok(Math.abs(result.hits[0]!.score-1)<1e-6);
    assert.ok(Math.abs(result.hits[1]!.score-Math.SQRT1_2)<1e-6);
    assert.equal(result.indexedCount,3);
    assert.equal(result.unindexedCount,2);
    assert.deepEqual((await index.search({workspaceId:"B",generation:3,profile,vector:[1,0],limit:2})).hits,[]);
    assert.equal((await index.search({workspaceId:"A",generation:4,profile,vector:[1,0],limit:2})).status,"building");
    assert.equal((await index.search({workspaceId:"A",generation:3,profile:{...profile,provider:"pseudo"},vector:[1,0],limit:2})).status,"profile_incompatible");
  } finally { await index.close(); }
});

test("over-capacity is an explicit lexical fallback with no partial semantic result",async () => {
  const index = new MemoryRecallVectorIndex({maxEntries:1});
  try {
    await index.begin({workspaceId:"A",generation:1,profile});
    await index.append({workspaceId:"A",generation:1,profile,entries:[{sourceType:"knowledge_chunk",sourceRef:"1",vector:[1,0],metadata},{sourceType:"knowledge_chunk",sourceRef:"2",vector:[0,1],metadata}]});
    await index.seal({workspaceId:"A",generation:1,profile});
    const result = await index.search({workspaceId:"A",generation:1,profile,vector:[1,0],limit:3});
    assert.equal(result.status,"over_capacity");
    assert.deepEqual(result.hits,[]);
  } finally {await index.close();}
});

test("10,000-vector exact retrieval leaves the caller event loop responsive and returns bounded top-K",async t => {
  const index = new MemoryRecallVectorIndex();
  const largeProfile = {...profile,dimensions:128};
  const scope = {workspaceId:"benchmark",generation:1,profile:largeProfile};
  try {
    await index.begin(scope);
    for (let offset=0;offset<10_000;offset+=200) await index.append({...scope,entries:Array.from({length:200},(_,i) => ({sourceType:"knowledge_chunk",sourceRef:`v${String(offset+i).padStart(5,"0")}`,
      vector:Array.from({length:128},(_,j) => j === ((offset+i)%128) ? 1 : 0),metadata:{...metadata,dimensions:128}}))});
    await index.seal(scope);
    const vector = Array.from({length:128},(_,i) => i === 37 ? 1 : 0);
    let ticks = 0;
    const timer = setInterval(() => ticks++,1);
    const timings:number[] = [];
    try {
      for (let i=0;i<20;i++) {
        const started = performance.now();
        const result = await index.search({...scope,vector,limit:40});
        timings.push(performance.now()-started);
        assert.equal(result.status,"ready");
        assert.equal(result.indexedCount,10_000);
        assert.equal(result.hits.length,40);
        assert.equal(result.hits[0]?.sourceRef,"v00037");
      }
    } finally {clearInterval(timer);}
    assert.ok(ticks>0,"caller timers must run while the worker scans vectors");
    timings.sort((a,b) => a-b);
    t.diagnostic(JSON.stringify({vectors:10_000,dimensions:128,queries:20,p50Ms:timings[10],p95Ms:timings[18],callerTimerTicks:ticks}));
  } finally {await index.close();}
});
