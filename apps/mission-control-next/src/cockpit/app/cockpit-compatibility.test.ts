import { catalogHref } from "../areas/library/capability-catalog-route";
import { describe, expect, it } from "vitest";
import { RAIL_ITEMS } from "../../app/route-model";
import {
  isChannelPageLocation,
  isCockpitConversationLocation,
  resolveCockpitCompatibility,
} from "./cockpit-compatibility";

describe("Cockpit compatibility coverage", () => {
  it.each([
    [
      "/projects/p%2Fone?workspaceId=w&citadelId=c&extra=keep#context",
      "/chat/projects/p%2Fone?workspaceId=w&citadelId=c&extra=keep#context",
    ],
    ["/projects?projectId=p%2Fone&workspaceId=w", "/chat/projects/p%2Fone?projectId=p%2Fone&workspaceId=w"],
    ["/chat/projects", "/chat/projects"],
    ["/chat/projects/p%2Fone?workspaceId=w#context", "/chat/projects/p%2Fone?workspaceId=w#context"],
  ])("resolves native Projects preserving exact identity: %s", (input, href) => {
    expect(resolveCockpitCompatibility(input)).toEqual({ kind: "native", href });
  });
  it("opens /chat/messaging/<connectionId> as a channel page, not a conversation", () => {
    expect(resolveCockpitCompatibility("/chat/messaging/conn%2F1?workspaceId=w&extra=keep#top")).toEqual({
      kind: "native",
      href: "/chat/messaging/conn%2F1?workspaceId=w&extra=keep#top",
    });
    // A channel page is not a conversation, so retained Chat never publishes a selection over it by itself.
    expect(isCockpitConversationLocation("/chat/messaging/conn-1")).toBe(false);
    expect(isCockpitConversationLocation("/chat")).toBe(true);
    expect(isChannelPageLocation("/chat/messaging/conn-1?workspaceId=w")).toBe(true);
    expect(isChannelPageLocation("/chat")).toBe(false);
    expect(isChannelPageLocation("/chat/projects/p-1")).toBe(false);
  });
  it.each([
    "/chat/messaging/add",
    "/chat/messaging/add/telegram",
    "/chat/messaging/0b9f2c1e-3d4a-4e5f-8a6b-7c8d9e0f1a2b/key",
    "/chat/messaging/add?workspaceId=w&extra=keep#top",
  ])("opens the add-channel and key-change views natively: %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "native", href });
  });
  it("treats every Messaging view as a page that is not a conversation", () => {
    for (const href of [
      "/chat/messaging/conn-1",
      "/chat/messaging/add",
      "/chat/messaging/add/telegram?workspaceId=w",
      "/chat/messaging/conn-1/key",
      "/chat/messaging/advanced?channel=channel.matrix",
    ]) {
      expect(isChannelPageLocation(href), href).toBe(true);
      expect(isCockpitConversationLocation(href), href).toBe(false);
    }
    expect(isChannelPageLocation("/chat/messaging/a/b")).toBe(false);
    expect(isChannelPageLocation("/chat/messaging/add/Tele%20gram")).toBe(false);
  });
  it.each([
    "/chat/messaging/add/Tele%20gram",
    "/chat/messaging/add/telegram/x",
    "/chat/messaging/conn-1/key/x",
    "/chat/messaging/conn-1/other",
  ])("keeps %s unavailable", (input) => {
    expect(resolveCockpitCompatibility(input)).toEqual({ kind: "missing" });
  });
  it.each([
    "/chat/messaging",
    "/chat/messaging/",
    "/chat/messaging/a/b",
    "/chat/messaging/%E0%A4%A",
    "/chat/messaging/%20",
    "/chat/messaging/a%0Ab",
    "/messaging/conn-1",
  ])("keeps %s unavailable: a channel page needs exactly one readable connection id", (input) => {
    expect(resolveCockpitCompatibility(input)).toEqual({ kind: "missing" });
  });
  it.each([
    "/capabilities",
    "/capabilities/skills",
    "/capabilities/skills?item=skill%3Areview&workspaceId=w#top",
    "/capabilities/connectors",
    "/capabilities/connectors?workspaceId=w#top",
    "/capabilities/tools",
    "/capabilities/tools?workspaceId=w&item=group%3Afiles#top",
  ])("opens the Capabilities area natively: %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "native", href });
  });
  it.each([
    "/capabilities/skills/extra",
    "/capabilities/connectors/extra",
    "/capabilities/tools/extra",
    "/capabilities/plugins",
    "/capabilities/unknown",
  ])("reports %s missing until its tab exists", (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "missing" });
  });
  it.each([
    "/capabilities/skills?shell=classic",
    "/capabilities/connectors?shell=classic",
    "/capabilities/tools?shell=classic",
  ])("offers Classic for an explicit rollback of the Capabilities area: %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "classic" });
  });
  it("retains explicit Classic Projects rollback", () => {
    expect(resolveCockpitCompatibility("/projects/p?shell=classic&workspaceId=w#context")).toMatchObject({
      kind: "classic",
      href: "/projects/p?shell=classic&workspaceId=w#context",
    });
  });
  it("opens the complete llama.cpp setup composition for its legacy subview", () => {
    expect(resolveCockpitCompatibility("/settings/onboarding?view=llamacpp&workspaceId=w&extra=keep")).toEqual({
      kind: "native",
      href: "/settings/models?view=llamacpp&workspaceId=w&extra=keep#local-ai",
    });
  });
  it("keeps canonical saved-board detail native with record identity and query state", () => {
    expect(resolveCockpitCompatibility("/system/dashboards/board%2F1?workspaceId=w#preview")).toEqual({
      kind: "native",
      href: "/system/dashboards/board%2F1?workspaceId=w#preview",
    });
  });
  it.each([
    "/inbox",
    "/",
    "/chat?runId=keep",
    "/work/runs/a%2Fb",
    "/system/activity",
    "/library/knowledge",
    "/library/agents?view=catalog",
    "/library/communications?workspaceId=w#compose",
    "/system/browser-sessions?sessionId=s%2F1",
    "/library/curator?skillId=skill-a",
    "/library/journey?category=memory&eventId=e-1",
    "/library/prompt-packs",
    "/library/prompt-packs?view=pack%3Apack-1",
  ])("keeps native %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "native", href });
  });
  it.each([
    ["/ops/approvals?approvalId=a%2Fb", "/inbox?approvalId=a%2Fb"],
    ["/?tab=approvals&approvalId=a", "/inbox?approvalId=a"],
    ["/ops/activity", "/system/activity"],
    ["/ops/quality", "/system/quality"],
    ["/ops/diagnostics", "/system/diagnostics"],
    ["/ops/costs", "/system/spend/details"],
    ["/ops/sessions?view=browser-sessions&sessionId=s1#grants", "/system/browser-sessions?sessionId=s1#grants"],
    ["/ops/improvement?reportId=rep-1", "/system/improvement?reportId=rep-1"],
    // A run link opens the run in Work; runtime controls and worker-status inspection keep their native owners.
    ["/ops/runtime?runId=r", "/work/runs/r"],
    ["/ops/runtime?runId=r&workspaceId=w", "/work/runs/r?workspaceId=w"],
    ["/ops/workers?workspaceId=w", "/system/runtime/workers?workspaceId=w"],
    ["/ops/notifications?workspaceId=w#latest", "/inbox?workspaceId=w#latest"],
    // Legacy Cowork board and task inputs normalize to the Work board.
    ["/cowork/board", "/work"],
    ["/cowork/tasks?workspaceId=w", "/work?workspaceId=w"],
  ])("maps %s", (input, href) => {
    expect(resolveCockpitCompatibility(input)).toMatchObject({ kind: "native", href });
  });
  it.each([
    "/ops/runtime?shell=classic",
    "/ops/workers?shell=classic",
    "/ops/notifications?shell=classic",
    "/cowork/board?shell=classic",
  ])("still honors explicit Classic for %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "classic" });
  });
  it("preserves scope, arbitrary query, record IDs and fragment", () => {
    expect(
      resolveCockpitCompatibility("/ops/approvals?approvalId=a&workspaceId=w&citadelId=c&runId=r&extra=yes#review"),
    ).toMatchObject({ kind: "native", href: "/inbox?approvalId=a&workspaceId=w&citadelId=c&runId=r&extra=yes#review" });
  });
  it.each([
    "/library/knowledge?shell=classic",
    "/library/communications?shell=classic",
    "/ops/sessions?shell=classic",
    "/ops/sessions?view=browser-sessions&shell=classic",
  ])("offers Classic for %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "classic" });
  });
  it.each([
    "/?space=unknown&page=unknown",
    "/?tab=unknown",
    "/unknown",
    "/system/unknown",
    "/inbox/unknown",
    "/work/unknown",
    "/library/unknown",
    "/cowork/unknown",
    "/cowork/workspace",
    "/ops/unknown",
    "/settings/unknown",
  ])("reports missing %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toMatchObject({ kind: "missing" });
  });
  // #370: no rail destination hands off to Classic; only the explicit `?shell=classic` rollback does.
  it.each(
    Object.values(RAIL_ITEMS)
      .flat()
      // The Cowork workspace is a Classic-only rail alias for Chat; Cockpit has no such path (pinned missing above).
      .filter((item) => item.area !== "cowork" || item.section !== "workspace")
      .map((item) => `/${item.area}${item.section ? `/${item.section}` : ""}`),
  )("opens rail destination %s natively", (href) => {
    expect(resolveCockpitCompatibility(href).kind).toBe("native");
  });
  it("opens the retired Ops root on the System overview", () => {
    expect(resolveCockpitCompatibility("/ops?workspaceId=w")).toEqual({
      kind: "native",
      href: "/system?workspaceId=w",
    });
  });
  it("opens saved boards and schedules natively now that their capabilities are native, keeping query and fragment", () => {
    expect(resolveCockpitCompatibility("/ops/boards?workspaceId=w#top")).toEqual({
      kind: "native",
      href: "/system/dashboards?workspaceId=w#top",
    });
    expect(resolveCockpitCompatibility("/ops/schedules?jobId=job-1&workspaceId=w")).toEqual({
      kind: "native",
      href: "/work/schedules?jobId=job-1&workspaceId=w",
    });
  });
  it("opens the existing native task and run owner for Kanban", () => {
    expect(resolveCockpitCompatibility("/ops/kanban?taskId=t-1")).toEqual({
      kind: "native",
      href: "/work/kanban?taskId=t-1",
    });
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
    expect(resolveCockpitCompatibility(`/library/notes/${id}?workspaceId=w&view=history#versions`)).toEqual({
      kind: "native",
      href: `/library/notes?workspaceId=w&view=history&noteId=${id}#versions`,
    });
  });
});

