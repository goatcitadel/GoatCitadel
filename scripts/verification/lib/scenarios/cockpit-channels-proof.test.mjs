import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertChannelDraftSaved, assertChannelFinalizationPlan } from "./cockpit-channels-proof.mjs";
describe("native Channels proof owner assertions", () => {
  it("requires exact submitted fields, acknowledged revision and canonical readback", () => {
    const before = { draftId: "d", revision: 1 }, owner = { draftId: "d", revision: 2, catalogId: "channel.ntfy", label: "Fixture", enabled: false, draft: { baseUrl: "http://127.0.0.1:9999", topic: "fixture" } };
    const input = { before, request: { expectedRevision: 1, label: "Fixture", enabled: false }, receipt: owner, owner, label: owner.label, ...owner.draft };
    assert.doesNotThrow(() => assertChannelDraftSaved(input));
    for (const change of [{ ...owner, revision: 1 }, { ...owner, enabled: true }, { ...owner, draftId: "foreign" }, { ...owner, draft: { ...owner.draft, topic: "foreign" } }])
      assert.throws(() => assertChannelDraftSaved({ ...input, owner: change }));
  });
  it("requires the exact plan scope and proves preparation did not finalize", () => {
    const draft = { draftId: "d", catalogId: "channel.ntfy", revision: 4, label: "Fixture", draft:{topic:"reviewed"} };
    const definition = {adapter:{secretFieldKeys:["token"]},wizard:{steps:[{fields:[{key:"topic",label:"Topic",type:"text",required:true},{key:"token",label:"Token",type:"secret"}]}]}};
    const plan = { kind: "channel_connection", origin: { workspaceId: "default", surface: "settings" }, target: { ownerId:"channel_setup_draft", resourceId:"d", expectedRevision: 4 }, request: { kind: "channel_connection", channelKind: "channel.ntfy", draftId: "d" }, status: "awaiting_input", requiredAction: { kind: "public_form", fields:[{fieldId:"topic",label:"Topic",type:"text",required:true,initialValue:"reviewed"}] } };
    const input = {plan,draft,definition,connections:[]};
    assert.doesNotThrow(() => assertChannelFinalizationPlan(input));
    assert.throws(() => assertChannelFinalizationPlan({ ...input, connections: [{ label: "Fixture" }] }));
    assert.throws(() => assertChannelFinalizationPlan({ ...input, plan: { ...plan, target: {...plan.target, expectedRevision: 5 } } }));
    assert.throws(() => assertChannelFinalizationPlan({ ...input, plan: { ...plan, status: "completed" } }));
    assert.throws(() => assertChannelFinalizationPlan({ ...input, plan: {...plan, requiredAction:{...plan.requiredAction,fields:[{...plan.requiredAction.fields[0],initialValue:"foreign"}]}} }));
  });
});
