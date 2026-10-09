import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { channelPlanReviewSearch, createChannelPlanReviewHandoff } from "@goatcitadel/mission-control-shared/api/channel-plan-handoff";
import { WorkspaceChannelPlanReview, isExactReviewedChannelAction } from "../../../../../packages/threaded-surface-core/src/chat/WorkspaceChannelPlanReview";

const api = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), confirmChangePlan: vi.fn(), cancelChangePlan: vi.fn(), respondToChangePlan: vi.fn(), submitChangePlanChannelSecrets: vi.fn(), dialog: null as Record<string, any> | null }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ API_BASE: "http://gateway-a" }));
vi.mock("@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog", () => ({
  ChatChangePlanActionDialog: (props: Record<string, any>) => { api.dialog = props; return props.plan?.requiredAction?.kind === "approval" ? props.renderApprovalAction(props.plan, props.pending) : null; },
}));
vi.mock("@goatcitadel/mission-control-shared/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => createElement("button", props),
}));
const base = {
  planId: "plan-a", revision: 3, origin: { surface: "settings", workspaceId: "workspace-a" },
  request: { kind: "channel_connection", channelKind: "channel.slack", draftId: "draft-a" },
  target: { ownerId: "channel_setup_draft", resourceId: "draft-a", expectedRevision: 7 },
  requiredAction: { kind: "confirmation", actionId: "action-a", actionNonce: "nonce-a", title: "Confirm Slack", confirmationText: "Apply reviewed setup." },
  title: "Connect Slack", summary: "Review Slack setup.", impact: "Provider test", risk: "caution", status: "awaiting_confirmation", intentHash: "intent-a",
  actionSnapshotHash: "snapshot-a", evidenceRefs: [], approvalRefs: [],
} as unknown as ChangePlanRecord;
let renderer: ReactTestRenderer | undefined;
beforeEach(() => { vi.clearAllMocks(); api.dialog = null; });
afterEach(async () => { await act(async () => renderer?.unmount()); renderer = undefined; });
const search = (plan = base) => channelPlanReviewSearch(createChannelPlanReviewHandoff(plan));
async function render(props: Partial<Parameters<typeof WorkspaceChannelPlanReview>[0]> = {}) {
  const input = { workspaceId: "workspace-a", routeSearch: search(), onReturnToChannels: vi.fn(), onOpenApprovals: vi.fn(), ...props };
  await act(async () => { renderer = create(<WorkspaceChannelPlanReview {...input} />); });
  return input;
}
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => node.children.join("") === label)!;
}
describe("workspace channel plan review in Chat", () => {
  it("reviews the exact settings plan using workspace-only canonical actions and returns to its connection evidence", async () => {
    api.fetchChangePlan.mockResolvedValue(base);
    const input = await render();
    expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-a", { workspaceId: "workspace-a" });
    expect(api.dialog!.plan).toEqual(base);
    const completed = { ...base, revision: 4, status: "completed", requiredAction: undefined, evidenceRefs: ["channel-connection:connection-a"] };
    api.confirmChangePlan.mockResolvedValue(completed);
    await act(async () => { await api.dialog!.onConfirm(base); });
    expect(api.confirmChangePlan).toHaveBeenCalledWith("plan-a", { workspaceId: "workspace-a" }, { expectedRevision: 3, actionNonce: "nonce-a" });
    await act(async () => button("Return to Channels").props.onClick());
    expect(input.onReturnToChannels).toHaveBeenCalledWith("/settings/channels?channelPlan=plan-a&channelDraft=draft-a&channelWorkspace=workspace-a&channelConnection=connection-a");
  });
  it("continues only the exact approval action through the canonical empty-response owner", async () => {
    const awaiting = { ...base, status: "awaiting_approval", requiredAction: {
      kind: "approval", actionId: "approval-action", actionNonce: "approval-nonce", title: "Review canonical approval", risk: "caution", approvalId: "approval-a",
    } } as ChangePlanRecord;
    api.fetchChangePlan.mockResolvedValue(awaiting);
    const input = await render();
    await act(async () => button("Open required approval").props.onClick());
    expect(input.onOpenApprovals).toHaveBeenCalledWith("approval-a");
    api.respondToChangePlan.mockRejectedValueOnce(new Error("Change Plan approval is not resolved as approved."));
    await act(async () => button("Continue after approval").props.onClick());
    expect(api.respondToChangePlan).toHaveBeenLastCalledWith("plan-a", { workspaceId: "workspace-a" }, {
      expectedRevision: 3, actionId: "approval-action", actionNonce: "approval-nonce", values: {},
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("not resolved as approved");
    expect(input.onReturnToChannels).not.toHaveBeenCalled();
    api.respondToChangePlan.mockResolvedValueOnce({ ...awaiting, revision: 4, status: "completed", requiredAction: undefined, evidenceRefs: ["channel-connection:connection-a"] });
    await act(async () => button("Continue after approval").props.onClick());
    await act(async () => button("Return to Channels").props.onClick());
    expect(input.onReturnToChannels).toHaveBeenCalledWith(expect.stringContaining("channelConnection=connection-a"));
  });
  it("requires a fresh review on changed revision and rejects a later stale action without confirmation", async () => {
    const changed = { ...base, revision: 4, actionSnapshotHash: "snapshot-b", requiredAction: { ...base.requiredAction!, actionNonce: "nonce-b" } };
    api.fetchChangePlan.mockResolvedValueOnce(changed);
    await render();
    expect(api.dialog!.plan).toBeNull();
    expect(JSON.stringify(renderer!.toJSON())).toContain("changed since Channels");
    await act(async () => button("Review current revision").props.onClick());
    expect(api.dialog!.plan).toEqual(changed);
    const changedAgain = { ...changed, revision: 5 };
    api.fetchChangePlan.mockResolvedValueOnce(changedAgain);
    await act(async () => { await api.dialog!.onConfirm(changed); });
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
    expect(api.dialog!.plan).toBeNull();
    expect(JSON.stringify(renderer!.toJSON())).toContain("requested action changed");
  });
  it("drops a delayed exact lookup after changing workspace and plan", async () => {
    let finishOld!: (plan: ChangePlanRecord) => void;
    api.fetchChangePlan.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
    const input = await render();
    const other = { ...base, planId: "plan-b", origin: { surface: "settings", workspaceId: "workspace-b" },
      request: { kind: "channel_connection", channelKind: "channel.slack", draftId: "draft-b" }, target: { ...base.target, resourceId: "draft-b" } } as ChangePlanRecord;
    api.fetchChangePlan.mockResolvedValueOnce(other);
    await act(async () => renderer!.update(<WorkspaceChannelPlanReview {...input} workspaceId="workspace-b" routeSearch={search(other)} />));
    await act(async () => finishOld(base));
    expect(api.dialog!.plan.planId).toBe("plan-b");
    expect(api.dialog!.plan.origin.workspaceId).toBe("workspace-b");
  });
  it("drops a late confirmation receipt after the workspace review changes", async () => {
    api.fetchChangePlan.mockResolvedValue(base);
    const input = await render();
    let finish!: (value: ChangePlanRecord) => void;
    api.confirmChangePlan.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let running!: Promise<void>;
    await act(async () => { running = api.dialog!.onConfirm(base); await Promise.resolve(); });
    const other = { ...base, planId: "plan-b", origin: { surface: "settings", workspaceId: "workspace-b" },
      request: { kind: "channel_connection", channelKind: "channel.slack", draftId: "draft-b" }, target: { ...base.target, resourceId: "draft-b" } } as ChangePlanRecord;
    api.fetchChangePlan.mockResolvedValueOnce(other);
    await act(async () => renderer!.update(<WorkspaceChannelPlanReview {...input} workspaceId="workspace-b" routeSearch={search(other)} />));
    await act(async () => { finish({ ...base, revision: 4, status: "completed", requiredAction: undefined }); await running; });
    expect(api.dialog!.plan.planId).toBe("plan-b");
    expect(input.onReturnToChannels).not.toHaveBeenCalled();
  });
  it("rejects session-origin and changed target/nonce snapshots", async () => {
    expect(isExactReviewedChannelAction(base, { ...base, requiredAction: { ...base.requiredAction!, actionNonce: "different" } })).toBe(false);
    expect(isExactReviewedChannelAction(base, { ...base, target: { ...base.target, expectedRevision: 8 } })).toBe(false);
    api.fetchChangePlan.mockResolvedValue({ ...base, origin: { ...base.origin, sessionId: "session-other", surface: "chat" } });
    await render();
    expect(api.dialog).toBeNull();
    expect(JSON.stringify(renderer!.toJSON())).toContain("not a workspace channel setup plan");
    expect(api.confirmChangePlan).not.toHaveBeenCalled();
  });
});