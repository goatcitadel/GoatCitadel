import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { setImmediate } from "node:timers";
import * as composerHydration from "./cockpit-chat-composer-proof.mjs";
import * as composerA11y from "./cockpit-chat-composer-evidence.mjs";
import {
  assertComposerConfirmation,
  assertComposerPlan,
  assertComposerSelectedScope,
  assertComposerTurn,
  assertUploadedAttachment,
  COMPOSER_SCHEMA,
  composerPackMarkdown,
} from "./cockpit-chat-composer-evidence.mjs";
import {
  currentConversationId,
  observePendingWait,
  selectComposerConversation,
} from "./cockpit-chat-composer-proof.mjs";

const digest = (content) => createHash("sha256").update(content).digest("hex");
const a11yInput573=()=>({variant:"mobile",phase:"completed",audit:{violations:[{id:"scrollable-region-focusable",impact:"serious",nodes:[{target:[["#owned-shadow-host",".owned-scroll"]],html:'<input value="DO_NOT_PERSIST_INPUT">',failureSummary:"DO_NOT_PERSIST_BODY"}]}]},observations:[{ruleIndex:0,nodeIndex:0,resolved:true,tagName:"DIV",role:"listbox",tabIndex:-1,focusableChildCount:0,rect:{x:4,y:40,width:360,height:80},scroll:{scrollWidth:400,scrollHeight:180,clientWidth:360,clientHeight:80}}]});
it("RED573 composer accessibility projection retains exact same audit rule/shadow target and measured scroll axes only",async()=>{
  assert.equal(typeof composerA11y.projectComposerAccessibilityEvidence,"function");
  const input=a11yInput573(),before=JSON.stringify(input);const result=await composerA11y.projectComposerAccessibilityEvidence(input);
  assert.equal(JSON.stringify(input),before,"Projection mutated the exact blocking audit");assert.equal(result.complete,true);
  assert.equal(result.violations[0].id,"scrollable-region-focusable");assert.equal(result.violations[0].impact,"serious");
  const node=result.violations[0].nodes[0];assert.deepEqual(node.target,input.audit.violations[0].nodes[0].target);assert.equal(node.tagName,"DIV");assert.equal(node.role,"listbox");assert.equal(node.tabIndex,-1);assert.equal(node.focusableChildCount,0);assert.deepEqual(node.rect,input.observations[0].rect);assert.deepEqual(node.scroll,input.observations[0].scroll);
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes("DO_NOT_PERSIST"));assert.ok(!serialized.includes('"html"')&&!serialized.includes('"failureSummary"'));assert.ok(Buffer.byteLength(serialized)<=65536);
});
it("RED573 composer accessibility projection uses canonical actual secret redaction and omits input/URL targets",async()=>{
  assert.equal(typeof composerA11y.projectComposerAccessibilityEvidence,"function");
  const key="GOATCITADEL_SYNTHETIC_A11Y_TOKEN",previous=process.env[key],canary="synthetic-composer-a11y-secret-573";process.env[key]=canary;
  try{const input=a11yInput573();input.audit.violations[0].nodes[0].target=['[data-proof="'+canary+'"]','input[value="DO_NOT_PERSIST_INPUT"]','a[href="https://fixture.invalid/private?token=DO_NOT_PERSIST_URL"]'];const result=await composerA11y.projectComposerAccessibilityEvidence(input);const text=JSON.stringify(result);assert.ok(!text.includes(canary)&&!text.includes("DO_NOT_PERSIST")&&!text.includes("https://"));assert.ok(text.includes("[REDACTED]"));}finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;}
});
it("RED573 unresolved closed or unsupported DOM targets are explicit observation gaps",async()=>{
  assert.equal(typeof composerA11y.projectComposerAccessibilityEvidence,"function");
  const input=a11yInput573();input.observations=[{ruleIndex:0,nodeIndex:0,resolved:false}];const result=await composerA11y.projectComposerAccessibilityEvidence(input);assert.equal(result.complete,false);assert.equal(result.counts.expectedNodes,1);assert.equal(result.counts.unresolvedNodes,1);assert.ok(result.gapReason);
});
it("RED573 oversized rule/node packets retain exact expected counts and bounded explicit gaps",async()=>{
  assert.equal(typeof composerA11y.projectComposerAccessibilityEvidence,"function");
  const input=a11yInput573();input.audit.violations=Array.from({length:40},(_,index)=>({id:"synthetic-rule-"+index,impact:"serious",nodes:Array.from({length:8},()=>({target:[".owned-scroll"]}))}));input.observations=[];
  const result=await composerA11y.projectComposerAccessibilityEvidence(input);assert.equal(result.complete,false);assert.equal(result.counts.expectedRules,40);assert.equal(result.counts.expectedNodes,320);assert.ok(result.counts.writtenRules<40||result.counts.writtenNodes<320);assert.ok(result.gapReason);assert.ok(Buffer.byteLength(JSON.stringify(result)+"\n")<=65536);
});
it("RED573 successful same-audit evidence is written before blocking-rule assertion and retains its diagnostic reference",async()=>{
  assert.equal(typeof composerA11y.captureComposerAccessibilityEvidence,"function");
  const input=a11yInput573(),writes=[];const result=await composerA11y.captureComposerAccessibilityEvidence(input,{artifactRoot:"C:/synthetic-composer-run",writeJson:async(file,payload)=>writes.push({file,payload})});
  assert.equal(writes.length,1);assert.equal(writes[0].payload.violations[0].id,input.audit.violations[0].id);assert.equal(result.relativePath,"diagnostics/cockpit-chat-composer-mobile-completed-axe.json");
  assert.throws(()=>assert.deepEqual(input.audit.violations.filter(item=>["serious","critical"].includes(item.impact)).map(item=>item.id),[]),/scrollable-region-focusable/u);
});
it("RED573 diagnostic write failure remains a fixed gap and never masks original blocking-rule failure",async()=>{
  assert.equal(typeof composerA11y.captureComposerAccessibilityEvidence,"function");
  const input=a11yInput573();const result=await composerA11y.captureComposerAccessibilityEvidence(input,{artifactRoot:"C:/synthetic-composer-run",writeJson:async()=>{throw new Error("DO_NOT_PERSIST_WRITE_SECRET");}});
  assert.equal(result.complete,false);assert.equal(result.gapReason,"write_failure");assert.equal(result.relativePath,null);assert.ok(!JSON.stringify(result).includes("DO_NOT_PERSIST"));
  assert.throws(()=>assert.deepEqual(input.audit.violations.filter(item=>["serious","critical"].includes(item.impact)).map(item=>item.id),[]),/scrollable-region-focusable/u);
});
function modelOptionsOwner563({expanded=false,triggers=1,popups=1,controls="owned-model-popup",doneCount=1,delayedPopup=false}={}){
  const actions=[],lookups=[],waits=[];let open=expanded,mounted=!delayedPopup;
  const popup={count:async()=>mounted?popups:0,waitFor:async({state}={})=>{if(state==="visible"&&delayedPopup)mounted=true;assert.equal(open,state!=="hidden");actions.push(state==="hidden"?"popup-hidden":"popup-visible");},getByRole:(role,options)=>{
    if(role==="heading"){assert.equal(options.name,"Model and reasoning");assert.equal(options.exact,true);return{count:async()=>1};}
    if(role==="button"){assert.equal(options.name,"Done");assert.equal(options.exact,true);return{count:async()=>doneCount,click:async()=>{actions.push("native-done");open=false;}};}
    assert.equal(role,"combobox");assert.ok(["Provider","Model","Effort"].includes(options.name));assert.equal(options.exact,true);
    return{selectOption:async value=>actions.push(["native-select",options.name,value]),inputValue:async()=>"owned-model"};
  }};
  const trigger={count:async()=>triggers,getAttribute:async name=>name==="aria-controls"?controls:name==="aria-expanded"?String(open):null,click:async()=>{actions.push("native-open");open=true;}};
  const page={locator:selector=>{
    if(selector==='[aria-label="Composer controls"]')return{getByRole:(role,options)=>{assert.equal(role,"button");assert.equal(options.name,"Options");return{count:async()=>0};}};
    lookups.push(selector);assert.equal(selector,'[id="owned-model-popup"]',"Controlled popover must be selected by the trigger's exact validated identity");return popup;
  },getByRole:(role,options)=>{
    if(role==="dialog"){assert.equal(options.name,"Message options");return{isVisible:async()=>false};}
    assert.equal(role,"button","Page-level model combobox access bypasses the current popup owner");
    assert.ok(options.name instanceof RegExp&&options.name.test("Owned model · Standard · Model and reasoning options"));return trigger;
  },waitForTimeout:async value=>{waits.push(value);}};
  return{page,popup,actions,lookups,waits};
}
it("RED563 actual model-options helper opens collapsed owned chip before scoped native provider selection",async()=>{
  assert.equal(typeof composerHydration.openComposerModelOptions,"function");assert.equal(typeof composerHydration.closeComposerModelOptions,"function");
  const fixture=modelOptionsOwner563();const popup=await composerHydration.openComposerModelOptions(fixture.page);assert.equal(popup,fixture.popup);
  await popup.getByRole("combobox",{name:"Provider",exact:true}).selectOption("owned-provider");
  await composerHydration.closeComposerModelOptions(fixture.page,popup);
  assert.deepEqual(fixture.actions,["native-open","popup-visible",["native-select","Provider","owned-provider"],"native-done","popup-hidden"]);
});
it("RED563 already-open owned model popup is reused rather than toggled closed",async()=>{
  assert.equal(typeof composerHydration.openComposerModelOptions,"function");
  const fixture=modelOptionsOwner563({expanded:true});assert.equal(await composerHydration.openComposerModelOptions(fixture.page),fixture.popup);assert.deepEqual(fixture.actions,["popup-visible"]);
});
it("RED570 expanded chip with controlled identity waits for deferred popup mount before counting its owner",async()=>{
  assert.equal(typeof composerHydration.openComposerModelOptions,"function");
  const fixture=modelOptionsOwner563({expanded:true,delayedPopup:true});
  assert.equal(await fixture.popup.count(),0,"Cold deferred module has not mounted its controlled popup");
  assert.equal(await composerHydration.openComposerModelOptions(fixture.page),fixture.popup);
  assert.deepEqual(fixture.actions,["popup-visible"],"Existing native visibility wait must bridge deferred mount");
  assert.equal(await fixture.popup.count(),1,"Unique mounted owner must still be checked");
});
it("RED563 duplicate model triggers and absent or duplicate controlled popovers are refused",async()=>{
  assert.equal(typeof composerHydration.openComposerModelOptions,"function");
  for(const options of [{triggers:2},{popups:0},{popups:2}]){const fixture=modelOptionsOwner563(options);await assert.rejects(()=>composerHydration.openComposerModelOptions(fixture.page));assert.ok(!fixture.actions.some(value=>Array.isArray(value)));}
});
it("RED563 model popup identity cannot inject a selector or fall back to unrelated page controls",async()=>{
  assert.equal(typeof composerHydration.openComposerModelOptions,"function");
  for(const controls of [null,"",'owned-model-popup\"] [id=\"foreign',"foreign popup"]){const fixture=modelOptionsOwner563({controls});await assert.rejects(()=>composerHydration.openComposerModelOptions(fixture.page));assert.deepEqual(fixture.lookups,[],"Invalid identity must be rejected before evaluating a selector");assert.ok(fixture.waits.length<=80);}
});
it("RED563 native popup closure requires its own exact Done control",async()=>{
  assert.equal(typeof composerHydration.closeComposerModelOptions,"function");
  for(const doneCount of [0,2]){const fixture=modelOptionsOwner563({expanded:true,doneCount});await assert.rejects(()=>composerHydration.closeComposerModelOptions(fixture.page,fixture.popup));assert.deepEqual(fixture.actions,[]);}
});
const catalogTarget552={providerId:"verification-composer-alt/owned",defaultModel:"owned-model"};
const catalog552=(source="live",catalogStatus="fresh",items=[{id:catalogTarget552.defaultModel}])=>({source,catalogStatus,items});
it("RED552 model readiness observes stale then actual live nonstale model without accepting the cache snapshot",async()=>{
  assert.equal(typeof composerHydration.waitForComposerModelCatalog,"function");
  const calls=[],waits=[],fresh=catalog552();const queue=[catalog552("live","stale"),fresh];
  const result=await composerHydration.waitForComposerModelCatalog({page:{waitForTimeout:async value=>waits.push(value)},read:async(...args)=>{calls.push(args);return queue.shift();},target:catalogTarget552,attempts:3});
  assert.equal(result,fresh);assert.deepEqual(waits,[250]);assert.deepEqual(calls,Array.from({length:2},()=>["/api/v1/llm/models?providerId=verification-composer-alt%2Fowned"]));
});
it("RED552 already-ready owned model requires exactly one genuine read and no delay",async()=>{
  assert.equal(typeof composerHydration.waitForComposerModelCatalog,"function");
  const fresh=catalog552();let calls=0;const waits=[];
  assert.equal(await composerHydration.waitForComposerModelCatalog({page:{waitForTimeout:async value=>waits.push(value)},read:async()=>{calls++;return fresh;},target:catalogTarget552,attempts:3}),fresh);
  assert.equal(calls,1);assert.deepEqual(waits,[]);
});
it("RED552 stale fallback and missing model cannot pass the finite readiness gate",async()=>{
  assert.equal(typeof composerHydration.waitForComposerModelCatalog,"function");
  for(const result of [catalog552("live","stale"),catalog552("template_fallback","fresh"),catalog552("live","fresh",[{id:"foreign-model"}])]){
    let calls=0;const waits=[];
    await assert.rejects(()=>composerHydration.waitForComposerModelCatalog({page:{waitForTimeout:async value=>waits.push(value)},read:async()=>{calls++;return result;},target:catalogTarget552,attempts:3}));
    assert.equal(calls,3);assert.ok(waits.length<=3&&waits.every(value=>value===250));
  }
});
it("RED552 actual catalog transport failure remains a failure with no implicit request retry",async()=>{
  assert.equal(typeof composerHydration.waitForComposerModelCatalog,"function");
  const failure=new Error("Owned synthetic catalog unavailable");let calls=0;const waits=[];
  await assert.rejects(()=>composerHydration.waitForComposerModelCatalog({page:{waitForTimeout:async value=>waits.push(value)},read:async()=>{calls++;throw failure;},target:catalogTarget552,attempts:3}),error=>error===failure);
  assert.equal(calls,1);assert.deepEqual(waits,[]);
});
it("RED552 catalog readiness cannot expand the existing80-attempt finite budget",async()=>{
  assert.equal(typeof composerHydration.waitForComposerModelCatalog,"function");
  for(const attempts of [0,81,Infinity,1.5]){
    let calls=0;await assert.rejects(()=>composerHydration.waitForComposerModelCatalog({page:{waitForTimeout:async()=>{}},read:async()=>{calls++;return catalog552();},target:catalogTarget552,attempts}));assert.equal(calls,0);
  }
});
const hydrationOwner542={sessionId:"owned/session",workspaceId:"owned-workspace"};
const hydrationStatus542={...hydrationOwner542,title:"Owned synthetic conversation"};
const corePath542="/api/v1/chat/sessions/owned%2Fsession/core-state";
const hydrationRequest542=path=>({method:()=>"GET",url:()=>"http://127.0.0.1:54321"+path});
const hydrationBatch542=paths=>hydrationRequest542("/api/v1/startup-reads?"+new URLSearchParams({reads:JSON.stringify(paths.map((path,index)=>({path,correlationId:"synthetic-"+index})))}));
const hydrationBody542=()=>({sessionId:hydrationOwner542.sessionId,thread:{sessionId:hydrationOwner542.sessionId,turns:[]},binding:null,prefs:{sessionId:hydrationOwner542.sessionId,revision:1}});
const hydrationResponse542=(body,status=200)=>({status:()=>status,json:async()=>body});
const hydrationPacket542=body=>({items:[{status:200,bodyText:JSON.stringify({items:[]}),headers:{}},{status:200,bodyText:JSON.stringify(body),headers:{"cache-control":"private, no-store"}}]});
it("RED542 hydration selects current core-state direct owner and genuine batch position",()=>{
  assert.equal(typeof composerHydration.matchComposerCoreStateRead,"function");
  assert.deepEqual(composerHydration.matchComposerCoreStateRead(hydrationRequest542(corePath542),hydrationOwner542.sessionId),{transport:"direct",index:0,count:1});
  assert.deepEqual(composerHydration.matchComposerCoreStateRead(hydrationBatch542(["/api/v1/settings",corePath542]),hydrationOwner542.sessionId),{transport:"startup_batch",index:1,count:2});
});
it("RED542 hydration never admits legacy thread, foreign session, write or transcript-excluded refresh",()=>{
  assert.equal(typeof composerHydration.matchComposerCoreStateRead,"function");
  for(const path of [corePath542.replace("core-state","thread"),corePath542.replace("owned%2Fsession","foreign"),corePath542+"?includeThread=false"]){assert.equal(composerHydration.matchComposerCoreStateRead(hydrationRequest542(path),hydrationOwner542.sessionId),null);}
  const write=hydrationRequest542(corePath542);write.method=()=>"POST";assert.equal(composerHydration.matchComposerCoreStateRead(write,hydrationOwner542.sessionId),null);
});
it("RED542 hydration rejects duplicate and malformed batch authority instead of choosing a matching response body",()=>{
  assert.equal(typeof composerHydration.matchComposerCoreStateRead,"function");
  for(const request of [hydrationBatch542([corePath542,corePath542]),hydrationRequest542("/api/v1/startup-reads?reads=not-json"),hydrationRequest542(corePath542+"?includeThread=true&includeThread=false")])assert.throws(()=>composerHydration.matchComposerCoreStateRead(request,hydrationOwner542.sessionId));
});
it("RED542 actual direct and batched response decode preserves canonical thread with independently scoped backend status",async()=>{
  assert.equal(typeof composerHydration.readComposerCoreStateResult,"function");
  const body=hydrationBody542();
  for(const [request,response] of [[hydrationRequest542(corePath542),hydrationResponse542(body)],[hydrationBatch542(["/api/v1/settings",corePath542]),hydrationResponse542(hydrationPacket542(body))]]){
    assert.deepEqual(await composerHydration.readComposerCoreStateResult(request,response,{...hydrationOwner542,status:hydrationStatus542}),body.thread);
  }
});
it("RED542 hydration refuses failed/unconfirmed/foreign/missing canonical owner responses",async()=>{
  assert.equal(typeof composerHydration.readComposerCoreStateResult,"function");
  const request=hydrationBatch542(["/api/v1/settings",corePath542]);
  const variants=[packet=>packet.items[1].status=403,packet=>packet.items[1].directReadRequired=true,packet=>packet.items.pop(),packet=>packet.items[1].bodyText="not-json",packet=>packet.items[1].bodyText=JSON.stringify({...hydrationBody542(),thread:{sessionId:"foreign",turns:[]}})];
  for(const change of variants){const packet=hydrationPacket542(hydrationBody542());change(packet);await assert.rejects(()=>composerHydration.readComposerCoreStateResult(request,hydrationResponse542(packet),{...hydrationOwner542,status:hydrationStatus542}));}
  await assert.rejects(()=>composerHydration.readComposerCoreStateResult(hydrationRequest542(corePath542),hydrationResponse542(hydrationBody542(),401),{...hydrationOwner542,status:hydrationStatus542}));
  await assert.rejects(()=>composerHydration.readComposerCoreStateResult(hydrationRequest542(corePath542),hydrationResponse542(hydrationBody542()),{...hydrationOwner542,status:{...hydrationStatus542,workspaceId:"foreign"}}));
});
const expected = {
  sessionId: "session-a",
  workspaceId: "workspace-a",
  fileName: "fixture.txt",
  mimeType: "text/plain",
  content: "Synthetic content.",
};
const attachment = {
  ...expected,
  attachmentId: "attachment-retained",
  sizeBytes: Buffer.byteLength(expected.content),
  sha256: digest(expected.content),
  extractStatus: "ready",
};
const prefs = {
  sessionId: "session-a",
  revision: 4,
  providerId: "provider-b",
  model: "model-b",
  thinkingLevel: "deep",
};
const invocation = {
  ownerKind: "prompt_pack",
  ownerId: "pack-a",
  ownerRevision: "2026-09-30T12:00:00Z",
  templateId: "test-a",
  schemaHash: "a".repeat(64),
  values: { count: 2, concise: true },
};
function turnInput() {
  const content = "Typed synthetic request.";
  return {
    sessionId: "session-a",
    content,
    attachments: [attachment],
    removedId: "attachment-removed",
    prefs,
    invocation,
    turn: {
      turnId: "turn-a",
      userMessage: {
        sessionId: "session-a",
        content,
        attachments: [
          {
            attachmentId: attachment.attachmentId,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          },
        ],
      },
      trace: {
        sessionId: "session-a",
        status: "completed",
        model: prefs.model,
        thinkingLevel: prefs.thinkingLevel,
        routing: {
          primaryProviderId: prefs.providerId,
          runVariables: {
            ...invocation,
            bindings: invocation.values,
            resolvedInputHash: digest(content),
            bindingsHash: "b".repeat(64),
          },
        },
      },
    },
  };
}
it("checks canonical attachment identity, scope and content hash", () => {
  assert.doesNotThrow(() => assertUploadedAttachment(attachment, expected));
  for (const change of [
    { sessionId: "foreign" },
    { workspaceId: "foreign" },
    { fileName: "foreign.txt" },
    { sha256: "f".repeat(64) },
    { sizeBytes: 0 },
    { extractStatus: "failed" },
    { attachmentId: "" },
  ]) {
    assert.throws(() => assertUploadedAttachment({ ...attachment, ...change }, expected));
  }
});
it("requires persisted turn bindings rather than browser chip text", () => {
  assert.doesNotThrow(() => assertComposerTurn(turnInput()));
  const input = turnInput();
  input.turn.userMessage.attachments[0].attachmentId = input.removedId;
  assert.throws(() => assertComposerTurn(input));
});
it("rejects extra/removed attachments, metadata changes and foreign turn scope", () => {
  for (const mutate of [
    (input) =>
      input.turn.userMessage.attachments.push({
        ...input.turn.userMessage.attachments[0],
        attachmentId: "attachment-removed",
      }),
    (input) => {
      input.turn.userMessage.attachments[0].sizeBytes += 1;
    },
    (input) => {
      input.turn.userMessage.sessionId = "foreign";
    },
    (input) => {
      input.turn.trace.sessionId = "foreign";
    },
  ]) {
    const input = turnInput();
    mutate(input);
    assert.throws(() => assertComposerTurn(input));
  }
});
it("rejects uncompleted turns and mismatched executed provider/model/effort", () => {
  for (const mutate of [
    (input) => {
      input.turn.trace.status = "failed";
    },
    (input) => {
      input.turn.trace.model = "old-model";
    },
    (input) => {
      input.turn.trace.thinkingLevel = "standard";
    },
    (input) => {
      input.turn.trace.routing.primaryProviderId = "foreign";
    },
  ]) {
    const input = turnInput();
    mutate(input);
    assert.throws(() => assertComposerTurn(input));
  }
});
it("rejects stale template evidence, stringified typed values and forged resolved input", () => {
  for (const change of [
    { ownerRevision: "old" },
    { schemaHash: "f".repeat(64) },
    { templateId: "foreign" },
    { bindings: { count: "2", concise: "true" } },
    { resolvedInputHash: "f".repeat(64) },
  ]) {
    const input = turnInput();
    Object.assign(input.turn.trace.routing.runVariables, change);
    assert.throws(() => assertComposerTurn(input));
  }
});
function planInput() {
  const before = { ...prefs, revision: 3, providerId: "provider-a", model: "model-a" };
  const patch = { providerId: prefs.providerId, model: prefs.model };
  return {
    sessionId: "session-a",
    workspaceId: "workspace-a",
    before,
    after: prefs,
    patch,
    plan: {
      kind: "session_model",
      origin: { sessionId: "session-a", workspaceId: "workspace-a" },
      request: { kind: "session_model", ...patch },
    },
  };
}
it("accepts an exact scoped session-model plan and newer matching owner receipt", () => {
  assert.doesNotThrow(() => assertComposerPlan(planInput()));
});
it("rejects cross-session plans, stale receipts and widened preference changes", () => {
  const foreign = planInput();
  foreign.plan.origin.sessionId = "foreign";
  assert.throws(() => assertComposerPlan(foreign));
  const stale = planInput();
  stale.after = { ...stale.after, revision: stale.before.revision };
  assert.throws(() => assertComposerPlan(stale));
  const changed = planInput();
  changed.after = { ...changed.after, thinkingLevel: "ultra" };
  assert.throws(() => assertComposerPlan(changed));
});
it("authors an importable typed schema before the test body, without capability authority", () => {
  const source = composerPackMarkdown();
  const schema = JSON.parse(source.match(/```goatcitadel-variables\n([\s\S]+?)\n```/u)[1]);
  assert.deepEqual(schema, COMPOSER_SCHEMA);
  assert.deepEqual(
    schema.fields.map((field) => field.type),
    ["text", "number", "boolean", "select"],
  );
  assert.ok(source.indexOf("```goatcitadel-variables") < source.indexOf("## TEST-91"));
  assert.doesNotMatch(source, /capabilityProfile|frozenSnapshot|callableCatalog/u);
});
it("switches the real conversation list without replacing the browser document", async () => {
  for (const layout of ["desktop", "phone"]) {
    const clicks = [];
    let sheetOpen = false;
    const locator = (path) => {
      const self = {
        or: () => locator([...path, "or"]),
        filter: () => self,
        first: () => self,
        waitFor: async () => {},
        isVisible: async () =>
          path[0] === "complementary:Conversations"
            ? layout === "desktop"
            : path[0] === "dialog:Conversations"
              ? layout === "phone" && sheetOpen
              : layout === "phone" && !sheetOpen,
        getByRole: (role, options) => locator([...path, [role, options]]),
        click: async () => {
          clicks.push(path);
          if (path[0] === "button:Conversations") sheetOpen = true;
        },
      };
      return self;
    };
    const page = {
      goto() {
        throw new Error("Document navigation bypasses the SPA scope persistence contract");
      },
      getByRole: (role, options) => {
        assert.equal(options.exact, true);
        return locator([`${role}:${options.name}`]);
      },
    };
    const session = { sessionId: "exact-session-id", title: "Composer [literal].title" };
    await selectComposerConversation(page, session);
    if (layout === "phone") assert.deepEqual(clicks.shift(), ["button:Conversations"]);
    assert.equal(clicks.length, 1);
    const [root, [navRole, navOptions], [rowRole, rowOptions]] = clicks[0];
    assert.equal(root, layout === "desktop" ? "complementary:Conversations" : "dialog:Conversations");
    assert.deepEqual([navRole, navOptions], ["navigation", { name: "Conversations", exact: true }]);
    assert.equal(rowRole, "button");
    assert.ok(rowOptions.name.test(`${session.title}2m agoactive`));
    assert.ok(!rowOptions.name.test("Composer ltitle"));
  }
});
it("maps the list's current row back to exactly one fixture conversation", () => {
  const sessions = [
    { sessionId: "a", title: "Composer x1" },
    { sessionId: "b", title: "Other composer x1" },
  ];
  assert.equal(currentConversationId("Composer x12m ago", sessions), "a");
  assert.equal(currentConversationId("Other composer x1just now", sessions), "b");
  assert.match(currentConversationId(null, sessions), /^unresolved:/u);
  assert.match(currentConversationId("Unrelated", sessions), /^unresolved:/u);
});
it("requires controlled session selection and the exact canonical thread in the same browser document", () => {
  const value = {
    requestedId: "session-b",
    selectedId: "session-b",
    threadId: "session-b",
    documentBefore: 123,
    documentAfter: 123,
  };
  assert.doesNotThrow(() => assertComposerSelectedScope(value));
  for (const change of [{ selectedId: "session-a" }, { threadId: "session-a" }, { documentAfter: 456 }]) {
    assert.throws(() => assertComposerSelectedScope({ ...value, ...change }));
  }
});

