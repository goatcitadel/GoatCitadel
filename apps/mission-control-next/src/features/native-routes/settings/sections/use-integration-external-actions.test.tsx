import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExternalConnectorServiceDetail, ExternalConnectorActionSummary, ExternalConnectorReviewStateRecord,
  CapabilityProposalRecord, ExternalSideEffectRunRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { useIntegrationSettings, type IntegrationSettingsOwner } from "./use-integration-settings";
import { externalReviewSummary } from "./external-connector-review";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { __resetIntegrationConnectionMutationsForTests } from "../integration-connection-mutation";
const api = vi.hoisted(() => ({ fetchIntegrationCatalog: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchSettings: vi.fn(),
  fetchExternalConnectorServices: vi.fn(), fetchExternalConnectorService: vi.fn(), fetchExternalConnectorAction: vi.fn(),
  updateExternalConnectorServiceReviewState: vi.fn(), updateExternalConnectorActionReviewState: vi.fn(),
  stageExternalConnectorAction: vi.fn(), fetchCapabilityProposal: vi.fn(), fetchExternalSideEffectRuns: vi.fn(),
  createExternalSideEffectReplayAuditRun: vi.fn(), fetchDurableRun: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (load) => ({ ...(await load<object>()), ...api }));
const time = "2026-09-30T00:00:00.000Z";
const action: ExternalConnectorActionSummary = { sourceId: "mscr", serviceId: "fixture", actionId: "inspect", catalogId: "mscr.fixture.inspect", label: "Inspect fixture", description: "Fixture", active: true, callable: false, runtimePosture: "catalog_only", configurationFields: [], upstreamPath: "fixture/inspect.ts", handlerSha256: "a".repeat(64), reviewState: { status: "new", pinned: false } };
const initial: ExternalConnectorServiceDetail = { sourceId: "mscr", serviceId: "fixture", catalogId: "mscr.fixture", label: "Fixture", description: "Fixture connector", auth: [], actionCount: 1, activeActionCount: 1, callable: false, runtimePosture: "catalog_only", source: { sourceId: "mscr", label: "Fixture catalog", repositoryUrl: "https://example.test/fixture", commit: "a".repeat(40), generatedAt: time, importerVersion: "fixture", serviceCount: 1, actionCount: 1 }, reviewState: { status: "new", pinned: false }, actions: [action] };
const run: ExternalSideEffectRunRecord = { runId: "effect", workspaceId: "default", boundary: "fixture", routePath: "/fixture", connectionId: "connection", actorScope: "operator", idempotencyKey: "fixture", payloadHash: "a".repeat(64), status: "failed_before_boundary", replayPolicy: "audit_only", resumeState: "manual_retry_after_recorded_failure", attemptCount: 1, createdAt: time, updatedAt: time };
let service: ExternalConnectorServiceDetail, owner: IntegrationSettingsOwner, view: ReactTestRenderer;
function Harness({ workspace = "default" }: { workspace?: string }) { owner = useIntegrationSettings(workspace); return null; }
async function mount(panel: "connectors" | "history" = "connectors") { await act(async () => { view = create(<Harness />); }); await act(async () => owner.openPanel(panel)); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  vi.resetAllMocks(); __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); __resetSessionViewStateForTests(); __resetIntegrationConnectionMutationsForTests();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network in hermetic connector proof"); }));
  service = structuredClone(initial);
  api.fetchIntegrationCatalog.mockResolvedValue({ items: [] }); api.fetchIntegrationConnections.mockResolvedValue({ items: [] }); api.fetchSettings.mockResolvedValue({});
  api.fetchExternalConnectorServices.mockImplementation(async () => ({ items: [service] })); api.fetchExternalConnectorService.mockImplementation(async () => service);
  api.fetchExternalConnectorAction.mockImplementation(async () => service.actions[0]); api.fetchExternalSideEffectRuns.mockResolvedValue({ items: [run] });
  api.updateExternalConnectorActionReviewState.mockImplementation(async (_source, _service, _action, input) => {
    const state: ExternalConnectorReviewStateRecord = { workspaceId: input.workspaceId, sourceId: "mscr", serviceId: "fixture", actionId: "inspect", status: input.status, pinned: false, createdAt: time, updatedAt: time };
    service = { ...service, actions: [{ ...action, reviewState: externalReviewSummary(state) }] }; return state;
  });
});
afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });

