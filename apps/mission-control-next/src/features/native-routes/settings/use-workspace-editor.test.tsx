// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { WorkspaceRecord } from "@goatcitadel/contracts";
import { __resetSessionDraftsForTests } from "../library/session-drafts";
import { useWorkspaceEditor } from "./use-workspace-editor";
import { __resetWorkspaceAttemptsForTests } from "./workspace-editor-state";

const api = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  updateWorkspace: vi.fn(),
  fetchWorkspaces: vi.fn(),
  listCitadels: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (error: unknown) => Boolean(error && typeof error === "object" && "status" in error),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const record = (patch: Partial<WorkspaceRecord> = {}): WorkspaceRecord => ({
  workspaceId: "ws-one",
  citadelId: "personal",
  revision: 3,
  name: "Research",
  description: "Saved description",
  slug: "research",
  lifecycleStatus: "active",
  createdAt: "2026-09-30T00:00:00Z",
  updatedAt: "2026-09-30T00:00:00Z",
  workspacePrefs: { defaultThreadMode: "chat" },
  ...patch,
});
type Options = Parameters<typeof useWorkspaceEditor>[0];
let options: Options;
let action: ReturnType<typeof useWorkspaceEditor>;
let canonical: WorkspaceRecord;
let root: Root;
let container: HTMLDivElement;
let onCreated: Mock<(workspace: WorkspaceRecord) => void>;
function Harness() {
  action = useWorkspaceEditor(options);
  return <p>{action.notice}</p>;
}
async function render(patch: Partial<Options> = {}) {
  options = { ...options, ...patch };
  await act(async () => root.render(<Harness />));
}
async function draft(name = "Renamed", description = "New description") {
  await act(async () => {
    const target = options.mode === "create" ? action.createDraft : action.editDraft;
    target.setValue((value) => ({ ...value, name, description }));
  });
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
  onCreated = vi.fn<(workspace: WorkspaceRecord) => void>();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  api.listCitadels.mockResolvedValue({ items: [{ citadelId: "personal", lifecycleStatus: "active" }] });
  api.fetchWorkspaces.mockImplementation(async () => ({ citadelId: "personal", items: [canonical] }));
  api.updateWorkspace.mockImplementation(
    async (id: string, input: { name: string; description: string; slug: string }) => {
      canonical = { ...canonical, workspaceId: id, ...input, revision: canonical.revision + 1 };
      return canonical;
    },
  );
  api.createWorkspace.mockImplementation(async (input: { name: string; description?: string; citadelId: string }) =>
    record({
      ...input,
      slug: input.name.toLowerCase().replace(/\s+/g, "-"),
      workspaceId: "new-workspace",
      revision: 1,
    }),
  );
  options = {
    citadelId: "personal",
    selected: canonical,
    selectedId: canonical.workspaceId,
    mode: "edit",
    available: true,
    metadataOnly: true,
    onCreated,
    reload: vi.fn(async () => {
      await render({ selected: canonical });
    }),
  };
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetWorkspaceAttemptsForTests();
  __resetSessionDraftsForTests();
});

