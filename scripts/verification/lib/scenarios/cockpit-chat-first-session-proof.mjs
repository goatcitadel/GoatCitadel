import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir,writeFile } from "node:fs/promises";
import { isStartupReadRequest,STARTUP_READ_BATCH_LIMIT,STARTUP_READ_BATCH_QUERY_LIMIT } from "../../../../packages/contracts/dist/gateway-startup-reads.js";
import { assertUploadedAttachment,assertUploadedBinaryAttachment } from "./cockpit-chat-composer-evidence.mjs";
import { DETERMINISTIC_LLM_CAPABILITIES,DETERMINISTIC_LLM_KEY_ENV } from "./deterministic-llm-stub.mjs";
import { openConversationList,conversationNavigation,closeConversationList } from "./cockpit-conversation-list.mjs";

export function composerFirstSessionEnabled(args){
 assert.ok(Array.isArray(args)&&args.every(value=>typeof value==="string"));
 assert.ok(!args.some(value=>value.startsWith("--with-first-session")&&value!=="--with-first-session"),"Unsupported first-session flag");
 const flags=args.filter(value=>value==="--with-first-session");assert.ok(flags.length<=1,"Duplicate first-session flag");return flags.length===1;
}
export async function clickFirstSessionCreateImage(page,controls){await controls.revealAttachControl(page);const summary=page.locator("summary").filter({hasText:/^Voice and images$/u}).filter({visible:true});await summary.waitFor({state:"visible"});assert.equal(await summary.count(),1);await summary.click();await page.getByRole("button",{name:"Create image",exact:true}).click();await controls.closeComposerOptions(page);}
export function firstSessionImageFixture(stub){
 assert.equal(stub.providerId,"openai");assert.equal(stub.model,"gpt-image-2");
 const url=new URL(stub.baseUrl);assert.equal(url.protocol,"http:");assert.ok(["127.0.0.1","localhost","[::1]"].includes(url.hostname));
 assert.ok(Number(url.port)>0&&Number(url.port)<=65535);assert.equal(url.pathname,"/v1");assert.equal(url.search,"");assert.equal(url.hash,"");assert.equal(url.username,"");assert.equal(url.password,"");
 assert.equal(typeof stub.imageGenerationDispatches,"function");assert.equal(typeof stub.completionDispatches,"function");
 return {provider:{providerId:"openai",label:"First-session image fixture (owned loopback)",baseUrl:stub.baseUrl,apiStyle:"openai-chat-completions",defaultModel:"gpt-image-2",apiKeyEnv:DETERMINISTIC_LLM_KEY_ENV,capabilities:{...DETERMINISTIC_LLM_CAPABILITIES,imageGenerate:true}},metadataKey:"openai/gpt-image-2",metadata:{contextWindow:128000,outputTokenLimit:16000,reasoning:{supportedEfforts:["none","low","medium","high"]}}};
}
export function assertFirstSessionCreatedOwner(record,workspaceId){
 assert.ok(record&&typeof record.sessionId==="string"&&/^[A-Za-z0-9._:-]{1,256}$/u.test(record.sessionId),"Unconfirmed first-session identity");assert.equal(record.workspaceId,workspaceId,"First-session creation returned foreign workspace");return record;
}
export function classifyFirstSessionSidebarRead(raw,workspaceId){
 let url;try{url=new URL(raw);}catch{return null;}
 const matches=path=>{const value=new URL(path,"http://fixture.invalid");return value.pathname==="/api/v1/chat/sessions"&&value.searchParams.get("workspaceId")===workspaceId&&value.searchParams.get("scope")==="all"&&value.searchParams.get("includeActivity")==="true";};
 if(url.pathname!=="/api/v1/startup-reads")return matches(url.pathname+url.search)?{transport:"direct",matchingSidebarReads:1,complete:true}:null;
 const gap=()=>({transport:"batch",matchingSidebarReads:0,complete:false,gap:"startup_read_membership"});
 if(Buffer.byteLength(url.search)>STARTUP_READ_BATCH_QUERY_LIMIT)return gap();
 try{
  if([...url.searchParams.keys()].some(key=>key!=="reads")||url.searchParams.getAll("reads").length!==1)return gap();
  const rows=JSON.parse(url.searchParams.get("reads"));if(!Array.isArray(rows)||rows.length>STARTUP_READ_BATCH_LIMIT||rows.some(row=>!isStartupReadRequest(row)))return gap();
  const count=rows.filter(row=>matches(row.path)).length;if(count>1)return gap();
  return count?{transport:"batch",matchingSidebarReads:count,complete:true}:null;
 }catch{return gap();}
}
/** Request-attempt guard for the canonical empty workspace, including batched core hydration. */
export function recordFirstSessionHydrationAttempt(stats,request){
 try{
  if(request.method()!=="GET")return;
  const url=new URL(request.url());
  const owner=url=>{
   const match=/^\/api\/v1\/chat\/sessions\/([^/]+)\/(thread|core-state)$/u.exec(url.pathname);
   if(!match)return null;
   if(match[2]==="core-state"){
    assert.ok([...url.searchParams.keys()].every(key=>key==="includeThread")&&url.searchParams.getAll("includeThread").length<=1);
    const value=url.searchParams.get("includeThread");assert.ok(value===null||value==="true"||value==="false");
    if(value==="false")return null;
   }
   return decodeURIComponent(match[1]);
  };
  let ids;
  if(url.pathname==="/api/v1/startup-reads"){
   assert.ok(Buffer.byteLength(url.pathname+url.search,"utf8")<=STARTUP_READ_BATCH_QUERY_LIMIT+100);
   assert.ok(url.searchParams.getAll("reads").length===1&&[...url.searchParams.keys()].every(key=>key==="reads"));
   const rows=JSON.parse(url.searchParams.get("reads"));
   assert.ok(Array.isArray(rows)&&rows.length>0&&rows.length<=STARTUP_READ_BATCH_LIMIT&&rows.every(isStartupReadRequest));
   ids=rows.map(row=>owner(new URL(row.path,"http://startup-read.invalid"))).filter(id=>id!==null);
   assert.equal(new Set(ids).size,ids.length);
  }else{const id=owner(url);ids=id===null?[]:[id];}
  for(const id of ids){if(stats.threads.length>=64){stats.observationGap=true;break;}stats.threads.push(id);}
 }catch{stats.observationGap=true;}
}
export function assertNoFirstSessionHydration(stats){
 assert.equal(stats.observationGap,false,"First-session hydration observation has a gap");
 assert.equal(stats.threads.length,0,"Empty first-session workspace attempted premature transcript hydration");
}
export function createFirstSessionReceiptGate({phase,timeoutMs=15000}){
 assert.ok(["creation-status","upload-receipt"].includes(phase));assert.ok(Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=15000);
 let capturedResolve,capturedReject,releaseResolve,releaseReject,admitted=false,disposed=false;
 const captured=new Promise((resolve,reject)=>{capturedResolve=resolve;capturedReject=reject;});void captured.catch(()=>undefined);
 const released=new Promise((resolve,reject)=>{releaseResolve=resolve;releaseReject=reject;});void released.catch(()=>undefined);
 const timer=setTimeout(()=>{const error=new Error("First-session owned receipt gate deadline");capturedReject(error);releaseReject(error);},timeoutMs);
 return {captured,async hold(response){assert.ok(!admitted&&!disposed,"Receipt gate may admit once; duplicate admission refused");admitted=true;capturedResolve(response);await released;return response;},release(){clearTimeout(timer);releaseResolve();},async dispose(){disposed=true;clearTimeout(timer);if(!admitted)capturedReject(new Error("First-session gate disposed before receipt"));releaseResolve();}};
}

