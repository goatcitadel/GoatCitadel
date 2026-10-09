// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelReturnNavigation } from "./use-channel-return-navigation";
import type { ChannelSettingsOwner } from "./use-channel-settings";
const api = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChannelSetupDraft: vi.fn(), fetchIntegrationConnection: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
const plan = { planId: "plan-exact", revision: 3, status: "completed", origin: { workspaceId: "default", surface: "settings" }, request: { kind: "channel_connection", draftId: "draft-exact", channelKind: "channel.telegram" }, target: { ownerId: "channel_setup_draft", resourceId: "draft-exact", expectedRevision: 7 }, evidenceRefs: ["channel-connection:connection-exact"] };
const draft = { draftId: "draft-exact", catalogId: "channel.telegram", connectionId: "connection-exact", revision: 8 };
const connection = { connectionId: "connection-exact", catalogId: "channel.telegram", revision: "current" };
const search = "?channelPlan=plan-exact&channelDraft=draft-exact&channelWorkspace=default&channelConnection=connection-exact";
function owner() {
  return { activeWorkspaceId: "default", data: { drafts: [draft], connections: [connection] }, isCurrentDraft: () => true,
    reload: vi.fn(async () => undefined), setNotice: vi.fn(), mergeDraft: vi.fn(), updateData: vi.fn(), setSelectedConnectionId: vi.fn(), setSelectedDraftId: vi.fn(), setPanel: vi.fn(), leave: { request: vi.fn() } };
}
async function render(value: ReturnType<typeof owner>, url = search) {
  function Harness() { useChannelReturnNavigation(value as unknown as ChannelSettingsOwner, url); return null; }
  let r!: ReactTestRenderer; await act(async () => { r = create(<Harness />); });
  for (let count = 0; count < 5; count++) await act(async () => { await Promise.resolve(); });
  return r;
}
beforeEach(() => { vi.clearAllMocks(); api.fetchChangePlan.mockResolvedValue(plan); api.fetchChannelSetupDraft.mockResolvedValue(draft); api.fetchIntegrationConnection.mockResolvedValue(connection); });
describe("canonical channel plan return", () => {
  it("fetches exact current plan and records before requesting the existing dirty leave guard", async () => {
    const value = owner(), r = await render(value);
    expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-exact", { workspaceId: "default" });
    expect(api.fetchChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.fetchIntegrationConnection).toHaveBeenCalledWith("connection-exact");
    expect(value.leave.request).toHaveBeenCalledTimes(1);
    expect(value.setSelectedConnectionId).not.toHaveBeenCalled();
    value.leave.request.mock.lastCall?.[0]();
    expect(value.setSelectedConnectionId).toHaveBeenCalledWith("connection-exact");
    expect(value.setPanel).toHaveBeenCalledWith("connection");
    r.unmount();
  });
  it("shows workspace guidance and retains current selection instead of switching workspace", async () => {
    const value = owner(), r = await render(value, search.replace("channelWorkspace=default", "channelWorkspace=other"));
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
    expect(value.leave.request).not.toHaveBeenCalled();
    expect(value.setNotice).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("workspace other") }));
    r.unmount();
  });
  it("rejects a foreign current plan even when the query IDs exist in the local list", async () => {
    api.fetchChangePlan.mockResolvedValue({ ...plan, request: { ...plan.request, draftId: "foreign-draft" }, target: { ...plan.target, resourceId: "foreign-draft" } });
    const value = owner(), r = await render(value);
    expect(value.leave.request).not.toHaveBeenCalled();
    expect(value.setNotice).toHaveBeenCalledWith(expect.objectContaining({ tone: "warning" }));
    expect(api.fetchChannelSetupDraft).not.toHaveBeenCalled();
    r.unmount();
  });
  it("rejects stale connection references that are absent from current activation evidence", async () => {
    api.fetchChangePlan.mockResolvedValue({ ...plan, evidenceRefs: [] });
    const value = owner(), r = await render(value);
    expect(value.leave.request).not.toHaveBeenCalled();
    expect(api.fetchIntegrationConnection).not.toHaveBeenCalled();
    r.unmount();
  });
  it("rejects a fresh connection with another catalog and stale navigation scopes", async () => {
    api.fetchIntegrationConnection.mockResolvedValue({ ...connection, catalogId: "channel.discord" });
    const value = owner(), r = await render(value);
    expect(value.leave.request).not.toHaveBeenCalled();
    r.unmount();
    api.fetchIntegrationConnection.mockResolvedValue(connection);
    const stale = owner(); stale.isCurrentDraft = () => false;
    const staleRenderer = await render(stale);
    expect(stale.leave.request).not.toHaveBeenCalled();
    staleRenderer.unmount();
  });  it("rejects duplicate navigation parameters and does not treat a draft ID alone as authority", async () => {
    const value = owner(), r = await render(value, search + "&channelDraft=draft-exact");
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
    expect(value.leave.request).not.toHaveBeenCalled();
    r.unmount();
    const plain = owner(), plainRenderer = await render(plain, "?channelDraft=draft-exact&channelWorkspace=default");
    expect(plain.leave.request).not.toHaveBeenCalled();
    plainRenderer.unmount();
  });
  it("returns an activated connection after successful finalization deleted its temporary draft", async () => {
    api.fetchChannelSetupDraft.mockRejectedValue(new Error("Draft no longer exists"));
    const value = owner(); value.data.drafts = [];
    const r = await render(value);
    expect(api.fetchChannelSetupDraft).not.toHaveBeenCalled();
    value.leave.request.mock.lastCall?.[0]();
    expect(value.setSelectedConnectionId).toHaveBeenCalledWith("connection-exact");
    expect(value.reload).toHaveBeenCalledTimes(1);
    r.unmount();
  });
  it("returns a cancelled plan to overview without requiring its deleted draft", async () => {
    api.fetchChangePlan.mockResolvedValue({ ...plan, status: "cancelled", evidenceRefs: [] });
    api.fetchChannelSetupDraft.mockRejectedValue(new Error("Cancelled draft deleted"));
    const value = owner(); value.data.drafts = [];
    const r = await render(value, search.replace("&channelConnection=connection-exact", ""));
    expect(api.fetchChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.fetchIntegrationConnection).not.toHaveBeenCalled();
    value.leave.request.mock.lastCall?.[0]();
    expect(value.setPanel).toHaveBeenCalledWith(null);
    expect(value.setNotice).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("cancelled") }));
    expect(value.reload).toHaveBeenCalledTimes(1);
    r.unmount();
  });
  it("retries the same query after the operator selects its matching workspace", async () => {
    const value = owner(); value.activeWorkspaceId = "other";
    function Harness({ workspaceId }: { workspaceId: string }) {
      useChannelReturnNavigation({ ...value, activeWorkspaceId: workspaceId } as unknown as ChannelSettingsOwner, search); return null;
    }
    let r!: ReactTestRenderer;
    await act(async () => { r = create(<Harness workspaceId="other" />); });
    expect(api.fetchChangePlan).not.toHaveBeenCalled();
    await act(async () => r.update(<Harness workspaceId="default" />));
    for (let count = 0; count < 5; count++) await act(async () => { await Promise.resolve(); });
    expect(api.fetchChangePlan).toHaveBeenCalledWith("plan-exact", { workspaceId: "default" });
    expect(value.leave.request).toHaveBeenCalledTimes(1);
    r.unmount();
  });
  it("returns pending plans to their fresh bound draft through the dirty leave guard", async () => {
    api.fetchChangePlan.mockResolvedValue({ ...plan, status: "awaiting_confirmation", evidenceRefs: [] });
    const value = owner(), r = await render(value, search.replace("&channelConnection=connection-exact", ""));
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("draft-exact");
    expect(value.setSelectedDraftId).not.toHaveBeenCalled();
    value.leave.request.mock.lastCall?.[0]();
    expect(value.setSelectedDraftId).toHaveBeenCalledWith("draft-exact");
    expect(value.setPanel).toHaveBeenCalledWith("editor");
    r.unmount();
  });

  it("retries a return read after automatic default catalog initialization changes owner scope", async () => {
    let resolveOld!: (value: typeof plan) => void;
    api.fetchChangePlan.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const value = owner(); let currentCatalog = "";
    function Harness({ catalog }: { catalog: string }) {
      const captured = catalog;
      useChannelReturnNavigation({ ...value, createCatalogId: catalog, isCurrentDraft: () => captured === currentCatalog } as unknown as ChannelSettingsOwner, search); return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness catalog="" />); });
    currentCatalog = "channel.slack";
    await act(async () => renderer.update(<Harness catalog={currentCatalog} />));
    await act(async () => resolveOld(plan));
    for (let count = 0; count < 5; count++) await act(async () => { await Promise.resolve(); });
    expect(api.fetchChangePlan).toHaveBeenCalledTimes(2);
    expect(value.leave.request).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

});
