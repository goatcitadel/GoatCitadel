import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionDraftsForTests } from "./library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "./library/use-form-dirty";
import { __resetSessionViewStateForTests } from "../../hooks/use-session-view-state";
const renderers: ReactTestRenderer[] = [];
function create(...args: Parameters<typeof createRenderer>) { const renderer = createRenderer(...args); renderers.push(renderer); return renderer; }
beforeEach(() => { __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests(); __resetSessionViewStateForTests(); });
afterEach(async () => { await act(async () => { for (const renderer of renderers.splice(0)) renderer.unmount(); }); });

vi.mock("./route-diagnostics", () => ({ recordRouteDiagnostic: vi.fn() }));

import { NativeRoutePages } from "./NativeRoutePages";

const mocks = vi.hoisted(() => ({
  listNotes: vi.fn(async () => ({
    items: [
      {
        noteId: "note-1",
        workspaceId: "default",
        title: "Launch checklist",
        body: "Confirm store copy and release proof.",
        tags: ["launch"],
        sourceRefs: ["run-1"],
        lifecycleStatus: "active",
        revision: 2,
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T11:00:00.000Z",
      },
    ],
  })),
  createNote: vi.fn(async (input: any) => ({
    noteId: "note-created",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    lifecycleStatus: "active",
    sourceRefs: [],
    tags: [],
    body: "",
    workspaceId: "default",
    ...input,
  })),
  archiveNote: vi.fn(async (noteId: string) => ({ noteId, lifecycleStatus: "archived" })),
  listNoteRevisions: vi.fn(async () => ({
    items: [
      {
        noteId: "note-1",
        workspaceId: "default",
        revision: 2,
        title: "Launch checklist",
        body: "Confirm store copy and release proof.",
        tags: ["launch"],
        sourceRefs: ["run-1"],
        contentHash: "hash-note-1-v2",
        actorId: "operator",
        source: "operator",
        createdAt: "2026-06-01T11:00:00.000Z",
      },
    ],
  })),
  updateNote: vi.fn(async (noteId: string, input: any) => ({
    noteId,
    workspaceId: "default",
    lifecycleStatus: "active",
    revision: 3,
    tags: ["launch"],
    sourceRefs: ["run-1"],
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...input,
  })),
  listReminders: vi.fn(async () => ({
    items: [
      {
        reminderId: "reminder-1",
        workspaceId: "default",
        title: "Send launch recap",
        dueAt: "2026-06-08T09:00:00.000Z",
        status: "scheduled",
        sourceRef: "note-1",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ],
  })),
  createReminder: vi.fn(async (input: any) => ({
    reminderId: "reminder-created",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    status: "scheduled",
    workspaceId: "default",
    ...input,
  })),
  completeReminder: vi.fn(async (reminderId: string) => ({ reminderId, status: "completed" })),
  fetchCommunicationsDashboard: vi.fn(async () => ({
    mailAccounts: [
      {
        accountId: "mail-1",
        workspaceId: "default",
        provider: "gmail",
        label: "Primary mail",
        address: "operator@example.test",
        syncStatus: "ready",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ],
    calendarAccounts: [
      {
        accountId: "cal-1",
        workspaceId: "default",
        provider: "google",
        label: "Primary calendar",
        syncStatus: "ready",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ],
    messages: [
      {
        messageId: "message-1",
        accountId: "mail-1",
        from: "lead@example.test",
        to: ["operator@example.test"],
        subject: "Launch timing",
        snippet: "Can we confirm the launch window?",
        receivedAt: "2026-06-01T12:00:00.000Z",
        labels: ["inbox"],
        triage: { urgency: "high", category: "reply", summary: "Confirm the launch window." },
      },
    ],
    events: [
      {
        eventId: "event-1",
        accountId: "cal-1",
        title: "Launch sync",
        startIso: "2026-06-08T16:00:00.000Z",
        endIso: "2026-06-08T16:30:00.000Z",
        attendees: ["lead@example.test"],
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ],
    contacts: [
      {
        contactId: "contact-1",
        workspaceId: "default",
        displayName: "Launch Lead",
        emailAddresses: ["lead@example.test"],
        phoneNumbers: [],
        company: "Example",
        role: "PM",
        externalRefs: [],
        lifecycleStatus: "active",
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      },
    ],
  })),
  createMailDraft: vi.fn(async (input: any) => ({
    draftId: "draft-1",
    bcc: [],
    status: "draft",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...input,
  })),
  sendMailDraft: vi.fn(async (draftId: string) => ({
    draftId,
    accountId: "mail-1",
    to: ["lead@example.test"],
    cc: [],
    bcc: [],
    subject: "Launch",
    bodyText: "Confirmed.",
    status: "approval_required",
    approvalId: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:01:00.000Z",
  })),
  createCalendarEvent: vi.fn(async (input: any) => ({
    eventId: "event-created",
    createdAt: "2026-06-01T12:00:00.000Z",
    updatedAt: "2026-06-01T12:00:00.000Z",
    ...input,
  })),
  listModelComparisons: vi.fn(async () => ({
    items: [
      {
        comparisonId: "comparison-1",
        packId: "launch-pack",
        status: "completed",
        title: "Launch pack comparison",
        candidates: [
          { candidateId: "candidate-a", providerId: "openai", model: "gpt-5", blindLabel: "A" },
          { candidateId: "candidate-b", providerId: "anthropic", model: "claude-5", blindLabel: "B" },
        ],
        testIds: ["test-1"],
        results: [
          {
            resultId: "result-1",
            testId: "test-1",
            candidateId: "candidate-a",
            responseText: "Use the direct launch answer.",
            latencyMs: 1200,
            costUsd: 0.02,
          },
        ],
        judgments: [],
        createdAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T11:00:00.000Z",
      },
    ],
  })),
  judgeModelComparison: vi.fn(async () => ({
    judgmentId: "judgment-1",
    testId: "test-1",
    winnerCandidateId: "candidate-a",
    scores: [{ candidateId: "candidate-a", quality: 4 }],
    createdAt: "2026-06-01T12:00:00.000Z",
  })),
}));

vi.mock("@goatcitadel/mission-control-shared/api/personal-ops", () => ({
  archiveNote: mocks.archiveNote,
  completeReminder: mocks.completeReminder,
  createCalendarEvent: mocks.createCalendarEvent,
  createMailDraft: mocks.createMailDraft,
  createNote: mocks.createNote,
  createReminder: mocks.createReminder,
  fetchCommunicationsDashboard: mocks.fetchCommunicationsDashboard,
  listNotes: mocks.listNotes,
  listNoteRevisions: mocks.listNoteRevisions,
  listReminders: mocks.listReminders,
  sendMailDraft: mocks.sendMailDraft,
  updateNote: mocks.updateNote,
}));

vi.mock("@goatcitadel/mission-control-shared/api/model-comparisons", () => ({
  judgeModelComparison: mocks.judgeModelComparison,
  listModelComparisons: mocks.listModelComparisons,
}));

describe("NativeRoutePages odysseus library sections", () => {
  it("searches all returned notes and reminders and keeps dismissed details closed after refresh", async () => {
    const note = (await mocks.listNotes()).items[0]!;
    const reminder = (await mocks.listReminders()).items[0]!;
    mocks.listNotes.mockResolvedValueOnce({ items: Array.from({ length: 55 }, (_, i) => ({ ...note, noteId: "note-" + i, title: "Access note " + i })) });
    mocks.listReminders.mockResolvedValueOnce({ items: Array.from({ length: 25 }, (_, i) => ({ ...reminder, reminderId: "reminder-" + i, title: "Access reminder " + i })) });
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = renderLibrary("notes"); });
    const search = (label: string) => renderer.root.findAllByType("label").find(node => collectText(node).includes(label))!.findByType("input");
    await act(async () => { search("Search notes").props.onChange({ target: { value: "Access note 54" } }); search("Search reminders").props.onChange({ target: { value: "Access reminder 24" } }); });
    expect(collectText(renderer.root)).toContain("Access note 54");
    await act(async () => { findButton(renderer.root, "Access reminder 24").props.onClick(); });
    expect(collectText(renderer.root)).toContain("Reminder ID");
    await act(async () => { renderer.root.findByProps({ "aria-label": "Close details" }).props.onClick(); });
    await act(async () => { findButton(renderer.root, "Refresh").props.onClick(); });
    expect(renderer.root.findAllByProps({ "aria-label": "Close details" })).toHaveLength(0);
  });

  it("does not claim reminder completion for a mismatched response and prevents duplicate requests", async () => {
    let settle!: (value: any) => void;
    mocks.completeReminder.mockClear();
    mocks.completeReminder.mockImplementationOnce(() => new Promise(resolve => { settle = resolve; }));
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = renderLibrary("notes"); });
    await act(async () => { findButton(renderer.root, "Send launch recap").props.onClick(); });
    const complete = findButton(renderer.root, "Mark completed");
    await act(async () => { complete.props.onClick(); complete.props.onClick(); });
    expect(mocks.completeReminder).toHaveBeenCalledTimes(1);
    await act(async () => { settle({ reminderId: "different", workspaceId: "default", status: "completed" }); });
    expect(collectText(renderer.root)).toContain("Completion is not confirmed");
    expect(collectText(renderer.root)).toContain("Mark completed");
    expect(renderer.root.findAllByType("button").filter(node => node.props["aria-label"] === "Close details")).toHaveLength(1);
  });

  it("renders notes and creates a scoped note", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderLibrary("notes");
    });
    await act(async () => undefined);

    expect(collectText(renderer!.root)).toContain("Notes");
    expect(collectText(renderer!.root)).toContain("Launch checklist");

    await act(async () => findButton(renderer!.root, "New note").props.onClick());
    await act(async () => {
      renderer!.root.findAllByType("input")[0]!.props.onChange({
        target: { value: "Operator recap" },
      });
      renderer!.root.findByType("textarea").props.onChange({
        target: { value: "Follow up with the launch lead." },
      });
    });
    await act(async () => {
      await findButton(renderer!.root, "Save note").props.onClick();
    });

    expect(mocks.createNote).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "default", title: "Operator recap" }),
    );

    await act(async () => findButton(renderer!.root, "Launch checklist").props.onClick());
    const editTitle = renderer!.root.findAll(
      (node) => node.type === "input" && node.props.value === "Launch checklist",
    )[0]!;
    const editBody = renderer!.root.findAll(
      (node) => node.type === "textarea" && node.props.value === "Confirm store copy and release proof.",
    )[0]!;
    await act(async () => {
      editTitle.props.onChange({ target: { value: "Updated launch checklist" } });
      editBody.props.onChange({ target: { value: "Updated body" } });
    });
    await act(async () => {
      await findButton(renderer!.root, "Save changes").props.onClick();
    });
    expect(mocks.updateNote).toHaveBeenCalledWith(
      "note-1",
      expect.objectContaining({
        workspaceId: "default",
        expectedRevision: 2,
        title: "Updated launch checklist",
        body: "Updated body",
      }),
    );
    await act(async () => findButton(renderer!.root, "History and details").props.onClick());
    expect(mocks.listNoteRevisions).toHaveBeenCalledWith("note-1", "default");

    await act(async () => {
      await findButton(renderer!.root, "Archive note").props.onClick();
    });
    await act(async () => findButton(renderer!.root, "Confirm archive").props.onClick());
    expect(mocks.archiveNote).toHaveBeenCalledWith("note-1", "default");
  });

  it("renders communications and creates a governed mail draft", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderLibrary("communications");
    });
    await act(async () => undefined);

    expect(collectText(renderer!.root)).toContain("Communications");
    expect(collectText(renderer!.root)).toContain("Launch timing");

    await act(async () => findButton(renderer!.root, "New draft").props.onClick());
    await act(async () => {
      findInputByPlaceholder(renderer!.root, "client@example.com").props.onChange({
        target: { value: "lead@example.test" },
      });
      findInputByPlaceholder(renderer!.root, "Follow-up").props.onChange({ target: { value: "Launch window" } });
      findTextareaByPlaceholder(renderer!.root, "Draft body").props.onChange({ target: { value: "Confirmed." } });
    });
    await act(async () => {
      await findButton(renderer!.root, "Queue approval").props.onClick();
    });

    expect(mocks.createMailDraft).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "mail-1", subject: "Launch window" }),
    );
  });

  it("renders model comparisons under prompt packs and saves a judgment", async () => {
    let renderer: ReactTestRenderer | null = null;
    await act(async () => {
      renderer = renderLibrary("prompt-packs");
    });
    await act(async () => undefined);

    expect(collectText(renderer!.root)).toContain("Prompt-pack review queue");
    expect(collectText(renderer!.root)).toContain("Launch pack comparison");

    await act(async () => findButton(renderer!.root, "Launch pack comparison").props.onClick());
    await act(async () => {
      await findButton(renderer!.root, "Save judgment").props.onClick();
    });

    expect(mocks.judgeModelComparison).toHaveBeenCalledWith(
      "comparison-1",
      expect.objectContaining({ reviewerId: "operator", testId: "test-1" }),
    );
  });
});

