import React, { StrictMode, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionForkResponse, ChatSessionRecord, ChatThreadResponse } from "@goatcitadel/contracts";
import type { ChatSessionsResponse } from "@goatcitadel/mission-control-shared/api/client";
import { useChatConversationFork } from "./useChatConversationFork";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fork = vi.hoisted(() => vi.fn());
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ forkChatSessionFromTurn: fork }));
type Input = Parameters<typeof useChatConversationFork>[0];
import { receipt, session, thread } from "./useChatConversationFork.test-support";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const focus = vi.fn(),
  notice = vi.fn(),
  setThread = vi.fn(),
  loadSidebar = vi.fn(),
  loadCore = vi.fn();
let current: ReturnType<typeof useChatConversationFork>;
let state: {
  selected: string | null;
  draft: string;
  pending: boolean;
  error: string | null;
  confirm: { turnId: string } | null;
  history: "active" | "archived";
  sessions: ChatSessionRecord[];
};
let navigate: (id: string) => void;
let setConfirm: Input["setForkConfirm"];
let renderer: ReactTestRenderer | undefined;
function Harness({
  workspaceId = "one",
  initialHistory = "active",
  source,
  sourceThread,
}: {
  workspaceId?: string;
  initialHistory?: "active" | "archived";
  source?: ChatSessionRecord;
  sourceThread?: ChatThreadResponse;
}) {
  const [selected, setSelected] = useState<string | null>("a");
  const [history, setHistory] = useState(initialHistory);
  const [draft, setDraft] = useState("draft-a");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, updateConfirm] = useState<{
    turnId: string;
    turnCount: number;
    attachmentCount: number;
    artifactCount: number;
  } | null>({ turnId: "turn-a", turnCount: 1, attachmentCount: 0, artifactCount: 0 });
  const [sessions, setSessions] = useState<ChatSessionsResponse | null>({
    items: [{ ...session("a"), lifecycleStatus: initialHistory }, session("b")],
  });
  setConfirm = updateConfirm;
  navigate = (id) => {
    setSelected(id);
    setDraft(`draft-${id}`);
    updateConfirm({ turnId: `turn-${id}`, turnCount: 1, attachmentCount: 0, artifactCount: 0 });
  };
  const data = {
    thread: sourceThread ?? thread(selected ?? "none"),
    setThread,
    setSessions,
    loadSidebar,
    loadSessionCoreState: loadCore,
  };
  current = useChatConversationFork({
    workspaceId,
    selection: {
      selectedSessionId: selected,
      historyView: history,
      setHistoryView: setHistory,
      setSelectedSessionId: setSelected,
    },
    sessionData: data,
    threadController: { selectedSession: source ?? session(selected ?? "none", workspaceId) },
    scopedErrors: { setUiError: setError },
    setForkPending: setPending,
    setSelectedTurnId: vi.fn(),
    setDraft,
    notices: { pushLocalNotice: notice },
    coordination: { composerRef: { current: { focus } as HTMLTextAreaElement } },
    setForkConfirm: updateConfirm,
    setSelectedContextTurnIds: vi.fn(),
    setPendingThreadContext: vi.fn(),
  });
  state = { selected, draft, pending, error, confirm, history, sessions: sessions?.items ?? [] };
  return null;
}
async function mount(props: React.ComponentProps<typeof Harness> = {}, strict = false) {
  await act(async () => {
    renderer = create(
      strict ? (
        <StrictMode>
          <Harness {...props} />
        </StrictMode>
      ) : (
        <Harness {...props} />
      ),
    );
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  fork.mockResolvedValue(receipt());
});
afterEach(async () => {
  if (renderer) await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("conversation fork ownership", () => {
  it("inserts the canonical session and selects it without an asynchronous sidebar selection or duplicate core load", async () => {
    await mount({}, true);
    await act(async () => {
      await current.handleStartNewThreadFromTurn("turn-a");
    });
    expect(fork).toHaveBeenCalledExactlyOnceWith("a", "turn-a", {
      expectedRevision: 3,
      title: "Fork of Conversation a",
    });
    expect(state).toMatchObject({ selected: "copy-a", draft: "", pending: false, confirm: null, error: null });
    expect(state.sessions[0]).toEqual(receipt().session);
    expect(loadSidebar).not.toHaveBeenCalled();
    expect(loadCore).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledTimes(1);
    await act(async () => {
      navigate("b");
    });
    expect(state).toMatchObject({ selected: "b", draft: "draft-b", confirm: { turnId: "turn-b" } });
  });

  it("switches archived history to active without retaining archived rows", async () => {
    await mount({ initialHistory: "archived" });
    await act(async () => {
      await current.handleStartNewThreadFromTurn("turn-a");
    });
    expect(state.history).toBe("active");
    expect(state.sessions.map((item) => item.sessionId)).toEqual(["copy-a", "b"]);
  });

  it("synchronously prevents duplicate dispatch before pending state renders", async () => {
    const pending = deferred<ChatSessionForkResponse>();
    fork.mockReturnValue(pending.promise);
    await mount();
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => {
      first = current.handleStartNewThreadFromTurn("turn-a");
      second = current.handleStartNewThreadFromTurn("turn-a");
    });
    expect(fork).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(receipt());
      await Promise.all([first, second]);
    });
    expect(state.selected).toBe("copy-a");
  });

  it.each([false, true])("ignores a late fork after navigation, including away/back=%s", async (back) => {
    const pending = deferred<ChatSessionForkResponse>();
    fork.mockReturnValue(pending.promise);
    await mount();
    let request!: Promise<void>;
    const oldCallback = current.handleStartNewThreadFromTurn;
    await act(async () => {
      request = oldCallback("turn-a");
    });
    await act(async () => {
      navigate("b");
    });
    if (back)
      await act(async () => {
        navigate("a");
      });
    const before = structuredClone(state);
    await act(async () => {
      await oldCallback("turn-a");
      if (back) await current.handleStartNewThreadFromTurn("turn-a");
      pending.resolve(receipt());
      await request;
    });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(state).toEqual(before);
    expect(notice).not.toHaveBeenCalled();
    expect(setThread).not.toHaveBeenCalled();
  });

  it("does not let an old rejection or finally clear a new conversation's pending dialog", async () => {
    const first = deferred<ChatSessionForkResponse>(),
      second = deferred<ChatSessionForkResponse>();
    fork.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    let requestA!: Promise<void>, requestB!: Promise<void>;
    await act(async () => {
      requestA = current.handleStartNewThreadFromTurn("turn-a");
    });
    await act(async () => {
      navigate("b");
    });
    await act(async () => {
      requestB = current.handleStartNewThreadFromTurn("turn-b");
    });
    await act(async () => {
      first.reject(new Error("late A error"));
      await requestA;
    });
    expect(state).toMatchObject({
      selected: "b",
      draft: "draft-b",
      pending: true,
      error: null,
      confirm: { turnId: "turn-b" },
    });
    await act(async () => {
      second.resolve(receipt("b"));
      await requestB;
    });
    expect(state.selected).toBe("copy-b");
  });

  it("preserves a later same-scope dialog when the first request rejects", async () => {
    const pending = deferred<ChatSessionForkResponse>();
    fork.mockReturnValue(pending.promise);
    await mount();
    let request!: Promise<void>;
    await act(async () => {
      request = current.handleStartNewThreadFromTurn("turn-a");
    });
    await act(async () => {
      setConfirm({ turnId: "different", turnCount: 1, attachmentCount: 0, artifactCount: 0 });
    });
    await act(async () => {
      pending.reject(new Error("source request failed"));
      await request;
    });
    expect(state.confirm?.turnId).toBe("different");
    expect(state.draft).toBe("draft-a");
  });

  it("withholds late success across workspace changes and unmount", async () => {
    const pending = deferred<ChatSessionForkResponse>();
    fork.mockReturnValue(pending.promise);
    await mount();
    let request!: Promise<void>;
    await act(async () => {
      request = current.handleStartNewThreadFromTurn("turn-a");
    });
    await act(async () => {
      renderer?.update(<Harness workspaceId="two" />);
    });
    const before = structuredClone(state);
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    await act(async () => {
      pending.resolve(receipt());
      await request;
    });
    expect(state).toEqual(before);
    expect(notice).not.toHaveBeenCalled();
    expect(setThread).not.toHaveBeenCalled();
  });

  it("does not restore a fork after workspace navigation away and back", async () => {
    const pending = deferred<ChatSessionForkResponse>();
    fork.mockReturnValue(pending.promise);
    await mount();
    let request!: Promise<void>;
    await act(async () => {
      request = current.handleStartNewThreadFromTurn("turn-a");
    });
    await act(async () => {
      renderer?.update(<Harness workspaceId="two" />);
    });
    await act(async () => {
      renderer?.update(<Harness workspaceId="one" />);
    });
    await act(async () => {
      setConfirm({ turnId: "later-review", turnCount: 1, attachmentCount: 0, artifactCount: 0 });
    });
    const before = structuredClone(state);
    await act(async () => {
      pending.resolve(receipt());
      await request;
    });
    expect(state).toEqual(before);
    expect(notice).not.toHaveBeenCalled();
  });

  it.each(["session", "workspace", "thread", "turn", "trace", "running"])(
    "rejects mismatched source %s without a POST",
    async (mismatch) => {
      const source = session("a"),
        sourceThread = thread("a");
      if (mismatch === "session") source.sessionId = "b";
      if (mismatch === "workspace") source.workspaceId = "other";
      if (mismatch === "thread") sourceThread.sessionId = "b";
      if (mismatch === "turn") sourceThread.turns[0]!.turnId = "other";
      if (mismatch === "trace") sourceThread.turns[0]!.trace.sessionId = "b";
      if (mismatch === "running") sourceThread.turns[0]!.trace.status = "running";
      await mount({ source, sourceThread });
      await act(async () => {
        await current.handleStartNewThreadFromTurn("turn-a");
      });
      expect(fork).not.toHaveBeenCalled();
      expect(state.draft).toBe("draft-a");
      expect(state.error).toContain("source turn");
    },
  );

  it.each(["source", "turn", "workspace", "new session", "relationship", "mapping", "hash"])(
    "withholds mismatched receipt %s",
    async (mismatch) => {
      const value = receipt();
      if (mismatch === "source") value.manifest.sourceSessionId = "other";
      if (mismatch === "turn") value.manifest.sourceTurnId = "other";
      if (mismatch === "workspace") value.session.workspaceId = "other";
      if (mismatch === "new session") value.manifest.newSessionId = "other";
      if (mismatch === "relationship") value.session.forkRelationships = [];
      if (mismatch === "mapping") value.manifest.turnMappings = [];
      if (mismatch === "hash") value.manifest.transcriptPathHash = "invalid";
      fork.mockResolvedValue(value);
      await mount();
      await act(async () => {
        await current.handleStartNewThreadFromTurn("turn-a");
      });
      expect(state).toMatchObject({ selected: "a", draft: "draft-a", pending: false });
      expect(state.sessions.map((item) => item.sessionId)).toEqual(["a", "b"]);
      expect(state.error).toContain("did not confirm");
      expect(notice).not.toHaveBeenCalled();
    },
  );
});