it.each(["code_mode", "proposal", "candidate_skill", "mesh_tool", "mesh_mcp_server", "mesh_skill"] as const)(
  "opens a generated %s catalog record link without dropping selection or filters",
  (kind) => {
    const href =
      catalogHref(
        { search: "retained", kind: "all", status: "available", trust: "all" },
        { kind, capabilityId: "record /?" },
      ) + "#details";
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "native", href });
  },
);
describe("the retired Settings › Connections addresses", () => {
  it.each([
    // The page itself, with no hash or one it never had, opens Advanced setup on its first section.
    ["/settings/connections", "/capabilities/connectors/advanced"],
    ["/settings/connections#unknown", "/capabilities/connectors/advanced"],
    // Each section's anchor, and its section name, open that section's new home.
    ["/settings/connections#mcp-servers", "/capabilities/connectors/advanced#mcp-servers"],
    ["/settings/connections#mcp", "/capabilities/connectors/advanced#mcp-servers"],
    ["/settings/connections#integration-connections", "/capabilities/connectors/advanced#integration-connections"],
    ["/settings/connections#web-search", "/capabilities/connectors/advanced#web-search"],
    ["/settings/connections#channels", "/chat/messaging/advanced"],
    ["/settings/connections#addons", "/settings/advanced#addons"],
    // The section paths follow their sections; Capability packs is still a Settings section and stays put.
    ["/settings/mcp", "/capabilities/connectors/advanced#mcp-servers"],
    ["/settings/integrations", "/capabilities/connectors/advanced#integration-connections"],
    ["/settings/web-search", "/capabilities/connectors/advanced#web-search"],
    ["/settings/channels", "/chat/messaging/advanced"],
    ["/settings/addons", "/settings/addons"],
    // The new homes are native as they are.
    ["/capabilities/connectors/advanced#web-search", "/capabilities/connectors/advanced#web-search"],
    ["/chat/messaging/advanced", "/chat/messaging/advanced"],
  ])("opens %s at %s", (input, href) => {
    expect(resolveCockpitCompatibility(input)).toEqual({ kind: "native", href });
  });

  it("keeps a provider's sign-in return whole, on Advanced setup, which hands it back", () => {
    for (const fragment of [
      "mcp-oauth-return&state=s-1&code=abc%2F1",
      "mcp-oauth-return&state=s-2&error=access_denied",
      "google-oauth-return&state=s-3&code=4%2F0Ad",
    ]) {
      expect(resolveCockpitCompatibility(`/settings/connections?shell=cockpit#${fragment}`)).toEqual({
        kind: "native",
        href: `/capabilities/connectors/advanced?shell=cockpit#${fragment}`,
      });
    }
  });

  it("carries the channel to set up and the workspace to Advanced channel setup", () => {
    expect(
      resolveCockpitCompatibility("/settings/connections?channel=channel.matrix&workspaceId=w&shell=cockpit#channels"),
    ).toEqual({ kind: "native", href: "/chat/messaging/advanced?channel=channel.matrix&workspaceId=w&shell=cockpit" });
  });

  it("leaves an explicit Classic rollback on Classic's own page", () => {
    expect(resolveCockpitCompatibility("/settings/connections?shell=classic#mcp-servers").kind).toBe("classic");
  });

  it("does not widen to other Settings or Capabilities paths", () => {
    expect(resolveCockpitCompatibility("/settings/connections/mcp").kind).toBe("missing");
    expect(resolveCockpitCompatibility("/capabilities/connectors/advanced/mcp").kind).toBe("missing");
    expect(resolveCockpitCompatibility("/capabilities/tools/advanced").kind).toBe("missing");
    expect(resolveCockpitCompatibility("/chat/messaging/advanced/x").kind).toBe("missing");
  });
});

