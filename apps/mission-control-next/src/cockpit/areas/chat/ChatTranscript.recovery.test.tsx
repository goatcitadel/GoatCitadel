// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InspectorProvider } from "../../app/inspector";
import { ChatTranscript } from "./ChatTranscript";

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

function turn(turnId: string): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: { messageId: `user-${turnId}`, content: `User ${turnId}` },
    assistantMessage: { content: `Assistant ${turnId}` },
    trace: { status: "completed" },
    toolRuns: [],
    citations: [],
    branch: { isSelectedPath: true },
  } as unknown as ChatThreadTurnRecord;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let composer: HTMLTextAreaElement;
function props(overrides: Partial<MissionThreadedActiveSessionSurfaceProps> = {}) {
  return {
    selectedSessionId: "session-1",
    workspaceId: "default",
    draft: "",
    onDraftChange: vi.fn(),
    loading: false,
    historicalReadOnly: false,
    sending: false,
    thread: { sessionId: "session-1", turns: [] },
    followOutput: true,
    hasActiveStream: false,
    composerRef: { current: composer },
    onRefreshThread: vi.fn(),
    ...overrides,
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
}
function render(node: ReactNode) {
  return act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <InspectorProvider>{node}</InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}
beforeEach(() => {
  container = document.createElement("div");
  composer = document.createElement("textarea");
  document.body.append(container, composer);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  composer.remove();
  client.clear();
});

it("shows only the pending turn while the first message sends (CH-04)", async () => {
  await render(
    <ChatTranscript
      props={props({
        optimisticUserMessage: { content: "First question", canonicalMessageId: "user-new" } as never,
      })}
    />,
  );
  expect(container.textContent).toContain("First question · Sending…");
  expect(container.textContent).not.toContain("No messages in this view.");
});

it("says messages can't load while the Gateway is unreachable instead of calling the view empty (CH-04)", async () => {
  await render(<ChatTranscript gatewayUnavailable props={props()} />);
  expect(container.textContent).toContain("Messages can’t load while GoatCitadel is unreachable.");
  expect(container.textContent).not.toContain("No messages in this view.");
});

it("offers Reload conversation when the conversation is unavailable (CH-22)", async () => {
  const onRefreshThread = vi.fn();
  await render(<ChatTranscript props={props({ thread: null, onRefreshThread })} />);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("This conversation couldn’t load.");
  const reload = [...container.querySelectorAll("button")].find((b) => b.textContent === "Reload conversation")!;
  await act(async () => reload.click());
  expect(onRefreshThread).toHaveBeenCalledTimes(1);
});

it("mentions a decision at the end of a response only when one is waiting (CH-10)", async () => {
  const thread = { sessionId: "session-1", turns: [turn("t1")] } as never;
  const status = () => container.querySelector('[aria-live="polite"]')?.textContent;
  await render(<ChatTranscript props={props({ thread, hasActiveStream: true })} />);
  await render(<ChatTranscript props={props({ thread, hasActiveStream: false })} />);
  expect(status()).toBe("Response ended.");
  await render(<ChatTranscript props={props({ thread, hasActiveStream: true })} />);
  await render(
    <ChatTranscript
      props={props({
        thread,
        hasActiveStream: false,
        pendingApproval: { approvalId: "a", riskLevel: "safe" } as never,
      })}
    />,
  );
  expect(status()).toBe("Response ended. A decision is waiting for you.");
});

it("keeps Jump to latest to messages, and moves focus to the composer after jumping (CH-10, CH-18)", async () => {
  const thread = { sessionId: "session-1", turns: [turn("t1")] } as never;
  await render(
    <ChatTranscript
      props={props({ thread, followOutput: false, pendingApproval: { approvalId: "a", riskLevel: "safe" } as never })}
    />,
  );
  const jump = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Jump to latest"))!;
  expect(jump.textContent).not.toContain("Decision waiting");
  jump.focus();
  await act(async () => jump.click());
  expect(document.activeElement).toBe(composer);
});
