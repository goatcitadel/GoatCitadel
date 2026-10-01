import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchPaletteObjects } from "./command-palette-search";

const api = vi.hoisted(() => ({
  workspaces: vi.fn(),
  sessions: vi.fn(),
  inbox: vi.fn(),
  catalog: vi.fn(),
  resources: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: api.workspaces }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessionSearch: api.sessions }));
vi.mock("@goatcitadel/mission-control-shared/api/operator-inbox", () => ({ fetchOperatorInbox: api.inbox }));
vi.mock("../areas/library/capability-catalog", async (original) => ({
  ...(await original<typeof import("../areas/library/capability-catalog")>()),
  loadCapabilityCatalog: api.catalog,
}));
vi.mock("../areas/library/library-resources", async (original) => ({
  ...(await original<typeof import("../areas/library/library-resources")>()),
  loadLibraryResources: api.resources,
}));
const scope = { workspaceId: "workspace-a", citadelId: "citadel-a" };
const session = (id: string, workspaceId = scope.workspaceId) => ({
  session: {
    sessionId: id,
    workspaceId,
    scope: "mission",
    includeInHistory: true,
    title: "Needle conversation",
    lifecycleStatus: "active",
  },
  hits: [],
  matchedFields: [],
  score: 1,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.workspaces.mockResolvedValue({ items: [{ ...scope, lifecycleStatus: "active" }] });
  api.sessions.mockResolvedValue({
    query: "needle",
    items: [session("exact")],
    mode: "discovery",
    generatedAt: "2026-09-30T00:00:00Z",
  });
  api.inbox.mockResolvedValue({ workspaceId: scope.workspaceId, items: [], counts: {}, coverage: [] });
  api.catalog.mockResolvedValue({ items: [], issues: [], callableKnown: true, skillsKnown: true, skillsById: {} });
  api.resources.mockResolvedValue({ items: [], coverage: "An explicitly bounded owner window." });
});

describe("palette Gateway object search", () => {
  it("binds search to the verified Citadel/workspace and withholds foreign conversation records", async () => {
    api.sessions.mockResolvedValue({
      query: "needle",
      items: [session("exact"), session("foreign", "workspace-b")],
      nextCursor: "more",
    });
    const groups = await searchPaletteObjects(scope, "needle");
    expect(api.workspaces).toHaveBeenCalledWith("active", 500, "citadel-a", { signal: expect.any(AbortSignal) });
    expect(api.sessions).toHaveBeenCalledWith({
      ...scope,
      query: "needle",
      mode: "discovery",
      surface: "chat",
      limit: 10,
      view: "all",
      includeHidden: false,
    });
    expect(groups[0]?.items).toEqual([
      expect.objectContaining({ id: "exact", target: { href: "/chat?shell=cockpit&sessionId=exact" } }),
    ]);
    expect(groups[0]?.coverage).toContain("outside this workspace were withheld");
    expect(api.resources).toHaveBeenCalledWith({ ...scope, kind: "files", query: "needle", status: "active" });
  });

  it("does not query objects when the current workspace belongs to another Citadel", async () => {
    api.workspaces.mockResolvedValue({ items: [{ ...scope, citadelId: "other", lifecycleStatus: "active" }] });
    await expect(searchPaletteObjects(scope, "needle")).rejects.toThrow("could not be verified");
    expect(api.sessions).not.toHaveBeenCalled();
    expect(api.resources).not.toHaveBeenCalled();
  });

  it("keeps unavailable and scope-mismatched sources distinct from empty sources", async () => {
    api.sessions.mockResolvedValue({ query: "different", items: [session("exact")] });
    api.inbox.mockResolvedValue({ workspaceId: "other", items: [], counts: {} });
    api.resources.mockRejectedValue(new Error("Directory unavailable"));
    const groups = await searchPaletteObjects(scope, "needle");
    expect(groups.find((group) => group.id === "threads")?.error).toContain("does not match");
    expect(groups.find((group) => group.id === "inbox")?.items).toEqual([]);
    expect(groups.find((group) => group.id === "notes")?.coverage).toContain("unavailable, not empty");
    expect(groups.find((group) => group.id === "capabilities")?.error).toBeUndefined();
  });

  it("bounds results and keeps exact scoped Inbox links with incomplete-coverage truth", async () => {
    api.inbox.mockResolvedValue({
      workspaceId: scope.workspaceId,
      items: Array.from({ length: 8 }, (_, i) => ({
        id: `approval:${i}`,
        kind: "approval",
        title: "Needle",
        summary: "Review",
        source: { workspaceId: scope.workspaceId },
      })),
      counts: { needs_decision: { known: 8, complete: false } },
      coverage: [],
    });
    const inbox = (await searchPaletteObjects(scope, "needle")).find((group) => group.id === "inbox");
    expect(inbox?.items).toHaveLength(5);
    expect(inbox?.items[0]?.target).toEqual({ href: "/inbox?shell=cockpit&workspaceId=workspace-a&item=approval%3A0" });
    expect(inbox?.coverage).toContain("Coverage is incomplete");
  });

  it("describes a defined Inbox scope without presenting it as a failed read", async () => {
    api.inbox.mockResolvedValue({
      workspaceId: scope.workspaceId,
      items: [],
      counts: { needs_decision: { known: 0, complete: false } },
      coverage: [{ source: "runtime_health", state: "limited", detail: "Other checks remain in System." }],
    });
    const inbox = (await searchPaletteObjects(scope, "needle")).find((group) => group.id === "inbox");
    expect(inbox?.coverage).toContain("Inbox has a defined scope");
    expect(inbox?.coverage).not.toContain("Coverage is incomplete");
  });
});
