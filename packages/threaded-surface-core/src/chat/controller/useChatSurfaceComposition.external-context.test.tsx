import { act, create, type ReactTestRenderer } from "react-test-renderer";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatSurfaceComposition } from "./useChatSurfaceComposition";
import { useChatComposerSendIntent } from "./useChatComposerSendIntent";
const inspection = vi.hoisted(() => ({ source: "immutable-bound-profile" }));
vi.mock("../useMissionControlSurfaceState", () => ({ useMissionControlSurfaceState: () => ({ messageMode: "chat" }) }));
vi.mock("../useChatCapabilityProfileInspection", () => ({ useChatCapabilityProfileInspection: () => inspection }));
vi.mock("../useChatDockWorkbenchController", () => ({ useChatDockWorkbenchController: () => ({ setDockOpen: vi.fn() }) }));
vi.mock("../useChatRunPresentation", () => ({ useChatRunPresentation: () => ({}) }));
type SurfaceInput = Parameters<typeof useChatSurfaceComposition>[0];
type SendInput = Parameters<typeof useChatComposerSendIntent>[0];
let root: ReactTestRenderer, result: ReturnType<typeof useChatSurfaceComposition>, send: ReturnType<typeof useChatComposerSendIntent>;
const handleSend = vi.fn(), setDraft = vi.fn(), notice = vi.fn(), queue = vi.fn();
beforeEach(() => { vi.clearAllMocks(); act(() => { root = create(<></>); }); });
afterEach(() => { act(() => root.unmount()); });
function Harness({ selected, draft = "Continue my work", historical = false }: { selected: string[]; draft?: string; historical?: boolean }) {
 const session = { sessionData: { proactiveRuns: [], specialistCandidates: [], learnedMemory: [], ...(historical ? { historicalWindowTarget: { workspaceId: "one", sessionId: "chat-a" }, historicalWindow: {} } : {}) }, threadController: { missionSessions: [], externalSessions: [] }, externalControl: {}, externalSourceAttachments: { selectedAttachmentIds: selected }, documentContext: { pendingDocumentContextRefs: [] } };
 result = useChatSurfaceComposition({ session, workspaceId: "one", draft, pendingAttachments: [], sending: false, selection: { selectedSessionId: "chat-a" }, execution: { contextActions: { capabilitySuggestions: [], specialistSuggestions: [] }, outbound: {}, setCapabilitySuggestions: vi.fn(), setSpecialistSuggestions: vi.fn() }, coordination: { lastCapabilitySuggestionSyncKeyRef: { current: null }, lastSpecialistSuggestionSyncKeyRef: { current: null }, activeStreamRef: { current: null } }, submission: { currentRoutePreflight: null, routePreflight: {}, providerRouting: {}, orchestration: {} }, oneShotContext: {}, pushLocalNotice: notice } as unknown as SurfaceInput);
 send = useChatComposerSendIntent({ workspaceId: "one", profileDependentAdmissionBlockReason: result.profileDependentAdmissionBlockReason, notices: { pushLocalNotice: notice }, setFollowThreadOutput: vi.fn(), knowledgeActions: {}, orchestration: { handleSend, setQueuedOutbound: queue }, scopedErrors: { setUiError: vi.fn() }, draft, setDraft, coordination: { activeStreamRef: { current: null } }, goalActions: {}, oneShotContext: { modelCouncilEnabledRef: { current: false } }, selection: { selectedSessionId: "chat-a" }, pendingAttachments: [], sessionData: {}, conversationContext: {}, externalSourceAttachments: { selectedAttachmentIds: selected }, pendingDocumentContextRefs: [], knowledgeUrlDraft: "", runVariables: {}, surfaceState: { messageMode: "chat" }, multimodal: {}, errorState: {} } as unknown as SendInput);
 return null;
}
it.each(["Continue my work", "/queue followup Continue my work"])("preserves retained intent and draft instead of sending or enqueueing %s", async draft => {
 await act(async () => root.update(<Harness selected={["retained"]} draft={draft} />)); expect(result.canSend).toBe(false); expect(result.profileDependentAdmissionBlockReason).toContain("Clear the source selection"); await act(async () => send.handleSendWithKnowledge()); expect(handleSend).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled(); expect(setDraft).not.toHaveBeenCalled(); expect(notice).toHaveBeenCalledWith(result.profileDependentAdmissionBlockReason, "warning");
});
it("restores ordinary Chat submission after explicit clearing and leaves bound inspection intact", async () => {
 await act(async () => root.update(<Harness selected={["retained"]} />)); await act(async () => root.update(<Harness selected={[]} />)); expect(result.canSend).toBe(true); expect(result.profileDependentAdmissionBlockReason).toBeUndefined(); await act(async () => send.handleSendWithKnowledge()); expect(handleSend).toHaveBeenCalledTimes(1); expect(result.capabilityProfileInspection).toBe(inspection);
 await act(async () => root.update(<Harness selected={[]} historical />)); expect(result.canSend).toBe(false); expect(result.historicalModeActive).toBe(true); expect(result.capabilityProfileInspection).toBe(inspection);
});
