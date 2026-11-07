import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID,webcrypto } from "node:crypto";
import { createContext,runInContext } from "node:vm";
import path from "node:path";
import * as owner from "./citadel-presence-provenance.mjs";
import { assertCitadelPresenceHeartbeat,runCockpitCitadelDirectoryProof } from "./cockpit-citadel-directory-proof.mjs";
const key="__syntheticCitadelPresenceObserver";
const clientId=randomUUID();
function observerFunction(){assert.equal(typeof owner.citadelPresenceInit,"function","Pre-navigation native UUID delegation observer must exist");return owner.citadelPresenceInit;}
function validator(){assert.equal(typeof owner.assertCitadelPresenceProvenance,"function","Presence oracle must use independent native generation, not nonexistent lease storage");return owner.assertCitadelPresenceProvenance;}
function realm({limit=256,nativeFailure,blocked=false,missing=false}={}){
 const init=observerFunction(),storage=new Map(),nativeValues=[],fetches=[];
 const crypto={randomUUID:function(...args){if(nativeFailure)throw nativeFailure;assert.equal(this,crypto);const result=Reflect.apply(webcrypto.randomUUID,webcrypto,args);nativeValues.push(result);return result;}};
 if(blocked)Object.defineProperty(crypto,"randomUUID",{value:crypto.randomUUID,writable:false,configurable:false});
 if(missing)delete crypto.randomUUID;
 const fetchPromise=Promise.resolve({synthetic:true});
 const fetch=function(...args){fetches.push({receiver:this,args});return fetchPromise;};
 const context=createContext({crypto,fetch,URL,Request,document:{synthetic:true},location:{href:"http://127.0.0.1/fixture",origin:"http://127.0.0.1"},sessionStorage:{setItem:(name,value)=>storage.set(name,value),getItem:name=>storage.get(name)??null}});
 runInContext("globalThis.window=globalThis",context);
 runInContext(`(${init.toString()})(${JSON.stringify({clientId,observerKey:key,limit})})`,context);
 return {context,storage,nativeValues,fetches,fetchPromise,snapshot:()=>context[key].snapshot(),uuid:()=>runInContext("crypto.randomUUID()",context),send:()=>runInContext('fetch("/api/v1/notifications/presence",{method:"PUT",body:"unconsumed-synthetic-body"})',context)};
}
function heartbeat(leaseId,focused=true,visible=true){const body={workspaceId:"default",clientId,leaseId,focused,visible,ttlMs:90000};return {method:"PUT",pathname:"/api/v1/notifications/presence",body,status:200,receipt:{workspaceId:"default",clientId,leaseId,focused,visible,updatedAt:"2026-09-30T00:00:00.000Z",expiresAt:"2026-09-30T00:01:30.000Z"}};}
function journey(){
 const r=realm();r.uuid();const cockpit=r.uuid();r.send();r.uuid();r.send();
 const before=r.snapshot();const transition={afterSend:before.sends.length,afterGeneration:before.generations.at(-1).sequence};
 const classic=r.uuid();r.send();r.send();r.uuid();
 return {r,cockpit,classic,transition,entries:[heartbeat(cockpit),heartbeat(cockpit),heartbeat(cockpit,false,false),heartbeat(classic)]};
}

test("delegates exact native UUID values/receiver and seeds only independently generated synthetic client, never a lease storage key",()=>{
 const r=realm();const value=r.uuid();assert.equal(value,r.nativeValues[0]);assert.notEqual(value,clientId);
 assert.equal(r.storage.get("goatcitadel.notification-client-id"),clientId);assert.equal(r.storage.has("goatcitadel.notification-lease-id"),false);
 const snapshot=r.snapshot();assert.equal(snapshot.generations[0].uuid,value);assert.equal(snapshot.complete,true);
 assert.ok(Object.isFrozen(snapshot));assert.ok(Object.isFrozen(snapshot.generations));assert.ok(Object.isFrozen(snapshot.generations[0]));
 assert.equal(typeof r.context[key].reset,"undefined");
});

test("captures generation custody synchronously before native fetch delegation without changing receiver arguments or Promise",()=>{
 const r=realm();r.uuid();const lease=r.uuid();const returned=r.send();
 assert.equal(returned,r.fetchPromise);assert.equal(r.fetches.length,1);assert.equal(r.fetches[0].args[1].body,"unconsumed-synthetic-body");
 const s=r.snapshot();assert.equal(s.sends.length,1);assert.ok(s.generations.find(entry=>entry.uuid===lease).sequence<s.sends[0].sequence);
 assert.equal(s.sends[0].generationSequence,s.generations.at(-1).sequence);
 const other=realm();other.context.syntheticReceiver={synthetic:true};other.context.syntheticArguments={method:"PUT",body:"untouched"};
 const promise=runInContext('Reflect.apply(fetch,syntheticReceiver,["/api/v1/notifications/presence",syntheticArguments])',other.context);
 assert.equal(promise,other.fetchPromise);assert.equal(other.fetches[0].receiver,other.context.syntheticReceiver);
 assert.equal(other.fetches[0].args[1],other.context.syntheticArguments);
});

test("accepts distinct Cockpit and Classic mount generations while unrelated UUID calls never become the expected lease",()=>{
 const check=validator(),value=journey();const result=check({snapshot:value.r.snapshot(),entries:value.entries,clientId,workspaceId:"default",transition:value.transition});
 assert.equal(result.complete,true);assert.equal(result.mounts.length,2);assert.equal(result.mounts[0].leaseId,value.cockpit);assert.equal(result.mounts[1].leaseId,value.classic);
 assert.equal(result.attribution,"native-generation-membership-qualified-by-pinned-hook");
 for(const entry of value.entries)assertCitadelPresenceHeartbeat(entry,{workspaceId:"default",clientId,leaseId:entry.body.leaseId});
});