function renderLibrary(section: "notes" | "communications" | "prompt-packs"): ReactTestRenderer {
  return create(
    <NativeRoutePages
      route={{ area: "library", section, theme: "ops" } as any}
      activeWorkspaceId="default"
      activeWorkspaceName="Default"
      pendingApprovals={0}
      navigate={vi.fn()}
      setActiveWorkspaceId={vi.fn()}
    />,
  );
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const match = root.findAll((node) => node.type === "button" && collectText(node).includes(label))[0];
  if (!match) {
    throw new Error(`Unable to find button: ${label}`);
  }
  return match;
}

function findInputByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.type === "input" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  )[0];
  if (!match) {
    throw new Error(`Unable to find input: ${placeholder}`);
  }
  return match;
}

function findTextareaByPlaceholder(root: ReactTestInstance, placeholder: string): ReactTestInstance {
  const match = root.findAll(
    (node) =>
      node.type === "textarea" && typeof node.props?.placeholder === "string" && node.props.placeholder === placeholder,
  )[0];
  if (!match) {
    throw new Error(`Unable to find textarea: ${placeholder}`);
  }
  return match;
}

function collectText(node: ReactTestInstance): string {
  return node.children
    .map((child) => {
      if (typeof child === "string") {
        return child;
      }
      if (typeof child === "number") {
        return String(child);
      }
      return collectText(child);
    })
    .join(" ");
}
