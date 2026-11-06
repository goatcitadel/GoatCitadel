import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";

export const COCKPIT_PERFORMANCE_LIMITS = Object.freeze({ startupRequests:20, idleRequests:12, elsewhereTurnRequests:10, initialJavaScriptGzipBytes:350_000, cls:0.10 });
export function evaluateCockpitPerformance(measured) {
 const failures=[];
 for(const [key,limit] of Object.entries(COCKPIT_PERFORMANCE_LIMITS))if(!Number.isFinite(measured[key])||measured[key]>limit)failures.push(`${key}: ${measured[key] ?? "unmeasured"} exceeds ${limit}`);
 if(measured.chatReadyWithinStartupWindow !== true)failures.push("Chat did not become ready within the unchanged startup measurement window");
 if(measured.firstFrameTheme!==measured.expectedTheme)failures.push("First-frame theme differs from the saved preference");
 if(measured.inverseFirstFrameTheme!=="light" || measured.inverseExpectedTheme!=="light")failures.push("Inverse first-frame theme is unmeasured or differs from the saved light preference");
 if(measured.firstFrameBackground!=="rgb(18, 34, 53)" || measured.inverseFirstFrameBackground!=="rgb(240, 248, 255)")failures.push("First-frame background differs from the retained theme boot colors");
 return {passed:failures.length===0,failures};
}
/** Keep approval-gated fixture work intact; a real new conversation owns the controlled background turn. */
export async function createCockpitPerformanceTurnSession({ stack, fixture, requestJson, assertOk }) {
 const result=await requestJson(stack.gatewayUrl,"/api/v1/chat/sessions",{method:"POST",body:{workspaceId:fixture.workspaceId,title:"Cockpit performance turn",mode:"chat"}});
 assertOk(result,"create the disposable controlled-turn conversation");
 const sessionId=result.body?.sessionId;
 if(typeof sessionId!=="string" || !/^[A-Za-z0-9._:-]{1,256}$/u.test(sessionId) || sessionId===fixture.sessionId || result.body?.workspaceId!==fixture.workspaceId) throw new Error("Controlled-turn conversation has no distinct canonical session in the requested workspace");
 return sessionId;
}

/** Record first visible Chat against the navigation deadline, including slow DOMContentLoaded. */
export async function installChatStartupReadinessProbe(page, deadline) {
 await page.addInitScript(({ deadline }) => {
  window.cockpitChatStartupReady = false;
  const check = () => {
   if (Date.now() > deadline) return;
   const bounds = document.querySelector('[aria-label="Messages"]')?.getBoundingClientRect();
   if (bounds && bounds.height > 0 && bounds.width > 0) { window.cockpitChatStartupReady = true; return; }
   globalThis.requestAnimationFrame(check);
  };
  globalThis.requestAnimationFrame(check);
 }, { deadline });
}

