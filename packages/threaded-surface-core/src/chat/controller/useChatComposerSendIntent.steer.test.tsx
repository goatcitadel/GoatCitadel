import { act, create, type ReactTestRenderer } from "react-test-renderer";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatComposerSendIntent } from "./useChatComposerSendIntent";
type SendInput = Parameters<typeof useChatComposerSendIntent>[0];

let root: ReactTestRenderer;
let send: ReturnType<typeof useChatComposerSendIntent>;
const handleSend = vi.fn();
const setDraft = vi.fn();
const handleSteerMidTurn = vi.fn<(instruction: string) => Promise<boolean>>();

beforeEach(() => {
  vi.clearAllMocks();
  act(() => {
    root = create(<></>);
  });
});
afterEach(() => {
  act(() => root.unmount());
});

function Harness({ draft }: { draft: string }) {
  send = useChatComposerSendIntent({
    workspaceId: "one",
    profileDependentAdmissionBlockReason: undefined,
    notices: { pushLocalNotice: vi.fn() },
    setFollowThreadOutput: vi.fn(),
    knowledgeActions: {},
    orchestration: { handleSend, setQueuedOutbound: vi.fn() },
    scopedErrors: { setUiError: vi.fn() },
    draft,
    setDraft,
    setPendingAttachments: vi.fn(),
    // A live turn makes a plain draft a mid-turn steer.
    coordination: { activeStreamRef: { current: { sessionId: "chat-a", turnId: "turn-live" } } },
    goalActions: { handleSteerMidTurn },
    oneShotContext: {
      consumeModelCouncilArming: () => undefined,
      modelCouncilEnabledRef: { current: false },
      consumeWorkspaceSnapshotRequest: () => undefined,
      workspaceSnapshotRequestRef: { current: undefined },
    },
    selection: { selectedSessionId: "chat-a" },
    pendingAttachments: [],
    sessionData: {},
    conversationContext: {},
    externalSourceAttachments: { selectedAttachmentIds: [] },
    pendingDocumentContextRefs: [],
    knowledgeUrlDraft: "",
    runVariables: {},
    surfaceState: { messageMode: "chat" },
    multimodal: {},
    errorState: {},
  } as unknown as SendInput);
  return null;
}

function clearedDraft(previous: string): string {
  const update = setDraft.mock.calls.at(-1)?.[0] as ((current: string) => string) | undefined;
  return update ? update(previous) : previous;
}

it("keeps the operator's text when a mid-turn steer is rejected or fails", async () => {
  handleSteerMidTurn.mockResolvedValueOnce(false);
  await act(async () => root.update(<Harness draft="Stay within the budget" />));
  await act(async () => send.handleSendWithKnowledge());
  expect(handleSteerMidTurn).toHaveBeenCalledWith("Stay within the budget");
  expect(setDraft).not.toHaveBeenCalled();
  expect(handleSend).not.toHaveBeenCalled();
});

it("clears only the submitted draft once the steer is accepted", async () => {
  handleSteerMidTurn.mockResolvedValueOnce(true);
  await act(async () => root.update(<Harness draft="/steer Cite the sources" />));
  await act(async () => send.handleSendWithKnowledge());
  expect(handleSteerMidTurn).toHaveBeenCalledWith("Cite the sources");
  expect(clearedDraft("/steer Cite the sources")).toBe("");
  // Text the operator typed while the steer was in flight is kept.
  expect(clearedDraft("A newer draft")).toBe("A newer draft");
});
