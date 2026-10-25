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

const renders = vi.hoisted(() => ({ byContent: new Map<string, number>() }));

vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => {
    renders.byContent.set(content, (renders.byContent.get(content) ?? 0) + 1);
    return <span>{content}</span>;
  },
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
