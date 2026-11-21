import { useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setGatewayCallerScope } from "@goatcitadel/mission-control-shared/api/access-scope";
import type { ChatAttachmentRecord } from "@goatcitadel/contracts";
import type { OutboundQueueItem } from "../useChatSurfaceOrchestration";
import { useChatSessionRestoration } from "./useChatSessionRestoration";
import { createAttachmentStorageKey, createDraftStorageKey } from "../useChatLocalPersistence";
import {
  beginChatSessionCreation,
  chatSessionCreationKey,
  publishChatSessionCreation,
  resetChatSessionCreationForTests,
  type ChatSessionCreation,
} from "@goatcitadel/mission-control-shared/state/chat-session-creation";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";

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
  draftHydrated: boolean;
  setDraft: (text: string) => void;
  attachments: ChatAttachmentRecord[];
  setAttachments: (items: ChatAttachmentRecord[]) => void;
};
const originalWindow = globalThis.window;
const values = new Map<string, string>();
const renders: Array<{ session: string | null; draft: string; draftHydrated: boolean }> = [];
function Harness({ workspace = "a", session = "s1" as string | null, unstable = 0 }) {
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [queue, setQueue] = useState<OutboundQueueItem[]>([]);
  const conflict = useRef(null);
  const setterHolder = useRef<{ unstable: number; set: typeof setAttachments } | null>(null);
  if (setterHolder.current?.unstable !== unstable)
    setterHolder.current = { unstable, set: (value) => setAttachments(value) };
  const stableSetter = setterHolder.current.set;
  const { draftHydrated } = useChatSessionRestoration({
    workspaceId: workspace,
    selection: { selectedSessionId: session },
    orchestration: { queuedOutbound: queue, setQueuedOutbound: setQueue },
    setPinnedGoal: noop,
    sessionData: { thread: null, generatedArtifacts: null },
    setDraft,
    // A fresh function each render stands for a dependency that is not stable.
    setPendingAttachments: stableSetter,
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
  observed = { draft, draftHydrated, setDraft, attachments, setAttachments };
  renders.push({ session, draft, draftHydrated });
  return null;
}
beforeEach(() => {
  values.clear();
  renders.length = 0;
  resetChatSessionCreationForTests();
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

const creationKey = (workspace = "a") => chatSessionCreationKey(getGatewayApiBaseUrl(), workspace);

it("exposes the draft as hydrated only for the current conversation's restored text", async () => {
  values.set(createDraftStorageKey("a", "s1"), "first draft");
  values.set(createDraftStorageKey("a", "s2"), "second draft");
  await act(async () => { renderer = create(<Harness />); });
  expect(observed).toMatchObject({ draft: "first draft", draftHydrated: true });

  await act(async () => renderer!.update(<Harness session="s2" />));
  const nextRenders = renders.filter(render => render.session === "s2");
  expect(nextRenders[0]).toMatchObject({ draft: "first draft", draftHydrated: false });
  expect(nextRenders.filter(render => render.draftHydrated)).not.toHaveLength(0);
  expect(nextRenders.filter(render => render.draftHydrated).every(render => render.draft === "second draft")).toBe(true);
});

async function pressNew(): Promise<ChatSessionCreation> {
  const attempt: ChatSessionCreation = { state: "pending", mode: "chat", message: "Creating" };
  await act(async () => {
    expect(beginChatSessionCreation(creationKey(), attempt)).toBe(true);
  });
  return attempt;
}

async function confirm(attempt: ChatSessionCreation, sessionId: string) {
  await act(async () => {
    attempt.sessionId = sessionId;
    attempt.state = "confirmed";
    publishChatSessionCreation(creationKey(), attempt);
  });
}

it("keeps text typed while New creates the conversation, for the same caller and workspace", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setDraft("review typed early"));
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.draft).toBe("review typed early");
  // The old conversation does not keep a copy of text that now belongs to the new one.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(values.get(createDraftStorageKey("a", "s1"))).toBeUndefined();
});

async function carryWith(refuseDestination: boolean) {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setDraft("typed during creation"));
  // The source conversation has its stored copy of the same text.
  values.set(createDraftStorageKey("a", "s1"), "typed during creation");
  const storage = (globalThis.window as unknown as { localStorage: { setItem: (k: string, v: string) => void } })
    .localStorage;
  const original = storage.setItem;
  storage.setItem = (key, value) => {
    if (refuseDestination && key === createDraftStorageKey("a", "s-new")) throw new Error("quota");
    original(key, value);
  };
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness session="s-new" />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(observed.draft).toBe("typed during creation");
}

it("keeps the source copy of carried text when the destination write is refused", async () => {
  await carryWith(true);
  expect(values.get(createDraftStorageKey("a", "s1"))).toBe("typed during creation");
  expect(values.get(createDraftStorageKey("a", "s-new"))).toBeUndefined();
});

