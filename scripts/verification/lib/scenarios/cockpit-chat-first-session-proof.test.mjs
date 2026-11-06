import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import * as first from "./cockpit-chat-first-session-proof.mjs";
import * as evidence from "./cockpit-chat-composer-evidence.mjs";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=","base64");
const expected={workspaceId:"owned-workspace",sessionId:"created-session",fileName:"synthetic-generated.png",mimeType:"image/png",bytes:png};
const receipt={attachmentId:"owned-attachment",workspaceId:expected.workspaceId,sessionId:expected.sessionId,fileName:expected.fileName,mimeType:expected.mimeType,mediaType:"image",sizeBytes:png.length,sha256:createHash("sha256").update(png).digest("hex"),storageRelPath:"synthetic/attachment.png",extractStatus:"unsupported",analysisStatus:"queued",createdAt:"2026-11-04T00:00:00.000Z"};
const canonical={...receipt,analysisStatus:"unsupported"};
function feature(name){assert.equal(typeof first[name],"function","Actual first-session fixture seam missing: "+name);return first[name];}
function imageDisclosure595({count=1,waitFailure}={}){
 const actions=[];let visible=false;
 const summary={filter(options){if(options.hasText){assert.ok(options.hasText.test("Voice and images"));}else assert.deepEqual(options,{visible:true});return summary;},count:async()=>visible?count:0,waitFor:async options=>{assert.deepEqual(options,{state:"visible"});actions.push("wait-visible");if(waitFailure)throw waitFailure;visible=true;},click:async()=>actions.push("native-disclosure")};
 const page={locator:selector=>{assert.equal(selector,"summary");return summary;},getByRole:(role,options)=>{assert.equal(role,"button");assert.deepEqual(options,{name:"Create image",exact:true});return{click:async()=>actions.push("native-image")};}};
 const controls={revealAttachControl:async value=>{assert.equal(value,page);actions.push("native-open-options");},closeComposerOptions:async value=>{assert.equal(value,page);actions.push("native-close-options");}};
 return{page,controls,summary,actions};
}
test("RED595 actual image action waits for mounted visible media disclosure before its strict owner count",async()=>{
 const click=feature("clickFirstSessionCreateImage"),fixture=imageDisclosure595();assert.equal(await fixture.summary.count(),0);
 await click(fixture.page,fixture.controls);
 assert.deepEqual(fixture.actions,["native-open-options","wait-visible","native-disclosure","native-image","native-close-options"]);
});
test("RED595 duplicate media owners remain refused after visibility without native image dispatch",async()=>{
 const click=feature("clickFirstSessionCreateImage"),fixture=imageDisclosure595({count:2});
 await assert.rejects(()=>click(fixture.page,fixture.controls));assert.deepEqual(fixture.actions,["native-open-options","wait-visible"]);
});
test("RED595 missing media disclosure preserves bounded native visibility failure and never substitutes API image work",async()=>{
 const click=feature("clickFirstSessionCreateImage"),failure=new Error("Owned media disclosure did not become visible"),fixture=imageDisclosure595({waitFailure:failure});
 await assert.rejects(()=>click(fixture.page,fixture.controls),error=>error===failure);assert.deepEqual(fixture.actions,["native-open-options","wait-visible"]);
});
const sidebar=workspace=>"/api/v1/chat/sessions?"+new URLSearchParams({scope:"all",view:"active",limit:"200",workspaceId:workspace,mode:"chat",includeActivity:"true"});
const batch=paths=>"http://localhost/api/v1/startup-reads?"+new URLSearchParams({reads:JSON.stringify(paths.map((path,index)=>({path,correlationId:"synthetic-correlation-"+index})))});

test("opt-in mode leaves original composer default off and refuses duplicate/misspelled first-session flags",()=>{
 const selected=feature("composerFirstSessionEnabled");
 assert.equal(selected([]),false);assert.equal(selected(["--with-rendering","--with-owners=citadel-directory"]),false);
 assert.equal(selected(["--with-first-session"]),true);
 assert.throws(()=>selected(["--with-first-session","--with-first-session"]));assert.throws(()=>selected(["--with-first-session=true"]));
});

test("third image-provider fixture admits only the actual owned OpenAI image model at loopback without changing existing text models",()=>{
 const fixture=feature("firstSessionImageFixture");
 const stub={providerId:"openai",model:"gpt-image-2",baseUrl:"http://127.0.0.1:12345/v1",imageGenerationDispatches:()=>0,completionDispatches:()=>0};
 const result=fixture(stub);assert.equal(result.provider.providerId,"openai");assert.equal(result.provider.baseUrl,stub.baseUrl);assert.equal(result.provider.defaultModel,"gpt-image-2");assert.equal(result.provider.capabilities.imageGenerate,true);
 assert.equal(result.metadataKey,"openai/gpt-image-2");assert.equal(Object.hasOwn(result,"activeProviderId"),false);assert.equal(Object.hasOwn(result,"activeModel"),false);
 for(const changed of [{baseUrl:"https://api.openai.com/v1"},{baseUrl:"http://user:synthetic@127.0.0.1:12345/v1"},{baseUrl:"http://127.0.0.1:12345/v1?token=synthetic"},{providerId:"other"},{model:"other-model"}])assert.throws(()=>fixture({...stub,...changed}));
});

