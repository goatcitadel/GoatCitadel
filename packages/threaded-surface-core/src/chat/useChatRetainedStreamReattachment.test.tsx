import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RetainedStreamReattachmentInput } from "./useChatRetainedStreamReattachment";

let useReattachment: typeof import("./useChatRetainedStreamReattachment").useChatRetainedStreamReattachment;
let renderer: ReactTestRenderer | undefined;
const load = vi.fn<() => Promise<void>>();
const run = vi.fn().mockResolvedValue(undefined);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: RetainedStreamReattachmentInput) {
  useReattachment(props);
  return null;
}

function input(status = "running"): RetainedStreamReattachmentInput {
  return {
    selectedSessionId: "conversation",
    thread: { sessionId: "conversation", turns: [{ turnId: "retained-turn", trace: { status } }] } as NonNullable<RetainedStreamReattachmentInput["thread"]>,
    streamEnabled: true,
    activeStreamRef: { current: null },
    sendingRef: { current: false },
    locallyHandledTurnKeysRef: { current: new Set() },
    setSending: vi.fn(),
    getStreamingPreviewBuffer: vi.fn(),
    clearStreamingPreview: vi.fn(),
    commitThreadUpdate: vi.fn(),
    loadSessionCoreState: vi.fn().mockResolvedValue(undefined),
    pushLocalNotice: vi.fn(),
  };
}

function holdCode() {
  let release!: () => void;
  load.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  return () => release();
}

const settleImports = () => act(async () => { await vi.dynamicImportSettled(); });

beforeEach(async () => {
  vi.resetModules();
  load.mockReset().mockResolvedValue(undefined);
  run.mockClear();
  vi.doMock("./retained-chat-stream", async () => {
    await load();
    return { runRetainedChatStream: run };
  });
  useReattachment = (await import("./useChatRetainedStreamReattachment")).useChatRetainedStreamReattachment;
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.doUnmock("./retained-chat-stream");
});

it("leaves retained stream code cold for a waiting approval and admits it when the turn runs", async () => {
  const props = input("waiting_for_approval");
  await act(async () => { renderer = create(<Harness {...props} />); });
  await settleImports();
  expect(load).not.toHaveBeenCalled();
  expect(props.setSending).not.toHaveBeenCalled();

  const running = input();
  await act(async () => renderer?.update(<Harness {...running} />));
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(run).toHaveBeenCalledWith("conversation", "retained-turn", expect.any(Object), expect.any(Object), expect.any(Function));
});

it.each(["selection", "access"] as const)("aborts a retained attachment whose %s changes during import", async (cause) => {
  const release = holdCode();
  const props = input();
  await act(async () => { renderer = create(<Harness {...props} />); });
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
  const stream = props.activeStreamRef.current;
  expect(stream?.controller.signal.aborted).toBe(false);
  expect(props.sendingRef.current).toBe(true);

  await act(async () => {
    if (cause === "selection") renderer?.update(<Harness {...props} selectedSessionId="other-conversation" thread={null} />);
    else {
      const { notifyGatewayAccessChanged } = await import("@goatcitadel/mission-control-shared/api/access-scope");
      notifyGatewayAccessChanged(false);
    }
  });
  expect(stream?.controller.signal.aborted).toBe(true);
  expect(props.sendingRef.current).toBe(false);
  await act(async () => { release(); });
  await settleImports();
  expect(run).not.toHaveBeenCalled();
  expect(props.loadSessionCoreState).not.toHaveBeenCalled();
});

it("releases the stream slot and reconciles canonical state after code load failure", async () => {
  load.mockRejectedValueOnce(new Error("private fixture failure"));
  const props = input();
  await act(async () => { renderer = create(<Harness {...props} />); });
  await vi.waitFor(() => expect(props.setSending).toHaveBeenLastCalledWith(false));
  expect(props.activeStreamRef.current).toBeNull();
  expect(props.loadSessionCoreState).toHaveBeenCalledExactlyOnceWith("conversation", { background: true, includeThread: true });
  expect(props.pushLocalNotice).toHaveBeenCalledExactlyOnceWith("Live response disconnected. Refresh the turn to check its status.", "warning");
  expect(run).not.toHaveBeenCalled();
});
