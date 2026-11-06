import assert from "node:assert/strict";
import { test } from "node:test";
import * as library from "./cockpit-library-resources-proof.mjs";
import * as grants from "./cockpit-tool-grants-proof.mjs";
const scopes={workspaceId:"workspace-owned",citadelId:"citadel-owned"};
function libraryPage({picker=false,count=1,href="/library/notes?shell=cockpit",scope=scopes}={}){
 let current="http://fixture.invalid/library/memory?shell=cockpit";const actions=[];
 const link={async count(){return count;},async getAttribute(name){assert.equal(name,"href");return href;},async click(){actions.push("click");current=new URL(href,current).href;}};
 const select={async count(){return picker?1:0;},locator(){return {async count(){return count;},async getAttribute(){return href;}};},async selectOption(value){actions.push(value);current=new URL(value,current).href;}};
 const navigation={async waitFor(options){assert.deepEqual(options,{state:"visible",timeout:30000});},async count(){return 1;},getByRole(role){return role==="combobox"?select:link;}};
 return {actions,url:()=>current,async evaluate(fn){return fn.toString().includes("timeOrigin")?111:{workspaceId:scope.workspaceId,citadelId:scope.citadelId};},
 getByRole(role,{name}){assert.equal(role,"navigation");assert.equal(name,"Library sections");return navigation;},async waitForURL(predicate){assert.equal(predicate(new URL(current)),true);}};
}

test("actual Library helper uses native picker or unique exact link, preserves same document/cockpit/scope",async()=>{
 assert.equal(typeof library.navigateLibraryResourceSection,"function","Actual owner navigation helper missing");
 for(const picker of [false,true]){const page=libraryPage({picker});await library.navigateLibraryResourceSection(page,"notes",scopes);assert.deepEqual(page.actions,picker?["/library/notes?shell=cockpit"]:["click"]);}
});
test("Library navigation rejects duplicate missing wrong-destination and foreign-scope owners",async()=>{
 assert.equal(typeof library.navigateLibraryResourceSection,"function");
 for(const options of [{count:0},{count:2},{href:"/library/files?shell=cockpit"},{scope:{...scopes,workspaceId:"foreign"}},{picker:true,count:2},{picker:true,href:"/library/files?shell=cockpit"}])await assert.rejects(library.navigateLibraryResourceSection(libraryPage(options),"notes",scopes));
 await assert.rejects(library.navigateLibraryResourceSection(libraryPage(),"unknown",scopes));
});
test("editable Memory/Notes selected identity is exact URL plus independent workspace owner, never title uniqueness",()=>{
 assert.equal(typeof library.assertLibraryEditableSelection,"function");
 for(const [kind,key] of [["memory","itemId"],["notes","noteId"]]){
  const entry={kind,id:"exact/id",workspaceId:scopes.workspaceId,citadelId:scopes.citadelId,origin:"http://fixture.invalid"};
  const value={url:`http://fixture.invalid/library/${kind}?shell=cockpit&${key}=exact%2Fid`,beforeDocument:111,afterDocument:111,selection:scopes};
  assert.doesNotThrow(()=>library.assertLibraryEditableSelection(value,entry));
  for(const changed of [{url:value.url.replace("exact%2Fid","foreign")},{url:value.url+`&${key}=exact%2Fid`},{selection:{...scopes,workspaceId:"foreign"}},{afterDocument:112},{url:value.url.replace("cockpit","classic")},{url:value.url.replace("fixture.invalid","foreign.invalid")}])assert.throws(()=>library.assertLibraryEditableSelection({...value,...changed},entry));
 }
});
test("owner-window duplicate identities are refused before selected-editor inspection",()=>{
 const record={itemId:"same",workspaceId:scopes.workspaceId};
 assert.throws(()=>library.assertLibraryResourceOwnerAgreement("memory",[record,{...record}],scopes.workspaceId,"same"),/unique|duplicate|exact/i);
});
const grant={grantId:"recorded-grant",scopeRef:scopes.workspaceId,toolPattern:"verification.tool",decision:"deny",scope:"workspace",grantType:"ttl",createdBy:"operator",createdAt:"2026-11-01T00:00:00.000Z"};
function grantDialog({count=1,identity={grantId:grant.grantId,scopeRef:grant.scopeRef}}={}){
 let opened=false;const actions=[];
 const summary={filter({hasText}){assert.ok(hasText instanceof RegExp);assert.equal(hasText.test("Grant identity"),true);assert.equal(hasText.test("Foreign Grant identity"),false);return this;},async count(){return count;},async textContent(){return "Grant identity";},locator(selector){assert.equal(selector,"..");return disclosure;},async click(){opened=true;actions.push("disclose");}};
 const disclosure={async count(){return 1;},async getAttribute(name){assert.equal(name,"open");return opened?"":null;},async evaluate(){assert.equal(opened,true);return identity;}};
 return {actions,locator(selector){assert.equal(selector,"details > summary");return summary;},getByText(){throw new Error("Outer-dialog rooted has locator is not a valid relative descendant contract");}};
}
test("Grant identity helper explicitly opens only the selected receipt's exact technical disclosure without a mutation",async()=>{
 assert.equal(typeof grants.inspectRecordedToolGrantIdentity,"function","Actual owner technical identity helper missing");
 const detail=grantDialog();await grants.inspectRecordedToolGrantIdentity(detail,grant,{items:[grant]});assert.deepEqual(detail.actions,["disclose"]);
});
test("Grant identity helper rejects wrong foreign duplicate missing receipt/disclosure values",async()=>{
 assert.equal(typeof grants.inspectRecordedToolGrantIdentity,"function");
 for(const options of [{count:0},{count:2},{identity:{grantId:"foreign",scopeRef:grant.scopeRef}},{identity:{grantId:grant.grantId,scopeRef:"foreign"}}])await assert.rejects(grants.inspectRecordedToolGrantIdentity(grantDialog(options),grant,{items:[grant]}));
 for(const items of [[],[grant,{...grant}],[{...grant,scopeRef:"foreign"}]])await assert.rejects(grants.inspectRecordedToolGrantIdentity(grantDialog(),grant,{items}));
});