describe("the Library skills and tools addresses", () => {
  it.each([
    ["/library/skills", "/capabilities/skills"],
    ["/library/skills/", "/capabilities/skills"],
    ["/library/capabilities", "/capabilities/skills"],
    ["/library?type=skill", "/capabilities/skills"],
    ["/library/?type=skill", "/capabilities/skills"],
    ["/library?type=tool", "/capabilities/tools"],
  ])("sends %s to %s", (from, to) => {
    expect(resolveCockpitCompatibility(from)).toEqual({ kind: "native", href: to });
  });
  it.each([
    ["/library/skills", "/capabilities/skills"],
    ["/library/capabilities", "/capabilities/skills"],
    ["/library?type=skill", "/capabilities/skills"],
    ["/library?type=tool", "/capabilities/tools"],
  ])("sends %s to %s without the catalog filters or the fragment", (from, to) => {
    const separator = from.includes("?") ? "&" : "?";
    expect(
      resolveCockpitCompatibility(`${from}${separator}q=review&type=skill&status=available&trust=trusted#details`),
    ).toEqual({ kind: "native", href: to });
  });
  it.each([
    ["/library/skills", "/capabilities/skills"],
    ["/library/capabilities", "/capabilities/skills"],
    ["/library?type=skill", "/capabilities/skills"],
    ["/library?type=tool", "/capabilities/tools"],
  ])("keeps the workspace and the shell travelling from %s", (from, to) => {
    const separator = from.includes("?") ? "&" : "?";
    expect(resolveCockpitCompatibility(`${from}${separator}workspaceId=w&shell=cockpit`)).toEqual({
      kind: "native",
      href: `${to}?workspaceId=w&shell=cockpit`,
    });
    expect(
      resolveCockpitCompatibility(`${from}${separator}q=a&workspaceId=w&shellScope=keep&shell=cockpit#top`),
    ).toEqual({ kind: "native", href: `${to}?workspaceId=w&shellScope=keep&shell=cockpit` });
  });
  it.each(["/library/skills", "/library/capabilities", "/library?type=skill", "/library?type=tool"])(
    "keeps an explicit Classic rollback on the Library for %s",
    (from) => {
      const separator = from.includes("?") ? "&" : "?";
      expect(resolveCockpitCompatibility(`${from}${separator}shell=classic`)).toMatchObject({ kind: "classic" });
    },
  );
  it("leaves the Library and the kinds it still lists where they were", () => {
    for (const href of [
      "/library",
      "/library?workspaceId=w",
      "/library?type=proposal",
      "/library?type=candidate_skill&shell=cockpit",
      "/library?type=mesh_tool",
      "/library?type=code_mode",
    ]) {
      expect(resolveCockpitCompatibility(href), href).toEqual({ kind: "native", href });
    }
  });
  it("sends a Library skill record to its Capabilities panel", () => {
    const href = catalogHref(
      { search: "retained", kind: "skill", status: "available", trust: "all" },
      { kind: "skill", capabilityId: "skill:review" },
    );
    // The catalog filters stay behind; the shell stays. The record is the panel's item.
    expect(resolveCockpitCompatibility(`${href}#details`)).toEqual({
      kind: "native",
      href: "/capabilities/skills?shell=cockpit&item=skill%3Areview",
    });
    expect(resolveCockpitCompatibility("/library/skill/skill%3Acode-review?workspaceId=w")).toEqual({
      kind: "native",
      href: "/capabilities/skills?workspaceId=w&item=skill%3Acode-review",
    });
    // An id without the `skill:` prefix names the same skill.
    expect(resolveCockpitCompatibility("/library/skill/review")).toEqual({
      kind: "native",
      href: "/capabilities/skills?item=skill%3Areview",
    });
    expect(resolveCockpitCompatibility("/library/skill/skill%3Areview?shell=classic")).toMatchObject({
      kind: "classic",
    });
  });
  it("sends a Library tool record to its group, or to Tools when it has none", () => {
    // `fs.read` is a Files tool, `shell.exec` a Shell and code tool: the id is `tool:<name>`.
    expect(
      resolveCockpitCompatibility(
        catalogHref(
          { search: "x", kind: "tool", status: "all", trust: "all" },
          { kind: "tool", capabilityId: "tool:fs.read" },
        ) + "#details",
      ),
    ).toEqual({ kind: "native", href: "/capabilities/tools?shell=cockpit&item=group%3Afiles" });
    expect(resolveCockpitCompatibility("/library/tool/tool%3Ashell.exec?workspaceId=w")).toEqual({
      kind: "native",
      href: "/capabilities/tools?workspaceId=w&item=group%3Ashell_and_code",
    });
    // An id without the `tool:` prefix is a tool name too.
    expect(resolveCockpitCompatibility("/library/tool/fs.write?workspaceId=w")).toEqual({
      kind: "native",
      href: "/capabilities/tools?workspaceId=w&item=group%3Afiles",
    });
    expect(resolveCockpitCompatibility("/library/tool/tool%3Ano-such-tool-anywhere?workspaceId=w#x")).toEqual({
      kind: "native",
      href: "/capabilities/tools?workspaceId=w",
    });
    expect(resolveCockpitCompatibility("/library/tool/tool%3Aread?shell=classic")).toMatchObject({
      kind: "classic",
    });
  });
});
describe("the Library tools address", () => {
  it("sends /library/tools to /capabilities/tools", () => {
    expect(resolveCockpitCompatibility("/library/tools")).toEqual({ kind: "native", href: "/capabilities/tools" });
    expect(resolveCockpitCompatibility("/library/tools/")).toEqual({ kind: "native", href: "/capabilities/tools" });
  });
  it("leaves the catalog filters and the fragment behind", () => {
    expect(resolveCockpitCompatibility("/library/tools?q=fs&type=tool&status=available&trust=trusted#details")).toEqual(
      { kind: "native", href: "/capabilities/tools" },
    );
  });
  it("keeps the workspace and the shell with it", () => {
    expect(resolveCockpitCompatibility("/library/tools?workspaceId=w&shell=cockpit")).toEqual({
      kind: "native",
      href: "/capabilities/tools?workspaceId=w&shell=cockpit",
    });
    expect(resolveCockpitCompatibility("/library/tools?q=fs&workspaceId=w&shellScope=keep&shell=cockpit#top")).toEqual({
      kind: "native",
      href: "/capabilities/tools?workspaceId=w&shellScope=keep&shell=cockpit",
    });
  });
  it("keeps an explicit Classic rollback on the Library", () => {
    expect(resolveCockpitCompatibility("/library/tools?shell=classic")).toEqual({
      kind: "classic",
      href: "/library/tools?shell=classic",
      label: "Open the classic view",
    });
  });
  it("does not widen to other Library tools paths", () => {
    expect(resolveCockpitCompatibility("/library/tools/extra")).toEqual({ kind: "missing" });
  });
  it("sends the one-tool record links to the tool's group", () => {
    const href = catalogHref(
      { search: "", kind: "all", status: "all", trust: "all" },
      { kind: "tool", capabilityId: "fs.write" },
    );
    expect(resolveCockpitCompatibility(href)).toEqual({
      kind: "native",
      href: "/capabilities/tools?shell=cockpit&item=group%3Afiles",
    });
  });
});
it.each([
  "/library/unknown/record",
  "/library/tool/%invalid",
  "/library/tool/record/extra",
  "/library/skill/%invalid",
  "/library/skill/skill%3Areview/extra",
  "/library/skills/extra",
])("rejects unsupported catalog selection %s", (href) => {
  expect(resolveCockpitCompatibility(href)).toEqual({ kind: "missing" });
});

