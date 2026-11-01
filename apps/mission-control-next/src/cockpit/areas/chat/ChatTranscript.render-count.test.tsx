// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import {
  publishChatStreamingPreview,
  resetChatStreamingPreviewForTests,
} from "@goatcitadel/mission-control-shared/state/chat-streaming-preview-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorProvider } from "../../app/inspector";
import { ChatTranscript } from "./ChatTranscript";

const renders = vi.hoisted(() => ({ byContent: new Map<string, number>(), details: new Map<string, number>() }));

vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => {
    renders.byContent.set(content, (renders.byContent.get(content) ?? 0) + 1);
    return <span>{content}</span>;
  },
}));

vi.mock("./ChatTurnDetails", () => ({
  ChatTurnDetails: ({ turn }: { turn: { turnId: string } }) => {
    renders.details.set(turn.turnId, (renders.details.get(turn.turnId) ?? 0) + 1);
    return null;
  },
}));

vi.mock("../../../features/native-routes/library/WorkflowSkillCaptureControl", () => ({
  WorkflowSkillCaptureControl: ({ draftEmpty }: { draftEmpty: boolean }) => (
    <span data-skill-capture>{draftEmpty ? "empty" : "drafting"}</span>
  ),
}));

function turn(turnId: string, withReply = true): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: { messageId: `user-${turnId}`, content: `User ${turnId}` },
    assistantMessage: withReply ? { content: `Assistant ${turnId}` } : undefined,
    trace: { status: withReply ? "completed" : "running", model: "sample/model" },
    toolRuns: [],
    citations: [],
    branch: { isSelectedPath: true },
  } as unknown as ChatThreadTurnRecord;
}

const turns = [turn("t1"), turn("t2"), turn("t3", false)];
const baseProps = {
  selectedSessionId: "session-1",
  draft: "",
  onDraftChange: vi.fn(),
  loading: false,
  historicalReadOnly: false,
  sending: false,
  thread: { sessionId: "session-1", turns },
  followOutput: true,
  hasActiveStream: true,
  activeStreamingTurnId: "t3",
} as unknown as MissionThreadedActiveSessionSurfaceProps;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
function renderTranscript(node: ReactNode) {
  root.render(
    <QueryClientProvider client={client}>
      <InspectorProvider>{node}</InspectorProvider>
    </QueryClientProvider>,
  );
}
function flush(visibleText: string) {
  act(() =>
    publishChatStreamingPreview("session-1", {
      sessionId: "session-1",
      turnId: "t3",
      text: visibleText,
      visibleText,
      updatedAt: Date.now(),
    }),
  );
}

beforeEach(() => {
  renders.byContent.clear();
  renders.details.clear();
  resetChatStreamingPreviewForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  resetChatStreamingPreviewForTests();
});

describe("ChatTranscript streaming flush rendering", () => {
  it("re-renders only the streaming turn on a preview flush", () => {
    act(() => renderTranscript(<ChatTranscript props={baseProps} />));
    flush("Hel");
    const settledBefore = {
      t1: renders.byContent.get("User t1"),
      t2: renders.byContent.get("Assistant t2"),
    };
    expect(renders.byContent.get("Hel")).toBe(1);

    flush("Hello");
    flush("Hello wor");
    flush("Hello world");

    expect(container.textContent).toContain("Hello world");
    expect(renders.byContent.get("Hello world")).toBe(1);
    expect(renders.byContent.get("User t1")).toBe(settledBefore.t1);
    expect(renders.byContent.get("Assistant t2")).toBe(settledBefore.t2);
  });
});

describe("ChatTranscript turn memo across composer and record changes", () => {
  // Every fifth turn completed with a complete answer, so it offers the workflow-skill capture that reads the draft.
  const manyTurns = Array.from({ length: 50 }, (_, index) => {
    const record = turn(`m${index + 1}`);
    return index % 5 === 4
      ? ({ ...record, trace: { ...record.trace, completion: { status: "complete" } } } as ChatThreadTurnRecord)
      : record;
  });
  const capturingTurnIds = manyTurns
    .filter((record) => record.trace.completion?.status === "complete")
    .map((record) => record.turnId);
  const settledProps = {
    ...baseProps,
    workspaceId: "workspace-1",
    composerRef: { current: null },
    thread: { sessionId: "session-1", turns: manyTurns },
    hasActiveStream: false,
    activeStreamingTurnId: undefined,
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
  const onInspectTurn = vi.fn();
  const onOpenArtifact = vi.fn();
  const onNewConversation = vi.fn();
  const renderSettled = (props: MissionThreadedActiveSessionSurfaceProps) =>
    act(() =>
      renderTranscript(
        <ChatTranscript
          props={props}
          onInspectTurn={onInspectTurn}
          onOpenArtifact={onOpenArtifact}
          onNewConversation={onNewConversation}
          // A fresh arrow on each render, as the production host passes it.
          onReviewPlan={() => undefined}
        />,
      ),
    );
  const snapshot = () => new Map(renders.details);
  const rerenderedSince = (before: Map<string, number>) =>
    [...renders.details].filter(([turnId, count]) => count !== before.get(turnId)).map(([turnId]) => turnId);

  it("re-renders no turn when only the draft changes", () => {
    renderSettled({ ...settledProps, draft: "h" });
    expect(renders.details.size).toBe(50);
    const before = snapshot();

    renderSettled({ ...settledProps, draft: "he" });
    renderSettled({ ...settledProps, draft: "hel" });

    expect(rerenderedSince(before)).toEqual([]);
  });

  it("re-renders only the turn whose record identity changed", () => {
    renderSettled(settledProps);
    const before = snapshot();
    const last = manyTurns.at(-1)!;
    const nextTurns = [...manyTurns.slice(0, -1), { ...last, thinking: "More reasoning" } as ChatThreadTurnRecord];
    nextTurns.slice(0, -1).forEach((record, index) => expect(record).toBe(manyTurns[index]));
    expect(nextTurns.at(-1)).not.toBe(last);

    renderSettled({
      ...settledProps,
      thread: { sessionId: "session-1", turns: nextTurns },
    } as unknown as MissionThreadedActiveSessionSurfaceProps);

    expect(rerenderedSince(before)).toEqual([last.turnId]);
  });

  it("re-renders only the turns that read the draft when it empties and fills", async () => {
    renderSettled({ ...settledProps, draft: "typed" });
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(container.querySelectorAll("[data-skill-capture]")).toHaveLength(capturingTurnIds.length);
    const before = snapshot();

    renderSettled({ ...settledProps, draft: "" });

    expect(rerenderedSince(before)).toEqual(capturingTurnIds);
    expect([...container.querySelectorAll("[data-skill-capture]")].map((node) => node.textContent)).toEqual(
      capturingTurnIds.map(() => "empty"),
    );
    const emptied = snapshot();

    renderSettled({ ...settledProps, draft: "typed again" });

    expect(rerenderedSince(emptied)).toEqual(capturingTurnIds);
  });
});