describe("external connector review owner", () => {
  it("keeps review/cancel read-only then confirms one exact scoped metadata write", async () => {
    await mount(); await act(async () => owner.handleReviewExternalConnectorAction(action, "reviewed"));
    expect(api.updateExternalConnectorActionReviewState).not.toHaveBeenCalled();
    await act(async () => owner.cancelExternalReview()); expect(api.updateExternalConnectorActionReviewState).not.toHaveBeenCalled();
    await act(async () => owner.handleReviewExternalConnectorAction(action, "reviewed"));
    await act(async () => { await Promise.all([owner.confirmExternalReview(), owner.confirmExternalReview()]); });
    expect(api.updateExternalConnectorActionReviewState).toHaveBeenCalledExactlyOnceWith("mscr", "fixture", "inspect", { workspaceId: "default", status: "reviewed" });
    expect(owner.notice?.message).toContain("remains non-callable"); expect(owner.externalMutation.locked).toBe(false);
  });
  it("withholds dispatch if catalog evidence changes, or navigation leaves and returns during preflight", async () => {
    await mount(); await act(async () => owner.handleReviewExternalConnectorAction(action, "reviewed"));
    api.fetchExternalConnectorService.mockResolvedValueOnce({ ...service, source: { ...service.source, commit: "b".repeat(40) } });
    await act(async () => { await owner.confirmExternalReview(); }); expect(api.updateExternalConnectorActionReviewState).not.toHaveBeenCalled(); expect(owner.externalMutation.locked).toBe(false);
    const pending = deferred<ExternalConnectorServiceDetail>(); api.fetchExternalConnectorService.mockReturnValueOnce(pending.promise);
    let saving!: Promise<void>; await act(async () => { saving = owner.confirmExternalReview(); });
    await act(async () => view.update(<Harness workspace="other" />)); await act(async () => view.update(<Harness />));
    await act(async () => { pending.resolve(service); await saving; }); expect(api.updateExternalConnectorActionReviewState).not.toHaveBeenCalled();
  });
  it.each(["lost", "foreign", "readback"])("retains %s post-dispatch uncertainty across remount", async (kind) => {
    await mount(); await act(async () => owner.handleReviewExternalConnectorAction(action, "reviewed"));
    if (kind === "lost") api.updateExternalConnectorActionReviewState.mockRejectedValueOnce(new Error("Lost response"));
    if (kind === "foreign") api.updateExternalConnectorActionReviewState.mockResolvedValueOnce({ workspaceId: "other" });
    if (kind === "readback") api.fetchExternalConnectorAction.mockResolvedValueOnce({ ...action, actionId: "foreign" });
    await act(async () => { await owner.confirmExternalReview(); }); expect(owner.externalMutation.phase).toBe("uncertain");
    await act(async () => view.unmount()); await mount(); await act(async () => owner.handleReviewExternalConnectorAction(action, "reviewed"));
    await act(async () => { await owner.confirmExternalReview(); }); expect(api.updateExternalConnectorActionReviewState).toHaveBeenCalledOnce();
  });
  it("stages only a verified non-callable proposal and checks both canonical owners", async () => {
    const proposal: CapabilityProposalRecord = { proposalId: "proposal", proposalKind: "tool", status: "proposed", title: "Fixture", summary: "Fixture", createdAt: time, updatedAt: time,
      payload: { sourceKind: "external_connector_catalog", sourceId: "mscr", sourceCommit: service.source.commit, callable: false, runtimePosture: "catalog_only", service: { serviceId: "fixture" }, action: { actionId: "inspect", handlerSha256: action.handlerSha256 } } };
    api.stageExternalConnectorAction.mockImplementation(async () => {
      const state: ExternalConnectorReviewStateRecord = { workspaceId: "default", sourceId: "mscr", serviceId: "fixture", actionId: "inspect", status: "staged", pinned: true, proposalId: "proposal", createdAt: time, updatedAt: time };
      service = { ...service, actions: [{ ...action, reviewState: externalReviewSummary(state) }] };
      return { state, proposal, action: service.actions[0], message: "Staged" };
    });
    api.fetchCapabilityProposal.mockResolvedValue({ proposal, events: [] });
    await mount(); await act(async () => owner.handleStageExternalConnectorAction(action));
    expect(api.stageExternalConnectorAction).not.toHaveBeenCalled(); await act(async () => { await owner.confirmExternalReview(); });
    expect(api.fetchCapabilityProposal).toHaveBeenCalledExactlyOnceWith("proposal"); expect(owner.notice?.message).toContain("remains non-callable"); expect(owner.externalMutation.locked).toBe(false);
  });
});