it.each(["history", "all", "recovery", "approved", "rejected", "edited"])(
  "keeps %s approval audit bookmarks native with exact record/scope/query/fragment",
  (view) => {
    const query = "?view=" + view + "&approvalId=a%2Fb&workspaceId=w&runId=r%2F1&sessionId=s%3A2&keep=yes#receipt";
    expect(resolveCockpitCompatibility("/ops/approvals" + query)).toEqual({ kind: "native", href: "/inbox" + query });
    expect(resolveCockpitCompatibility("/inbox" + query)).toEqual({ kind: "native", href: "/inbox" + query });
    expect(
      resolveCockpitCompatibility("/ops/approvals" + query.replace("#receipt", "&shell=classic#receipt")),
    ).toMatchObject({ kind: "classic" });
  },
);
it.each(["/inbox?view=unknown", "/ops/approvals?view=unknown", "/inbox?view=history&historyView=unknown"])(
  "rejects unsupported approval audit view %s",
  (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "missing" });
  },
);

it.each([
  ["/ops/sessions", "/system/sessions"],
  [
    "/ops/sessions?sessionId=s%3A1&workspaceId=w&citadelId=c&extra=keep#control",
    "/system/sessions?sessionId=s%3A1&workspaceId=w&citadelId=c&extra=keep#control",
  ],
  [
    "/ops/sessions?view=run-detail&runId=r%2F1&sessionId=s&workspaceId=w#receipt",
    "/system/sessions?view=run-detail&runId=r%2F1&sessionId=s&workspaceId=w#receipt",
  ],
  [
    "/?space=observe&page=sessions&workspaceId=w&sessionId=s#evidence",
    "/system/sessions?workspaceId=w&sessionId=s#evidence",
  ],
  ["/?tab=sessions&sessionId=s&keep=1#evidence", "/system/sessions?sessionId=s&keep=1#evidence"],
  [
    "/ops/kanban?taskId=t%2F1&workspaceId=w&citadelId=c&extra=keep#details",
    "/work/kanban?taskId=t%2F1&workspaceId=w&citadelId=c&extra=keep#details",
  ],
  [
    "/ops/kanban?runId=r%2F1&taskId=t&view=run-detail&workspaceId=w#receipt",
    "/work/kanban?runId=r%2F1&taskId=t&view=run-detail&workspaceId=w#receipt",
  ],
  ["/system/sessions?sessionId=s&workspaceId=w#control", "/system/sessions?sessionId=s&workspaceId=w#control"],
])("uses the current native session or task owner without losing bookmark context: %s", (input, href) => {
  expect(resolveCockpitCompatibility(input)).toEqual({ kind: "native", href });
});
it.each([
  "/ops/sessions?shell=classic&sessionId=s",
  "/ops/kanban?shell=classic&taskId=t#details",
  "/ops/runtime?shell=classic#backups",
])("preserves the explicit owner rollback: %s", (href) => {
  expect(resolveCockpitCompatibility(href)).toEqual({ kind: "classic", href, label: "Open the classic view" });
});
it.each(["/system/sessions/extra", "/ops/kanban/unknown", "/ops/sessions/unknown"])(
  "does not claim an unsupported evidence destination: %s",
  (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "missing" });
  },
);

