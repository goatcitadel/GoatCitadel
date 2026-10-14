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
  let page, browserLog;
  const artifact=path.join(context.artifactRoot,"diagnostics",`cockpit-performance-${index+1}.json`);
  const save=async acceptance=>writeJson(artifact,{measured,acceptance,limits:COCKPIT_PERFORMANCE_LIMITS,windows:{startupMs:3500,idleMs:120_000,settleMs:10_000,elsewhereTurnMs:10_000},exclusions:["/api/v1/events/stream"],requests:requests.slice(0,2000),scripts:[...scripts.entries()].slice(0,500)});
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
    if(url.pathname!=="/api/v1/events/stream")requests.push({path:url.pathname,at});
    // Count scripts begun during startup even when a slow response arrives after its window.
    if(request.resourceType()==="script"&&at<=3500)pending.push(request.response().then(async response=>{if(!response)throw new Error("Startup script failed to load");scripts.set(url.pathname,gzipSync(await response.body()).length);}));
   });
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
    return {status:"failed",metrics:measured,notes:acceptance.failures,artifacts:{...artifacts,diagnostics:[...artifacts.diagnostics,relativeToRun(context,artifact)]}};
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
   await page.getByRole("navigation",{name:"Areas",exact:true}).getByRole("button",{name:/^Inbox(?:,|$)/}).click();await page.waitForTimeout(10_000);
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
   return {status:acceptance.passed?"passed":"failed",metrics:measured,notes:acceptance.failures,artifacts:{diagnostics:[relativeToRun(context,artifact)]}};
  } catch(error) {
    const acceptance={passed:false,failures:[String(error?.message??error).slice(0,3000)]};await save(acceptance);
    const artifacts=page && browserLog ? await captureBrowserArtifacts(context,{slug:`cockpit-performance-failure-${index+1}`,page,browserLog,gatewayUrl:stack.gatewayUrl}) : {};
    return {status:"failed",metrics:measured,notes:acceptance.failures,artifacts:{...artifacts,diagnostics:[...(artifacts.diagnostics??[]),relativeToRun(context,artifact)]}};
  } finally {await browserContext.close();}
 });
}
