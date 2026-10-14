import { test } from "node:test";
import assert from "node:assert/strict";
import { findClassicWorkflowDependencies, checkCockpitWorkflowDependencies } from "./check-cockpit-workflow-dependencies.mjs";
test("rejects new required Classic imports and raw continuations",()=>{
 assert.equal(findClassicWorkflowDependencies("Feature.tsx",'import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink"; const x=<a href="/ops/runtime?shell=classic">Runtime</a>;').length,2);
 assert.equal(findClassicWorkflowDependencies("Feature.tsx",'import { CockpitOwnerLink } from "../../ui/CockpitOwnerLink"; const x=<NativeOwnerLink href="/ops/runtime?shell=classic"/>;').length,1);
});
test("allows compatibility input without requiring a Classic destination",()=>{
 assert.deepEqual(findClassicWorkflowDependencies("Feature.tsx",'const legacy="/ops/runtime?shell=classic"; const x=<CockpitOwnerLink href={legacy}/>;'),[]);
});
test("current release-bearing feature areas use native continuations",async()=>assert.deepEqual(await checkCockpitWorkflowDependencies(),[]));