it("writes carried text under the destination first, then removes the matching source copy", async () => {
  await carryWith(false);
  expect(values.get(createDraftStorageKey("a", "s-new"))).toBe("typed during creation");
  expect(values.get(createDraftStorageKey("a", "s1"))).toBeUndefined();
});
it("does not carry a draft the box already held when New started", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => observed.setDraft("older draft"));
  const attempt = await pressNew();
  await act(async () => observed.setDraft("older draft and more"));
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.draft).toBe("");
  // The previous conversation keeps its own draft.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(values.get(createDraftStorageKey("a", "s1"))).toBe("older draft and more");
});

it("drops typed text when the workspace changes", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setDraft("typed"));
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness workspace="b" session="s-new" />));
  expect(observed.draft).toBe("");
});

it("drops typed text when the caller changes on a mounted hook", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setDraft("typed"));
  await confirm(attempt, "s-new");
  setGatewayCallerScope("actor-b");
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.draft).toBe("");
});

it("shows a different existing conversation's own draft, and an empty one otherwise", async () => {
  values.set(createDraftStorageKey("a", "s3"), "saved");
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => observed.setDraft("typed"));
  await act(async () => renderer!.update(<Harness session="s3" />));
  expect(observed.draft).toBe("saved");
  await act(async () => renderer!.update(<Harness session="s2" />));
  expect(observed.draft).toBe("");
});

it("never overwrites newer typing with a stored value when only another dependency changed", async () => {
  values.set(createDraftStorageKey("a", "s1"), "stored");
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(observed.draft).toBe("stored");
  await act(async () => observed.setDraft("newer typing"));
  values.set(createDraftStorageKey("a", "s1"), "stored again");
  await act(async () => renderer!.update(<Harness unstable={1} />));
  expect(observed.draft).toBe("newer typing");
});

const attachment = (id: string, session = "s1"): ChatAttachmentRecord => ({
  attachmentId: id,
  sessionId: session,
  workspaceId: "a",
  fileName: id + ".txt",
  mimeType: "text/plain",
  mediaType: "text",
  sizeBytes: 3,
  sha256: "a".repeat(64),
  storageRelPath: "chat/a/attachments/" + id + ".txt",
  extractStatus: "ready",
  createdAt: "2026-10-05T00:00:00.000Z",
});

it("does not carry text to a conversation opened later, after New's conversation was never opened (A)", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => renderer!.update(<Harness session="w" />));
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness session="s1" />));
  await act(async () => observed.setDraft("note for X"));
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.draft).toBe("");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(values.get(createDraftStorageKey("a", "s1"))).toBe("note for X");
});

it("does not carry text typed in the same conversation after New confirmed and was never opened (A)", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await confirm(attempt, "s-new");
  await act(async () => observed.setDraft("note for X"));
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.draft).toBe("");
});

it("gives no carry to an attempt that started before the draft was hydrated (B)", async () => {
  values.set(createDraftStorageKey("a", "s1"), "real");
  const attempt = await pressNew();
  await act(async () => {
    renderer = create(<Harness />);
  });
  expect(observed.draft).toBe("real");
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.draft).toBe("");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(values.get(createDraftStorageKey("a", "s1"))).toBe("real");
});

it.each(["unknown", "error"] as const)("does not carry after an attempt ends as %s", async (state) => {
  values.set(createDraftStorageKey("a", "s3"), "own");
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setDraft("typed"));
  await act(async () => {
    attempt.state = state;
    publishChatSessionCreation(creationKey(), attempt);
  });
  expect(observed.draft).toBe("typed");
  await act(async () => renderer!.update(<Harness session="s3" />));
  expect(observed.draft).toBe("own");
  // The text stays with the conversation it was typed in, after the debounce, and is stored nowhere else.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
  expect(values.get(createDraftStorageKey("a", "s1"))).toBe("typed");
  expect(values.get(createDraftStorageKey("a", "s3"))).toBe("own");
  expect([...values.entries()].filter(([, value]) => value === "typed").map(([key]) => key)).toEqual([
    createDraftStorageKey("a", "s1"),
  ]);
});

it("carries text typed during creation when confirm and select land in a single commit", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setDraft("typed during creation"));
  await act(async () => {
    attempt.sessionId = "s-new";
    attempt.state = "confirmed";
    publishChatSessionCreation(creationKey(), attempt);
    renderer!.update(<Harness session="s-new" />);
  });
  expect(observed.draft).toBe("typed during creation");
});

it("keeps an attachment added during creation with the conversation it was added in", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  const attempt = await pressNew();
  await act(async () => observed.setAttachments([attachment("att-1")]));
  await confirm(attempt, "s-new");
  await act(async () => renderer!.update(<Harness session="s-new" />));
  expect(observed.attachments).toEqual([]);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
  expect(values.get(createAttachmentStorageKey("a", "s1"))).toContain("att-1");
});

it("never replaces an attachment added since with the stored copy when only another dependency changed (E)", async () => {
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => observed.setAttachments([attachment("att-2")]));
  await act(async () => renderer!.update(<Harness unstable={1} />));
  expect(observed.attachments.map((item) => item.attachmentId)).toEqual(["att-2"]);
});