test("binary receipt uses actual PNG bytes and allows only sourced queued-to-unsupported OCR advancement; text-ready contract remains strict",()=>{
 assert.equal(typeof evidence.assertUploadedBinaryAttachment,"function","Binary evidence assertion must be separate from text extraction readiness");
 assert.doesNotThrow(()=>evidence.assertUploadedBinaryAttachment(receipt,expected,canonical,Buffer.from(png)));
 assert.throws(()=>evidence.assertUploadedAttachment(receipt,{...expected,content:png}),/Text attachment/);
 const text={...receipt,fileName:"fixture.txt",mimeType:"text/plain",extractStatus:"ready",sizeBytes:4,sha256:createHash("sha256").update("text").digest("hex")};
 assert.doesNotThrow(()=>evidence.assertUploadedAttachment(text,{...expected,fileName:"fixture.txt",mimeType:"text/plain",content:"text"}));
});

test("binary receipt refuses foreign owner altered bytes/hash/name/type and unsupported OCR backslide or invented ready state",()=>{
 assert.equal(typeof evidence.assertUploadedBinaryAttachment,"function");
 for(const changed of [{workspaceId:"foreign"},{sessionId:"foreign"},{fileName:"foreign.png"},{mimeType:"text/plain"},{sha256:"0".repeat(64)},{sizeBytes:1},{extractStatus:"ready"}])assert.throws(()=>evidence.assertUploadedBinaryAttachment({...receipt,...changed},expected,canonical,png));
 assert.throws(()=>evidence.assertUploadedBinaryAttachment(receipt,expected,{...canonical,sha256:"f".repeat(64)},png));
 assert.throws(()=>evidence.assertUploadedBinaryAttachment(receipt,expected,canonical,Buffer.from("not a png")));
 assert.throws(()=>evidence.assertUploadedBinaryAttachment({...receipt,analysisStatus:"unsupported"},expected,{...canonical,analysisStatus:"queued"},png));
 assert.throws(()=>evidence.assertUploadedBinaryAttachment({...receipt,analysisStatus:"ready"},expected,{...canonical,analysisStatus:"ready"},png));
});

test("passively classifies exact workspace sidebar reads in direct or authentic startup batch without exposing correlation/foreign rows",()=>{
 const classify=feature("classifyFirstSessionSidebarRead");
 assert.deepEqual(classify("http://localhost"+sidebar("owned-workspace"),"owned-workspace"),{transport:"direct",matchingSidebarReads:1,complete:true});
 assert.deepEqual(classify(batch([sidebar("foreign-workspace"),sidebar("owned-workspace"),"/api/v1/settings"]),"owned-workspace"),{transport:"batch",matchingSidebarReads:1,complete:true});
 assert.equal(classify("http://localhost"+sidebar("foreign-workspace"),"owned-workspace"),null);
 assert.equal(classify("http://localhost/api/v1/chat/sessions/created-session/status","owned-workspace"),null);
 assert.equal(JSON.stringify(classify(batch([sidebar("owned-workspace")]),"owned-workspace")).includes("synthetic-correlation"),false);
});

test("malformed oversized duplicate or unknown startup rows are bounded observation gaps and never a transport substitute",()=>{
 const classify=feature("classifyFirstSessionSidebarRead");
 for(const url of ["http://localhost/api/v1/startup-reads?reads=broken",batch(Array.from({length:17},()=>sidebar("owned-workspace"))),batch([sidebar("owned-workspace"),sidebar("owned-workspace")]),batch(["/api/v1/unknown?token=synthetic-secret"]),"http://localhost/api/v1/startup-reads?reads="+"X".repeat(7001)]){
  const result=classify(url,"owned-workspace");assert.equal(result.complete,false);assert.equal(JSON.stringify(result).includes("synthetic-secret"),false);
 }
});

test("actual creator receipt must confirm exact workspace before any operation-owned handoff",()=>{
 const check=feature("assertFirstSessionCreatedOwner");const record={sessionId:"created-session",workspaceId:"owned-workspace"};
 assert.equal(check(record,"owned-workspace"),record);
 for(const value of [{...record,workspaceId:"foreign"},{workspaceId:"owned-workspace"},{...record,sessionId:"bad/id"},null])assert.throws(()=>check(value,"owned-workspace"));
});

test("owned creator/upload response gate holds exact real response object until explicit release and never consumes or retries it",async()=>{
 const make=feature("createFirstSessionReceiptGate");const gate=make({phase:"creation-status",timeoutMs:15000});
 const response=Object.freeze({synthetic:true,json(){throw new Error("Gate must not consume body");}});let returned=false;
 const held=gate.hold(response).then(value=>{returned=true;return value;});assert.equal(await gate.captured,response);
 await Promise.resolve();assert.equal(returned,false);gate.release();assert.equal(await held,response);await gate.dispose();
});

test("owned response gate cleanup releases its exact held response and duplicate admission refuses without a retry",async()=>{
 const make=feature("createFirstSessionReceiptGate");const gate=make({phase:"upload-receipt",timeoutMs:15000});
 const firstResponse=Object.freeze({synthetic:1});const held=gate.hold(firstResponse);await gate.captured;
 await assert.rejects(gate.hold(Object.freeze({synthetic:2})),/duplicate|already|once/i);await gate.dispose();assert.equal(await held,firstResponse);
 assert.throws(()=>make({phase:"unrelated-owner",timeoutMs:15000}));
});