/** Counts every request except the established SSE exclusion, including dynamically loaded JavaScript. */
export async function runCockpitPerformanceProof({ context,browser,stack,fixture,deps,startupDiagnosticOnly=false }) {
 const { runScenario,installMissionControlNextBrowserState,buildVerificationUiUrl,writeJson,path,relativeToRun,requestJson,assertOk,attachBrowserLogging,captureBrowserArtifacts }=deps;
 for(let index=0;index<3;index++)await runScenario(context,{id:`cockpit-performance.cold-${index+1}`,lane:"ux-budgets",title:`Matched Cockpit cold run ${index+1}`,subsystem:"mission-control-performance"},async()=>{
  const browserContext=await browser.newContext({viewport:{width:1440,height:900},colorScheme:"light"});
  let measured = {expectedTheme:"dark"};
  const requests=[],scripts=new Map(),pending=[];
  const startupReads=createStartupReadDiagnostics({fixture}), startupHandles=new WeakMap(), startupStatuses=new WeakMap();
  let startupDiagnosticWritten=false;
  let page, browserLog;
  const artifact=path.join(context.artifactRoot,"diagnostics",`cockpit-performance-${index+1}.json`);
  const startupArtifact=path.join(context.artifactRoot,"diagnostics",`cockpit-performance-${index+1}-startup-reads.json`);
  const save=async acceptance=>{
   const diagnostic=await persistStartupReadDiagnostics({collector:startupReads,file:startupArtifact,acceptance,sensitiveValues:fixture.sensitiveValues??[]},{writeJson});
   startupDiagnosticWritten=diagnostic.written;
   const startupReadDiagnostic={written:diagnostic.written,complete:diagnostic.complete,...(diagnostic.gapReason?{gapReason:diagnostic.gapReason}:{})};
   await writeJson(artifact,{measured,acceptance,limits:COCKPIT_PERFORMANCE_LIMITS,windows:{startupMs:3500,idleMs:120_000,settleMs:10_000,elsewhereTurnMs:10_000},exclusions:["/api/v1/events/stream"],requests:requests.slice(0,2000),scripts:[...scripts.entries()].slice(0,500),startupReadDiagnostic});
  };
  const startupDiagnosticRefs=()=>startupDiagnosticWritten?[relativeToRun(context,startupArtifact)]:[];
  try {
   await installMissionControlNextBrowserState(browserContext,fixture.workspaceId,fixture.citadelId);
   await browserContext.addInitScript(()=>{
    globalThis.localStorage.setItem("goatcitadel.ui.shell.v1","cockpit");globalThis.localStorage.setItem("goatcitadel.ui.theme.v1","dark");
    window.cockpitPerformance={cls:0,shifts:[],firstFrameTheme:undefined};
    new PerformanceObserver(list=>{for(const entry of list.getEntries())if(!entry.hadRecentInput){window.cockpitPerformance.cls+=entry.value;if(window.cockpitPerformance.shifts.length<16)window.cockpitPerformance.shifts.push({value:entry.value,sources:entry.sources.slice(0,6).map(source=>({tag:source.node?.tagName,label:source.node?.getAttribute?.("aria-label"),className:String(source.node?.className??"").slice(0,200),previous:source.previousRect.toJSON(),current:source.currentRect.toJSON()}))});}}).observe({type:"layout-shift",buffered:true});
    globalThis.requestAnimationFrame(()=>{window.cockpitPerformance.firstFrameTheme=document.documentElement.dataset.theme;window.cockpitPerformance.firstFrameBackground=getComputedStyle(document.documentElement).backgroundColor;});
   });
   page=await browserContext.newPage();browserLog=attachBrowserLogging(page);let started=performance.now();
   page.on("request",request=>{
    const url=new URL(request.url()), at=performance.now()-started;
    if(at<=3500) { try { const handle=startupReads.start({url:request.url(),method:request.method(),at}); if(handle!==null)startupHandles.set(request,handle); } catch { startupReads.markProjectionGap(); } }
    if(url.pathname!=="/api/v1/events/stream")requests.push({path:url.pathname,at});
    // Count scripts begun during startup even when a slow response arrives after its window.
    if(request.resourceType()==="script"&&at<=3500)pending.push(request.response().then(async response=>{if(!response)throw new Error("Startup script failed to load");scripts.set(url.pathname,gzipSync(await response.body()).length);}));
   });
   page.on("response",response=>{try{const request=response.request();if(startupHandles.has(request))startupStatuses.set(request,response.status());}catch{startupReads.markProjectionGap();}});
   page.on("requestfinished",request=>{try{if(startupHandles.has(request))startupReads.finish(startupHandles.get(request),{at:performance.now()-started,status:startupStatuses.get(request)});}catch{startupReads.markProjectionGap();}});
   page.on("requestfailed",request=>{try{if(startupHandles.has(request))startupReads.finish(startupHandles.get(request),{at:performance.now()-started,failed:true});}catch{startupReads.markProjectionGap();}});
   started=performance.now();
   await installChatStartupReadinessProbe(page, Date.now()+3500);
   await page.goto(buildVerificationUiUrl(stack.uiUrl,`/chat?sessionId=${encodeURIComponent(fixture.sessionId)}&shell=cockpit`),{waitUntil:"domcontentloaded"});
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,3500-(performance.now()-started))));
   const chatReadyWithinStartupWindow=await page.evaluate(()=>window.cockpitChatStartupReady===true);
   const frame=await page.evaluate(()=>window.cockpitPerformance);
   await Promise.all(pending);
   measured={...measured,startupRequests:requests.filter(item=>item.at<=3500).length,initialJavaScriptGzipBytes:[...scripts.values()].reduce((sum,value)=>sum+value,0),cls:frame.cls,layoutShifts:frame.shifts,firstFrameTheme:frame.firstFrameTheme,firstFrameBackground:frame.firstFrameBackground,chatReadyWithinStartupWindow};
   await save({passed:false,failures:["Measurement in progress"]});
   await page.waitForSelector('[aria-label="Messages"]');
   if (startupDiagnosticOnly) {
    const layout=await page.evaluate(() => [...document.querySelectorAll('[aria-label="Chat"], [aria-label="Messages"], header, form, main')].slice(0,12).map(element => ({tag:element.tagName,label:element.getAttribute("aria-label"),bounds:element.getBoundingClientRect().toJSON()})));
    measured.layout=layout;
    const artifacts=await captureBrowserArtifacts(context,{slug:`cockpit-startup-diagnostic-${index+1}`,page,browserLog,gatewayUrl:stack.gatewayUrl});
    const acceptance={passed:false,failures:["Startup diagnostic only; full idle, turn and theme acceptance is unmeasured"]};await save(acceptance);
    return {status:"failed",metrics:measured,notes:acceptance.failures,artifacts:{...artifacts,diagnostics:[...artifacts.diagnostics,relativeToRun(context,artifact),...startupDiagnosticRefs()]}};
   }
   const inboxPage=await browserContext.newPage();
   inboxPage.on("request",request=>{const url=new URL(request.url());if(url.pathname!=="/api/v1/events/stream")requests.push({path:url.pathname,at:performance.now()-started});});
   await inboxPage.goto(buildVerificationUiUrl(stack.uiUrl,"/inbox?shell=cockpit"),{waitUntil:"domcontentloaded"});
   await page.waitForTimeout(10_000);const idleStart=performance.now()-started;
   await page.waitForTimeout(60_000);await page.waitForTimeout(60_000);
   const idleRequests=requests.filter(item=>item.at>=idleStart&&item.at<idleStart+120_000).length;
   measured.idleRequests=idleRequests;await save({passed:false,failures:["Measurement in progress"]});
   await inboxPage.close();
   const turnSessionId=await createCockpitPerformanceTurnSession({stack,fixture,requestJson,assertOk});
   await page.getByRole("navigation",{name:"Areas",exact:true}).getByRole("link",{name:/^Inbox(?:,|$)/}).click();await page.waitForTimeout(10_000);
   const elsewhereStart=performance.now()-started;
   const turn={content:"Reply with PERFORMANCE_TURN_OK",webMode:"off",memoryMode:"off",thinkingLevel:"off",subagentPolicy:"off"};
   const preflight=await requestJson(stack.gatewayUrl,`/api/v1/chat/sessions/${encodeURIComponent(turnSessionId)}/route-preflight`,{method:"POST",body:{action:"send",...turn}});
   assertOk(preflight,"review the controlled provider route");
   if(!preflight.body?.decision)throw new Error("Provider route preflight returned no canonical decision");
   const sent=await requestJson(stack.gatewayUrl,`/api/v1/chat/sessions/${encodeURIComponent(turnSessionId)}/agent-send`,{method:"POST",body:{...turn,providerId:preflight.body.decision.effectiveProviderId,model:preflight.body.decision.effectiveModel,routeDecision:preflight.body.decision}});
   assertOk(sent,"complete the controlled Chat turn while viewing Inbox");
   if(sent.body?.sessionId!==turnSessionId || sent.body?.trace?.status!=="completed" || !sent.body?.assistantMessage?.content?.includes("UX_BUDGET_OK")) throw new Error("Controlled Chat turn did not record the expected completed provider result");
   await page.waitForTimeout(Math.max(0,10_000-(performance.now()-started-elsewhereStart)));
   const elsewhereTurnRequests=requests.filter(item=>item.at>=elsewhereStart&&item.at<elsewhereStart+10_000).length;
   measured.elsewhereTurnRequests=elsewhereTurnRequests;
   const inverseContext=await browser.newContext({viewport:{width:1440,height:900},colorScheme:"dark"});
   try {
    await installMissionControlNextBrowserState(inverseContext,fixture.workspaceId,fixture.citadelId);
    await inverseContext.addInitScript(()=>{
     globalThis.localStorage.setItem("goatcitadel.ui.shell.v1","cockpit");globalThis.localStorage.setItem("goatcitadel.ui.theme.v1","light");
     globalThis.requestAnimationFrame(()=>window.cockpitInverseFrame={theme:document.documentElement.dataset.theme,background:getComputedStyle(document.documentElement).backgroundColor});
    });
    const inversePage=await inverseContext.newPage();
    await inversePage.goto(buildVerificationUiUrl(stack.uiUrl,"/chat?shell=cockpit"),{waitUntil:"domcontentloaded"});
    await inversePage.waitForFunction(()=>Boolean(window.cockpitInverseFrame));
    const inverse=await inversePage.evaluate(()=>window.cockpitInverseFrame);
    measured={...measured,inverseExpectedTheme:"light",inverseFirstFrameTheme:inverse.theme,inverseFirstFrameBackground:inverse.background};
   } finally {await inverseContext.close();}
   const acceptance=evaluateCockpitPerformance(measured);
   await save(acceptance);
   return {status:acceptance.passed?"passed":"failed",metrics:measured,notes:acceptance.failures,artifacts:{diagnostics:[relativeToRun(context,artifact),...startupDiagnosticRefs()]}};
  } catch(error) {
    const acceptance={passed:false,failures:[String(error?.message??error).slice(0,3000)]};await save(acceptance);
    const artifacts=page && browserLog ? await captureBrowserArtifacts(context,{slug:`cockpit-performance-failure-${index+1}`,page,browserLog,gatewayUrl:stack.gatewayUrl}) : {};
    return {status:"failed",metrics:measured,notes:acceptance.failures,artifacts:{...artifacts,diagnostics:[...(artifacts.diagnostics??[]),relativeToRun(context,artifact),...startupDiagnosticRefs()]}};
  } finally {await browserContext.close();}
 });
}

