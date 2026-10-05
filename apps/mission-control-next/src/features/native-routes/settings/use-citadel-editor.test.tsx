// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CitadelRecord } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { __resetWorkspaceAttemptsForTests } from "./workspace-editor-state";
import { useCitadelEditor } from "./use-citadel-editor";
import { useDirectoryLifecycle } from "./use-directory-lifecycle";
const api = vi.hoisted(() => ({
  createCitadel: vi.fn(),
  updateCitadel: vi.fn(),
  listCitadels: vi.fn(),
  archiveCitadel: vi.fn(),
  restoreCitadel: vi.fn(),
  archiveWorkspace: vi.fn(),
  restoreWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
const record = (): CitadelRecord => ({
  citadelId: "personal",
  revision: "a".repeat(64),
  name: "Personal",
  description: "Saved",
  slug: "personal",
  kind: "personal",
  lifecycleStatus: "active",
  createdAt: "2026-09-30T00:00:00.000Z",
  updatedAt: "2026-09-30T00:00:00.000Z",
  defaultWorkspaceId: "one",
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let canonical: CitadelRecord,
  options: Parameters<typeof useCitadelEditor>[0],
  editor: ReturnType<typeof useCitadelEditor>,
  lifecycle: ReturnType<typeof useDirectoryLifecycle>;
let root: Root, container: HTMLDivElement;
function Harness() {
  editor = useCitadelEditor(options);
  lifecycle = useDirectoryLifecycle({ ownerKey: options.ownerKey, available: true, reload: options.reload });
  return <p>{editor.notice}</p>;
}
async function render(patch: Partial<typeof options> = {}) {
  options = { ...options, ...patch };
  await act(async () => root.render(<Harness />));
}
async function edit(name = "Updated", description = "") {
  await act(async () => editor.editDraft.setValue((value) => ({ ...value, name, description })));
}
async function save() {
  let saved!: boolean;
  await act(async () => {
    saved = await editor.save();
  });
  return saved;
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
  canonical = record();
  api.listCitadels.mockImplementation(async () => ({ items: [canonical] }));
  api.updateCitadel.mockImplementation(async (_id, input) => {
    canonical = { ...canonical, ...input, revision: "b".repeat(64), updatedAt: "2026-09-30T01:00:00.000Z" };
    return canonical;
  });
  options = {
    ownerKey: "personal",
    selected: canonical,
    selectedId: "personal",
    mode: "edit",
    available: true,
    reload: vi.fn(async () => undefined),
    onCreated: vi.fn(),
  };
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
describe("shared Citadel metadata owner", () => {
  it("keeps a confirmed save going when a background refresh starts during its check", async () => {
    const read = deferred<{ items: CitadelRecord[] }>();
    api.listCitadels.mockReturnValueOnce(read.promise);
    await edit();
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = editor.save();
    });
    await render({ checking: true });
    let saved!: boolean;
    await act(async () => {
      read.resolve({ items: [canonical] });
      saved = await saving;
    });
    expect(saved).toBe(true);
    expect(api.updateCitadel).toHaveBeenCalledOnce();
  });
  it("waits to start a save while the directory is checking", async () => {
    await edit();
    await render({ checking: true });
    expect(await save()).toBe(false);
    expect(api.listCitadels).not.toHaveBeenCalled();
    expect(api.updateCitadel).not.toHaveBeenCalled();
    await render({ checking: false });
    expect(await save()).toBe(true);
  });
  it("says so when the directory stops being ready during the check", async () => {
    const read = deferred<{ items: CitadelRecord[] }>();
    api.listCitadels.mockReturnValueOnce(read.promise);
    await edit();
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = editor.save();
    });
    await render({ available: false });
    await act(async () => {
      read.resolve({ items: [canonical] });
      await saving;
    });
    expect(api.updateCitadel).not.toHaveBeenCalled();
    expect(editor.pending).toBe(false);
    expect(editor.notice).toBe("This list changed while checking. Review it again.");
  });
  it("submits normalized metadata with exact revision, clears description, and preserves workspace/lifecycle", async () => {
    await edit("  Updated  ");
    expect(await save()).toBe(true);
    expect(api.updateCitadel).toHaveBeenCalledExactlyOnceWith("personal", {
      expectedRevision: "a".repeat(64),
      name: "Updated",
      description: "",
      slug: "personal",
      kind: "personal",
    });
    expect(canonical.defaultWorkspaceId).toBe("one");
    expect(canonical.lifecycleStatus).toBe("active");
    expect(editor.editDraft.isDirty).toBe(false);
  });
  it("withholds a stale preflight write and retains its draft until explicit review of the winner", async () => {
    await edit();
    canonical = { ...canonical, name: "Peer", revision: "c".repeat(64) };
    expect(await save()).toBe(false);
    expect(api.updateCitadel).not.toHaveBeenCalled();
    expect(editor.hasConflict).toBe(true);
    expect(editor.editDraft.value.name).toBe("Updated");
    expect(editor.canRebase).toBe(false);
    await render({ selected: canonical });
    expect(editor.canRebase).toBe(true);
    await act(async () => editor.rebase());
    expect(editor.hasConflict).toBe(false);
    expect(await save()).toBe(true);
  });
  it("latched exact noncommitted conflicts cannot be silently rebased onto their rejected token", async () => {
    await edit();
    api.updateCitadel.mockRejectedValue({
      status: 409,
      body: { code: "WRITE_CONFLICT", details: { reason: "CITADEL_RECORD_REVISION_CONFLICT" } },
    });
    expect(await save()).toBe(false);
    expect(editor.locked).toBe(false);
    expect(editor.hasConflict).toBe(true);
    await act(async () => editor.rebase());
    expect(editor.hasConflict).toBe(true);
    expect(await save()).toBe(false);
    expect(api.updateCitadel).toHaveBeenCalledOnce();
  });
  it("keeps pending and unknown metadata locks across remount and blocks lifecycle in both directions", async () => {
    const pending = deferred<CitadelRecord>();
    api.updateCitadel.mockReturnValue(pending.promise);
    await edit();
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = editor.save();
    });
    await remount();
    await act(async () => lifecycle.request({ kind: "citadel", record: canonical, action: "archive" }));
    expect(lifecycle.review).toBeNull();
    expect(editor.locked).toBe(true);
    await act(async () => {
      pending.reject(new Error("response lost"));
      await saving;
    });
    await remount();
    expect(editor.uncertain).toBe(true);
    await act(async () => lifecycle.request({ kind: "citadel", record: canonical, action: "archive" }));
    expect(lifecycle.review).toBeNull();
    expect(api.archiveCitadel).not.toHaveBeenCalled();
  });
  it("acknowledges a delayed successful origin save without overwriting newer typing", async () => {
    const pending = deferred<CitadelRecord>();
    api.updateCitadel.mockReturnValue(pending.promise);
    await edit("Submitted");
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = editor.save();
    });
    await edit("Newer typing");
    await remount();
    canonical = {
      ...canonical,
      name: "Submitted",
      description: "",
      revision: "b".repeat(64),
      updatedAt: "2026-09-30T01:00:00.000Z",
    };
    await act(async () => {
      pending.resolve(canonical);
      await saving;
    });
    await render({ selected: canonical });
    expect(editor.editDraft.value.name).toBe("Newer typing");
    expect(editor.editDraft.baseRevision).toBe(canonical.revision);
    expect(editor.editDraft.isDirty).toBe(true);
  });
  it("prevents late preflight dispatch after leaving the origin scope and returning", async () => {
    const read = deferred<{ items: CitadelRecord[] }>();
    api.listCitadels.mockReturnValue(read.promise);
    await edit();
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = editor.save();
    });
    await render({ ownerKey: "company" });
    await render({ ownerKey: "personal" });
    await act(async () => {
      read.resolve({ items: [canonical] });
      await saving;
    });
    expect(api.updateCitadel).not.toHaveBeenCalled();
  });
  it("rejects incorrect receipt governance and missing canonical readback without unlocking", async () => {
    await edit();
    api.updateCitadel.mockResolvedValue({
      ...canonical,
      name: "Updated",
      description: "",
      revision: "b".repeat(64),
      updatedAt: "2026-09-30T01:00:00.000Z",
      defaultWorkspaceId: "foreign",
    });
    expect(await save()).toBe(false);
    expect(editor.uncertain).toBe(true);
    __resetWorkspaceAttemptsForTests();
    await render();
    api.updateCitadel.mockImplementation(async () => {
      canonical = {
        ...canonical,
        name: "Updated",
        description: "",
        revision: "b".repeat(64),
        updatedAt: "2026-09-30T01:00:00.000Z",
      };
      return canonical;
    });
    api.listCitadels.mockResolvedValueOnce({ items: [canonical] }).mockResolvedValueOnce({ items: [] });
    expect(await save()).toBe(false);
    expect(editor.uncertain).toBe(true);
  });
  it("creates only a new exact canonical slug, and retains global uncertainty across scope changes", async () => {
    await render({ mode: "create" });
    await act(async () =>
      editor.createDraft.setValue({ name: "New Citadel", description: "Draft", slug: "", kind: "custom" }),
    );
    api.createCitadel.mockImplementation(async () => {
      canonical = {
        ...record(),
        citadelId: "new-citadel",
        slug: "new-citadel",
        name: "New Citadel",
        description: "Draft",
        kind: "custom",
        defaultWorkspaceId: undefined,
      };
      return canonical;
    });
    await act(async () => {
      expect(await editor.create()).toBe(true);
    });
    expect(options.onCreated).toHaveBeenCalledOnce();
    expect(editor.createDraft.isDirty).toBe(false);
    await act(async () => editor.createDraft.setValue({ name: "Other", description: "", slug: "", kind: "custom" }));
    api.createCitadel.mockRejectedValue(new Error("response lost"));
    await act(async () => {
      expect(await editor.create()).toBe(false);
    });
    await render({ ownerKey: "company" });
    expect(editor.locked).toBe(true);
    expect(editor.createDraft.value.name).toBe("Other");
  });
});