describe("Exact native approval record compatibility", () => {
  it("normalizes the encoded record path once while preserving independent context", () => {
    const id = "approval /?# exact";
    const input =
      "/inbox/approvals/" +
      encodeURIComponent(id) +
      "?workspaceId=w&runId=r%2F1&sessionId=s%3A1&extra=one&extra=two&view=history#review";
    const result = resolveCockpitCompatibility(input);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Expected exact native approval");
    const target = new URL(result.href, "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.getAll("approvalId")).toEqual([id]);
    expect(target.searchParams.get("workspaceId")).toBe("w");
    expect(target.searchParams.get("runId")).toBe("r/1");
    expect(target.searchParams.get("sessionId")).toBe("s:1");
    expect(target.searchParams.getAll("extra")).toEqual(["one", "two"]);
    expect(target.searchParams.get("view")).toBe("history");
    expect(target.hash).toBe("#review");
    expect(resolveCockpitCompatibility(result.href)).toEqual(result);
  });
  it.each([
    "/inbox/approvals/..",
    "/inbox/approvals/%2e%2e",
    "/inbox/approvals/.%2e",
    "/inbox/approvals/%2e.",
    "/inbox/approvals/.",
    "/inbox/approvals/%2e",
    "/inbox/approvals/a/../..",
    "/inbox/approvals/%",
    "/inbox/approvals/%ZZ",
    "/inbox/approvals/%C0%AF",
    "/inbox/approvals/%00",
    "/inbox/approvals/%0A",
    "/inbox/approvals/%20",
    "/inbox/approvals/",
    "/inbox//approvals/a",
    "/inbox/approvals/a/extra",
    "/inbox/approvals/a?approvalId=b",
    "/inbox/approvals/a?approvalId=a&approvalId=b",
    "/inbox?approvalId=a&approvalId=b",
    "/ops/approvals?approvalId=a&approvalId=b",
    "/inbox?approvalId=",
    "/inbox?approvalId=%00",
    "/inbox?approvalId=%20a",
    "/inbox/approvals/a?view=unknown",
    "/inbox/approvals/a?view=history&historyView=unknown",
  ])("rejects malformed or conflicting selected records: %s", (href) => {
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "missing" });
  });
  it.each([
    "/inbox?approvalId=a&approvalId=a",
    "/ops/approvals?approvalId=a&approvalId=a",
    "/inbox/approvals/a?approvalId=a&approvalId=a",
  ])("accepts repeated identical record identity: %s", (href) => {
    const result = resolveCockpitCompatibility(href);
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Expected native approval");
    expect(
      new URL(result.href, "http://cockpit.invalid").searchParams.getAll("approvalId").every((id) => id === "a"),
    ).toBe(true);
  });
  it.each([".", "..", "%2e%2e"])("keeps opaque query approval identity %s unchanged", (id) => {
    const href = "/inbox?approvalId=" + id + "&workspaceId=w#review";
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "native", href });
  });
  it("keeps explicit Classic ahead of malformed native dot-path rejection", () => {
    expect(resolveCockpitCompatibility("/inbox/approvals/%2e%2e?shell=classic&workspaceId=w")).toMatchObject({
      kind: "classic",
    });
  });
  it("keeps an explicit Classic record path before native normalization", () => {
    const href = "/inbox/approvals/a%2Fb?approvalId=other&workspaceId=w&shell=classic#review";
    expect(resolveCockpitCompatibility(href)).toEqual({ kind: "classic", href, label: "Open the classic view" });
  });
});