const STARTUP_DIAGNOSTIC_TARGETS = new Set(["workspaces", "settings", "agents", "llm/config", "llm/models", "onboarding/state", "observe/health", "chat/projects", "chat/sessions", "chat/messaging", "chat/tools/approvals", "inbox", "durable/runs", "agentic/runs", "change-plans", "capabilities/autonomy-grants"]);
const STARTUP_DIAGNOSTIC_ENUMS = { mode: ["chat"], surface: ["chat", "cockpit"], scope: ["all", "mission", "external"], view: ["active", "archived", "all"], historyView: ["active", "archived", "all"] };
const STARTUP_DIAGNOSTIC_FLAGS = new Set(["includeActivity", "includeExpired", "includeThread", "includeArchived", "includeHidden", "includeDisabled", "cacheOnly", "forceRefresh", "includeUnknown"]);
const STARTUP_DIAGNOSTIC_SCOPES = { workspaceId: "workspace", sessionId: "session", citadelId: "citadel", runId: "run", parentRunId: "run", turnId: "turn", projectId: "project", folderId: "folder", boardId: "board", providerId: "provider", sessionIncarnation: "incarnation", incarnationId: "incarnation" };
const diagnosticBytes = value => Buffer.byteLength(JSON.stringify(value,null,2)+"\n");

