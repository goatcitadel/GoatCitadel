import { act, create, type ReactTestRenderer } from "react-test-renderer";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatComposerSendIntent } from "./useChatComposerSendIntent";
type SendInput = Parameters<typeof useChatComposerSendIntent>[0];

const snapshotRequest = { capture: true as const, requestId: "snapshot-queued" };
let root: ReactTestRenderer;
let send: ReturnType<typeof useChatComposerSendIntent>;
const queue = vi.fn();
const handleSend = vi.fn();
const consumeWorkspaceSnapshotRequest = vi.fn(() => snapshotRequest);

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
    orchestration: { handleSend, setQueuedOutbound: queue },
    scopedErrors: { setUiError: vi.fn() },
    draft,
    setDraft: vi.fn(),
    setPendingAttachments: vi.fn(),
    coordination: { activeStreamRef: { current: null } },
    goalActions: {},
    oneShotContext: {
      consumeModelCouncilArming: () => undefined,
      modelCouncilEnabledRef: { current: false },
      consumeWorkspaceSnapshotRequest,
      workspaceSnapshotRequestRef: { current: snapshotRequest },
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

it.each(["followup", "collect"])("freezes an armed workspace snapshot with a /queue %s item", async (kind) => {
  await act(async () => root.update(<Harness draft={`/queue ${kind} Check the build`} />));
  await act(async () => send.handleSendWithKnowledge());
  expect(consumeWorkspaceSnapshotRequest).toHaveBeenCalledTimes(1);
  expect(handleSend).not.toHaveBeenCalled();
  const update = queue.mock.calls[0]![0] as (current: unknown[]) => Array<Record<string, unknown>>;
  const [item] = update([]);
  expect(item).toMatchObject({ action: "send", content: "Check the build", workspaceSnapshot: snapshotRequest });
});
