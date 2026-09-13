import assert from "node:assert/strict";
import {test} from "node:test";
import {installVisualLocalAiFixture} from "./visual-host-fixture.mjs";

test("visual host stabilization preserves failures, unavailable payloads and mutation requests", async () => {
  let handler;
  await installVisualLocalAiFixture({route:async(pattern,callback)=>{assert.equal(pattern,"**/api/v1/local-ai/readiness");handler=callback;}});
  for (const body of [null,{error:"unavailable"},{data:null,success:true}]) {
    const response={ok:()=>true,json:async()=>body};let received;
    await handler({request:()=>({method:()=>"GET"}),fetch:async()=>response,fulfill:async(value)=>{received=value;}});
    assert.deepEqual(received,{response});
  }
  const failure={ok:()=>false};let received;
  await handler({request:()=>({method:()=>"GET"}),fetch:async()=>failure,fulfill:async(value)=>{received=value;}});
  assert.deepEqual(received,{response:failure});
  let continued=false;
  await handler({request:()=>({method:()=>"POST"}),continue:async()=>{continued=true;},fetch:()=>{throw Error("must not intercept mutations");}});
  assert.equal(continued,true);
});

test("different live host payloads render the same explicit synthetic profile", async () => {
  let handler;await installVisualLocalAiFixture({route:async(_pattern,callback)=>{handler=callback;}});
  const observed=[];
  for(const platform of ["linux","win32"]){
    const response={ok:()=>true,json:async()=>({success:true,meta:{test:1},data:{hardware:{os:{platform},cpu:{logicalCores:platform === "linux" ? 4 : 24}}}})};
    await handler({request:()=>({method:()=>"GET"}),fetch:async()=>response,fulfill:async(value)=>{observed.push(value.json);}});
  }
  assert.deepEqual(observed[0],observed[1]);
  assert.equal(observed[0].meta.test,1);
  assert.equal(observed[0].data.hardware.os.release,"verification-fixture");
  assert.equal(observed[0].data.recommendations[0].modelId,observed[0].data.catalog[0].modelId);
});
