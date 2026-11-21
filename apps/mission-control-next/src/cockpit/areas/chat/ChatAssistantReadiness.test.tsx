// @vitest-environment happy-dom
import {act,create,type ReactTestRenderer} from "react-test-renderer";
import {afterEach,expect,it,vi} from "vitest";
import type {AssistantReadinessResponse} from "@goatcitadel/contracts";
import {ChatAssistantReadiness} from "./ChatAssistantReadiness";
let tree:ReactTestRenderer;
afterEach(async()=>{if(tree)await act(async()=>tree.unmount());});
it("shows a scoped setup decision and never starts setup merely by rendering",async()=>{
  const action=vi.fn(),refresh=vi.fn();
  const readiness={items:[{id:"memory",label:"Reviewed memory",state:"disabled",scope:"installation",reasons:["memory_administration_disabled"],nextAction:{kind:"review_change_plan",href:"/settings/advanced",label:"Review memory setup",request:{kind:"runtime_configuration",change:{operation:"feature_flag",flag:"memoryLifecycleAdminV1Enabled",enabled:true}}}}],learning:{canExtractMemory:false,canDraftSkill:false,provider:{state:"unavailable",reasonCode:"provider_unavailable"},budget:{state:"blocked",reasonCode:"usage_unknown"}},indexedRecall:{state:"disabled"}} as AssistantReadinessResponse;
  await act(async()=>{tree=create(<ChatAssistantReadiness readiness={readiness} onAction={action} onRefresh={refresh}/>);});
  expect(action).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain("whole installation");
  await act(async()=>tree.root.findByProps({"data-readiness-action":"memory"}).props.onClick());
  expect(action).toHaveBeenCalledWith(readiness.items[0]!.nextAction);
});
it("keeps unavailable distinct from disabled and offers a retry without showing fake readiness",async()=>{
  await act(async()=>{tree=create(<ChatAssistantReadiness error="Sign in again to check assistant readiness." onAction={vi.fn()} onRefresh={vi.fn()}/>);});
  expect(JSON.stringify(tree.toJSON())).toContain("Sign in again");
  expect(tree.root.findByProps({"data-readiness-retry":true}).props.disabled).not.toBe(true);
});
it.each(["blocked","unavailable"] as const)("does not describe %s instruction readiness as a known off switch",async state=>{
  const readiness={version:1,workspaceId:"A",sessionId:"s",configRevision:1,sourceHash:"a".repeat(64),items:[],learning:{canExtractMemory:true,canDraftSkill:false,canEvaluateMaintenance:false,source:{state:"ready"},memory:{state:"ready"},skill:{state:"disabled"},maintenance:{state:"disabled"},provider:{state:"ready"},budget:{state:"ready"}},indexedRecall:{state:"disabled"},reviewedSkillUse:{state}} as AssistantReadinessResponse;
  await act(async()=>{tree=create(<ChatAssistantReadiness readiness={readiness} onAction={vi.fn()} onRefresh={vi.fn()}/>);});
  expect(JSON.stringify(tree.toJSON())).not.toContain("while instruction use is off");
  expect(JSON.stringify(tree.toJSON())).toContain(state==="unavailable"?"could not be confirmed":"needs attention");
});
it("offers reviewed-skill use setup separately and groups identical unchecked prerequisites",async()=>{
  const action=vi.fn();
  const setup={kind:"review_change_plan",href:"/settings/advanced",label:"Review skill use setup",request:{kind:"runtime_configuration",change:{operation:"feature_flag",flag:"chatSkillInstructionsV1Enabled",enabled:true}}} as const;
  const readiness:AssistantReadinessResponse={version:1,workspaceId:"A",sessionId:"s",configRevision:1,sourceHash:"a".repeat(64),items:[],learning:{canExtractMemory:false,canDraftSkill:false,canEvaluateMaintenance:false,source:{state:"ready"},memory:{state:"disabled"},skill:{state:"disabled"},maintenance:{state:"disabled"},provider:{state:"unavailable",reasonCode:"not_checked"},budget:{state:"unavailable",reasonCode:"not_checked"}},indexedRecall:{state:"disabled"},reviewedSkillUse:{state:"disabled",reasonCode:"skill_instructions_disabled"},reviewedSkillUseSetup:setup};
  await act(async()=>{tree=create(<ChatAssistantReadiness readiness={readiness} onAction={action} onRefresh={vi.fn()}/>);});
  expect(tree.root.findAllByType("p").filter(p=>p.children.join("").includes("A prerequisite is off"))).toHaveLength(1);
  expect(JSON.stringify(tree.toJSON())).toContain("Approved skills are not being added to Chat");
  await act(async()=>tree.root.findByProps({"data-readiness-action":"skill_use"}).props.onClick());
  expect(action).toHaveBeenCalledWith(setup);
});
