// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_SKILL_CAPTURE_MARKER, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { WorkflowSkillCaptureControl } from "./WorkflowSkillCaptureControl";
import { __resetSessionViewStateForTests } from "../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../native-routes/library/session-drafts";

const api = vi.hoisted(() => ({ prepare: vi.fn(), stage: vi.fn(), plan: vi.fn(), fetchPlan: vi.fn(), proposals: vi.fn(async () => ({ items: [] })) }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  prepareWorkflowSkillCapture: api.prepare,
  fetchCapabilityProposals: api.proposals,
  fetchCapabilityCandidate: vi.fn(),
  fetchChangePlan: api.fetchPlan,
  stageWorkflowSkillCapture: api.stage,
  createChangePlan: api.plan,
}));
vi.mock("@goatcitadel/mission-control-shared/components/chat/OwnedChangePlanList", () => ({
  OwnedChangePlanList: () => null,
}));

const sourceTurn = {
  turnId: "turn-1",
  trace: { status: "completed", completion: { status: "complete" } },
  userMessage: { content: "Summarize the launch." },
  assistantMessage: { content: "The launch is ready for review." },
} as ChatThreadTurnRecord;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  __resetSessionDraftsForTests();
  __resetSessionViewStateForTests();
  vi.clearAllMocks();
});

describe("skill capture preparation", () => {
  it("retains the exact candidate and review receipt and suppresses duplicate writes after remount", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); roots.push(root);
    let resolveStage!: (value: unknown) => void;
    let resolvePlan!: (value: unknown) => void;
    api.stage.mockImplementation(() => new Promise(resolve => { resolveStage = resolve; }));
    api.plan.mockImplementation(() => new Promise(resolve => { resolvePlan = resolve; }));
    const turn = {...sourceTurn, turnId:"capture-turn", userMessage:{...sourceTurn.userMessage, content:WORKFLOW_SKILL_CAPTURE_MARKER + "{}"}};
    const onReviewPlan = vi.fn();
    const props = {turn, sessionId:"session-receipt", workspaceId:"default", draftEmpty:true, onPrepare:vi.fn(), onReviewPlan};
    const button = (label:string) => [...host.querySelectorAll("button")].find(item=>item.textContent === label)!;
    await act(async()=>root.render(<WorkflowSkillCaptureControl {...props} />));
    await act(async()=>button("Save reviewed candidate").click());
    await vi.waitFor(()=>expect(api.stage).toHaveBeenCalledOnce());
    await act(async()=>root.render(null));
    await act(async()=>root.render(<WorkflowSkillCaptureControl {...props} />));
    expect(button("Saving…").disabled).toBe(true);
    await act(async()=>button("Saving…").click());
    expect(api.stage).toHaveBeenCalledOnce();
    await act(async()=>resolveStage({candidateId:"candidate-1",versionId:"version-1",proposalId:"proposal-1"}));
    expect(button("Save reviewed candidate").disabled).toBe(true);
    await act(async()=>button("Review activation").click());
    expect(api.plan).toHaveBeenCalledWith(expect.objectContaining({request:{kind:"capability_candidate",proposalId:"proposal-1",versionId:"version-1"}}));
    await act(async()=>root.render(null));
    await act(async()=>root.render(<WorkflowSkillCaptureControl {...props} />));
    expect(button("Review activation").disabled).toBe(true);
    await act(async()=>resolvePlan({planId:"plan-1",status:"draft",origin:{sessionId:"session-receipt",workspaceId:"default"}}));
    expect(host.textContent).toContain("The activation review is attached to this turn.");
    await act(async()=>root.render(null));
    await act(async()=>root.render(<WorkflowSkillCaptureControl {...props} />));
    expect(host.textContent).toContain("Candidate saved.");
    expect(host.textContent).toContain("The activation review is attached to this turn.");
    expect(api.stage).toHaveBeenCalledOnce();
    expect(api.plan).toHaveBeenCalledOnce();
    expect(onReviewPlan).not.toHaveBeenCalled();
    api.fetchPlan.mockResolvedValueOnce({planId:"plan-1",status:"awaiting_input",origin:{sessionId:"session-receipt",workspaceId:"default"}});
    await act(async()=>button("Open activation review").click());
    expect(api.fetchPlan).toHaveBeenCalledWith("plan-1",{workspaceId:"default",sessionId:"session-receipt",turnId:"capture-turn"});
    expect(onReviewPlan).toHaveBeenCalledWith(expect.objectContaining({planId:"plan-1"}));
  });
  it("retains capture guidance through unmount and failed preparation", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host); roots.push(root);
    const props = { turn: sourceTurn, sessionId: "session-retained", workspaceId: "default", draftEmpty: true, onPrepare: vi.fn() };
    await act(async () => root.render(<WorkflowSkillCaptureControl {...props} />));
    await act(async () => host.querySelector("summary")!.click());
    const field = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Keep approval and provenance checks.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => root.render(null));
    await act(async () => root.render(<WorkflowSkillCaptureControl {...props} />));
    expect(host.querySelector("textarea")?.value).toBe("Keep approval and provenance checks.");
    expect(host.querySelector("summary")?.textContent).toContain("Unsaved");
    api.prepare.mockRejectedValueOnce(new Error("Preparation unavailable"));
    await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Prepare skill draft")!.click());
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Preparation unavailable");
    expect(host.querySelector("textarea")?.value).toBe("Keep approval and provenance checks.");
  });
  it.each(["draft", "session"])("preserves a %s changed while preparation was in flight", async (change) => {
    let resolve!: (result: { prompt: string }) => void;
    api.prepare.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const onPrepare = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const props = { turn: sourceTurn, sessionId: "session-1", workspaceId: "default", draftEmpty: true, onPrepare };
    await act(async () => root.render(<WorkflowSkillCaptureControl {...props} />));
    const prepare = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Prepare skill draft",
    )!;
    await act(async () => prepare.click());
    expect(api.prepare).toHaveBeenCalledOnce();
    await act(async () =>
      root.render(
        <WorkflowSkillCaptureControl
          {...props}
          draftEmpty={change !== "draft"}
          sessionId={change === "session" ? "session-2" : "session-1"}
        />,
      ),
    );
    await act(async () => resolve({ prompt: "prepared workflow payload" }));
    expect(onPrepare).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/changed/);
  });
});