test("real generated lease defeats the old nonexistent storage oracle and succeeds only with independent provenance",()=>{
 const check=validator(),value=journey();const missing=value.r.storage.get("goatcitadel.notification-lease-id");
 assert.equal(missing,undefined);assert.throws(()=>assertCitadelPresenceHeartbeat(value.entries[0],{workspaceId:"default",clientId,leaseId:missing}));
 assert.equal(check({snapshot:value.r.snapshot(),entries:value.entries,clientId,workspaceId:"default",transition:value.transition}).complete,true);
});

test("rejects absent duplicate or late UUID provenance and missing or overflowing observer evidence",()=>{
 const check=validator(),value=journey(),base=value.r.snapshot();
 const matching=base.generations.find(entry=>entry.uuid===value.cockpit);
 const variants=[{...base,generations:base.generations.filter(entry=>entry.uuid!==value.cockpit)},
 {...base,generations:[...base.generations,{...matching}]},
 {...base,generations:base.generations.map(entry=>entry.uuid===value.cockpit?{...entry,sequence:base.sends.at(-1).sequence+1}:entry)},
 {...base,complete:false,gapReason:"overflow"},null];
 for(const snapshot of variants)assert.throws(()=>check({snapshot,entries:value.entries,clientId,workspaceId:"default",transition:value.transition}),/provenance|observer|generation|ledger|complete|duplicate/i);
});

test("rejects unrequested stable-stage replacement, old active publication after retirement and extra mount generation",()=>{
 const check=validator(),value=journey(),snapshot=value.r.snapshot();
 const alreadyGeneratedUnrelated=snapshot.generations[2].uuid;
 const variants=[value.entries.map((entry,index)=>index===1?heartbeat(alreadyGeneratedUnrelated):entry),
 [value.entries[0],value.entries[1],heartbeat(value.cockpit,false,false),heartbeat(value.cockpit)],
 [...value.entries,heartbeat(randomUUID())]];
 for(const entries of variants)assert.throws(()=>check({snapshot,entries,clientId,workspaceId:"default",transition:value.transition}),/mount|lease|generation|retir|send|provenance/i);
});

test("missing/unwrappable native API and ledger overflow are explicit gaps without substituting generated identities",()=>{
 const r=realm({limit:2});const results=[r.uuid(),r.uuid(),r.uuid()];assert.deepEqual(results,r.nativeValues);
 assert.equal(r.snapshot().complete,false);
 const blocked=realm({blocked:true});assert.equal(blocked.snapshot().complete,false);assert.equal(blocked.uuid(),blocked.nativeValues[0]);
 const missing=realm({missing:true});assert.equal(missing.snapshot().complete,false);assert.equal(missing.nativeValues.length,0);
});

test("actual directory collector installs independent client/observer before first navigation without changing its retained-write journey",async()=>{
 const init=observerFunction(),initializers=[],results=[];let initializersAtNavigation;
 const page={on(){},async goto(){initializersAtNavigation=initializers.slice();throw new Error("Controlled pre-navigation boundary");},isClosed(){return true;}};
 const browser={async newContext(){return {async addInitScript(fn,args){initializers.push({fn,args});},async newPage(){return page;},async close(){}};}};
 await runCockpitCitadelDirectoryProof({context:{artifactRoot:"synthetic-proof"},browser,stack:{runtimeRoot:"goatcitadel-synthetic",gatewayUrl:"http://localhost",uiUrl:"http://localhost"},citadelId:"synthetic-citadel",
  viewports:[{variant:"desktop",viewport:{width:1440,height:900}}],deps:{path,assertOk(){},requestJson:async()=>({body:{items:[]}}),
   runScenario:async(_context,_definition,run)=>results.push(await run()),installMissionControlNextBrowserState:async()=>{},
   buildVerificationUiUrl:(base,route)=>new URL(route,base).href,emptyArtifacts:fields=>fields,relativeToRun:(_context,file)=>file,
  }});
 const installed=initializersAtNavigation.filter(entry=>entry.fn===init);
 assert.equal(installed.length,1,"Actual owner must install the observer before app code, not infer lease from later storage/request");
 assert.match(installed[0].args.clientId,/^[a-f0-9-]{36}$/i);
 assert.match(results[0].error,/Controlled pre-navigation boundary/);
 assert.equal(results[0].metrics.browserMutations,0);
});

test("native UUID error identity is preserved exactly and failed observation never changes native caller outcome",()=>{
 const error=new Error("synthetic-native-failure"),r=realm({nativeFailure:error});
 assert.throws(()=>r.uuid(),cause=>cause===error);
 const capped=realm({limit:1});capped.uuid();const value=capped.uuid();assert.equal(value,capped.nativeValues[1]);assert.equal(capped.snapshot().complete,false);
});

test("requires exact receipt client scope TTL and document custody, never caller authentication from ledger membership",()=>{
 const check=validator(),value=journey(),snapshot=value.r.snapshot();
 for(const patch of [{clientId:randomUUID()},{workspaceId:"foreign"},{snapshot:{...snapshot,sameDocument:false}},
 {entries:value.entries.map((entry,index)=>index===0?{...entry,receipt:{...entry.receipt,expiresAt:"2026-09-30T00:02:00.000Z"}}:entry)}])assert.throws(()=>check({snapshot,entries:value.entries,clientId,workspaceId:"default",transition:value.transition,...patch}));
});