/** Bounded observer projection only. No headers, bodies, correlation IDs or raw routes escape this closure. */
export function createStartupReadDiagnostics({ fixture = {}, maxQueryBytes = 7000, maxDescriptors = 16, maxEvents = 128, maxBytes = 65536 } = {}) {
 for (const [value, ceiling] of [[maxQueryBytes,7000],[maxDescriptors,16],[maxEvents,128],[maxBytes,65536]]) if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new Error("Invalid diagnostic bound");
 if (maxBytes < 1024) throw new Error("Invalid diagnostic byte bound");
 const events = [], gaps = new Map(), aliases = new Map(), aliasCounts = new Map();
 const counts = { observedEvents:0, retainedEvents:0, omittedEvents:0, observedDescriptors:0, retainedDescriptors:0, omittedDescriptors:0, malformedPackets:0 };
 const gap = reason => gaps.set(reason, (gaps.get(reason) ?? 0) + 1);
 const alias = (kind, value) => {
  if (typeof value !== "string" || value.length > 512 || !value) { gap("scope_not_projectable"); return null; }
  if (value === fixture[kind + "Id"]) return kind + ":fixture";
  const key = kind + ":" + value;
  if (!aliases.has(key)) {
   if (aliases.size >= 2048) { gap("alias_limit"); return null; }
   const ordinal = (aliasCounts.get(kind) ?? 0) + 1; aliasCounts.set(kind, ordinal); aliases.set(key, kind + ":" + ordinal);
  }
  return aliases.get(key);
 };
 const project = raw => {
  if (typeof raw !== "string" || raw.length > 1024 || !raw.startsWith("/api/v1/") || /[\\#\r\n]/u.test(raw)) { gap("route_not_projectable"); return null; }
  let url; try { url = new URL(raw, "http://diagnostic.invalid"); } catch { gap("route_not_projectable"); return null; }
  const tail = url.pathname.slice(8), scope = {}, settings = {}; let route;
  if (STARTUP_DIAGNOSTIC_TARGETS.has(tail)) route = "/api/v1/" + tail;
  else {
   const session = /^chat\/sessions\/([^/]+)\/(core-state|control|goal|external-source-attachments|delegations\/latest-explorer)$/u.exec(tail);
   const citadel = /^citadels\/([^/]+)\/structure$/u.exec(tail);
   const approval = /^approvals\/([^/]+)$/u.exec(tail);
   const run = /^agentic\/runs\/([^/]+)\/tree$/u.exec(tail);
   const match = session ?? citadel ?? approval ?? run;
   if (!match) { gap("route_not_projectable"); return null; }
   const kind = session ? "session" : citadel ? "citadel" : approval ? "approval" : "run";
   let value; try { value = decodeURIComponent(match[1]); } catch { gap("scope_not_projectable"); return null; }
   scope[kind + "Id"] = alias(kind, value);
   route = session ? "/api/v1/chat/sessions/:session/" + match[2] : citadel ? "/api/v1/citadels/:citadel/structure" : approval ? "/api/v1/approvals/:approval" : "/api/v1/agentic/runs/:run/tree";
  }
  const seen = new Set();
  for (const [key,value] of [...url.searchParams.entries()].sort(([a],[b])=>a.localeCompare(b))) {
   if (seen.has(key)) { gap("query_not_projectable"); continue; } seen.add(key);
   if (Object.hasOwn(STARTUP_DIAGNOSTIC_SCOPES,key)) {
    if(Object.hasOwn(scope,key)){gap("scope_identity_collision");return null;}
    scope[key] = alias(STARTUP_DIAGNOSTIC_SCOPES[key], value);
   }
   else if (key === "limit" && /^\d{1,4}$/u.test(value) && Number(value) >= 1 && Number(value) <= 1000) settings[key] = Number(value);
   else if (STARTUP_DIAGNOSTIC_FLAGS.has(key) && ["true","false"].includes(value)) settings[key] = value === "true";
   else if (Object.hasOwn(STARTUP_DIAGNOSTIC_ENUMS,key) && STARTUP_DIAGNOSTIC_ENUMS[key].includes(value)) settings[key] = value;
   else gap("query_not_projectable");
  }
  return { route, scope, settings };
 };
 return {
  markProjectionGap() { gap("projection_failure"); },
  start({url:raw,method,at}) {
   if (method !== "GET" || typeof raw !== "string" || raw.length > 32768) { if (method === "GET" && typeof raw === "string" && raw.length > 32768) gap("url_limit"); return null; }
   let url; try { url = new URL(raw); } catch { gap("invalid_url"); return null; }
   const batch = url.pathname === "/api/v1/startup-reads";
   if (!batch && (!url.pathname.startsWith("/api/v1/") || url.pathname === "/api/v1/events/stream")) return null;
   if (!batch && !STARTUP_DIAGNOSTIC_TARGETS.has(url.pathname.slice(8)) && !/^\/api\/v1\/(?:chat\/sessions\/[^/]+\/(?:core-state|control|goal|external-source-attachments|delegations\/latest-explorer)|citadels\/[^/]+\/structure|approvals\/[^/]+|agentic\/runs\/[^/]+\/tree)$/u.test(url.pathname)) return null;
   counts.observedEvents++;
   const event = { ordinal:counts.observedEvents,kind:batch?"batch":"direct",at:Number.isFinite(at)&&at>=0?at:null,completedAt:null,status:null,descriptors:[] };
   if (event.at === null) gap("invalid_timing");
   let rows;
   if (batch) {
    if (Buffer.byteLength(url.search) > maxQueryBytes) { gap("query_limit"); counts.malformedPackets++; rows=[]; }
    else {
     try {
      if ([...url.searchParams.keys()].some(key=>key!=="reads") || url.searchParams.getAll("reads").length!==1) throw new Error();
      rows=JSON.parse(url.searchParams.get("reads"));
      if (!Array.isArray(rows)) throw new Error();
     } catch { rows=[]; gap("malformed_packet"); counts.malformedPackets++; }
    }
   } else rows=[{path:url.pathname+url.search}];
   counts.observedDescriptors += rows.length;
   if (rows.length > maxDescriptors) gap("descriptor_limit");
   const retain = events.length < maxEvents;
   if (!retain) gap("event_limit");
   for (const row of rows.slice(0,maxDescriptors)) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key=>!["path","correlationId","originSurface"].includes(key)) || typeof row.path!=="string") { gap("malformed_packet"); counts.malformedPackets++; continue; }
    if (retain) { const descriptor=project(row.path); if (descriptor) event.descriptors.push(descriptor); }
   }
   if (!retain) return null;
   events.push(event); return event.ordinal;
  },
  finish(handle,{at,status,failed=false}) {
   if (handle === null) return;
   const event=events.find(item=>item.ordinal===handle); if (!event) return;
   if (!Number.isFinite(at) || at < event.at || (!failed && (!Number.isInteger(status)||status<100||status>599))) { gap("invalid_timing"); return; }
   event.completedAt=at; event.status=failed?null:status; if (failed) event.failed=true;
  },
  snapshot() {
   const retained=events.map(event=>({...event,descriptors:event.descriptors.map(descriptor=>({...descriptor,scope:{...descriptor.scope},settings:{...descriptor.settings}}))}));
   const assemble = () => {
    const pendingEvents=retained.filter(event=>event.completedAt===null).length;
    const projectionComplete=gaps.size===0,completionComplete=pendingEvents===0 && retained.length===counts.observedEvents;
    return {schemaVersion:1,complete:projectionComplete&&completionComplete,projectionComplete,completionComplete,
     descriptorCountKnown:!gaps.has("query_limit")&&!gaps.has("malformed_packet")&&!gaps.has("url_limit"),
     counts:{...counts,pendingEvents,retainedEvents:retained.length,omittedEvents:counts.observedEvents-retained.length,retainedDescriptors:retained.reduce((sum,event)=>sum+event.descriptors.length,0),omittedDescriptors:counts.observedDescriptors-retained.reduce((sum,event)=>sum+event.descriptors.length,0)},gaps:[...gaps].map(([reason,count])=>({reason,count})),events:retained};
   };
   let report=assemble();
   while (diagnosticBytes(report)>maxBytes && retained.length) { retained.pop(); gap("byte_limit"); report=assemble(); }
   return report;
  },
 };
}

