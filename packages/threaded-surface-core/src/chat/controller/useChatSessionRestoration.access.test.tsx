import { useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "../useChatSurfaceOrchestration";
import { useChatSessionRestoration } from "./useChatSessionRestoration";
import { createDraftStorageKey, createAttachmentStorageKey, createQueueStorageKey } from "../useChatLocalPersistence";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatSessionGoal: vi.fn(async () => ({ goal: null })),
}));
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  setDevDiagnosticsLatestTraceSummary: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => undefined;
let renderer: ReactTestRenderer | undefined;
let observed: {
  draft: string;
  attachments: ChatAttachmentRecord[];
  queue: OutboundQueueItem[];
  setDraft: (text: string) => void;
};
const originalWindow = globalThis.window;
const values = new Map<string, string>();
function Harness({ workspace = "workspace-a", session = "session-a" }) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [queue, setQueue] = useState<OutboundQueueItem[]>([]);
  const conflict = useRef(null);
  useChatSessionRestoration({
    workspaceId: workspace,
    selection: { selectedSessionId: session },
    orchestration: { queuedOutbound: queue, setQueuedOutbound: setQueue },
    setPinnedGoal: noop,
    sessionData: { thread: null, generatedArtifacts: null },
    setDraft,
    setPendingAttachments: setAttachments,
    setPendingAttachmentModes: noop,
    pendingAttachments: attachments,
    activeGeneratedArtifact: null,
    setActiveGeneratedArtifact: noop,
    draft,
    STREAM_PREF_KEY: "goatcitadel.chat.agent.stream.enabled",
    streamPreferences: { streamEnabled: true, visualStreamMode: "smooth" },
    metadataDraft: { sessionMetadataConflictDraftRef: conflict, setFolderName: noop, setTagsValue: noop },
    threadController: { selectedSession: null },
    setRenameTitle: noop,
  });
  observed = { draft, attachments, queue, setDraft };
  return null;
}
beforeEach(() => {
  values.clear();
  setGatewayCallerScope("actor-a");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  setGatewayCallerScope("");
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});
it("the actual restoration owner keeps same-caller drafts and never hydrates another caller's local state", async () => {
  const attachment: ChatAttachmentRecord = {
    attachmentId: "attachment-a",
    sessionId: "session-a",
    workspaceId: "workspace-a",
    fileName: "notes.txt",
    mimeType: "text/plain",
    mediaType: "text",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    storageRelPath: "chat/workspace-a/attachments/notes.txt",
    extractStatus: "ready",
    createdAt: "2026-10-05T00:00:00.000Z",
  };
  const queue: OutboundQueueItem = {
    id: "queue-a",
    action: "send",
    sessionId: "session-a",
    content: "queued actor A input",
    attachments: [attachment],
    createdAt: "2026-10-05T00:00:00.000Z",
    paused: true,
    requestPrefs: {
      mode: "chat",
      providerId: "fixture",
      model: "fixture",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "off",
      speedMode: "standard",
      subagentPolicy: "off",
      fullWebAccess: false,
    },
  };
  values.set(createAttachmentStorageKey("workspace-a", "session-a"), JSON.stringify([attachment]));
  values.set(createQueueStorageKey("workspace-a", "session-a"), JSON.stringify([queue]));
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(observed.attachments).toEqual([attachment]);
  expect(observed.queue).toEqual([queue]);
  await act(async () => observed.setDraft("actor A unsent input"));
  // An interrupted owner flushes its captured key even if credentials have changed before cleanup.
  setGatewayCallerScope("actor-b");
  await act(async () => renderer!.unmount());
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(observed.draft).toBe("");
  expect(observed.attachments).toEqual([]);
  expect(observed.queue).toEqual([]);
  await act(async () => observed.setDraft("actor B input"));
  await act(async () => renderer!.unmount());
  setGatewayCallerScope("actor-a");
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(observed.draft).toBe("actor A unsent input");
  expect(observed.attachments).toEqual([attachment]);
  expect(observed.queue).toEqual([queue]);
  await act(async () => renderer!.update(<Harness workspace="workspace-b" />));
  expect(observed.draft).toBe("");
  await act(async () => renderer!.update(<Harness />));
  expect(observed.draft).toBe("actor A unsent input");
});
it("does not attribute legacy unscoped browser input to an identified caller", async () => {
  values.set("goatcitadel.chat.draft.workspace-a.session-a", "unattributed legacy input");
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(observed.draft).toBe("");
  expect(createDraftStorageKey("workspace-a", "session-a")).not.toBe("goatcitadel.chat.draft.workspace-a.session-a");
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(values.get("goatcitadel.chat.draft.workspace-a.session-a")).toBe("unattributed legacy input");
});
