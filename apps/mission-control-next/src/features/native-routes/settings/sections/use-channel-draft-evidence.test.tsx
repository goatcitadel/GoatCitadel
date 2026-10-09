// @vitest-environment happy-dom
import { useEffect, useRef } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft, ChannelSetupDraftEvidence, ChannelSetupEvidence, ChannelSetupTestResult } from "@goatcitadel/contracts";
import { useChannelSetupState, type ChannelSetupState } from "./use-channel-setup-state";
import { useChannelDraftActions } from "./use-channel-draft-actions";
import { useChannelDraftEvidence } from "./use-channel-draft-evidence";
import { ChannelSetupWizard } from "../channel-setup/ChannelSetupWizard";
import { ChannelDraftEditor } from "../../../../cockpit/areas/settings/ChannelDraftEditor";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../../library/session-drafts";
import { __resetChannelMutationStateForTests } from "./channel-setup-state";
const runtimeDefinitions = import.meta.glob<{ listChannelSetupDefinitions: () => ChannelSetupDefinition[] }>("../../../../../../gateway/src/services/channel-setup-definitions.ts");
const definition = (await Object.values(runtimeDefinitions)[0]!()).listChannelSetupDefinitions().find((item) => item.catalog.key === "ntfy")!;
const api = vi.hoisted(() => ({ fetchChannelSetupDefinitions: vi.fn(), fetchChannelSetupDrafts: vi.fn(), fetchIntegrationConnections: vi.fn(), fetchIntegrationConnection: vi.fn(), fetchSettings: vi.fn(), fetchChannelSetupDraft: vi.fn(), updateChannelSetupDraft: vi.fn(), submitChannelSetupDraftSecrets: vi.fn(), validateChannelSetupDraft: vi.fn(), testChannelSetupDraft: vi.fn(), createChangePlan: vi.fn() }));
const operations = vi.hoisted(() => ({ fetchChannelSetupDraftEvidence: vi.fn(), acknowledgeChannelSetupTest: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", () => operations);
vi.mock("../../../../cockpit/ui/Dialog", () => ({ Dialog: ({ open, children, title }: { open: boolean; children: import("react").ReactNode; title: string }) => open ? <div role="dialog" aria-label={title}>{children}</div> : null }));
const checkedAt = "2026-10-09T04:00:00.000Z";
const initialDraft: ChannelSetupDraft = { draftId: "resume-ntfy-fixture", revision: 7, catalogId: definition.catalog.catalogId, lifecycleMode: "create", label: "Resume fixture", enabled: true, draft: { topic: "fixture-topic" }, secretState: {}, contentVersion: definition.wizard.contentVersion, adapterVersion: definition.adapter.adapterVersion, validationVersion: definition.validation.validationVersion, testVersion: definition.testing.testVersion, createdAt: checkedAt, updatedAt: checkedAt };
const receipt: ChannelSetupEvidence = { evidenceId: "original-receipt", catalogId: initialDraft.catalogId, draftId: initialDraft.draftId, draftRevision: 5, phase: "test", status: "ok", checkedAt, createdAt: checkedAt, issues: [], probe: { kind: "ntfy", checkedAt, steps: [{ key: "send", label: "Sandbox send", status: "pass", disposition: "blocking", message: "Visible fixture notification accepted.", providerMessageId: "resume-provider-receipt", cleanupStatus: "completed" }] }, finalizationEligibility: { allowed: true, blockingReasons: [], evidenceId: "original-receipt" } };
const currentTest: ChannelSetupTestResult = { draftId: initialDraft.draftId, draftRevision: initialDraft.revision, status: "ok", levels: ["live-auth", "live-send"], checkedAt, proofExpiresAt: "2026-10-09T04:05:00.000Z", issues: receipt.issues, probe: receipt.probe, evidenceId: receipt.evidenceId, finalizationEligibility: receipt.finalizationEligibility };
const initialEvidence: ChannelSetupDraftEvidence = { draftId: initialDraft.draftId, draftRevision: initialDraft.revision, items: [receipt], currentTest };
let draft: ChannelSetupDraft;
let evidence: ChannelSetupDraftEvidence;
let owner!: ChannelSetupState;
let actions!: ReturnType<typeof useChannelDraftActions>;
let renderer: ReactTestRenderer | undefined;
const onPlan = vi.fn();
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join(" ").replace(/\s+/g, " ");
function button(view: ReactTestRenderer, label: string) { return view.root.findAllByType("button").find((item) => text(item).trim() === label)!; }
function Harness({ shell = "cockpit" }: { shell?: "classic" | "cockpit" }) {
  const state = useChannelSetupState("default");
  owner = state;
  actions = useChannelDraftActions(owner, onPlan);
  const saved = useChannelDraftEvidence(owner);
  const opened = useRef(false);
  useEffect(() => { if(state.data && !opened.current) { opened.current=true; state.setSelectedDraftId(initialDraft.draftId); state.setPanel("editor"); } }, [state]);
  if(!owner.selectedDraft || owner.panel !== "editor") return <p>Select a saved draft</p>;
  const props = { scopeId: "default", definition, draft: owner.selectedDraft, values: owner.draftValues, label: owner.draftLabel, enabled: owner.draftEnabled, dirty: owner.draftDirty, feedback: owner.validationRevision === owner.selectedDraft.revision ? owner.validationResult : null, busyAction: owner.busyAction, mutationBlocked: owner.mutation.pending || Boolean(owner.mutation.uncertain), draftEvidence: saved.draftEvidence, draftEvidenceLoading: saved.draftEvidenceLoading, draftEvidenceError: saved.draftEvidenceError,
    onValuesChange: owner.setDraftValues, onLabelChange: owner.setDraftLabel, onEnabledChange: owner.setDraftEnabled, onDirty: () => owner.setValidationResult(null), onSave: actions.handleSave, onValidate: actions.handleValidate, onTest: actions.handleTest, onFinalize: actions.handleFinalize, onAcknowledgeTest: actions.handleAcknowledgeTest };
  return shell === "classic" ? <ChannelSetupWizard {...props} /> : <ChannelDraftEditor {...props} />;
}
async function render(shell: "classic" | "cockpit" = "cockpit") { await act(async () => { renderer=create(<Harness shell={shell} />); }); for(let i=0;i<6;i++) await act(async () => { await Promise.resolve(); }); return renderer!; }
async function activation(view: ReactTestRenderer, shell: "classic" | "cockpit") {
  const title=definition.wizard.steps.find((step) => step.kind === "confirm")!.title;
  await act(async () => { view.root.findAllByType("button").find((item) => text(item).includes(title))!.props.onClick(); });
  return button(view, shell === "classic" ? "Finalize connection" : "Prepare finalization plan");
}
function deferred<T>() { let resolve!: (value: T) => void; const promise=new Promise<T>((next) => { resolve=next; }); return { promise, resolve }; }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(new Date("2026-10-09T04:01:00.000Z"));
  vi.resetAllMocks(); onPlan.mockReset(); __resetSessionViewStateForTests(); __resetSessionDraftsForTests(); __resetChannelMutationStateForTests();
  draft=structuredClone(initialDraft); evidence=structuredClone(initialEvidence);
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [definition] }); api.fetchChannelSetupDrafts.mockImplementation(async () => ({ items: [structuredClone(draft)] })); api.fetchIntegrationConnections.mockResolvedValue({ items: [] }); api.fetchSettings.mockResolvedValue({ features: {} }); api.fetchChannelSetupDraft.mockImplementation(async () => structuredClone(draft));
  operations.fetchChannelSetupDraftEvidence.mockImplementation(async () => structuredClone(evidence));
  api.createChangePlan.mockImplementation(async () => ({ planId: "resume-plan", revision: 1, status: "awaiting_confirmation", origin: { workspaceId: "default", surface: "settings" }, request: { kind: "channel_connection", draftId: draft.draftId, channelKind: draft.catalogId }, target: { ownerId: "channel_setup_draft", resourceId: draft.draftId, expectedRevision: draft.revision } }));
  api.updateChannelSetupDraft.mockImplementation(async (_id: string, input: { expectedRevision: number; label?: string; enabled: boolean; draft: Record<string, unknown> }) => { draft={ ...draft, revision: input.expectedRevision+1, label: input.label, enabled: input.enabled, draft: input.draft }; evidence={ ...evidence, draftRevision: draft.revision, currentTest: undefined }; return structuredClone(draft); });
});
afterEach(async () => { if(renderer) await act(async () => { renderer?.unmount(); }); renderer=undefined; vi.useRealTimers(); });
describe("exact saved draft evidence recovery", () => {
  for(const shell of ["classic", "cockpit"] as const) it(shell+" restores canonical current proof and prepares its exact plan without validation or another live send", async () => {
    const view=await render(shell);
    expect(operations.fetchChannelSetupDraftEvidence).toHaveBeenCalledWith(draft.draftId, 7);
    expect(owner.validationRevision).toBe(7);
    expect(owner.validationResult).toEqual(expect.objectContaining({ kind: "test", restored: true, evidenceId: receipt.evidenceId, finalizationEligibility: { allowed: true, blockingReasons: [], evidenceId: receipt.evidenceId } }));
    const history=view.root.findByProps({ "aria-label": "Channel check history" });
    expect(text(history)).toContain("Tested draft revision 5");
    expect(text(history)).toContain("Provider receipt: resume-provider-receipt");
    expect(text(view.root.findByProps({ "aria-label": "Channel check result" }))).toContain("Restored current proof for this saved draft revision");
    const prepare=await activation(view, shell); expect(prepare.props.disabled).toBe(false);
    await act(async () => { await prepare.props.onClick(); });
    expect(api.createChangePlan).toHaveBeenCalledWith(expect.objectContaining({ request: { kind: "channel_connection", channelKind: draft.catalogId, draftId: draft.draftId }, idempotencyKey: "settings-channel-finalize:"+draft.draftId+":7" }));
    expect(onPlan).toHaveBeenCalledTimes(1);
    for(const mock of [api.validateChannelSetupDraft, api.testChannelSetupDraft, api.updateChannelSetupDraft, api.submitChannelSetupDraftSecrets, operations.acknowledgeChannelSetupTest]) expect(mock).not.toHaveBeenCalled();
  });
  it("keeps expired/history-only receipts visible while blocking plan preparation even when they were once allowed", async () => {
    evidence.currentTest=undefined;
    const view=await render(); const prepare=await activation(view, "cockpit");
    expect(prepare.props.disabled).toBe(true); expect(owner.validationResult).toBeNull();
    const history=view.root.findByProps({ "aria-label": "Channel check history" });
    expect(text(history)).toContain("No fresh test proof is available"); expect(text(history)).toContain("Passed");
    expect(text(view.root)).not.toContain("The Gateway permits preparing"); expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
  });
  it("clears previously restored proof when a later exact refresh has only history", async () => {
    const view=await render(); expect(owner.validationResult?.restored).toBe(true);
    evidence.currentTest=undefined; await act(async () => { await owner.reload(); });
    expect(owner.validationResult).toBeNull(); expect(owner.validationRevision).toBeNull();
    expect((await activation(view, "cockpit")).props.disabled).toBe(true);
    expect(text(view.root.findByProps({ "aria-label": "Channel check history" }))).toContain("original-receipt");
  });
  it("preserves newer dirty input and displays history without restoring eligibility from a delayed read", async () => {
    const read=deferred<ChannelSetupDraftEvidence>(); operations.fetchChannelSetupDraftEvidence.mockReturnValue(read.promise);
    const view=await render(); await act(async () => { owner.setDraftValues({ topic: "unsaved-new-destination" }); });
    await act(async () => { read.resolve(structuredClone(initialEvidence)); });
    expect(owner.draftValues).toEqual({ topic: "unsaved-new-destination" }); expect(owner.draftDirty).toBe(true); expect(owner.validationResult).toBeNull();
    expect((await activation(view, "cockpit")).props.disabled).toBe(true);
    expect(text(view.root.findByProps({ "aria-label": "Channel check history" }))).toContain("original-receipt");
  });
  it("drops delayed proof after a newer save and never overwrites its current revision/input", async () => {
    const read=deferred<ChannelSetupDraftEvidence>(); operations.fetchChannelSetupDraftEvidence.mockReturnValueOnce(read.promise);
    const view=await render(); await act(async () => { owner.setDraftValues({ topic: "saved-new-destination" }); });
    await act(async () => { expect(await actions.handleSave()).toBe(true); });
    expect(owner.selectedDraft?.revision).toBe(8); expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    await act(async () => { read.resolve(structuredClone(initialEvidence)); });
    expect(owner.draftValues).toEqual({ topic: "saved-new-destination" }); expect(owner.validationResult).toBeNull();
    expect((await activation(view, "cockpit")).props.disabled).toBe(true); expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
  });
  it("drops a response after navigating out of its editor scope", async () => {
    const read=deferred<ChannelSetupDraftEvidence>(); operations.fetchChannelSetupDraftEvidence.mockReturnValue(read.promise);
    const view=await render(); await act(async () => { owner.setPanel("connection"); });
    await act(async () => { read.resolve(structuredClone(initialEvidence)); });
    expect(owner.validationResult).toBeNull(); expect(text(view.root)).toContain("Select a saved draft");
  });
  for(const foreign of ["draft", "revision", "receipt", "history"] as const) it("rejects foreign "+foreign+" bindings without permitting historical eligibility", async () => {
    if(foreign === "draft") evidence.draftId="foreign-draft";
    if(foreign === "revision") evidence.draftRevision=6;
    if(foreign === "receipt") evidence.currentTest={ ...currentTest, evidenceId: "foreign-receipt" };
    if(foreign === "history") evidence.items=[{ ...receipt, catalogId: "channel.telegram" }];
    const view=await render(); expect(owner.validationResult).toBeNull();
    expect((await activation(view, "cockpit")).props.disabled).toBe(true);
    expect(text(view.root)).toContain("Saved check evidence could not be verified");
    expect(api.createChangePlan).not.toHaveBeenCalled();
  });
  it("retains history but rejects a canonical proof that expired while its response was delayed", async () => {
    const read=deferred<ChannelSetupDraftEvidence>(); operations.fetchChannelSetupDraftEvidence.mockReturnValue(read.promise);
    const view=await render(); vi.setSystemTime(new Date("2026-10-09T04:06:00.000Z"));
    await act(async () => { read.resolve(structuredClone(initialEvidence)); });
    expect(owner.validationResult).toBeNull(); expect(owner.validationRevision).toBeNull();
    expect((await activation(view,"cockpit")).props.disabled).toBe(true);
    expect(text(view.root.findByProps({ "aria-label": "Channel check history" }))).toContain("original-receipt");
    expect(text(view.root)).toContain("No fresh test proof is available"); expect(text(view.root)).not.toContain("The Gateway permits preparing");
  });
  for(const shell of ["classic", "cockpit"] as const) it(shell+" expires an open current result without losing historical receipts or permitting a stale action", async () => {
    const view=await render(shell); expect((await activation(view,shell)).props.disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(240_001); });
    expect((await activation(view,shell)).props.disabled).toBe(true);
    expect(text(view.root.findByProps({ "aria-label": "Channel check result" }))).toContain("This test proof expired");
    expect(text(view.root)).not.toContain("The Gateway permits preparing");
    expect(text(view.root.findByProps({ "aria-label": "Channel check history" }))).toContain("original-receipt");
    await act(async () => { await actions.handleFinalize(); }); expect(api.createChangePlan).not.toHaveBeenCalled(); expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
  });
  it("rechecks the deadline after a slow canonical draft read before dispatching any plan mutation", async () => {
    await render(); const read=deferred<ChannelSetupDraft>(); api.fetchChannelSetupDraft.mockReturnValue(read.promise);
    let preparing!: Promise<void>; await act(async () => { preparing=actions.handleFinalize(); });
    vi.setSystemTime(new Date("2026-10-09T04:06:00.000Z"));
    await act(async () => { read.resolve(structuredClone(draft)); await preparing; });
    expect(api.createChangePlan).not.toHaveBeenCalled(); expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
  });
  it("expires an open acknowledgement review and blocks its direct callback as well", async () => {
    evidence.currentTest={ ...currentTest, status: "warn", finalizationEligibility: { allowed: false, blockingReasons: ["Observe the receipt"], evidenceId: receipt.evidenceId, requiresAcknowledgement: true } };
    const view=await render(); await act(async () => { button(view,"Review delivery confirmation").props.onClick(); });
    expect(button(view,"Confirm observed sandbox message").props.disabled).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(240_001); });
    expect(button(view,"Confirm observed sandbox message").props.disabled).toBe(true);
    await act(async () => { await actions.handleAcknowledgeTest("receipt"); });
    expect(operations.acknowledgeChannelSetupTest).not.toHaveBeenCalled(); expect(api.testChannelSetupDraft).not.toHaveBeenCalled();
  });
  it("restores warning/cleanup evidence for explicit exact acknowledgement without changing its warning status", async () => {
    const warning={ ...receipt, status: "warn" as const, issues: [{ key: "cleanup", level: "warn" as const, message: "Remove the sandbox message manually." }], probe: { ...receipt.probe!, steps: [{ key: "cleanup", label: "Test message cleanup", status: "warn" as const, disposition: "advisory" as const, message: "Provider cleanup not confirmed.", providerMessageId: "resume-provider-receipt", cleanupStatus: "manual_required" as const }] }, finalizationEligibility: { allowed: false, blockingReasons: ["Cleanup needs acknowledgement"], evidenceId: receipt.evidenceId, requiresAcknowledgement: true } };
    evidence={ ...evidence, items: [warning], currentTest: { ...currentTest, status: "warn", issues: warning.issues, probe: warning.probe, finalizationEligibility: warning.finalizationEligibility } };
    operations.acknowledgeChannelSetupTest.mockImplementation(async () => {
      const acknowledged={ ...warning, evidenceId: "acknowledged-receipt", phase: "acknowledgement" as const, priorEvidenceId: warning.evidenceId, acknowledgement: "cleanup" as const, finalizationEligibility: { allowed: true, blockingReasons: [], evidenceId: "acknowledged-receipt" } };
      evidence={ ...evidence, items: [acknowledged, warning], currentTest: { ...evidence.currentTest!, evidenceId: acknowledged.evidenceId, finalizationEligibility: acknowledged.finalizationEligibility } }; return structuredClone(evidence.currentTest);
    });
    const view=await render(); expect((await activation(view, "cockpit")).props.disabled).toBe(true);
    await act(async () => { button(view,"Review test message cleanup").props.onClick(); });
    await act(async () => { await button(view,"Acknowledge reviewed cleanup warning").props.onClick(); });
    for(let i=0;i<4;i++) await act(async () => { await Promise.resolve(); });
    expect(operations.acknowledgeChannelSetupTest).toHaveBeenCalledWith(draft.draftId, { expectedRevision: 7, evidenceId: receipt.evidenceId, acknowledgement: "cleanup" });
    expect(owner.validationResult?.status).toBe("warn"); expect(owner.validationResult?.finalizationEligibility?.allowed).toBe(true);
    expect(text(view.root)).toContain("Reviewed cleanup warning acknowledged"); expect(text(view.root)).toContain("Connection test · Warning");
    expect((await activation(view,"cockpit")).props.disabled).toBe(false);
    expect(api.testChannelSetupDraft).not.toHaveBeenCalled(); expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
  });
});