/** Optional diagnostics cannot change acceptance or hide its original error. */
export async function persistStartupReadDiagnostics({collector,file,acceptance,sensitiveValues=[]},{writeJson,redact}={}) {
 try {
  const projected=collector.snapshot();let payload;
  if(redact){
   // Preserve the existing injectable string-in/string-out contract exactly.
   const clean=await redact(JSON.stringify(projected));
   if(typeof clean!=="string"||Buffer.byteLength(clean)>65536)throw new Error();
   payload=JSON.parse(clean);
  }else{
   const {redactStructuredSecrets}=await import("../../../../packages/contracts/dist/secret-redaction.js");
   const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>/(?:TOKEN|(?:^|_)KEY(?:_|$)|SECRET|PASSWORD|CREDENTIAL)/iu.test(name)));
   const secrets=[...new Set([...Object.values(env),...sensitiveValues].filter(value=>typeof value==="string"&&value))].sort((a,b)=>b.length-a.length);
   if(diagnosticBytes(projected)>65536)throw new Error();
   let nodes=0;
   const stringLeaves=(value,depth=0)=>{
    if(++nodes>10000||depth>12)throw new Error();
    if(typeof value==="string"){for(const secret of secrets)value=value.split(secret).join("[REDACTED]");return value;}
    if(Array.isArray(value))return value.map(entry=>stringLeaves(entry,depth+1));
    if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,stringLeaves(entry,depth+1)]));
    return value;
   };
   // Exact classified-secret matching remains strict even for short strings/"true", but cannot
   // rewrite JSON punctuation, property names or primitive boolean/number tokens.
   payload=redactStructuredSecrets(stringLeaves(projected),{env}).value;
  }
  if(diagnosticBytes(payload)>65536)throw new Error();await writeJson(file,payload);
  return {acceptance,complete:projected.complete,written:true};
 }catch{return {acceptance,complete:false,written:false,gapReason:"diagnostic_write_failure"};}
}
