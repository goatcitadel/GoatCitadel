import { useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "../useChatSurfaceOrchestration";
import { useChatSessionRestoration } from "./useChatSessionRestoration";
import { createDraftStorageKey } from "../useChatLocalPersistence";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  fetchChatSessionGoal: vi.fn(async () => ({ goal: null })),
}));
vi.mock("@goatcitadel/mission-control-shared/state/dev-diagnostics-store", () => ({
  setDevDiagnosticsLatestTraceSummary: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => undefined;
let renderer: ReactTestRenderer | undefined;
let observed: { draft: string; setDraft: (text: string) => void };
const originalWindow = globalThis.window;
const values = new Map<string, string>();
function Harness({ workspace = "a", session = "s1" }) {
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
  } as unknown as Parameters<typeof useChatSessionRestoration>[0]);
  observed = { draft, setDraft };
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

it("keeps text typed into a conversation when only the storage key changes for the same conversation", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => observed.setDraft("typed"));
  await act(async () => renderer!.update(<Harness workspace="b" />));
  expect(observed.draft).toBe("typed");
});

it("starts an empty draft in another conversation with nothing stored", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => observed.setDraft("typed"));
  await act(async () => renderer!.update(<Harness session="s2" />));
  expect(observed.draft).toBe("");
});

it("hydrates the stored draft of the conversation you switch to", async () => {
  values.set(createDraftStorageKey("a", "s3"), "saved");
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => observed.setDraft("typed"));
  await act(async () => renderer!.update(<Harness session="s3" />));
  expect(observed.draft).toBe("saved");
});
