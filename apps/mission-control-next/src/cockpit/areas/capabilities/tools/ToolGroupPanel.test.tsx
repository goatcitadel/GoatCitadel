// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TOOL_GROUPS,
  type CapabilityToolBlock,
  type CapabilityToolGroupItem,
  type CapabilityToolItem,
  type CapabilityToolsResponse,
  type CapabilityToolUsageResponse,
  type ToolGroupId,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider, useInspector } from "../../../app/inspector";
import { toolListQuery, toolUsageQuery } from "../../../data/capability-tools-query";
import { connectorIdFromSource, connectorPanelSource } from "../connectors/connector-links";
import { ToolGroupPanel } from "./ToolGroupPanel";
import { ToolsTab } from "./ToolsTab";
import { TOOL_GROUP_NOTES } from "./tool-group-notes";
import { setToolGroupSwitch } from "./tool-group-switch-store";
import { TOOL_PANEL_SOURCE_PREFIX, toolGroupIdFromSource, toolPanelSource } from "./tool-links";
import { __resetToolGroupSwitchesForTests } from "./use-tool-group-switch";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const api = vi.hoisted(() => ({ fetchCapabilityTools: vi.fn(), fetchCapabilityToolUsage: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-tools", () => api);
const settings = vi.hoisted(() => ({ patchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings-operations", () => settings);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChangePlans: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));
// Library's inspector has its own tests (CapabilityPolicyInspector.test.tsx); here only what the panel hands it.
vi.mock("../../library/CapabilityPolicyInspector", () => ({
  CapabilityPolicyInspector: ({ workspaceId, toolName }: { workspaceId: string; toolName?: string }) => (
    <p data-policy-inspector={`${workspaceId}|${toolName ?? ""}`}>Tool policy inspector</p>
  ),
}));

const LIST_KEY = toolListQuery("ws-1").queryKey;
const USAGE_KEY = toolUsageQuery().queryKey;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function tool(toolName: string, overrides: Partial<CapabilityToolItem> = {}): CapabilityToolItem {
  return {
    toolName,
    description: `${toolName} does one thing. It does it well.`,
    risk: "safe",
    asks: "runs_freely",
    ...overrides,
  };
}

type Overrides = Partial<Record<ToolGroupId, Partial<CapabilityToolGroupItem>>>;

/** All 14 groups as the Gateway lists them, two free tools each unless `overrides` says otherwise. */
function listOf(overrides: Overrides = {}): CapabilityToolsResponse {
  return {
    workspaceId: "ws-1",
    groups: TOOL_GROUPS.map((definition) => ({
      groupId: definition.id,
      label: definition.label,
      description: definition.description,
      state: definition.switchable ? "on" : "always_on",
      risk: "caution",
      tools: [tool(`${definition.id}.a`), tool(`${definition.id}.b`)],
      blockedToolCount: 0,
      ...overrides[definition.id],
    })),
    settingsRevision: 7,
    issues: [],
    generatedAt: "2026-10-28T10:00:00.000Z",
  };
}

function usageOf(tools: CapabilityToolUsageResponse["tools"] = []): CapabilityToolUsageResponse {
  return {
    since: "2025-10-28T00:00:00.000Z",
    generatedAt: "2026-10-28T10:00:00.000Z",
    tools,
    groups: TOOL_GROUPS.map((definition) => ({ groupId: definition.id, calls: 0 })),
    mostUsed: { kind: "essentials", groupIds: ["files", "web_search", "memory", "browser"] },
  };
}

const FILES = {
  files: {
    risk: "danger",
    tools: [
      // The registry's own descriptions, written for the model: the panel shows plain labels instead (tool-labels.ts).
      tool("fs.read", { description: "Read a file inside allowed read roots." }),
      tool("fs.write", { description: "Write a file inside write jail roots.", risk: "caution", asks: "asks_first" }),
      tool("fs.delete", { description: "Delete a file or directory in write jail.", risk: "danger", asks: "unknown" }),
    ],
  },
} satisfies Overrides;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

const text = () => container.textContent ?? "";
const body = () => document.body.querySelector<HTMLElement>('[data-inspector-body="true"]');
const panelText = () => body()?.textContent ?? "";
const buttonIn = (parent: ParentNode, name: string) =>
  [...parent.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === name || entry.getAttribute("aria-label") === name,
  );
const switchIn = (parent: ParentNode, name: string) =>
  parent.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`);
const entryOf = (parent: ParentNode, toolName: string) =>
  [...parent.querySelectorAll("li")].find((entry) => entry.querySelector("code")?.textContent === toolName)!;
const cardIn = (headings: string[], label: string) =>
  [
    ...([...container.querySelectorAll("section")]
      .find((entry) => headings.includes(entry.querySelector("h2")?.textContent ?? ""))
      ?.querySelectorAll("li") ?? []),
  ].find((entry) => entry.querySelector("h3")?.textContent === label)!;
const rowOf = (label: string) => cardIn(["All tools"], label);
const cardOf = (label: string) => cardIn(["Most used", "Essentials"], label);
/** Where a link goes, without the shell parameter the cockpit adds. */
const destination = (link: Element | undefined) => {
  const target = new URL(link?.getAttribute("href") ?? "", "http://cockpit.invalid");
  return target.pathname + target.hash;
};

async function settle() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The panel on its own, reading the lists from the cache. */
async function renderPanel(
  groupId: ToolGroupId,
  list = listOf(FILES),
  usage: CapabilityToolUsageResponse | null = usageOf(),
) {
  client.setQueryData(LIST_KEY, list);
  if (usage) client.setQueryData(USAGE_KEY, usage);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ToolGroupPanel groupId={groupId} />
      </QueryClientProvider>,
    ),
  );
}

/** The Tools tab with the real address and the real inspector, as the cockpit shell mounts them. */
async function renderTab() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>
            <ToolsTab />
            <InspectorPanel />
          </InspectorProvider>
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** A pointer click focuses the button it lands on; a scripted one does not. */
async function press(element: HTMLElement | undefined | null) {
  if (!element) throw new Error("nothing to press");
  element.focus();
  await act(async () => element.click());
  await settle();
}

const address = () => window.location.pathname + window.location.search;

beforeEach(() => {
  // The docked desktop layout.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  api.fetchCapabilityTools.mockReset().mockResolvedValue(listOf(FILES));
  api.fetchCapabilityToolUsage.mockReset().mockResolvedValue(usageOf());
  settings.patchSettings.mockReset();
  plans.fetchChangePlan.mockReset();
  plans.fetchChangePlans.mockReset().mockResolvedValue({ items: [] });
  prefs.showTechnicalDetails = false;
  window.history.replaceState(null, "", "/capabilities/tools?shell=cockpit");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetToolGroupSwitchesForTests();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Tool group panel", () => {
  it("lists each tool with its risk, asks line and last use", async () => {
    await renderPanel(
      "files",
      listOf(FILES),
      usageOf([{ toolName: "fs.read", calls: 12, lastCalledAt: minutesAgo(5) }]),
    );

    // The group's own risk and state lead the panel. Its name is the inspector's title, not repeated here.
    expect([...container.querySelectorAll("[data-tone]")].slice(0, 2).map((badge) => badge.textContent)).toEqual([
      "Danger",
      "On",
    ]);
    expect([...container.querySelectorAll("p, h3, span")].some((entry) => entry.textContent === "Files")).toBe(false);
    expect(text()).toContain(TOOL_GROUPS.find((entry) => entry.id === "files")!.description);
    expect(container.querySelector("h3")?.textContent).toBe("Tools in this group");

    const read = entryOf(container, "fs.read");
    // A plain label for the tool, not the registry's description of it.
    expect(read.textContent).toContain("Read a file");
    expect(read.textContent).not.toContain("allowed read roots");
    expect(read.textContent).toContain("Safe");
    expect(read.textContent).toContain("Runs freely");
    expect(read.textContent).toContain("Last used 5 minutes ago");

    const write = entryOf(container, "fs.write");
    expect(write.textContent).toContain("Caution");
    expect(write.textContent).toContain("Asks first");
    expect(write.textContent).toContain("Not used yet");

    const remove = entryOf(container, "fs.delete");
    expect(remove.textContent).toContain("Danger");
    expect(remove.textContent).toContain("Can't tell before it's used");

    // A tool's name stands once, alone in the monospace slot, and nowhere in the sentences.
    expect([...container.querySelectorAll("code")].map((entry) => entry.textContent)).toEqual([
      "fs.read",
      "fs.write",
      "fs.delete",
    ]);
    for (const name of ["fs.read", "fs.write", "fs.delete"]) expect(text().split(name)).toHaveLength(2);
  });

  describe("names each tool in plain words", () => {
    it("shows a label for each tool, and never the model-facing description", async () => {
      await renderPanel("files");
      expect(entryOf(container, "fs.read").textContent).toContain("Read a file");
      expect(entryOf(container, "fs.write").textContent).toContain("Write a file");
      expect(entryOf(container, "fs.delete").textContent).toContain("Delete a file or folder");
      for (const jargon of ["jail", "read roots", "allowed"]) expect(text()).not.toContain(jargon);
    });

    it("says a plain line for a tool with no label, never its raw name", async () => {
      await renderPanel("git");
      // The fixture's tools (`git.a`, `git.b`) are not in the label map.
      for (const entry of container.querySelectorAll("li")) {
        expect(entry.querySelector("p")?.textContent).toBe("A tool GoatCitadel can use");
      }
      expect(text()).toContain("A tool GoatCitadel can use");
    });
  });

  describe("links a blocked tool to the rule that blocks it", () => {
    const BLOCKS: Array<[CapabilityToolBlock, string, string]> = [
      ["safety_rules", "Blocked by your safety rules", "/settings/safety#permission-profile"],
      ["permission_profile", "Blocked by a permission profile", "/settings/safety#permission-profile"],
      ["citadel_ward", "Blocked by a Citadel Ward", "/settings/citadel#citadel-wards"],
      ["grant", "Blocked by a grant", "/settings/safety#approval-mode"],
      ["install_profile", "Blocked by how this install is set up", "/settings/safety#approval-mode"],
    ];

    it.each(BLOCKS)("%s", async (block, line, href) => {
      const blocked = tool("git.commit", { asks: "unknown", blockedBy: block });
      await renderPanel("git", listOf({ git: { tools: [blocked], blockedToolCount: 1 } }));
      const entry = entryOf(container, "git.commit");
      expect(entry.textContent).toContain(line);
      const links = [...entry.querySelectorAll("a")];
      expect(links.map((link) => link.textContent)).toEqual(["See the rule"]);
      expect(destination(links[0])).toBe(href);
    });

    it("sends safety rules on the file tools to where the write folders are changed", async () => {
      const blocked = tool("fs.write", { asks: "unknown", blockedBy: "safety_rules" });
      await renderPanel("files", listOf({ files: { tools: [blocked], blockedToolCount: 1 } }));
      expect(destination(entryOf(container, "fs.write").querySelector("a")!)).toBe(
        "/settings/safety#filesystem-write-roots",
      );
    });

    it("offers no link to a tool nothing blocks", async () => {
      await renderPanel("files");
      expect(entryOf(container, "fs.read").querySelector("a")).toBeNull();
    });

    it("lets a block show in a group that is off, and says Switched off for the rest", async () => {
      const blocked = tool("fs.write", { asks: "unknown", blockedBy: "safety_rules" });
      const off = tool("fs.read", { asks: "unknown" });
      await renderPanel("files", listOf({ files: { state: "off", tools: [blocked, off], blockedToolCount: 1 } }));
      expect(entryOf(container, "fs.write").textContent).toContain("Blocked by your safety rules");
      expect(entryOf(container, "fs.read").textContent).toContain("Switched off");
      expect(entryOf(container, "fs.read").textContent).not.toContain("Can't tell");
    });
  });

  it("points to the detailed rules in Settings", async () => {
    await renderPanel("files");
    const link = [...container.querySelectorAll("a")].find((entry) => entry.textContent?.includes("Settings"));
    expect(link?.textContent).toBe("Detailed rules are in Settings › Safety");
    expect(destination(link)).toBe("/settings/safety#permission-profile");
  });

  it("shows Core without a switch", async () => {
    await renderPanel("core");
    expect(text()).toContain("Always on");
    expect(text()).toContain(TOOL_GROUPS.find((entry) => entry.id === "core")!.description);
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(text()).not.toContain("Turn it on or off");
    expect(text()).toContain("Tools in this group");
  });

  describe("last use", () => {
    it("says Not used yet only once the counts loaded", async () => {
      await renderPanel("files", listOf(FILES), usageOf());
      expect(text()).toContain("Not used yet");
      expect(text()).not.toContain("Last use unknown");
    });

    it("says it doesn't know without counts, and never Not used yet", async () => {
      await renderPanel("files", listOf(FILES), null);
      expect(text()).not.toContain("Not used yet");
      expect(container.querySelectorAll("li")).toHaveLength(3);
      for (const entry of container.querySelectorAll("li")) expect(entry.textContent).toContain("Last use unknown");
    });

    it("says it doesn't know while the counts load, and when they fail", async () => {
      window.history.replaceState(null, "", "/capabilities/tools?item=group%3Afiles&shell=cockpit");
      const counts = deferred<CapabilityToolUsageResponse>();
      api.fetchCapabilityToolUsage.mockReturnValue(counts.promise);
      await renderTab();
      await vi.waitFor(() => expect(panelText()).toContain("Tools in this group"));
      expect(panelText()).toContain("Last use unknown");
      expect(panelText()).not.toContain("Not used yet");

      await act(async () => counts.reject(new Error("The connection dropped.")));
      await settle();
      expect(panelText()).toContain("Last use unknown");
      expect(panelText()).not.toContain("Not used yet");

      // Once the counts arrive, the same panel says what they say.
      await act(async () => {
        client.setQueryData(USAGE_KEY, usageOf([{ toolName: "fs.write", calls: 2, lastCalledAt: minutesAgo(30) }]));
      });
      await settle();
      expect(entryOf(body()!, "fs.write").textContent).toContain("Last used 30 minutes ago");
      expect(entryOf(body()!, "fs.read").textContent).toContain("Not used yet");
    });
  });

  describe("the switch", () => {
    it("is named for the panel, apart from the group's row and card, and saves like them", async () => {
      window.history.replaceState(null, "", "/capabilities/tools?item=group%3Afiles&shell=cockpit");
      await renderTab();
      await vi.waitFor(() => expect(body()).not.toBeNull());
      expect(switchIn(body()!, "Turn it on or off: Files")?.getAttribute("aria-checked")).toBe("true");
      expect(switchIn(container, "Files")).not.toBeNull();
      expect(switchIn(container, "Files, essentials")).not.toBeNull();
      expect(panelText()).toContain("Turn it on or off");

      settings.patchSettings.mockReturnValueOnce(new Promise(() => {}));
      await press(switchIn(body()!, "Turn it on or off: Files"));
      expect(settings.patchSettings).toHaveBeenCalledExactlyOnceWith({
        expectedRevision: 7,
        toolGroupChange: { groupId: "files", enabled: false },
      });
      // Switching off shows at once, in the panel and on the page behind it.
      expect(switchIn(body()!, "Turn it on or off: Files")?.getAttribute("aria-checked")).toBe("false");
      expect(switchIn(container, "Files")?.getAttribute("aria-checked")).toBe("false");
      expect(switchIn(container, "Files, essentials")?.getAttribute("aria-checked")).toBe("false");
      expect(panelText()).toContain("The AI can't use these in any chat.");
      expect(entryOf(body()!, "fs.read").textContent).toContain("Switched off");
    });

    it("says what Off does not stop, for the four groups where it would surprise someone", async () => {
      expect(Object.keys(TOOL_GROUP_NOTES).sort()).toEqual(["documents", "memory", "messaging", "subagents"]);
      for (const [groupId, note] of Object.entries(TOOL_GROUP_NOTES)) {
        await renderPanel(groupId as ToolGroupId);
        expect(text()).toContain(note);
        // The note stands under the switch and describes it.
        const describedBy = container.querySelector('[role="switch"]')?.getAttribute("aria-describedby") ?? "";
        const noted = describedBy.split(" ").map((id) => container.querySelector(`[id="${id}"]`)?.textContent);
        expect(noted).toContain(note);
      }
      expect(TOOL_GROUP_NOTES.memory).toBe(
        "Switching off doesn't stop the memory GoatCitadel adds to chats on its own.",
      );
      expect(TOOL_GROUP_NOTES.documents).toBe(
        "Switching off doesn't stop GoatCitadel reading files you attach to a chat.",
      );
      expect(TOOL_GROUP_NOTES.subagents).toBe(
        "Switching off doesn't stop GoatCitadel splitting a plan into parts on its own.",
      );
      expect(TOOL_GROUP_NOTES.messaging).toBe(
        "Replies in your chat apps keep working. Notifications to your chat apps pause while this is off.",
      );

      await renderPanel("files");
      expect(text()).not.toContain("Switching off doesn't stop");
      await renderPanel("core");
      expect(text()).not.toContain("Switching off doesn't stop");
    });

    it("shows that a change waits in Inbox, with the link only when the plan names its approval", async () => {
      await renderPanel("git");
      await act(async () =>
        setToolGroupSwitch("git", { phase: "waiting", groupId: "git", planId: "plan-git", enabled: false }),
      );
      expect(text()).toContain("Waiting on you in Inbox");
      expect([...container.querySelectorAll("a")].some((link) => link.textContent === "Open in Inbox")).toBe(false);
      expect(switchIn(container, "Turn it on or off: Git")?.getAttribute("aria-busy")).toBe("true");

      await act(async () =>
        setToolGroupSwitch("git", {
          phase: "waiting",
          groupId: "git",
          planId: "plan-git",
          enabled: false,
          approvalId: "approval-1",
        }),
      );
      expect(text()).toContain("Waiting on you in Inbox");
      const link = [...container.querySelectorAll("a")].find((entry) => entry.textContent === "Open in Inbox");
      const target = new URL(link?.getAttribute("href") ?? "", "http://cockpit.invalid");
      expect(target.pathname).toBe("/inbox");
      expect(target.searchParams.get("approvalId")).toBe("approval-1");
      expect(target.searchParams.get("workspaceId")).toBe("default");
    });

    it("says why a change did not happen", async () => {
      await renderPanel("git");
      await act(async () =>
        setToolGroupSwitch("git", {
          phase: "failed",
          message: "Not switched on. The request expired.",
          conflict: false,
        }),
      );
      expect(text()).toContain("Not switched on. The request expired.");
    });
  });

  describe("announcing", () => {
    const regions = () => container.querySelectorAll('[role="status"], [role="alert"]');
    const failed = { phase: "failed", message: "Not switched on. The request expired.", conflict: false } as const;

    it("stays quiet beside the page, where the group's row announces", async () => {
      await renderPanel("git");
      await act(async () => setToolGroupSwitch("git", failed));
      expect(text()).toContain("Not switched on. The request expired.");
      expect(regions()).toHaveLength(0);
    });

    it("announces itself in a modal window, which hides the page behind it", async () => {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      const modalRoot = createRoot(dialog);
      client.setQueryData(LIST_KEY, listOf(FILES));
      await act(async () =>
        modalRoot.render(
          <QueryClientProvider client={client}>
            <ToolGroupPanel groupId="git" />
          </QueryClientProvider>,
        ),
      );
      await act(async () => setToolGroupSwitch("git", failed));
      expect(dialog.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(1);
      await act(async () => modalRoot.unmount());
      dialog.remove();
    });

    it("shows a failure the store kept from before a modal window opened, without announcing it again", async () => {
      // The row read this out when it happened; opening the panel later is not a new failure.
      setToolGroupSwitch("git", failed);
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
      const modalRoot = createRoot(dialog);
      client.setQueryData(LIST_KEY, listOf(FILES));
      await act(async () =>
        modalRoot.render(
          <QueryClientProvider client={client}>
            <ToolGroupPanel groupId="git" />
          </QueryClientProvider>,
        ),
      );
      expect(dialog.textContent).toContain("Not switched on. The request expired.");
      expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(0);
      // The note about what the switch means still announces: only the carried failure is quiet.
      expect(dialog.querySelectorAll('[role="status"]')).toHaveLength(1);

      // A failure that comes while the window is open is new to it.
      await act(async () =>
        setToolGroupSwitch("git", { ...failed, message: "Not switched on. The request was cancelled." }),
      );
      expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(1);
      await act(async () => modalRoot.unmount());
      dialog.remove();
    });
  });

  it("says when the group is not in the list anymore", async () => {
    client.setQueryData(LIST_KEY, { ...listOf(), groups: listOf().groups.filter((entry) => entry.groupId !== "git") });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ToolGroupPanel groupId="git" />
        </QueryClientProvider>,
      ),
    );
    expect(text()).toContain("This tool group isn't in the list anymore.");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("keeps the group id, tool names and the registry's descriptions in Technical details only", async () => {
    await renderPanel("files");
    expect(container.querySelector("details")).toBeNull();
    // Hidden, the registry's wording is nowhere on the panel.
    expect(text()).not.toContain("write jail");
    await act(async () => root.unmount());
    root = createRoot(container);
    prefs.showTechnicalDetails = true;
    await renderPanel("files");
    const details = container.querySelector("details");
    expect(details?.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details?.textContent).toContain("files");
    // Each tool's name stands beside the description the Gateway sent for it.
    const terms = [...(details?.querySelectorAll("dt") ?? [])].map((entry) => entry.textContent);
    expect(terms).toEqual(["Group", "fs.read", "fs.write", "fs.delete"]);
    expect(details?.textContent).toContain("Write a file inside write jail roots.");
    expect(details?.textContent).toContain("Read a file inside allowed read roots.");
    // The tool-name slot beside each label stays, and carries only the name.
    expect([...container.querySelectorAll("li code")].map((entry) => entry.textContent)).toEqual([
      "fs.read",
      "fs.write",
      "fs.delete",
    ]);
  });

  it("checks a tool's policy from the group panel's technical details", async () => {
    await renderPanel("files");
    // Hidden with the rest of Technical details.
    expect(container.querySelector("[data-policy-inspector]")).toBeNull();
    expect(container.querySelector("select")).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    prefs.showTechnicalDetails = true;
    await renderPanel("files");
    const details = container.querySelector("details")!;
    const picker = [...details.querySelectorAll("label")].find((entry) =>
      entry.textContent?.startsWith("Check a tool's policy"),
    );
    const select = picker?.querySelector("select");
    expect([...(select?.options ?? [])].map((option) => option.value)).toEqual(["fs.read", "fs.write", "fs.delete"]);
    // The first tool is checked until another is chosen, in the workspace the panel reads.
    expect(details.querySelector("[data-policy-inspector]")?.getAttribute("data-policy-inspector")).toBe(
      "ws-1|fs.read",
    );

    await act(async () => {
      select!.value = "fs.write";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(details.querySelector("[data-policy-inspector]")?.getAttribute("data-policy-inspector")).toBe(
      "ws-1|fs.write",
    );
  });

  it("offers no policy check for a group with no tools", async () => {
    prefs.showTechnicalDetails = true;
    await renderPanel("git", listOf({ git: { tools: [] } }));
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("[data-policy-inspector]")).toBeNull();
    expect(container.querySelector("select")).toBeNull();
  });
});

describe("Opening the panel", () => {
  it("opens from ?item= once the list loads", async () => {
    window.history.replaceState(null, "", "/capabilities/tools?item=group%3Afiles&shell=cockpit");
    const list = deferred<CapabilityToolsResponse>();
    api.fetchCapabilityTools.mockReturnValue(list.promise);
    await renderTab();
    // Nothing to open yet: the list has not arrived.
    expect(body()).toBeNull();

    await act(async () => list.resolve(listOf(FILES)));
    await vi.waitFor(() => expect(body()).not.toBeNull());
    expect(document.body.querySelector('[aria-label="Inspector: Files"]')).not.toBeNull();
    expect(panelText()).toContain("Tools in this group");
    expect(address()).toContain("item=group%3Afiles");
    // The inspector's title names the group, so the body doesn't say its name again.
    expect(document.body.querySelector("aside h2")?.textContent).toBe("Files");
    expect([...(body()?.querySelectorAll("p, h3, span") ?? [])].some((entry) => entry.textContent === "Files")).toBe(
      false,
    );
  });

  it("opens the Core group from its address too", async () => {
    window.history.replaceState(null, "", "/capabilities/tools?item=group%3Acore&shell=cockpit");
    await renderTab();
    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Inspector: Core"]')).not.toBeNull());
    expect(body()?.querySelector('[role="switch"]')).toBeNull();
  });

  // An id that is not a group, a group the list doesn't have, and a connector's id are all left alone: nothing opens
  // and the address is not rewritten.
  it.each([
    ["an id that is not a group", "group%3Anope"],
    ["an inherited property name", "group%3Aconstructor"],
    ["a group the list doesn't have", "group%3Agit"],
    ["an id without the group prefix", "files"],
    ["a connector's id", "mcp-server%3Alinear"],
    ["an empty group id", "group%3A"],
  ])("ignores %s", async (_what, item) => {
    const rows = listOf(FILES);
    api.fetchCapabilityTools.mockResolvedValue({
      ...rows,
      groups: rows.groups.filter((entry) => entry.groupId !== "git"),
    });
    window.history.replaceState(null, "", `/capabilities/tools?item=${item}&shell=cockpit`);
    await renderTab();
    await vi.waitFor(() => expect(text()).toContain("All tools"));
    expect(body()).toBeNull();
    expect(address()).toBe(`/capabilities/tools?item=${item}&shell=cockpit`);
  });

  it("puts the group in the address and opens the panel when a View button is pressed", async () => {
    await renderTab();
    expect(body()).toBeNull();
    await press(buttonIn(rowOf("Files"), "View Files"));
    expect(address()).toBe("/capabilities/tools?item=group%3Afiles&shell=cockpit");
    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Inspector: Files"]')).not.toBeNull());

    // Closing clears the address, so the same button can be pressed again and a reload doesn't reopen it.
    await press(buttonIn(document.body, "Close inspector"));
    expect(body()).toBeNull();
    expect(address()).toBe("/capabilities/tools?shell=cockpit");
    await press(buttonIn(rowOf("Files"), "View Files"));
    await vi.waitFor(() => expect(body()).not.toBeNull());
  });

  it("moves to another group when its View button is pressed with a panel open", async () => {
    await renderTab();
    await press(buttonIn(rowOf("Files"), "View Files"));
    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Inspector: Files"]')).not.toBeNull());
    await press(buttonIn(rowOf("Git"), "View Git"));
    await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Inspector: Git"]')).not.toBeNull());
    expect(document.body.querySelector('[aria-label="Inspector: Files"]')).toBeNull();
    expect(address()).toBe("/capabilities/tools?item=group%3Agit&shell=cockpit");
  });

  it("follows the list: a group that leaves it says so in its open panel", async () => {
    window.history.replaceState(null, "", "/capabilities/tools?item=group%3Agit&shell=cockpit");
    await renderTab();
    await vi.waitFor(() => expect(body()).not.toBeNull());
    const rows = listOf(FILES);
    await act(async () => {
      client.setQueryData(LIST_KEY, { ...rows, groups: rows.groups.filter((entry) => entry.groupId !== "git") });
    });
    await settle();
    expect(panelText()).toContain("This tool group isn't in the list anymore.");
  });

  describe("keeps the Connectors panel and the Tools panel apart", () => {
    it("never reads one tab's source as the other's", () => {
      expect(TOOL_PANEL_SOURCE_PREFIX).toBe("capabilities-tools:");
      expect(toolGroupIdFromSource(connectorPanelSource("files"))).toBeUndefined();
      expect(toolGroupIdFromSource("capabilities:files")).toBeUndefined();
      expect(connectorIdFromSource(toolPanelSource("files"))).toBeNull();
      expect(connectorIdFromSource("capabilities-tools:files")).toBeNull();
    });

    it("does not take a connector's panel on screen for its own", async () => {
      window.history.replaceState(null, "", "/capabilities/tools?item=group%3Afiles&shell=cockpit");
      const list = deferred<CapabilityToolsResponse>();
      api.fetchCapabilityTools.mockReturnValue(list.promise);
      // A connector's panel (its source starts with `capabilities:`) is on screen when the address names a group.
      function ConnectorPanelOnScreen() {
        const { open } = useInspector();
        useEffect(() => {
          open({ source: connectorPanelSource("files"), title: "A connector", body: <p>Connector panel</p> });
        }, [open]);
        return null;
      }
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <CockpitNavigationProvider>
              <InspectorProvider>
                <ConnectorPanelOnScreen />
                <ToolsTab />
                <InspectorPanel />
              </InspectorProvider>
            </CockpitNavigationProvider>
          </QueryClientProvider>,
        ),
      );
      await vi.waitFor(() =>
        expect(document.body.querySelector('[aria-label="Inspector: A connector"]')).not.toBeNull(),
      );

      // The group the address names still opens, in place of the connector's panel.
      await act(async () => list.resolve(listOf(FILES)));
      await vi.waitFor(() => expect(document.body.querySelector('[aria-label="Inspector: Files"]')).not.toBeNull());
      expect(document.body.querySelector('[aria-label="Inspector: A connector"]')).toBeNull();
    });
  });
});

describe("Focus", () => {
  it.each([
    ["its row", (label: string) => rowOf(label), "View Files"],
    ["its Essentials card", (label: string) => cardOf(label), "View Files, essentials"],
  ])("returns to the View button of %s when the panel closes", async (_where, place, name) => {
    await renderTab();
    const opener = buttonIn(place("Files"), name)!;
    expect(opener).toBeDefined();
    await press(opener);
    await vi.waitFor(() => expect(body()).not.toBeNull());

    // Focus moves into the panel, as it does when someone works in it.
    buttonIn(document.body, "Close inspector")?.focus();
    await press(buttonIn(document.body, "Close inspector"));
    expect(body()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns to the button that opened it, not to the other View button of the same group", async () => {
    await renderTab();
    const card = buttonIn(cardOf("Files"), "View Files, essentials")!;
    const row = buttonIn(rowOf("Files"), "View Files")!;
    expect(card).not.toBe(row);
    await press(card);
    await vi.waitFor(() => expect(body()).not.toBeNull());
    await press(buttonIn(document.body, "Close inspector"));
    expect(document.activeElement).toBe(card);
    expect(document.activeElement).not.toBe(row);
  });
});
