// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InspectorProvider } from "../../app/inspector";
import { ChatTranscript } from "./ChatTranscript";
import { ChatTurnThinking, thinkingPreviewLine } from "./ChatTurnThinking";

vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/approvals")>()),
  fetchApproval: vi.fn(() => new Promise(() => {})),
}));
vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => null,
}));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});
function render(node: ReactNode) {
  return act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>{node}</InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}
const section = () => container.querySelector<HTMLDetailsElement>('[data-testid="chat-turn-thinking"]');

describe("thinkingPreviewLine", () => {
  it("shows the newest non-empty line, with its spacing tidied", () => {
    expect(thinkingPreviewLine("First idea.\n  Then   the second\n\n")).toBe("Then the second");
  });

  it("keeps the end of a long line, where the newest words are", () => {
    const line = `${"a".repeat(200)} the newest words`;
    const preview = thinkingPreviewLine(line);
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("the newest words")).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(141);
  });
});

describe("ChatTurnThinking", () => {
  it("renders nothing without reasoning", async () => {
    await render(<ChatTurnThinking thinking={undefined} live answerStarted={false} />);
    expect(section()).toBeNull();
    await render(<ChatTurnThinking thinking={"  \n"} live answerStarted={false} />);
    expect(section()).toBeNull();
  });

  it("previews the newest line while the model thinks, hidden from screen readers and shut", async () => {
    await render(<ChatTurnThinking thinking={"Check the file.\nCompare both versions"} live answerStarted={false} />);
    const details = section()!;
    expect(details.open).toBe(false);
    const summary = details.querySelector("summary")!;
    expect(summary.textContent).toContain("Thinking…");
    const preview = summary.querySelector('span[aria-hidden="true"]');
    expect(preview?.textContent).toBe("Compare both versions");
    expect(details.textContent).toContain("Check the file.");
  });

  it("drops the preview once the answer starts, and names it as a finished thought process", async () => {
    await render(<ChatTurnThinking thinking="Compare both versions" live answerStarted />);
    const summary = section()!.querySelector("summary")!;
    expect(summary.textContent).toBe("Thought process");
    expect(summary.querySelector('span[aria-hidden="true"]')).toBeNull();
    await render(<ChatTurnThinking thinking="Compare both versions" live={false} answerStarted={false} />);
    expect(section()!.querySelector("summary")!.textContent).toBe("Thought process");
  });
});

describe("Cockpit transcript", () => {
  function props(turns: ChatThreadTurnRecord[]) {
    return {
      selectedSessionId: "session-1",
      workspaceId: "default",
      draft: "",
      onDraftChange: vi.fn(),
      loading: false,
      historicalReadOnly: false,
      sending: false,
      thread: { sessionId: "session-1", turns },
      followOutput: true,
      hasActiveStream: false,
      composerRef: { current: null },
      onRefreshThread: vi.fn(),
    } as unknown as MissionThreadedActiveSessionSurfaceProps;
  }
  function turn(overrides: Partial<ChatThreadTurnRecord>): ChatThreadTurnRecord {
    return {
      turnId: "t1",
      userMessage: { messageId: "user-t1", content: "Which is faster?" },
      trace: { status: "running" },
      toolRuns: [],
      citations: [],
      branch: { isSelectedPath: true },
      ...overrides,
    } as unknown as ChatThreadTurnRecord;
  }

  it("shows the reasoning in the reply before any answer text arrives", async () => {
    await render(<ChatTranscript props={props([turn({ thinking: "Weigh the two loops" })])} />);
    expect(section()?.querySelector("summary")?.textContent).toContain("Thinking…");
    expect(container.textContent).not.toContain("Preparing response…");
  });

  it("puts the thought process above the answer once it arrives", async () => {
    await render(
      <ChatTranscript
        props={props([
          turn({
            thinking: "Weigh the two loops",
            assistantMessage: { content: "The second loop is faster." } as never,
            trace: { status: "completed" } as never,
          }),
        ])}
      />,
    );
    const thinking = section()!;
    expect(thinking.querySelector("summary")?.textContent).toBe("Thought process");
    const answer = [...container.querySelectorAll("span")].find((s) => s.textContent === "The second loop is faster.")!;
    expect(thinking.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("leaves a turn without reasoning as it was", async () => {
    await render(
      <ChatTranscript
        props={props([
          turn({ assistantMessage: { content: "Done." } as never, trace: { status: "completed" } as never }),
        ])}
      />,
    );
    expect(section()).toBeNull();
    expect(container.textContent).toContain("Done.");
  });
});