it.each([
  [
    "/ops/runtime?workspaceId=w&citadelId=c&sessionId=s&runId=r&keep=yes#ops-runtime-backups",
    "/system/runtime?workspaceId=w&citadelId=c&sessionId=s&runId=r&keep=yes#ops-runtime-backups",
  ],
  [
    "/ops/diagnostics?workspaceId=w&sessionId=s&keep=yes#release",
    "/system/diagnostics?workspaceId=w&sessionId=s&keep=yes#release",
  ],
  ["/system/runtime?workspaceId=w#ops-runtime-posture", "/system/runtime?workspaceId=w#ops-runtime-posture"],
  [
    "/system/runtime/diagnostics?workspaceId=w&keep=yes#release",
    "/system/runtime/diagnostics?workspaceId=w&keep=yes#release",
  ],
])("opens the actual full native runtime owner without losing record context: %s", (input, href) => {
  expect(resolveCockpitCompatibility(input)).toEqual({ kind: "native", href });
});
it.each(["/system/runtime/unknown", "/system/runtime/diagnostics/extra"])(
  "withholds an unsupported runtime destination: %s",
  (input) => {
    expect(resolveCockpitCompatibility(input)).toEqual({ kind: "missing" });
  },
);

it.each([
  "/system/spend/details?workspaceId=w&citadelId=c&runId=r%2F1&sessionId=s%2F1&keep=yes#cost-coverage",
  "/ops/costs?workspaceId=w&citadelId=c&runId=r%2F1&sessionId=s%2F1&keep=yes#cost-coverage",
])("opens the full native Costs owner preserving exact context: %s", (input) => {
  const target = new URL(input, "http://cockpit.invalid");
  expect(resolveCockpitCompatibility(input)).toEqual({
    kind: "native",
    href: "/system/spend/details" + target.search + target.hash,
  });
});
it("keeps unknown Costs suffixes unavailable and explicit Classic Costs rollback intact", () => {
  expect(resolveCockpitCompatibility("/system/spend/unknown")).toEqual({ kind: "missing" });
  expect(resolveCockpitCompatibility("/system/spend/details/unknown")).toEqual({ kind: "missing" });
  expect(resolveCockpitCompatibility("/ops/costs?shell=classic&workspaceId=w&keep=yes#cost-coverage")).toMatchObject({
    kind: "classic",
    href: "/ops/costs?shell=classic&workspaceId=w&keep=yes#cost-coverage",
  });
});

