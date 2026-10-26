// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChatSessionRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type {
  MissionThreadedActiveSessionSurfaceProps,
  MissionThreadedRenderSurfaceInput,
} from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAreaView } from "./ChatArea";
import { InspectorProvider } from "../../app/inspector";

const messaging = vi.hoisted(() => ({
  requests: [] as Array<boolean | undefined>,
  composer: [] as Array<Record<string, unknown>>,
}));

vi.mock("./ThreadList", () => ({ ThreadList: () => null }));
vi.mock("./MessagingSection", () => ({ MessagingSection: () => null }));
// The overview has not answered yet in every test here: what the chat does must not wait for it.
vi.mock("./use-messaging-overview", () => ({
  useMessagingOverview: (_workspaceId: string, options?: { enabled?: boolean }) => {
    messaging.requests.push(options?.enabled);
    return { data: undefined, isError: false };
  },
}));
vi.mock("./ChatTextComposer", () => ({
  ChatTextComposer: ({ props }: { props: Record<string, unknown> }) => {
    messaging.composer.push(props);
    return null;
  },
}));
vi.mock("./ProjectAssignmentReview", () => ({ ProjectAssignmentReview: () => null }));
vi.mock("./ChatBuildEditor", () => ({ ChatBuildEditor: () => null }));
vi.mock("./NativeMessageRenderer", () => ({
  NativeMessageRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}));
vi.mock("@goatcitadel/mission-control-shared/state/chat-streaming-preview-store", () => ({
  useChatStreamingPreviewSnapshot: () => null,
}));
vi.mock("../../../features/native-routes/library/WorkflowSkillCaptureControl", () => ({
  WorkflowSkillCaptureControl: () => null,
}));
vi.mock("../../ui/Sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <section>{children}</section> : null),
}));

let root: Root;
let container: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  messaging.requests = [];
  messaging.composer = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
  queryClient.setQueryData(["system", "onboarding"], { completed: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function turn(turnId: string, status: "completed" | "cancelled"): ChatThreadTurnRecord {
  return {
    turnId,
    userMessage: {
      messageId: `user-${turnId}`,
      content: `Question ${turnId}`,
      timestamp: "2026-10-25T09:00:00.000Z",
      sourceAuthority: "operator",
    },
    assistantMessage: {
      messageId: `assistant-${turnId}`,
      content: `Answer ${turnId}`,
      timestamp: "2026-10-25T09:00:05.000Z",
    },
    trace: { status, completion: { status: "complete" } },
    toolRuns: [],
    citations: [],
    branch: { isSelectedPath: true },
  } as unknown as ChatThreadTurnRecord;
}

/** One open conversation: a finished turn, then a stopped one that could be continued. */
function surface(session: Partial<ChatSessionRecord> & { sessionId: string }) {
  const composerRef = { current: document.createElement("textarea") };
  const active = {
    selectedSessionId: session.sessionId,
    workspaceId: "default",
    sessionTitle: "Weekend plans",
    notices: [],
    draft: "",
    canSend: true,
    sending: false,
    loading: false,
    historicalReadOnly: false,
    hasActiveStream: false,
    followOutput: true,
    pendingAttachments: [],
    commandSuggestions: [],
    composerRef,
    thread: { sessionId: session.sessionId, turns: [turn("first", "completed"), turn("stopped", "cancelled")] },
    isDragActive: false,
    onDragEnter: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onComposerPaste: vi.fn(),
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    onRetryTurn: vi.fn(),
    onEditTurn: vi.fn(),
    onSelectTurn: vi.fn(),
    onStartNewThreadFromTurn: vi.fn(),
    onOpenRunDetails: vi.fn(),
    onRefreshThread: vi.fn(),
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
  const external = session.scope === "external";
  return {
    active,
    input: {
      sessionRail: {
        selectedSessionId: session.sessionId,
        missionSessions: external ? [] : [session],
        externalSessions: external ? [session] : [],
        onCreateSession: vi.fn(),
        creatingSession: false,
      },
      activeSessionSurfaceProps: active,
    } as unknown as MissionThreadedRenderSurfaceInput,
  };
}

async function show(input: MissionThreadedRenderSurfaceInput) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <InspectorProvider>
          <ChatAreaView input={input} />
        </InspectorProvider>
      </QueryClientProvider>,
    ),
  );
}

function buttonTexts(): string[] {
  return [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

describe("which conversations Chat treats as channel conversations", () => {
  it("keeps a mission chat bound to a channel an ordinary chat: its composer, tools, Retry and Continue", async () => {
    const { active, input } = surface({ sessionId: "bound-1", scope: "mission", channelConnectionId: "conn-1" });
    await show(input);

    // The composer gets the conversation's own props back, so its files, model and tools are as before.
    const composer = messaging.composer.at(-1)!;
    expect(composer).toBe(active);
    expect(composer).not.toHaveProperty("channelCheck");
    expect(composer).not.toHaveProperty("channelReply");
    expect(messaging.requests.every((enabled) => enabled === false)).toBe(true);
    expect(buttonTexts()).toContain("Retry");
    expect(buttonTexts()).toContain("Continue");
  });

  it("hides Continue, Retry and the model tools in a channel conversation before the overview loads", async () => {
    const { active, input } = surface({ sessionId: "channel-1", scope: "external", channelConnectionId: "conn-1" });
    await show(input);

    expect(buttonTexts()).not.toContain("Continue");
    expect(buttonTexts()).not.toContain("Retry");
    const composer = messaging.composer.at(-1)!;
    expect(composer).not.toBe(active);
    expect(composer.channelCheck).toBe("checking");
    expect(messaging.requests.at(-1)).toBe(true);
  });
});
