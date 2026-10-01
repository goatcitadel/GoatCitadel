import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSessionRecord, NoteRecord } from "@goatcitadel/contracts";
import { useChatDocuments } from "./useChatDocuments";

const api = vi.hoisted(() => ({
  listNotes: vi.fn(),
  updateNote: vi.fn(),
  listDocumentPatchProposals: vi.fn(),
  applyDocumentPatchProposal: vi.fn(),
  createChatGeneratedArtifactVersion: vi.fn(),
  createDocumentPatchProposal: vi.fn(),
  rejectDocumentPatchProposal: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => api);
vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => api);
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const setUiError = vi.fn();
const setActiveGeneratedArtifact = vi.fn();
const loadSessionSecondaryState = vi.fn(async () => undefined);
const session = (sessionId: string, workspaceId: string): ChatSessionRecord => ({
  sessionId,
  workspaceId,
  revision: 3,
  sessionKey: sessionId,
  scope: "mission",
  mode: "chat",
  includeInHistory: true,
  pinned: false,
  lifecycleStatus: "active",
  channel: "mission",
  account: "operator",
  updatedAt: "2026-09-30T00:00:00Z",
  lastActivityAt: "2026-09-30T00:00:00Z",
  tokenTotal: 0,
  costUsdTotal: 0,
});
const note = (workspaceId: string): NoteRecord => ({
  noteId: "note-" + workspaceId,
  workspaceId,
  title: workspaceId,
  body: "saved body",
  tags: [],
  sourceRefs: [],
  lifecycleStatus: "active",
  revision: 3,
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
});
let current: ReturnType<typeof useChatDocuments>;
let renderer: ReactTestRenderer | undefined;
function Harness({ workspaceId = "one", sessionId = "one" }: { workspaceId?: string; sessionId?: string }) {
  current = useChatDocuments({
    workspaceId,
    selectedSession: session(sessionId, workspaceId),
    selectedSessionId: sessionId,
    documentEditingEnabled: true,
    artifacts: [],
    setUiError,
    setActiveGeneratedArtifact,
    loadSessionSecondaryState,
  });
  return null;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  api.listNotes.mockImplementation(async (workspaceId: string) => ({ items: [note(workspaceId)] }));
  api.listDocumentPatchProposals.mockResolvedValue({ items: [] });
  api.updateNote.mockResolvedValue(note("one"));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});

describe("Chat document owner extraction", () => {
  it("keeps refresh identity on unrelated renders and sends the note revision to its owner", async () => {
    await act(async () => {
      renderer = create(<Harness />);
    });
    const refresh = current.documents?.onRefresh;
    await act(async () => renderer?.update(<Harness />));
    expect(current.documents?.onRefresh).toBe(refresh);
    await act(async () => {
      await current.documents?.onSaveNote(note("one"), "new body");
    });
    expect(api.updateNote).toHaveBeenCalledWith("note-one", {
      workspaceId: "one",
      expectedRevision: 3,
      body: "new body",
    });
  });
  it("withholds a late response after leaving and returning to the same scope", async () => {
    const pending = deferred<{ items: NoteRecord[] }>();
    api.listNotes.mockReturnValueOnce(pending.promise);
    await act(async () => {
      renderer = create(<Harness />);
    });
    const oldRefresh = current.documents?.onRefresh;
    await act(async () => renderer?.update(<Harness workspaceId="two" sessionId="two" />));
    await act(async () => renderer?.update(<Harness />));
    const count = api.listNotes.mock.calls.length;
    await act(async () => {
      pending.resolve({ items: [{ ...note("one"), title: "stale snapshot" }] });
    });
    expect(current.documents?.notes[0]?.title).toBe("one");
    await act(async () => oldRefresh?.());
    expect(api.listNotes).toHaveBeenCalledTimes(count);
  });
  it("does not refresh a different conversation after an old note save settles", async () => {
    await act(async () => {
      renderer = create(<Harness />);
    });
    const pending = deferred<NoteRecord>();
    api.updateNote.mockReturnValueOnce(pending.promise);
    let save: Promise<NoteRecord> | undefined;
    await act(async () => {
      save = current.documents?.onSaveNote(note("one"), "retained draft");
    });
    await act(async () => renderer?.update(<Harness workspaceId="two" sessionId="two" />));
    const count = api.listNotes.mock.calls.length;
    await act(async () => {
      pending.resolve(note("one"));
      await save;
    });
    expect(current.documents?.notes[0]?.workspaceId).toBe("two");
    expect(api.listNotes).toHaveBeenCalledTimes(count);
    expect(setUiError).not.toHaveBeenCalled();
  });
});
