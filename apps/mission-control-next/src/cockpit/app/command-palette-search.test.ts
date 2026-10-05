import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import {
  assertPaletteWorkspace,
  paletteGroup,
  searchCapabilities,
  searchInbox,
  searchLibrary,
  searchThreads,
} from "./command-palette-search";
import type { CapabilityCatalogView } from "../areas/library/capability-catalog";

const api = vi.hoisted(() => ({
  workspaces: vi.fn(),
  sessions: vi.fn(),
  resources: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({ fetchWorkspaces: api.workspaces }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessionSearch: api.sessions }));
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
const inbox = (overrides: Partial<OperatorInboxResponse>) =>
  ({ workspaceId: scope.workspaceId, items: [], counts: {}, coverage: [], ...overrides }) as OperatorInboxResponse;

beforeEach(() => {
  vi.clearAllMocks();
  api.workspaces.mockResolvedValue({ items: [{ ...scope, lifecycleStatus: "active" }] });
  api.sessions.mockResolvedValue({
    query: "needle",
    items: [session("exact")],
    mode: "discovery",
    generatedAt: "2026-09-30T00:00:00Z",
  });
  api.resources.mockResolvedValue({ items: [], coverage: "An explicitly bounded owner window." });
});

describe("palette Gateway object search", () => {
  it("verifies the Citadel/workspace with the caller's signal", async () => {
    const signal = new AbortController().signal;
    await assertPaletteWorkspace(scope, signal);
    expect(api.workspaces).toHaveBeenCalledWith("active", 500, "citadel-a", { signal });
    api.workspaces.mockResolvedValue({ items: [{ ...scope, citadelId: "other", lifecycleStatus: "active" }] });
    await expect(assertPaletteWorkspace(scope)).rejects.toThrow("could not be verified");
  });

  it("searches conversations in scope, passes the signal through and withholds foreign records", async () => {
    api.sessions.mockResolvedValue({
      query: "needle",
      items: [session("exact"), session("foreign", "workspace-b")],
      nextCursor: "more",
    });
    const signal = new AbortController().signal;
    const result = await searchThreads(scope, "needle", signal);
    expect(api.sessions).toHaveBeenCalledWith(
      {
        ...scope,
        query: "needle",
        mode: "discovery",
        surface: "chat",
        limit: 10,
        view: "all",
        includeHidden: false,
      },
      { signal },
    );
    expect(result.items).toEqual([
      expect.objectContaining({ id: "exact", target: { href: "/chat?shell=cockpit&sessionId=exact" } }),
    ]);
    expect(result.coverage).toContain("outside this workspace were withheld");
  });

  it("refuses a conversation response for another query", async () => {
    api.sessions.mockResolvedValue({ query: "different", items: [session("exact")] });
    await expect(searchThreads(scope, "needle")).rejects.toThrow("does not match");
  });

  it("reads a Library source with the signal and keeps an unavailable source distinct from an empty one", async () => {
    const signal = new AbortController().signal;
    await searchLibrary("files")(scope, "needle", signal);
    expect(api.resources).toHaveBeenCalledWith({ ...scope, kind: "files", query: "needle", status: "active", signal });
    const group = paletteGroup("notes", "Library notes", { error: new Error("Directory unavailable") });
    expect(group.items).toEqual([]);
    expect(group.coverage).toContain("unavailable, not empty");
    expect(group.error).toContain("Directory unavailable");
  });

  it("bounds results and keeps exact scoped Inbox links with incomplete-coverage truth", () => {
    const projection = inbox({
      items: Array.from({ length: 8 }, (_, i) => ({
        id: `approval:${i}`,
        kind: "approval",
        title: "Needle",
        summary: "Review",
        source: { workspaceId: scope.workspaceId },
      })) as OperatorInboxResponse["items"],
      counts: { needs_decision: { known: 8, complete: false } } as OperatorInboxResponse["counts"],
    });
    const group = paletteGroup("inbox", "Inbox", { result: searchInbox(projection, scope, "needle") });
    expect(group.items).toHaveLength(5);
    expect(group.items[0]?.target).toEqual({ href: "/inbox?shell=cockpit&workspaceId=workspace-a&item=approval%3A0" });
    expect(group.coverage).toContain("Coverage is incomplete");
  });

  it("describes a defined Inbox scope and refuses another workspace's Inbox", () => {
    const limited = inbox({
      counts: { needs_decision: { known: 0, complete: false } } as OperatorInboxResponse["counts"],
      coverage: [{ source: "runtime_health", state: "limited", detail: "Other checks remain in System." }],
    } as Partial<OperatorInboxResponse>);
    const result = searchInbox(limited, scope, "needle");
    expect(result.coverage).toContain("Inbox has a defined scope");
    expect(result.coverage).not.toContain("Coverage is incomplete");
    expect(() => searchInbox(inbox({ workspaceId: "other" }), scope, "needle")).toThrow("does not match");
  });

  it("filters the cached capability catalog without reading it", () => {
    const catalog = {
      items: [],
      issues: ["Current callability could not be checked."],
    } as unknown as CapabilityCatalogView;
    const result = searchCapabilities(catalog, "needle");
    expect(result.items).toEqual([]);
    expect(result.coverage).toContain("Current callability could not be checked.");
  });
});