it.each(["/ops/workers", "/system/runtime/workers"])(
  "preserves exact native worker record and query/hash through %s",
  (pathname) => {
    const result = resolveCockpitCompatibility(
      pathname +
        "?workerId=worker%2Fone&assignmentId=assignment%3Aone&workspaceId=workspace-a&citadelId=citadel-a&sessionId=session-a&runId=run-a&keep=one&keep=two#record",
    );
    expect(result.kind).toBe("native");
    if (result.kind !== "native") throw new Error("Native worker owner unavailable");
    const target = new URL(result.href, "http://cockpit.invalid");
    expect(target.pathname).toBe("/system/runtime/workers");
    expect(target.searchParams.get("workerId")).toBe("worker/one");
    expect(target.searchParams.get("assignmentId")).toBe("assignment:one");
    expect(target.searchParams.get("workspaceId")).toBe("workspace-a");
    expect(target.searchParams.get("citadelId")).toBe("citadel-a");
    expect(target.searchParams.get("sessionId")).toBe("session-a");
    expect(target.searchParams.get("runId")).toBe("run-a");
    expect(target.searchParams.getAll("keep")).toEqual(["one", "two"]);
    expect(target.hash).toBe("#record");
  },
);

it("consumes only the explicit fixed Costs overview rollback marker while retaining all other context", () => {
  expect(
    resolveCockpitCompatibility("/ops/costs?cockpitReturnView=spend-overview&workspaceId=w&keep=one&keep=two#coverage"),
  ).toEqual({ kind: "native", href: "/system/spend?workspaceId=w&keep=one&keep=two#coverage" });
  expect(
    resolveCockpitCompatibility("/ops/costs?cockpitReturnView=spend-overview&shell=classic#coverage"),
  ).toMatchObject({ kind: "classic", href: "/ops/costs?cockpitReturnView=spend-overview&shell=classic#coverage" });
});

it.each([
  "https%3A%2F%2Felsewhere.invalid",
  "/system/health",
  "spend-overview&cockpitReturnView=details",
  "spend-overview&cockpitReturnView=spend-overview",
  "",
])("does not interpret an unsupported or ambiguous overview return as a destination: %s", (value) => {
  const input = "/ops/costs?cockpitReturnView=" + value + "&keep=yes#coverage";
  expect(resolveCockpitCompatibility(input)).toEqual({
    kind: "native",
    href: "/system/spend/details" + new URL(input, "http://localhost").search + "#coverage",
  });
});

it("does not interpret an overview return marker on another Classic owner", () => {
  expect(resolveCockpitCompatibility("/ops/runtime?cockpitReturnView=spend-overview&keep=yes#runtime")).toEqual({
    kind: "native",
    href: "/system/runtime?cockpitReturnView=spend-overview&keep=yes#runtime",
  });
});
