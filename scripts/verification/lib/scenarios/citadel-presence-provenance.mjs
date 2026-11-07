import assert from "node:assert/strict";

/** Serialized into the fresh main document before application code. No application/runtime hook. */
export function citadelPresenceInit({clientId,observerKey,limit=256,gatewayOrigin}) {
 if(window.top && window.top!==window)return;
 const gaps=new Set(),generations=[],sends=[];let sequence=0;
 const initialDocument=document;
 const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
 if(!Number.isInteger(limit)||limit<1||limit>256)throw new Error("Invalid presence observer bound");
 if(typeof clientId!=="string"||!uuidPattern.test(clientId)||typeof observerKey!=="string"||!/^__syntheticCitadelPresenceObserver(?:_[a-z0-9]+)?$/iu.test(observerKey))throw new Error("Invalid synthetic presence observer identity");
 const gap=reason=>gaps.add(reason);
 try{window.sessionStorage.setItem("goatcitadel.notification-client-id",clientId);if(window.sessionStorage.getItem("goatcitadel.notification-client-id")!==clientId)gap("client_storage");}catch{gap("client_storage");}
 const nativeCrypto=globalThis.crypto,originalUUID=nativeCrypto?.randomUUID;
 if(typeof originalUUID!=="function")gap("native_uuid_missing");
 else {
  const wrapper=function(...args){
   const value=Reflect.apply(originalUUID,this,args);
   try{if(generations.length>=limit)gap("generation_overflow");else if(!uuidPattern.test(value))gap("native_uuid_invalid");else generations.push({uuid:value,sequence:++sequence});}catch{gap("generation_observer");}
   return value;
  };
  try{if(!Reflect.set(nativeCrypto,"randomUUID",wrapper)||nativeCrypto.randomUUID!==wrapper)gap("native_uuid_unwrappable");}catch{gap("native_uuid_unwrappable");}
 }
 const originalFetch=window.fetch;
 if(typeof originalFetch!=="function")gap("fetch_missing");
 else {
  const wrapper=function(...args){
   try{
    const input=args[0],request=typeof Request!=="undefined"&&input instanceof Request;
    const raw=typeof input==="string"?input:request?input.url:input instanceof URL?input.href:null;
    const method=String(args[1]?.method??(request?input.method:"GET")).toUpperCase();
    if(raw!==null && raw.length<=4096 && method==="PUT") {
     const url=new URL(raw,window.location.href);
     if(url.pathname==="/api/v1/notifications/presence" && !url.search && !url.hash && !url.username && !url.password && (url.origin===window.location.origin||url.origin===gatewayOrigin)) {
      if(sends.length>=limit)gap("send_overflow");
      else sends.push({sequence:++sequence,generationSequence:generations.at(-1)?.sequence??0});
     }
    }
   }catch{gap("fetch_observer");}
   return Reflect.apply(originalFetch,this,args);
  };
  try{if(!Reflect.set(window,"fetch",wrapper)||window.fetch!==wrapper)gap("fetch_unwrappable");}catch{gap("fetch_unwrappable");}
 }
 const snapshot=()=>Object.freeze({complete:gaps.size===0,sameDocument:document===initialDocument,clientId,
  generations:Object.freeze(generations.map(entry=>Object.freeze({...entry}))),sends:Object.freeze(sends.map(entry=>Object.freeze({...entry}))),gaps:Object.freeze([...gaps])});
 try{Object.defineProperty(window,observerKey,{value:Object.freeze({snapshot}),writable:false,configurable:false,enumerable:false});}catch{gap("observer_exposure");}
}

/** Existing exact presence request/owner receipt contract, retained for the directory proof. */
export function assertCitadelPresenceHeartbeat({ method, pathname, body, status, receipt }, expected) {
 assert.equal(method,"PUT");assert.equal(pathname,"/api/v1/notifications/presence");
 assert.deepEqual(Object.keys(body).sort(),["clientId","focused","leaseId","ttlMs","visible","workspaceId"]);
 assert.equal(body.workspaceId,expected.workspaceId);
 for(const field of ["clientId","leaseId"]){assert.ok(typeof expected[field]==="string"&&expected[field].length>0);assert.equal(body[field],expected[field]);}
 assert.equal(typeof body.focused,"boolean");assert.equal(typeof body.visible,"boolean");assert.equal(body.ttlMs,90000);assert.equal(status,200);
 assert.deepEqual(Object.keys(receipt).sort(),["clientId","expiresAt","focused","leaseId","updatedAt","visible","workspaceId"]);
 for(const field of ["workspaceId","clientId","leaseId","focused","visible"])assert.equal(receipt[field],body[field]);
 assert.ok(Number.isFinite(Date.parse(receipt.updatedAt)));assert.equal(Date.parse(receipt.expiresAt)-Date.parse(receipt.updatedAt),body.ttlMs);
}

