import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateCockpitPerformance, installChatStartupReadinessProbe, createCockpitPerformanceTurnSession } from "./cockpit-performance-proof.mjs";
const accepted={chatReadyWithinStartupWindow:true,startupRequests:20,idleRequests:12,elsewhereTurnRequests:10,initialJavaScriptGzipBytes:350000,cls:0.10,firstFrameTheme:"dark",expectedTheme:"dark",inverseFirstFrameTheme:"light",inverseExpectedTheme:"light",firstFrameBackground:"rgb(18, 34, 53)",inverseFirstFrameBackground:"rgb(240, 248, 255)"};
test("preserves all agreed thresholds and rejects a missing measurement",()=>{
 assert.equal(evaluateCockpitPerformance(accepted).passed,true);
 for(const key of ["startupRequests","idleRequests","elsewhereTurnRequests","initialJavaScriptGzipBytes","cls"]){assert.equal(evaluateCockpitPerformance({...accepted,[key]:accepted[key]+1}).passed,false);assert.equal(evaluateCockpitPerformance({...accepted,[key]:undefined}).passed,false);}
 assert.equal(evaluateCockpitPerformance({...accepted,firstFrameTheme:"light"}).passed,false);
});

test("requires both saved themes against the opposite operating system theme",()=>{
 assert.equal(evaluateCockpitPerformance({...accepted,inverseFirstFrameTheme:undefined}).passed,false);
 assert.equal(evaluateCockpitPerformance({...accepted,inverseFirstFrameTheme:"dark"}).passed,false);
 assert.equal(evaluateCockpitPerformance({...accepted,firstFrameBackground:"rgb(255, 255, 255)"}).passed,false);
 assert.equal(evaluateCockpitPerformance({...accepted,inverseFirstFrameBackground:"rgb(18, 34, 53)"}).passed,false);
});

test("startup readiness must be measured rather than inferred from a later script response",()=>{
 assert.equal(evaluateCockpitPerformance({...accepted,chatReadyWithinStartupWindow:undefined}).passed,false);
 assert.equal(evaluateCockpitPerformance({...accepted,chatReadyWithinStartupWindow:false}).passed,false);
});

test("slow navigation cannot turn a late visible Chat into an accepted startup", async () => {
 const previous={window:globalThis.window,document:globalThis.document,requestAnimationFrame:globalThis.requestAnimationFrame};
 try {
  globalThis.window={};globalThis.document={querySelector:()=>({getBoundingClientRect:()=>({height:500,width:800})})};
  globalThis.requestAnimationFrame=callback=>callback();
  const page={addInitScript:async (callback,input)=>callback(input)};
  await installChatStartupReadinessProbe(page,0);assert.equal(window.cockpitChatStartupReady,false);
  await installChatStartupReadinessProbe(page,Number.MAX_SAFE_INTEGER);assert.equal(window.cockpitChatStartupReady,true);
 } finally {for(const [key,value] of Object.entries(previous)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});


test("elsewhere-turn setup creates a distinct governed conversation without changing the approval-gated fixture", async () => {
 const calls=[];const fixture={workspaceId:"workspace-proof",sessionId:"seeded-approval-chat"};
 const result=await createCockpitPerformanceTurnSession({stack:{gatewayUrl:"http://127.0.0.1:8787"},fixture,requestJson:async(...args)=>{calls.push(args);return {status:200,body:{sessionId:"performance-chat",workspaceId:fixture.workspaceId}};},assertOk:(response)=>assert.equal(response.status,200)});
 assert.equal(result,"performance-chat");assert.equal(calls.length,1);assert.equal(calls[0][1],"/api/v1/chat/sessions");assert.deepEqual(calls[0][2],{method:"POST",body:{workspaceId:"workspace-proof",title:"Cockpit performance turn",mode:"chat"}});
 for(const body of [{sessionId:fixture.sessionId,workspaceId:fixture.workspaceId},{sessionId:"wrong-scope",workspaceId:"another-workspace"},{workspaceId:fixture.workspaceId},{sessionId:"bad/id",workspaceId:fixture.workspaceId}]) await assert.rejects(createCockpitPerformanceTurnSession({stack:{gatewayUrl:"http://127.0.0.1:8787"},fixture,requestJson:async()=>({status:200,body}),assertOk:()=>{}}),/distinct canonical session/);
 await assert.rejects(createCockpitPerformanceTurnSession({stack:{gatewayUrl:"http://127.0.0.1:8787"},fixture,requestJson:async()=>({status:409}),assertOk:()=>{throw new Error("creation denied");}}),/creation denied/);
});