describe("shared workspace editor", () => {
  it("edits only reviewed metadata with exact owner revision, preserving slug and preferences", async () => {
    await draft();
    await act(async () => expect(await action.save()).toBe(true));
    expect(api.updateWorkspace).toHaveBeenCalledExactlyOnceWith("ws-one", {
      expectedRevision: 3,
      name: "Renamed",
      description: "New description",
      slug: "research",
    });
    expect(canonical.workspacePrefs).toEqual(record().workspacePrefs);
    expect(action.notice).toContain("Renamed updated");
    expect(action.editDraft.isDirty).toBe(false);
  });
  it("creates only in the explicit active Citadel and retains the existing active workspace selection", async () => {
    await render({ mode: "create" });
    await draft("Fresh workspace", "Description");
    await act(async () => expect(await action.create()).toBe(true));
    expect(api.createWorkspace).toHaveBeenCalledExactlyOnceWith({
      citadelId: "personal",
      name: "Fresh workspace",
      description: "Description",
      slug: undefined,
    });
    expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "new-workspace", citadelId: "personal" }),
    );
    expect(options.selectedId).toBe("ws-one");
  });
  it("withholds mutations for missing or archived parent scope", async () => {
    await render({ citadelId: undefined, mode: "create" });
    await draft();
    await act(async () => action.create());
    expect(api.createWorkspace).not.toHaveBeenCalled();
    await render({ citadelId: "personal" });
    await draft();
    api.listCitadels.mockResolvedValue({ items: [{ citadelId: "personal", lifecycleStatus: "archived" }] });
    await act(async () => action.create());
    expect(action.notice).toContain("unavailable or archived");
    expect(api.createWorkspace).not.toHaveBeenCalled();
  });
  it("keeps a confirmed save going when a background refresh starts during its check", async () => {
    await draft();
    const read = deferred<{ items: WorkspaceRecord[]; citadelId: string }>();
    api.fetchWorkspaces.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.save();
    });
    await render({ checking: true });
    let saved!: boolean;
    await act(async () => {
      read.resolve({ citadelId: "personal", items: [canonical] });
      saved = await pending;
    });
    expect(saved).toBe(true);
    expect(api.updateWorkspace).toHaveBeenCalledOnce();
  });
  it("waits to start a save while the directory is checking", async () => {
    await draft();
    await render({ checking: true });
    await act(async () => expect(await action.save()).toBe(false));
    expect(api.listCitadels).not.toHaveBeenCalled();
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(action.pending).toBe(false);
    await render({ checking: false });
    await act(async () => expect(await action.save()).toBe(true));
  });
  it("says so when the directory stops being ready during the check", async () => {
    await draft();
    const read = deferred<{ items: WorkspaceRecord[]; citadelId: string }>();
    api.fetchWorkspaces.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.save();
    });
    await render({ available: false });
    await act(async () => {
      read.resolve({ citadelId: "personal", items: [canonical] });
      await pending;
    });
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(action.pending).toBe(false);
    expect(action.notice).toBe("This list changed while checking. Review it again.");
  });
  it("cancels a late preflight after a Citadel switch, including a switch back", async () => {
    await draft();
    const read = deferred<{ items: WorkspaceRecord[] }>();
    api.fetchWorkspaces.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.save();
    });
    await render({ citadelId: "company" });
    await render({ citadelId: "personal" });
    await act(async () => {
      read.resolve({ items: [canonical] });
      await pending;
    });
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(action.locked).toBe(false);
  });
  it("cancels late preflight after selecting another workspace or unmounting", async () => {
    await draft();
    const read = deferred<{ items: WorkspaceRecord[] }>();
    api.fetchWorkspaces.mockReturnValueOnce(read.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.save();
    });
    await render({ selectedId: "ws-two", selected: record({ workspaceId: "ws-two" }) });
    await act(async () => {
      read.resolve({ items: [canonical] });
      await pending;
    });
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    await render({ selectedId: "ws-one", selected: canonical });
    const next = deferred<{ items: WorkspaceRecord[] }>();
    api.fetchWorkspaces.mockReturnValueOnce(next.promise);
    await act(async () => {
      pending = action.save();
    });
    await remount();
    await act(async () => {
      next.resolve({ items: [canonical] });
      await pending;
    });
    expect(api.updateWorkspace).not.toHaveBeenCalled();
  });
  it("preserves a stale draft and requires explicit rebase before saving the refreshed revision and slug", async () => {
    await draft();
    canonical = record({ revision: 4, name: "Peer name", slug: "peer-slug" });
    await act(async () => action.save());
    expect(api.updateWorkspace).not.toHaveBeenCalled();
    expect(action.editDraft.value.name).toBe("Renamed");
    expect(action.editDraft.hasRemoteChanges).toBe(true);
    await act(async () => action.editDraft.rebaseToCurrent());
    await act(async () => action.save());
    expect(api.updateWorkspace).toHaveBeenCalledExactlyOnceWith("ws-one", {
      expectedRevision: 4,
      name: "Renamed",
      description: "New description",
      slug: "peer-slug",
    });
  });
  it("handles an exact owner CAS conflict without an uncertainty lock", async () => {
    await draft();
    api.updateWorkspace.mockImplementationOnce(async () => {
      canonical = record({ revision: 4, name: "Peer" });
      throw {
        status: 409,
        body: {
          code: "WRITE_CONFLICT",
          details: { resourceKind: "workspace", resourceId: "ws-one", expectedRevision: 3, currentRevision: 4 },
        },
      };
    });
    await act(async () => action.save());
    expect(action.locked).toBe(false);
    expect(action.editDraft.hasRemoteChanges).toBe(true);
    expect(action.notice).toContain("draft is preserved");
  });
  it("retains a pending and then uncertain create attempt across remount without duplicate creation", async () => {
    await render({ mode: "create" });
    await draft();
    const response = deferred<WorkspaceRecord>();
    api.createWorkspace.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.create();
    });
    await remount();
    expect(action.pending).toBe(true);
    await act(async () => action.create());
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {
      response.reject(new Error("connection lost after send"));
      await pending;
    });
    await remount();
    expect(action.uncertain).toBe(true);
    await render({ metadataOnly: false });
    await draft();
    expect(action.uncertain).toBe(true);
    await act(async () => action.create());
    expect(api.createWorkspace).toHaveBeenCalledTimes(1);
  });
  it.each([
    { workspaceId: "foreign" },
    { citadelId: "company" },
    { revision: 99 },
    { name: "Another request" },
    { slug: "unexpected-slug" },
    { workspacePrefs: {} },
    { lifecycleStatus: "archived" as const },
  ])("locks an inconsistent mutation receipt %j", async (patch) => {
    await draft();
    api.updateWorkspace.mockResolvedValueOnce(
      record({ revision: 4, name: "Renamed", description: "New description", ...patch }),
    );
    await act(async () => action.save());
    expect(action.uncertain).toBe(true);
    expect(action.editDraft.value.name).toBe("Renamed");
    await remount();
    await act(async () => action.save());
    expect(api.updateWorkspace).toHaveBeenCalledTimes(1);
  });
  it("records late successful acknowledgements without callbacks into a different selection", async () => {
    await render({ mode: "create" });
    await draft("Fresh");
    const response = deferred<WorkspaceRecord>();
    api.createWorkspace.mockReturnValueOnce(response.promise);
    let pending!: Promise<boolean>;
    await act(async () => {
      pending = action.create();
    });
    await render({ citadelId: "company" });
    await act(async () => {
      response.resolve(record({ workspaceId: "new", name: "Fresh", slug: "fresh", description: "New description" }));
      await pending;
    });
    expect(onCreated).not.toHaveBeenCalled();
    await render({ citadelId: "personal" });
    expect(action.createDraft.value.name).toBe("");
    expect(action.notice).toContain("Fresh created");
  });
  it("never sends a hidden classic slug draft through native metadata editing", async () => {
    await render({ metadataOnly: false });
    await draft("Classic name");
    await act(async () => action.editDraft.setValue((value) => ({ ...value, slug: "classic-slug" })));
    await render({ metadataOnly: true });
    expect(action.editDraft.value.slug).toBe("research");
    await draft("Native name");
    await act(async () => action.save());
    expect(api.updateWorkspace.mock.calls[0]?.[1].slug).toBe("research");
    await render({ metadataOnly: false });
    expect(action.editDraft.value.slug).toBe("classic-slug");
  });
});