it("requires exact confirmation nonce/revision and independently read terminal plan", () => {
  const plan = {
    ...planInput().plan,
    planId: "plan-a",
    revision: 2,
    status: "awaiting_confirmation",
    requiredAction: { kind: "confirmation", actionNonce: "exact-owner-issued-nonce" },
  };
  const request = {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    expectedRevision: 2,
    actionNonce: plan.requiredAction.actionNonce,
  };
  const receipt = { ...plan, status: "completed", revision: 3, requiredAction: undefined };
  const value = { plan, request, receipt, owner: structuredClone(receipt) };
  assertComposerConfirmation(value);
  for (const patch of [
    { actionNonce: "foreign" },
    { expectedRevision: 1 },
    { sessionId: "foreign" },
    { workspaceId: "foreign" },
    { model: "unreviewed" },
  ])
    assert.throws(() => assertComposerConfirmation({ ...value, request: { ...request, ...patch } }));
  for (const patch of [
    { status: "awaiting_confirmation" },
    { planId: "foreign" },
    { revision: 2 },
    { request: { ...plan.request, thinkingLevel: "ultra" } },
  ]) {
    const changed = { ...receipt, ...patch };
    assert.throws(() => assertComposerConfirmation({ ...value, receipt: changed, owner: structuredClone(changed) }));
  }
  assert.throws(() => assertComposerConfirmation({ ...value, owner: plan }));
});

it("observes pending wait rejection immediately while preserving its exact awaited error", async () => {
  const error = new Error("Synthetic response wait failed");
  const pending = observePendingWait(Promise.reject(error));
  // node:test fails on an unhandled rejection during this action-sized gap.
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(pending, (cause) => cause === error);
  assert.equal(await observePendingWait(Promise.resolve("canonical response")), "canonical response");
});
it("allows an action failure to reach cleanup while its outstanding wait rejects", async () => {
  let reject;
  const actionError = new Error("Synthetic selection failed");
  let cleaned = false;
  await assert.rejects(
    async () => {
      observePendingWait(
        new Promise((_, fail) => {
          reject = fail;
        }),
      );
      try {
        throw actionError;
      } finally {
        cleaned = true;
        reject(new Error("Page closed during cleanup"));
      }
    },
    (cause) => cause === actionError,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleaned, true);
});