/** Membership is qualified by pinned hook source/tests; it is not authenticated caller custody. */
export function assertCitadelPresenceProvenance({snapshot,entries,clientId,workspaceId,transition}) {
 assert.ok(snapshot?.complete===true&&snapshot.sameDocument===true,"Presence observer/ledger is incomplete or document custody changed");
 assert.equal(snapshot.clientId,clientId,"Presence observer client differs from independently seeded client");
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
 assert.match(clientId,uuid);assert.equal(workspaceId,"default");
 assert.ok(Array.isArray(entries)&&entries.length>=3&&entries.length<=256,"Presence send/mount evidence missing or exceeds bound");
 assert.ok(Array.isArray(snapshot.generations)&&snapshot.generations.length<=256&&Array.isArray(snapshot.sends)&&snapshot.sends.length===entries.length,"Presence generation/send ledger count is ambiguous");
 assert.ok(Number.isInteger(transition?.afterSend)&&transition.afterSend>=1&&transition.afterSend<entries.length&&Number.isInteger(transition.afterGeneration)&&transition.afterGeneration>=1,"Presence mount transition is missing");
 const seen=new Set(),uuids=new Set();let previous=0;
 for(const generation of snapshot.generations){assert.match(generation.uuid,uuid);assert.ok(Number.isSafeInteger(generation.sequence)&&generation.sequence>previous&&!seen.has(generation.sequence)&&!uuids.has(generation.uuid),"Presence generation ledger duplicate or invalid order");previous=generation.sequence;seen.add(generation.sequence);uuids.add(generation.uuid);}
 previous=0;
 for(const send of snapshot.sends){assert.ok(Number.isSafeInteger(send.sequence)&&send.sequence>previous&&!seen.has(send.sequence)&&Number.isInteger(send.generationSequence)&&send.generationSequence<send.sequence,"Presence send provenance sequence invalid");previous=send.sequence;seen.add(send.sequence);}
 const mounts=[];let retired=false;
 for(let index=0;index<entries.length;index++){
  const entry=entries[index],send=snapshot.sends[index],leaseId=entry.body?.leaseId;
  const matches=snapshot.generations.filter(generation=>generation.uuid===leaseId);
  assert.ok(matches.length===1&&matches[0].sequence<send.sequence&&matches[0].sequence<=send.generationSequence,"Presence lease lacks unique pre-request generation provenance");
  assert.notEqual(leaseId,clientId,"Presence lease must be independently generated from client");
  assertCitadelPresenceHeartbeat(entry,{workspaceId,clientId,leaseId:matches[0].uuid});
  if(index<transition.afterSend){
   if(!mounts.length)mounts.push({shell:"cockpit",leaseId});
   assert.equal(leaseId,mounts[0].leaseId,"Presence stable-stage lease replacement is unrequested");
  } else if(leaseId===mounts[0].leaseId){
   if(retired){assert.equal(entry.body.focused,false,"Retired Cockpit lease cannot publish active presence");assert.equal(entry.body.visible,false,"Retired Cockpit lease cannot publish visible presence");}
   if(!entry.body.focused&&!entry.body.visible)retired=true;
  } else {
   assert.ok(matches[0].sequence>transition.afterGeneration,"Classic mount lease was not generated after requested shell transition");
   if(mounts.length===1)mounts.push({shell:"classic",leaseId});
   assert.equal(leaseId,mounts[1].leaseId,"Additional unrequested presence mount generation");
  }
 }
 assert.equal(mounts.length,2,"Both actual shell mount generations required");assert.equal(retired,true,"Cockpit presence retirement missing");
 return {complete:true,mounts,heartbeats:entries.length,attribution:"native-generation-membership-qualified-by-pinned-hook"};
}