const PNG=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const CASES=["manual-first-attachment","button-image-first-attachment","auto-image-first-attachment","held-upload-draft-edit","pending-creator-shell-navigation","uploader-conversation-switch","unconfirmed-upload-receipt","confirmed-reload-isolation"];
const imagePrompt="Create an image of a teal goat beside a silver moon.";
const observed=pending=>{void pending.catch(()=>undefined);return pending;};
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");

/** Additive cases within the existing composer scenario IDs. No ordinary turn or model service is invoked. */
export async function runCockpitChatFirstSessionProof({context,browser,stack,citadelId,variant,viewport,deps,controls,readProviderCounters}){
 const {requestJson,assertOk,path,relativeToRun,installMissionControlNextBrowserState}=deps;
 assert.ok(stack.runtimeRoot&&/^goatcitadel-usability-/u.test(path.basename(stack.runtimeRoot)),"First-session proof requires owned disposable runtime");
 const screenshots=[],diagnostics=[],cases=[];
 for(const caseName of CASES){
  const token=randomUUID().slice(0,8),report={caseName,variant,stage:"empty workspace",delayedSidebarInterleaving:"unit-only; browser not exercised"};
  let browserContext,page,creatorGate,uploadGate,apiHandler;
  const routeTasks=new Set();
  try{
   const api=async(route,init)=>{const response=await requestJson(stack.gatewayUrl,route,init);assertOk(response,route);return response.body;};
   const workspace=await api("/api/v1/workspaces",{method:"POST",body:{name:`First attachment ${variant} ${caseName} ${token}`,...(citadelId?{citadelId}:{})}});
   assert.ok(workspace.workspaceId&&workspace.citadelId);const workspaceId=workspace.workspaceId;
   const before=await api(`/api/v1/chat/sessions?${new URLSearchParams({workspaceId,scope:"all",view:"all",limit:"200"})}`);assert.deepEqual(before.items,[],"First-session workspace must have no existing conversation");
   report.workspaceId=workspaceId;
   const countersBefore=readProviderCounters();
   const stats={creates:[],images:0,uploads:0,sends:0,renames:0,threads:[],foreignRequests:0,sidebar:[],observationGap:false};report.traffic=stats;
   const stored=[];let created,otherCreated,confirmed=false,sidebarObservationArmed=false,creatorHandled=false,heldUploadNumber=0;
   const isImage=!["manual-first-attachment","confirmed-reload-isolation","pending-creator-shell-navigation"].includes(caseName);
   const expectedImages=caseName==="uploader-conversation-switch"?2:isImage?1:0;
   const expectedUploads=caseName==="pending-creator-shell-navigation"?0:caseName==="uploader-conversation-switch"?2:1;
   const expectedCreates=["uploader-conversation-switch","confirmed-reload-isolation"].includes(caseName)?2:1;
   browserContext=await browser.newContext({viewport,colorScheme:variant==="mobile"?"light":"dark"});browserContext.setDefaultTimeout(15000);
   const allowed=new Set([new URL(stack.uiUrl).origin,new URL(stack.gatewayUrl).origin]);
   await browserContext.route("**/*",async route=>{const url=new URL(route.request().url());if(["data:","blob:"].includes(url.protocol)||allowed.has(url.origin))return route.fallback();stats.foreignRequests++;await route.abort("blockedbyclient");});
   await browserContext.addInitScript(theme=>{window.localStorage.setItem("goatcitadel.ui.shell.v1","cockpit");window.localStorage.setItem("goatcitadel.ui.theme.v1",theme);},variant==="mobile"?"light":"dark");
   await installMissionControlNextBrowserState(browserContext,workspaceId,workspace.citadelId);
   page=await browserContext.newPage();
   page.on("request",request=>{
    try{
     const url=new URL(request.url()),method=request.method();
     if(method==="POST"&&url.pathname==="/api/v1/chat/sessions")assert.equal(request.postDataJSON().workspaceId,workspaceId);
     if(method==="POST"&&url.pathname==="/api/v1/llm/images"){stats.images++;const body=request.postDataJSON();assert.equal(body.providerId,"openai");assert.equal(body.model,"gpt-image-2");assert.equal(body.outputFormat,"png");}
     if(method==="POST"&&url.pathname==="/api/v1/chat/attachments")stats.uploads++;
     if(method==="POST"&&/\/chat\/sessions\/[^/]+\/(?:agent-send|send)(?:\/stream)?$/u.test(url.pathname))stats.sends++;
     if(method==="PATCH"&&/^\/api\/v1\/chat\/sessions\/[^/]+$/u.test(url.pathname))stats.renames++;
     recordFirstSessionHydrationAttempt(stats,request);
     if(method==="GET"&&sidebarObservationArmed){const membership=classifyFirstSessionSidebarRead(request.url(),workspaceId);if(membership){if(stats.sidebar.length>=64)stats.observationGap=true;else stats.sidebar.push(membership);if(!membership.complete)stats.observationGap=true;}}
    }catch{stats.observationGap=true;}
   });
   apiHandler=route=>{
    const task=(async()=>{
     const request=route.request(),url=new URL(request.url()),method=request.method();
     if(method==="POST"&&url.pathname==="/api/v1/chat/sessions"){
      const input=request.postDataJSON();assert.equal(input.workspaceId,workspaceId);
      const response=await route.fetch({maxRetries:0,maxRedirects:0,timeout:15000});assert.equal(response.status(),201);
      const record=assertFirstSessionCreatedOwner(await response.json(),workspaceId);stats.creates.push(record.sessionId);
      if(!created)created=record;else{assert.ok(expectedCreates===2&&stats.creates.length===2,"No implicit creation retry or substitute conversation allowed");otherCreated=record;assert.notEqual(record.sessionId,created.sessionId);}
      return route.fulfill({response});
     }
     if(method==="GET"&&created&&url.pathname===`/api/v1/chat/sessions/${encodeURIComponent(created.sessionId)}/status`&&!creatorHandled){
      creatorHandled=true;const response=await route.fetch({maxRetries:0,maxRedirects:0,timeout:15000});assert.equal(response.status(),200);
      const owner=assertFirstSessionCreatedOwner(await response.json(),workspaceId);assert.equal(owner.sessionId,created.sessionId);confirmed=true;
      return route.fulfill({response:await creatorGate.hold(response)});
     }
     if(method==="POST"&&url.pathname==="/api/v1/chat/attachments"){
      assert.equal(url.searchParams.get("sessionId"),created?.sessionId,"Upload left its actually created owner");
      assert.ok(confirmed,"Upload occurred before independent creator confirmation");
      const response=await route.fetch({maxRetries:0,maxRedirects:0,timeout:15000});assert.equal(response.status(),201);
      const record=await response.json();assert.equal(record.fileName,url.searchParams.get("fileName"));assert.equal(record.mimeType,url.searchParams.get("mimeType"));stored.push(record);
      if(stored.length===heldUploadNumber)await uploadGate.hold(response);
      if(caseName==="unconfirmed-upload-receipt")return route.fulfill({status:502,headers:{"content-type":"application/json"},body:JSON.stringify({error:"Synthetic attachment receipt was not confirmed."})});
      return route.fulfill({response});
     }
     return route.fallback();
    })();routeTasks.add(task);void task.finally(()=>routeTasks.delete(task)).catch(()=>undefined);return task;
   };
   await page.route("**/api/v1/**",apiHandler);
   await page.goto(deps.buildVerificationUiUrl(stack.uiUrl,"/chat?shell=cockpit"),{waitUntil:"domcontentloaded"});
   await page.waitForSelector('[data-cockpit-ready="true"]',{timeout:30000});
   const draft=page.getByRole("textbox",{name:"Message",exact:true});
   await page.getByText("Choose a conversation",{exact:true}).waitFor();
   assert.equal(await draft.count(),0,"Canonical empty Chat must not be relabelled as a null-owner composer");
   assert.equal(new URL(page.url()).searchParams.get("sessionId"),null);assert.equal(stats.creates.length,0);assertNoFirstSessionHydration(stats);
   const admitted=isImage?imagePrompt:`Synthetic retained attachment draft ${token}`;
   creatorGate=createFirstSessionReceiptGate({phase:"creation-status"});
   const creatorReply=observed(page.waitForResponse(response=>response.request().method()==="GET"&&created&&new URL(response.url()).pathname===`/api/v1/chat/sessions/${encodeURIComponent(created.sessionId)}/status`));
   report.stage="actual explicit New conversation operator entry";
   const create=page.getByRole("button",{name:"New conversation",exact:true});assert.equal(await create.count(),1);await create.click();
   await creatorGate.captured;report.sessionId=created.sessionId;assert.equal(stats.uploads,0,"Held creator status must precede file upload");
   assert.equal(stats.images,0);assert.equal(await draft.count(),0,"No typing or media controls are reachable while explicit creation is pending");
   report.entry="empty Chat -> explicit UI New conversation -> independently confirmed selected owner";
   report.stage="held independent creator confirmation";
   if(caseName==="pending-creator-shell-navigation"){
    const areas=page.getByRole("navigation",{name:variant==="mobile"?"Areas on small screens":"Areas",exact:true});
    await nativeNavigation(()=>areas.getByRole("link",{name:"Library",exact:true}).click(),url=>url.pathname==="/library");
    sidebarObservationArmed=true;creatorGate.release();await(await creatorReply).finished();await settleFrames();
    assert.equal(new URL(page.url()).pathname,"/library");assert.equal(stats.uploads,0);assert.equal(stats.sends,0);
    const owner=await api(`/api/v1/chat/sessions/${encodeURIComponent(created.sessionId)}/status`);assertFirstSessionCreatedOwner(owner,workspaceId);
    report.canonicalCreationMayRemain=true;
   }else{
    sidebarObservationArmed=true;creatorGate.release();await(await creatorReply).finished();
    await page.waitForURL(url=>url.pathname==="/chat"&&url.searchParams.get("sessionId")===created.sessionId);await draft.waitFor();
    assertFirstSessionCreatedOwner(await api(`/api/v1/chat/sessions/${encodeURIComponent(created.sessionId)}/status`),workspaceId);
    await draft.fill(admitted);
    if(["held-upload-draft-edit","unconfirmed-upload-receipt"].includes(caseName)){heldUploadNumber=1;uploadGate=createFirstSessionReceiptGate({phase:"upload-receipt"});}
    const uploadReply=observed(page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/api/v1/chat/attachments"&&new URL(response.url()).searchParams.get("sessionId")===created.sessionId));
    report.stage="first attachment in explicitly created reachable composer";
    if(!isImage){
     const chooser=observed(page.waitForEvent("filechooser"));await controls.revealAttachControl(page);await page.getByRole("button",{name:"Attach files",exact:true}).click();
     await(await chooser).setFiles({name:`first-${token}.txt`,mimeType:"text/plain",buffer:Buffer.from(`Owned first attachment ${token}.`)});await controls.closeComposerOptions(page);
    }else if(caseName==="button-image-first-attachment")await clickFirstSessionCreateImage(page,controls);
    else await page.getByRole("button",{name:"Send",exact:true}).click();
    if(uploadGate){await uploadGate.captured;report.stage="held real upload receipt";
     if(caseName==="held-upload-draft-edit")await draft.fill(`Final replacement while upload pending ${token}`);
     uploadGate.release();
    }
    const reply=await uploadReply;
    if(caseName==="unconfirmed-upload-receipt"){
     assert.equal(reply.status(),502);await page.getByText("The attachment didn’t upload. Select the file again to retry.",{exact:true}).waitFor();
     assert.equal(await draft.inputValue(),admitted);assert.equal(await page.locator('[aria-label="Attached files"]').count(),0);
     assert.equal(await page.getByText(/^Detected image request and generated it via /u).count(),0);assert.equal(await page.getByText("Generated image added to the draft attachments.",{exact:true}).count(),0);
     await checkStored(stored[0]);report.storedButBrowserUnconfirmed=true;
    }else{
     assert.equal(reply.status(),201);const record=await reply.json();await chip(record).waitFor();await checkStored(record);
     await page.waitForURL(url=>url.pathname==="/chat"&&url.searchParams.get("sessionId")===created.sessionId);
     const expectedDraft=caseName==="held-upload-draft-edit"?`Final replacement while upload pending ${token}`:caseName==="button-image-first-attachment"||!isImage?admitted:"";
     assert.equal(await draft.inputValue(),expectedDraft);await waitPersisted(record);
     if(isImage){const notice=caseName==="button-image-first-attachment"?page.getByText("Generated image added to the draft attachments.",{exact:true}):page.getByText(/^Detected image request and generated it via /u);await notice.waitFor();}
     if(caseName==="confirmed-reload-isolation"){
      report.stage="actual successful reload";await page.reload({waitUntil:"domcontentloaded"});await draft.waitFor();await chip(record).waitFor();assert.equal(new URL(page.url()).searchParams.get("sessionId"),created.sessionId);assert.equal(await draft.inputValue(),admitted);
     }
     if(["uploader-conversation-switch","confirmed-reload-isolation"].includes(caseName)){
      report.stage="actual UI creates other conversation and selects exact unique owners";
      const ownTitle=`First owner ${token}`,otherTitle=`Other owner ${token}`;await renameCurrent(created.sessionId,ownTitle);
      const otherReply=observed(page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/api/v1/chat/sessions"));
      await page.keyboard.press("Control+k");const palette=page.getByRole("dialog",{name:"Command palette",exact:true});await palette.getByRole("combobox",{name:"Search or run a command",exact:true}).fill("New chat");
      await nativeNavigation(()=>palette.getByRole("option",{name:/^New chat Create one conversation/u}).click(),url=>url.pathname==="/chat"&&url.searchParams.get("sessionId")!==created.sessionId&&Boolean(url.searchParams.get("sessionId")));
      const otherResponse=await otherReply;assert.equal(otherResponse.status(),201);const other=assertFirstSessionCreatedOwner(await otherResponse.json(),workspaceId);assert.equal(other.sessionId,otherCreated?.sessionId);
      await renameCurrent(other.sessionId,otherTitle);assert.equal(await page.locator('[aria-label="Attached files"]').count(),0);
      await selectExact(ownTitle,created.sessionId);await chip(record).waitFor();
      if(caseName==="uploader-conversation-switch"){
       heldUploadNumber=2;uploadGate=createFirstSessionReceiptGate({phase:"upload-receipt"});await draft.fill(imagePrompt);
       const secondReply=observed(page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/api/v1/chat/attachments"));
       await page.getByRole("button",{name:"Send",exact:true}).click();await uploadGate.captured;
       await selectExact(otherTitle,other.sessionId);const foreignDraft=`Other owner kept text ${token}`;await draft.fill(foreignDraft);uploadGate.release();const staleReply=await secondReply;assert.equal(staleReply.status(),201);await staleReply.finished();await settleFrames();
       assert.equal(new URL(page.url()).searchParams.get("sessionId"),other.sessionId);assert.equal(await draft.inputValue(),foreignDraft);assert.equal(await page.locator('[aria-label="Attached files"]').count(),0);
       await checkStored(stored[1]);await selectExact(ownTitle,created.sessionId);await chip(record).waitFor();assert.equal(await chip(stored[1]).count(),0,"Stale second receipt must not be adopted");report.oldOwnerStoredWithoutLateAdoption=true;
      }else{
       await selectExact(otherTitle,other.sessionId);assert.equal(await page.locator('[aria-label="Attached files"]').count(),0);await selectExact(ownTitle,created.sessionId);await chip(record).waitFor();
      }
     }
    }
    await settleFrames();assert.equal(await page.getByText(/^Uploading \d+ attachments?…$/u).count(),0);assert.equal(await page.getByRole("button",{name:"Creating image…",exact:true}).count(),0);
    report.sidebarObservation="passive direct/batch; zero rows is permitted for explicit local-record insertion";
   }
   const afterCounters=readProviderCounters();
   assert.equal(afterCounters.imageGenerations-countersBefore.imageGenerations,expectedImages);for(const field of ["primaryCompletions","alternateCompletions","imageCompletions"])assert.equal(afterCounters[field]-countersBefore[field],0,"Unexpected completion dispatch during attachment-only subflow");
   assert.equal(stats.images,expectedImages);assert.equal(stats.uploads,expectedUploads);assert.equal(stats.creates.length,expectedCreates);assert.equal(stats.sends,0);assert.equal(stats.foreignRequests,0);assert.equal(stats.observationGap,false);
   assert.equal(stats.renames,expectedCreates===2?2:0);
   for(const id of stats.creates){const owner=await api(`/api/v1/chat/sessions/${encodeURIComponent(id)}/status`);assertFirstSessionCreatedOwner(owner,workspaceId);const thread=await api(`/api/v1/chat/sessions/${encodeURIComponent(id)}/thread`);assert.equal(thread.sessionId,id);assert.deepEqual(thread.turns,[]);}
   report.providerDelta={imageGenerations:expectedImages,completionDispatches:0};report.status="passed";
   await captureCase();cases.push(report);

   function chip(record){return page.getByRole("button",{name:`Remove ${record.fileName}`,exact:true});}
   async function checkStored(record){
    assert.ok(record);const canonical=await api(`/api/v1/chat/attachments/${encodeURIComponent(record.attachmentId)}`);
    const response=await browserContext.request.get(new URL(`/api/v1/chat/attachments/${encodeURIComponent(record.attachmentId)}/content?disposition=attachment`,stack.gatewayUrl).href);assert.equal(response.status(),200);const bytes=await response.body();
    if(isImage){assert.match(record.fileName,/^goatcitadel-generate-[0-9TZ-]+\.png$/u);assertUploadedBinaryAttachment(record,{workspaceId,sessionId:created.sessionId,fileName:record.fileName,mimeType:"image/png",bytes:PNG},canonical,bytes);}
    else{assertUploadedAttachment(record,{workspaceId,sessionId:created.sessionId,fileName:`first-${token}.txt`,mimeType:"text/plain",content:`Owned first attachment ${token}.`});assert.deepEqual(canonical,record);assert.deepEqual(bytes,Buffer.from(`Owned first attachment ${token}.`));}
   }
   async function waitPersisted(record){await page.waitForFunction(({attachmentId,workspaceId,sessionId})=>Object.keys(window.localStorage).filter(key=>key.startsWith("goatcitadel.chat.attachments.")).some(key=>{try{const rows=JSON.parse(window.localStorage.getItem(key));return Array.isArray(rows)&&rows.some(row=>row.attachmentId===attachmentId&&row.workspaceId===workspaceId&&row.sessionId===sessionId);}catch{return false;}}),{attachmentId:record.attachmentId,workspaceId,sessionId:created.sessionId},{timeout:15000});}
   async function settleFrames(){await page.evaluate(()=>new Promise(resolve=>globalThis.requestAnimationFrame(()=>globalThis.requestAnimationFrame(resolve))));}
   async function nativeNavigation(trigger,predicate){const prior=page.url();await trigger();const dialog=page.getByRole("dialog",{name:"Unsaved changes",exact:true});const outcome=await Promise.race([observed(page.waitForURL(predicate)).then(()=>"destination"),observed(dialog.waitFor({state:"visible"})).then(()=>"review")]);if(outcome==="review"){assert.equal(page.url(),prior);assert.equal(await dialog.count(),1);await dialog.getByRole("button",{name:"Keep draft and close",exact:true}).click();await dialog.waitFor({state:"hidden"});}await page.waitForURL(predicate);}
   async function renameCurrent(id,title){
    await page.getByRole("button",{name:"Rename conversation",exact:true}).click();await page.getByRole("textbox",{name:"Conversation title",exact:true}).fill(title);
    const response=observed(page.waitForResponse(value=>value.request().method()==="PATCH"&&new URL(value.url()).pathname===`/api/v1/chat/sessions/${encodeURIComponent(id)}`));
    const save=page.getByRole("button",{name:"Save",exact:true});assert.equal(await save.count(),1);await save.click();assert.equal((await response).status(),200);assert.equal((await api(`/api/v1/chat/sessions/${encodeURIComponent(id)}/status`)).title,title);await page.getByRole("heading",{name:title,exact:true}).waitFor();
   }
   async function selectExact(title,id){await controls.closeComposerOptions(page);const list=await openConversationList(page);const row=conversationNavigation(list).getByRole("button",{name:new RegExp("^"+escapeRegex(title),"u")});assert.equal(await row.count(),1,"Synthetic conversation label must identify exactly one canonical owner");await nativeNavigation(()=>row.click(),url=>url.searchParams.get("sessionId")===id);await closeConversationList(page);assert.equal((await api(`/api/v1/chat/sessions/${encodeURIComponent(id)}/status`)).title,title);}
   async function captureCase(){const directory=path.join(context.artifactRoot,"screenshots");await mkdir(directory,{recursive:true});const file=path.join(directory,`cockpit-first-session-${variant}-${caseName}.png`);await page.screenshot({path:file,fullPage:false});screenshots.push(relativeToRun(context,file));}
  }catch(error){
   report.status="failed";report.error=error instanceof Error?error.message.slice(0,1000):"First-session fixture failed";
   if(page&&!page.isClosed()){try{const directory=path.join(context.artifactRoot,"screenshots");await mkdir(directory,{recursive:true});const file=path.join(directory,`cockpit-first-session-${variant}-${caseName}-failure.png`);await page.screenshot({path:file,fullPage:false});screenshots.push(relativeToRun(context,file));}catch{/* Preserve original case outcome. */}}
   cases.push(report);
  }finally{
   await creatorGate?.dispose();await uploadGate?.dispose();if(page&&apiHandler)await page.unroute("**/api/v1/**",apiHandler).catch(()=>undefined);await Promise.allSettled([...routeTasks]);await browserContext?.close();
  }
  if(report.status!=="passed")break;
 }
 const directory=path.join(context.artifactRoot,"diagnostics");await mkdir(directory,{recursive:true});const file=path.join(directory,`cockpit-first-session-${variant}.json`);
 const excluded=["Initial-null attachment/image/typing: canonical empty Chat has no composer","Creator-pending draft editing or conversation switching: no composer or existing conversation","Delayed-sidebar interleaving: defensive focused hook unit coverage only","Dedicated Cockpit retained-prompt action and multipart image edit: not exposed/in scope"];
 const {redactStructuredSecrets}=await import("../../../../packages/contracts/dist/secret-redaction.js");const payload=redactStructuredSecrets({inventory:CASES,cases,notExecuted:CASES.slice(cases.length),excluded}).value;
 assert.ok(Buffer.byteLength(JSON.stringify(payload,null,2)+"\n")<=65536,"First-session diagnostic exceeds bound");await writeFile(file,JSON.stringify(payload,null,2)+"\n");diagnostics.push(relativeToRun(context,file));
 return {passed:cases.length===CASES.length&&cases.every(value=>value.status==="passed"),inventory:payload.inventory,notExecuted:payload.notExecuted,excluded:payload.excluded,error:payload.cases.find(value=>value.status!=="passed")?.error,cases:payload.cases,screenshots,diagnostics};
}
