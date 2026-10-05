// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelRecord, WorkspaceRecord } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests, hasSessionDraft, useSessionDraft } from "../library/session-drafts";
import { directoryLifecycleReceiptMatches, type DirectoryLifecycleReview } from "./directory-lifecycle-binding";
import { __resetWorkspaceAttemptsForTests, workspaceAttemptLocked } from "./workspace-editor-state";
import { useDirectoryLifecycle } from "./use-directory-lifecycle";

const api = vi.hoisted(() => ({
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  archiveCitadel: vi.fn(),
  restoreCitadel: vi.fn(),
  fetchWorkspaces: vi.fn(),
  listCitadels: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const workspace = (): WorkspaceRecord => ({
  workspaceId: "one",
  citadelId: "personal",
  revision: 3,
  name: "Research",
  slug: "research",
  description: "Saved",
  lifecycleStatus: "active",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  workspacePrefs: { hooks: { allowMutatingHooks: false } },
});
const citadel = (): CitadelRecord => ({
  citadelId: "personal",
  revision: "a".repeat(64),
  name: "Personal",
  slug: "personal",
  kind: "personal",
  lifecycleStatus: "active",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  defaultWorkspaceId: "one",
  hasCharter: true,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let savedWorkspace: WorkspaceRecord, savedCitadel: CitadelRecord;
let root: Root, container: HTMLDivElement;
let options: Parameters<typeof useDirectoryLifecycle>[0], actions: ReturnType<typeof useDirectoryLifecycle>;
let draft: ReturnType<typeof useSessionDraft<{ name: string }>>;
function Harness() {
  actions = useDirectoryLifecycle(options);
  draft = useSessionDraft("workspace:personal:one:edit", { name: "Research" }, undefined, {
    label: "Research",
    active: false,
  });
  return <p>{actions.notice}</p>;
}
async function render(patch: Partial<typeof options> = {}) {
  options = { ...options, ...patch };
  await act(async () => root.render(<Harness />));
}
const target = (action: "archive" | "restore" = "archive"): DirectoryLifecycleReview => ({
  kind: "workspace",
  scope: "personal",
  record: savedWorkspace,
  action,
});
async function request(next = target()) {
  await act(async () => actions.request(next));
}
async function confirm() {
  let result!: boolean;
  await act(async () => {
    result = await actions.confirm();
  });
  return result;
}
async function remount() {
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
}
beforeEach(async () => {
  vi.resetAllMocks();
  __resetWorkspaceAttemptsForTests();
  __resetSessionDraftsForTests();
  savedWorkspace = workspace();
  savedCitadel = citadel();
  api.fetchWorkspaces.mockImplementation(async () => ({ citadelId: "personal", items: [savedWorkspace] }));
  api.listCitadels.mockImplementation(async () => ({ items: [savedCitadel] }));
  const updatedAt = "2026-09-30T01:00:00.000Z";
  api.archiveWorkspace.mockImplementation(async () => {
    savedWorkspace = {
      ...savedWorkspace,
      revision: savedWorkspace.revision + 1,
      lifecycleStatus: "archived",
      archivedAt: updatedAt,
      updatedAt,
    };
    return savedWorkspace;
  });
  api.restoreWorkspace.mockImplementation(async () => {
    savedWorkspace = {
      ...savedWorkspace,
      revision: savedWorkspace.revision + 1,
      lifecycleStatus: "active",
      archivedAt: undefined,
      updatedAt,
    };
    return savedWorkspace;
  });
  api.archiveCitadel.mockImplementation(async () => {
    savedCitadel = {
      ...savedCitadel,
      revision: "b".repeat(64),
      lifecycleStatus: "archived",
      archivedAt: updatedAt,
      updatedAt,
    };
    return savedCitadel;
  });
  options = { ownerKey: "personal", available: true, reload: vi.fn(async () => undefined), onConfirmed: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetWorkspaceAttemptsForTests();
  __resetSessionDraftsForTests();
});

describe("shared directory lifecycle", () => {
  it("reviews without writes, cancels without dropping a draft, then archives the exact revision once", async () => {
    await act(async () => draft.setValue({ name: "Unsaved research" }));
    await request();
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
    await act(async () => actions.cancel());
    expect(hasSessionDraft(draft.key)).toBe(true);
    await request();
    expect(await confirm()).toBe(true);
    expect(api.archiveWorkspace).toHaveBeenCalledExactlyOnceWith("one", 3);
    expect(savedWorkspace.workspacePrefs).toEqual(workspace().workspacePrefs);
    expect(hasSessionDraft(draft.key)).toBe(false);
    expect(options.onConfirmed).toHaveBeenCalledOnce();
  });
  it("restores only the reviewed archived record and preserves metadata", async () => {
    savedWorkspace = {
      ...savedWorkspace,
      revision: 8,
      lifecycleStatus: "archived",
      archivedAt: savedWorkspace.updatedAt,
    };
    await request(target("restore"));
    expect(await confirm()).toBe(true);
    expect(api.restoreWorkspace).toHaveBeenCalledExactlyOnceWith("one", 8);
    expect(savedWorkspace).toMatchObject({
      name: "Research",
      citadelId: "personal",
      revision: 9,
      lifecycleStatus: "active",
    });
  });
  it("refuses the default workspace and withholds foreign or duplicate owner records", async () => {
    await request({
      kind: "workspace",
      scope: "personal",
      action: "archive",
      record: { ...savedWorkspace, workspaceId: "default" },
    });
    expect(actions.review).toBeNull();
    await request();
    api.fetchWorkspaces.mockResolvedValue({ citadelId: "company", items: [savedWorkspace] });
    expect(await confirm()).toBe(false);
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
    await request();
    api.fetchWorkspaces.mockResolvedValue({ citadelId: "personal", items: [savedWorkspace, savedWorkspace] });
    expect(await confirm()).toBe(false);
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
  });
  it("cancels before dispatch when parent is archived, record changes, or selection leaves and returns", async () => {
    await request();
    savedCitadel = { ...savedCitadel, lifecycleStatus: "archived" };
    expect(await confirm()).toBe(false);
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
    savedCitadel = citadel();
    await request();
    savedWorkspace = { ...savedWorkspace, revision: 4 };
    expect(await confirm()).toBe(false);
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
    const read = deferred<{ items: WorkspaceRecord[]; citadelId: string }>();
    api.fetchWorkspaces.mockReturnValue(read.promise);
    await request();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = actions.confirm();
    });
    await render({ ownerKey: "company" });
    await render({ ownerKey: "personal" });
    await act(async () => {
      read.resolve({ items: [savedWorkspace], citadelId: "personal" });
      await pending;
    });
    expect(api.archiveWorkspace).not.toHaveBeenCalled();
  });
  it("shares the editor lock across simultaneous confirms and remounts", async () => {
    const write = deferred<WorkspaceRecord>();
    api.archiveWorkspace.mockReturnValue(write.promise);
    await request();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = actions.confirm();
    });
    expect(workspaceAttemptLocked("workspace:personal:one:edit")).toBe(true);
    expect(await confirm()).toBe(false);
    await remount();
    await request();
    expect(actions.review).toBeNull();
    await act(async () => {
      write.reject(new Error("response lost"));
      await pending;
    });
    await remount();
    expect(actions.locked(target())).toBe(true);
    expect(api.archiveWorkspace).toHaveBeenCalledOnce();
  });
  it("retains uncertainty for wrong receipts, missing readback, and a committed conflict", async () => {
    await request();
    api.archiveWorkspace.mockResolvedValue({
      ...savedWorkspace,
      lifecycleStatus: "archived",
      revision: 4,
      archivedAt: "2026-09-30T01:00:00.000Z",
      updatedAt: "2026-09-30T01:00:00.000Z",
      citadelId: "foreign",
    });
    expect(await confirm()).toBe(false);
    expect(actions.locked(target())).toBe(true);
    __resetWorkspaceAttemptsForTests();
    await request();
    api.archiveWorkspace.mockRejectedValue({
      status: 409,
      body: {
        code: "WRITE_CONFLICT",
        mutationCommitted: true,
        details: { resourceKind: "workspace", resourceId: "one", expectedRevision: 3 },
      },
    });
    expect(await confirm()).toBe(false);
    expect(actions.locked(target())).toBe(true);
    __resetWorkspaceAttemptsForTests();
    api.archiveWorkspace.mockImplementation(async () => {
      savedWorkspace = {
        ...savedWorkspace,
        lifecycleStatus: "archived",
        revision: 4,
        archivedAt: "2026-09-30T01:00:00.000Z",
        updatedAt: "2026-09-30T01:00:00.000Z",
      };
      return savedWorkspace;
    });
    await request();
    api.fetchWorkspaces
      .mockResolvedValueOnce({ items: [savedWorkspace], citadelId: "personal" })
      .mockResolvedValueOnce({ items: [], citadelId: "personal" });
    expect(await confirm()).toBe(false);
    expect(actions.locked(target())).toBe(true);
  });
  it("unlocks only the exact prewrite revision conflict and keeps the retained draft", async () => {
    await act(async () => draft.setValue({ name: "Retain me" }));
    await request();
    api.archiveWorkspace.mockRejectedValue({
      status: 409,
      body: {
        code: "WRITE_CONFLICT",
        details: { resourceKind: "workspace", resourceId: "one", expectedRevision: 3, currentRevision: 4 },
      },
    });
    expect(await confirm()).toBe(false);
    expect(actions.locked(target())).toBe(false);
    expect(hasSessionDraft(draft.key)).toBe(true);
    await request();
    api.archiveWorkspace.mockRejectedValue({ status: 409, body: { code: "STATE_CONFLICT" } });
    expect(await confirm()).toBe(false);
    expect(actions.locked(target())).toBe(true);
  });
  it("keeps a confirmed write when displayed refresh fails or finishes after a new review", async () => {
    const read = deferred<undefined>();
    options.reload = vi.fn(() => read.promise);
    await render();
    await request();
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = actions.confirm();
    });
    expect(savedWorkspace.lifecycleStatus).toBe("archived");
    expect(actions.locked(target())).toBe(false);
    await request(target("restore"));
    await act(async () => {
      read.reject(new Error("late refresh"));
      await pending;
    });
    expect(actions.review?.action).toBe("restore");
    expect(actions.notice).toBeNull();
  });
  it("binds Citadel lifecycle to its opaque profile revision and keeps directory projection separate", async () => {
    await request({ kind: "citadel", record: savedCitadel, action: "archive" });
    api.listCitadels.mockImplementation(async () => ({ items: [{ ...savedCitadel, hasCharter: false }] }));
    expect(await confirm()).toBe(true);
    expect(api.archiveCitadel).toHaveBeenCalledExactlyOnceWith("personal", "a".repeat(64));
    expect(savedCitadel.defaultWorkspaceId).toBe("one");
  });
  it("rejects lifecycle receipts that change governance or identity", () => {
    const review = target(),
      saved = {
        ...savedWorkspace,
        revision: 4,
        lifecycleStatus: "archived" as const,
        archivedAt: "2026-09-30T01:00:00.000Z",
        updatedAt: "2026-09-30T01:00:00.000Z",
      };
    expect(directoryLifecycleReceiptMatches(review, saved)).toBe(true);
    for (const changed of [
      { ...saved, workspaceId: "other" },
      { ...saved, revision: 5 },
      { ...saved, name: "Other" },
      { ...saved, archivedAt: undefined },
      { ...saved, workspacePrefs: { hooks: { allowMutatingHooks: true } } },
    ])
      expect(directoryLifecycleReceiptMatches(review, changed)).toBe(false);
  });
});
