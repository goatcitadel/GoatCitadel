import { catalogHref } from "../areas/library/capability-catalog-route";
import { describe, expect, it } from "vitest";
import { resolveCockpitCompatibility } from "./cockpit-compatibility";

describe("Cockpit compatibility coverage", () => {
  it.each([
    ["/projects/p%2Fone?workspaceId=w&citadelId=c&extra=keep#context", "/chat/projects/p%2Fone?workspaceId=w&citadelId=c&extra=keep#context"],
    ["/projects?projectId=p%2Fone&workspaceId=w", "/chat/projects/p%2Fone?projectId=p%2Fone&workspaceId=w"],
    ["/chat/projects", "/chat/projects"],
    ["/chat/projects/p%2Fone?workspaceId=w#context", "/chat/projects/p%2Fone?workspaceId=w#context"],
  ])("resolves native Projects preserving exact identity: %s", (input, href) => {
    expect(resolveCockpitCompatibility(input)).toEqual({ kind: "native", href });
  });
  it("retains explicit Classic Projects rollback", () => {
    expect(resolveCockpitCompatibility("/projects/p?shell=classic&workspaceId=w#context")).toMatchObject({ kind: "classic", href: "/projects/p?shell=classic&workspaceId=w#context" });
  });
  it("opens the complete llama.cpp setup composition for its legacy subview", () => {
    expect(resolveCockpitCompatibility("/settings/onboarding?view=llamacpp&workspaceId=w&extra=keep")).toEqual({ kind: "native", href: "/settings/models?view=llamacpp&workspaceId=w&extra=keep#local-ai" });
  });
  it("keeps canonical saved-board detail native with record identity and query state", () => {
    expect(resolveCockpitCompatibility("/system/dashboards/board%2F1?workspaceId=w#preview")).toEqual({ kind: "native", href: "/system/dashboards/board%2F1?workspaceId=w#preview" });
  });
  it.each(["/inbox", "/", "/chat?runId=keep", "/work/runs/a%2Fb", "/system/activity", "/library/knowledge", "/library/agents?view=catalog", "/library/communications?workspaceId=w#compose", "/system/browser-sessions?sessionId=s%2F1", "/library/curator?skillId=skill-a", "/library/journey?category=memory&eventId=e-1", "/library/prompt-packs", "/library/prompt-packs?view=pack%3Apack-1"])("keeps native %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "native", href });
  });
  it.each([
    ["/ops/approvals?approvalId=a%2Fb", "/inbox?approvalId=a%2Fb"],
    ["/?tab=approvals&approvalId=a", "/inbox?approvalId=a"],
    ["/ops/activity", "/system/activity"],
    ["/ops/quality", "/system/quality"],
    ["/ops/diagnostics", "/system/diagnostics"],
    ["/ops/costs", "/system/spend"],
    ["/ops/sessions?view=browser-sessions&sessionId=s1#grants", "/system/browser-sessions?sessionId=s1#grants"],
    ["/ops/improvement?reportId=rep-1", "/system/improvement?reportId=rep-1"],
  ])("maps %s", (input, href) => {
    expect(resolveCockpitCompatibility(input)).toMatchObject({ kind: "native", href });
  });
  it("preserves scope, arbitrary query, record IDs and fragment", () => {
    expect(
      resolveCockpitCompatibility("/ops/approvals?approvalId=a&workspaceId=w&citadelId=c&runId=r&extra=yes#review"),
    ).toMatchObject({ kind: "native", href: "/inbox?approvalId=a&workspaceId=w&citadelId=c&runId=r&extra=yes#review" });
  });
  it.each(["/inbox?view=history", "/ops/runtime", "/library/knowledge?shell=classic", "/library/communications?shell=classic", "/ops/approvals?view=history", "/ops/sessions", "/ops/sessions?view=browser-sessions&shell=classic"])(
    "offers Classic for %s",
    (href) => {
      expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "classic" });
    },
  );
  it.each([
    "/?space=unknown&page=unknown",
    "/?tab=unknown",
    "/unknown",
    "/system/unknown",
    "/inbox/unknown",
    "/work/unknown",
    "/library/unknown",
  ])("reports missing %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "missing" });
  });
  it("opens saved boards and schedules natively now that their capabilities are native, keeping query and fragment", () => {
    expect(resolveCockpitCompatibility("/ops/boards?workspaceId=w#top")).toEqual({ kind: "native", href: "/system/dashboards?workspaceId=w#top" });
    expect(resolveCockpitCompatibility("/ops/schedules?jobId=job-1&workspaceId=w")).toEqual({ kind: "native", href: "/work/schedules?jobId=job-1&workspaceId=w" });
  });
  it("keeps Kanban with Classic while its agentic run evidence has no native owner", () => {
    expect(resolveCockpitCompatibility("/ops/kanban?taskId=t-1")).toMatchObject({ kind: "classic" });
  });
  it("still honors explicit Classic for the newly native views", () => {
    expect(resolveCockpitCompatibility("/ops/boards?shell=classic")).toMatchObject({ kind: "classic" });
    expect(resolveCockpitCompatibility("/ops/schedules?shell=classic")).toMatchObject({ kind: "classic" });
  });
  it("honors explicit Classic", () => {
    expect(resolveCockpitCompatibility("/ops/approvals?shell=classic&approvalId=a")).toMatchObject({ kind: "classic" });
  });
  it("normalizes a canonical note path without losing workspace, view or fragment", () => {
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(resolveCockpitCompatibility(`/library/notes/${id}?workspaceId=w&view=history#versions`)).toEqual({ kind: "native", href: `/library/notes?workspaceId=w&view=history&noteId=${id}#versions` });
  });
});

it.each([
  "tool",
  "skill",
  "code_mode",
  "proposal",
  "candidate_skill",
  "mesh_tool",
  "mesh_mcp_server",
  "mesh_skill",
] as const)("opens a generated %s catalog record link without dropping selection or filters", (kind) => {
  const href =
    catalogHref(
      { search: "retained", kind: "all", status: "available", trust: "all" },
      { kind, capabilityId: "record /?" },
    ) + "#details";
  expect(resolveCockpitCompatibility(href)).toEqual({ kind: "native", href });
});
it.each(["/library/skills", "/library/tools"])("keeps supported catalog alias %s native", (href) => {
  expect(resolveCockpitCompatibility(href)).toEqual({ kind: "native", href });
});
it.each(["/library/unknown/record", "/library/tool/%invalid", "/library/tool/record/extra"])(
  "rejects unsupported catalog selection %s",
  (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "missing" });
  },
);
