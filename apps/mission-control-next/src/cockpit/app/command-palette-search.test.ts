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
    const group = paletteGroup("notes", "Notes", { error: new Error("Directory unavailable") });
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
    expect(group.items[0]?.description).toBe("Approval · Open to see its current state");
  });

  it("describes a defined Inbox scope and refuses another workspace's Inbox", () => {
    const limited = inbox({
      counts: { needs_decision: { known: 0, complete: false } } as OperatorInboxResponse["counts"],
      coverage: [{ source: "runtime_health", state: "limited", detail: "Other checks remain in System." }],
    } as Partial<OperatorInboxResponse>);
    const result = searchInbox(limited, scope, "needle");
    expect(result.coverage).toContain("The Inbox covers a set range; find other work in its own area.");
    expect(result.coverage).not.toContain("Coverage is incomplete");
    expect(() => searchInbox(inbox({ workspaceId: "other" }), scope, "needle")).toThrow(
      "This Inbox belongs to a different workspace.",
    );
    for (const text of [result.coverage, ...result.items.map((item) => item.description)])
      expect(text).not.toMatch(/owner|projection/u);
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

  it("names the capability kind in plain words, never the wire token", () => {
    const catalog = {
      items: [
        { kind: "mesh_mcp_server", capabilityId: "c1", title: "Needle server", summary: "" },
        { kind: "tool", capabilityId: "c2", title: "Needle tool", summary: "" },
      ],
      issues: [],
    } as unknown as CapabilityCatalogView;
    const descriptions = searchCapabilities(catalog, "needle").items.map((item) => item.description);
    expect(descriptions[0]).toMatch(/^Mesh MCP server · /);
    expect(descriptions[1]).toMatch(/^Tool · /);
    expect(descriptions.join(" ")).not.toContain("mesh_mcp_server");
  });

  it("opens a skill result in Capabilities and says where it is", () => {
    const catalog = {
      items: [
        { kind: "skill", capabilityId: "skill:review", skillId: "review", title: "Needle review", summary: "" },
        // A record that carries no skill id still names its skill in its capability id.
        { kind: "skill", capabilityId: "skill:triage", title: "Needle triage", summary: "" },
      ],
      issues: [],
    } as unknown as CapabilityCatalogView;
    const items = searchCapabilities(catalog, "needle").items;
    expect(items.map((item) => item.target)).toEqual([
      { href: "/capabilities/skills?item=skill%3Areview" },
      { href: "/capabilities/skills?item=skill%3Atriage" },
    ]);
    expect(items.map((item) => item.description)).toEqual([
      "Skill · Capabilities › Skills",
      "Skill · Capabilities › Skills",
    ]);
  });

  it("opens a tool result at its group, or at Tools when it is in no group", () => {
    const catalog = {
      items: [
        { kind: "tool", capabilityId: "tool:fs.read", toolName: "fs.read", title: "Needle read", summary: "" },
        { kind: "tool", capabilityId: "tool:shell.exec", title: "Needle shell", summary: "" },
        { kind: "tool", capabilityId: "tool:linear.find", toolName: "linear.find", title: "Needle find", summary: "" },
      ],
      issues: [],
    } as unknown as CapabilityCatalogView;
    const items = searchCapabilities(catalog, "needle").items;
    expect(items.map((item) => item.target)).toEqual([
      { href: "/capabilities/tools?item=group%3Afiles" },
      { href: "/capabilities/tools?item=group%3Ashell_and_code" },
      { href: "/capabilities/tools" },
    ]);
    for (const item of items) expect(item.description).toBe("Tool · Capabilities › Tools");
  });

  it("keeps the other kinds' Library links and descriptions", () => {
    const catalog = {
      items: [{ kind: "candidate_skill", capabilityId: "cand-1", title: "Needle candidate", summary: "" }],
      issues: [],
    } as unknown as CapabilityCatalogView;
    const [item] = searchCapabilities(catalog, "needle").items;
    expect(item?.target).toEqual({
      href: "/library/candidate_skill/cand-1?shell=cockpit&q=needle",
    });
    expect(item?.description).toBe("Candidate skill · Installation catalog; availability is reviewed in Library");
  });
});