describe("durable replay audit handoff", () => {
  it("requires explicit review, rechecks the side-effect owner, and binds the created durable payload", async () => {
    let saved: DurableRunRecord;
    api.createExternalSideEffectReplayAuditRun.mockImplementation(async (input) => { saved = { runId: "audit", workflowKey: "external_side_effect.replay", status: "queued", attemptCount: 0, maxAttempts: 1, version: 1,
      payload: { version: "external_side_effect.replay.v1", ...input }, metadata: { posture: "replay_audit", sideEffectPosture: "eligibility_check" }, createdAt: time, updatedAt: time }; return saved; });
    api.fetchDurableRun.mockImplementation(async () => ({ ...saved, status: "running" }));
    await mount("history"); await act(async () => owner.handleStartReplayAudit(run)); expect(api.createExternalSideEffectReplayAuditRun).not.toHaveBeenCalled();
    await act(async () => { await owner.confirmReplayAudit(); });
    expect(api.createExternalSideEffectReplayAuditRun).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: "default", runIds: ["effect"], connectionId: "connection", limit: 1 }));
    expect(owner.lastReplayAuditRunId).toBe("audit"); expect(owner.replayMutation.locked).toBe(false);
  });
  it("never audits a foreign/unknown outcome or stale preflight snapshot", async () => {
    await mount("history"); await act(async () => owner.handleStartReplayAudit({ ...run, workspaceId: "other" })); expect(owner.replayReview).toBeNull();
    await act(async () => owner.handleStartReplayAudit({ ...run, status: "unknown_external_outcome" })); expect(owner.replayReview).toBeNull();
    await act(async () => owner.handleStartReplayAudit(run)); api.fetchExternalSideEffectRuns.mockResolvedValueOnce({ items: [{ ...run, status: "external_call_started" }] });
    await act(async () => { await owner.confirmReplayAudit(); }); expect(api.createExternalSideEffectReplayAuditRun).not.toHaveBeenCalled();
  });
  it("retains an unknown durable creation rather than repeating it", async () => {
    api.createExternalSideEffectReplayAuditRun.mockRejectedValueOnce(new Error("Lost reply"));
    await mount("history"); await act(async () => owner.handleStartReplayAudit(run)); await act(async () => { await owner.confirmReplayAudit(); });
    expect(owner.replayMutation.phase).toBe("uncertain"); await act(async () => view.unmount()); await mount("history");
    await act(async () => owner.handleStartReplayAudit(run)); await act(async () => { await owner.confirmReplayAudit(); }); expect(api.createExternalSideEffectReplayAuditRun).toHaveBeenCalledOnce();
  });
});
