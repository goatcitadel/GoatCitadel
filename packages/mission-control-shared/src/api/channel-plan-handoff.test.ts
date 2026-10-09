import { describe, expect, it } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { assertChannelPlanReviewBinding, channelPlanReturnHref, channelPlanReviewHref, createChannelPlanReviewHandoff, preserveChannelPlanReviewHref, readChannelPlanReviewHandoff } from "./channel-plan-handoff";
function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return { planId: "plan-1", revision: 3, origin: { surface: "settings", workspaceId: "workspace-a" },
    request: { kind: "channel_connection", channelKind: "channel.slack", draftId: "draft-1" },
    target: { ownerId: "channel_setup_draft", resourceId: "draft-1", expectedRevision: 7 }, evidenceRefs: [], ...overrides } as ChangePlanRecord;
}
describe("exact channel plan navigation", () => {
  it("round-trips only the exact workspace/plan/draft/revision without credential or arbitrary return data", () => {
    const handoff = createChannelPlanReviewHandoff(plan());
    const href = channelPlanReviewHref(handoff);
    expect(readChannelPlanReviewHandoff(href.slice(href.indexOf("?")))).toEqual(handoff);
    expect(href).not.toContain("nonce");
    expect(readChannelPlanReviewHandoff("?channelPlan=plan-1&channelPlan=plan-2&channelDraft=draft-1&channelRevision=3&channelWorkspace=workspace-a")).toBeNull();
    expect(readChannelPlanReviewHandoff("?channelPlan=plan-1&channelDraft=draft-1&channelRevision=0&channelWorkspace=workspace-a")).toBeNull();
    expect(readChannelPlanReviewHandoff("?channelPlan=../bad&channelDraft=draft-1&channelRevision=3&channelWorkspace=workspace-a")).toBeNull();
  });
  it("rejects session-origin, another workspace, and another draft even when a link names a real plan", () => {
    const handoff = createChannelPlanReviewHandoff(plan());
    expect(() => assertChannelPlanReviewBinding(plan({ origin: { surface: "settings", workspaceId: "workspace-b" } }), handoff)).toThrow();
    expect(() => createChannelPlanReviewHandoff(plan({ origin: { surface: "chat", workspaceId: "workspace-a", sessionId: "session-1" } }))).toThrow();
    expect(() => assertChannelPlanReviewBinding(plan({ target: { ownerId: "channel_setup_draft", resourceId: "draft-2" } }), handoff)).toThrow();
  });
  it("derives the allowlisted return destination from canonical plan evidence and preserves review through session publication", () => {
    const p = plan({ evidenceRefs: ["channel-connection:connection-1", "https://evil.example.test"] });
    expect(channelPlanReturnHref(p)).toBe("/settings/channels?channelPlan=plan-1&channelDraft=draft-1&channelWorkspace=workspace-a&channelConnection=connection-1");
    const search = channelPlanReviewHref(createChannelPlanReviewHandoff(p)).split("?")[1]!;
    expect(preserveChannelPlanReviewHref("/chat?sessionId=session-1", search, "workspace-a")).toContain("channelPlan=plan-1");
    expect(preserveChannelPlanReviewHref("/chat?sessionId=session-1", search, "workspace-b")).toBe("/chat?sessionId=session-1");
    expect(() => preserveChannelPlanReviewHref("https://evil.example.test/chat", search, "workspace-a")).toThrow();
  });
});