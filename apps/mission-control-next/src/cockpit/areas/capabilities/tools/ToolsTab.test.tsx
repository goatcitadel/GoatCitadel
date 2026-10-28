// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TOOL_GROUPS,
  type CapabilityToolGroupItem,
  type CapabilityToolItem,
  type CapabilityToolsResponse,
  type CapabilityToolUsageResponse,
  type ToolGroupId,
} from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolListQuery, toolUsageQuery } from "../../../data/capability-tools-query";
import { setToolGroupSwitch } from "./tool-group-switch-store";
import { ToolsTab } from "./ToolsTab";
import { __resetToolGroupSwitchesForTests } from "./use-tool-group-switch";

const api = vi.hoisted(() => ({ fetchCapabilityTools: vi.fn(), fetchCapabilityToolUsage: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-tools", () => api);
const settings = vi.hoisted(() => ({ patchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings-operations", () => settings);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChangePlans: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "default", activeWorkspaceId: "ws-1" }),
}));

const LIST_KEY = toolListQuery("ws-1").queryKey;
const USAGE_KEY = toolUsageQuery().queryKey;

function tool(overrides: Partial<CapabilityToolItem> = {}): CapabilityToolItem {
  return { toolName: "tool.one", description: "Does one thing.", risk: "safe", asks: "runs_freely", ...overrides };
}

type Overrides = Partial<Record<ToolGroupId, Partial<CapabilityToolGroupItem>>>;

/** All 14 groups as the Gateway lists them, every tool free to run unless `overrides` says otherwise. */
function listOf(overrides: Overrides = {}, issues: string[] = []): CapabilityToolsResponse {
  return {
    workspaceId: "ws-1",
    groups: TOOL_GROUPS.map((definition) => ({
      groupId: definition.id,
      label: definition.label,
      description: definition.description,
      state: definition.switchable ? "on" : "always_on",
      risk: "caution",
      tools: [tool({ toolName: `${definition.id}.a` }), tool({ toolName: `${definition.id}.b` })],
      blockedToolCount: 0,
      ...overrides[definition.id],
    })),
    settingsRevision: 7,
    issues,
    generatedAt: "2026-10-28T10:00:00.000Z",
  };
}

function usageOf(
  kind: "most_used" | "essentials",
  groupIds: ToolGroupId[],
  calls: Partial<Record<ToolGroupId, number>>,
): CapabilityToolUsageResponse {
  return {
    since: "2025-10-28T00:00:00.000Z",
    generatedAt: "2026-10-28T10:00:00.000Z",
    tools: [],
    groups: TOOL_GROUPS.map((definition) => ({ groupId: definition.id, calls: calls[definition.id] ?? 0 })),
    mostUsed: { kind, groupIds },
  };
}

const MOST_USED = usageOf("most_used", ["memory", "git", "files", "browser"], {
  memory: 1204,
  git: 40,
  files: 1,
  browser: 20,
  core: 9000,
});
const STARTER = usageOf("essentials", ["files", "web_search", "memory", "browser"], {});

const httpFailure = (status: number) =>
  new ApiRequestError("failed", { kind: "http", method: "GET", path: "/api/v1/capabilities/tools", status });
const conflict = () =>
  new ApiRequestError("conflict", {
    kind: "http",
    method: "PATCH",
    path: "/api/v1/settings",
    status: 409,
    body: { code: "WRITE_CONFLICT" },
  });

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
const onOpen = vi.fn();

const text = () => container.textContent ?? "";
const section = (title: string) =>
  [...container.querySelectorAll("section")].find((entry) => entry.querySelector("h2")?.textContent === title);
const headings = () => [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
const cardsIn = (title: string) => [...(section(title)?.querySelectorAll("li") ?? [])];
const labelsIn = (title: string) => cardsIn(title).map((card) => card.querySelector("h3")?.textContent);
const cardOf = (title: string, label: string) =>
  cardsIn(title).find((card) => card.querySelector("h3")?.textContent === label)!;
const rowOf = (label: string) => cardOf("All tools", label);
const button = (name: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === name || entry.getAttribute("aria-label") === name,
  );
const switchNamed = (name: string) =>
  container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`);
const switchNames = () =>
  [...container.querySelectorAll('button[role="switch"]')].map((entry) => entry.getAttribute("aria-label"));
const searchBox = () => container.querySelector<HTMLInputElement>("input")!;

async function settle() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ToolsTab onOpen={onOpen} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(searchBox(), value);
    searchBox().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(element: Element | null | undefined) {
  await act(async () => (element as HTMLElement).click());
  await settle();
}

beforeEach(() => {
  api.fetchCapabilityTools.mockReset().mockResolvedValue(listOf());
  api.fetchCapabilityToolUsage.mockReset().mockResolvedValue(MOST_USED);
  settings.patchSettings.mockReset();
  plans.fetchChangePlan.mockReset();
  plans.fetchChangePlans.mockReset().mockResolvedValue({ items: [] });
  onOpen.mockReset();
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
});

describe("Tools tab", () => {
  it("reads the active workspace's list and keeps it in the cache entry the switch writes", async () => {
    await render();
    expect(api.fetchCapabilityTools).toHaveBeenCalledWith("ws-1", expect.anything());
    expect(client.getQueryData<CapabilityToolsResponse>(LIST_KEY)?.groups).toHaveLength(14);

    // Switching off shows in that same entry at once, so every view of the group agrees.
    settings.patchSettings.mockReturnValueOnce(new Promise(() => {}));
    await click(switchNamed("Files"));
    expect(
      client.getQueryData<CapabilityToolsResponse>(LIST_KEY)?.groups.find((g) => g.groupId === "files")?.state,
    ).toBe("off");
    expect(settings.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      toolGroupChange: { groupId: "files", enabled: false },
    });
  });

  it("shows Most used with counts once 4 groups have calls", async () => {
    await render();

    expect(headings()).toEqual(["Most used", "All tools"]);
    expect(labelsIn("Most used")).toEqual(["Memory", "Git", "Files", "Browser"]);
    expect(cardOf("Most used", "Memory").textContent).toContain("1,204 calls in the last year");
    expect(cardOf("Most used", "Files").textContent).toContain("1 call in the last year");
    // Every group is in the list, in the Gateway's order, with its own count.
    expect(labelsIn("All tools")).toEqual(TOOL_GROUPS.map((definition) => definition.label));
    expect(rowOf("Git").textContent).toContain("40 calls in the last year");
    expect(rowOf("Shell and code").textContent).toContain("No calls yet");
    expect(rowOf("Core").textContent).toContain("9,000 calls in the last year");
    expect(text()).not.toContain("Calls unknown");
    expect(text()).not.toContain("everything the AI did");
  });

  it("shows Essentials and Calls unknown when counts fail, and keeps the list", async () => {
    api.fetchCapabilityToolUsage.mockRejectedValue(httpFailure(503));
    await render();

    expect(headings()).toEqual(["Essentials", "All tools"]);
    expect(section("Most used")).toBeUndefined();
    expect(labelsIn("Essentials")).toEqual(["Files", "Web search", "Memory", "Browser"]);
    expect(labelsIn("All tools")).toHaveLength(14);
    expect(cardOf("Essentials", "Files").textContent).toContain("Calls unknown");
    expect(rowOf("Git").textContent).toContain("Calls unknown");
    expect(text()).toContain("Call counts can't be read right now.");

    // Trying again reads them; the line goes and the counts come in.
    api.fetchCapabilityToolUsage.mockResolvedValue(MOST_USED);
    await click(button("Try again"));
    expect(text()).not.toContain("Call counts can't be read right now.");
    expect(headings()).toEqual(["Most used", "All tools"]);
    expect(rowOf("Git").textContent).toContain("40 calls in the last year");
  });

  it("never shows No calls yet while counts are loading or failed", async () => {
    const loading = deferred<CapabilityToolUsageResponse>();
    api.fetchCapabilityToolUsage.mockReturnValue(loading.promise);
    await render();
    expect(text()).not.toContain("No calls yet");
    expect(rowOf("Git").textContent).toContain("Calls unknown");
    // The line about trouble is for a read that failed, not one still running.
    expect(text()).not.toContain("Call counts can't be read right now.");
    expect(button("Try again")).toBeUndefined();

    await act(async () => loading.reject(httpFailure(503)));
    await settle();
    expect(text()).not.toContain("No calls yet");
    expect(text()).toContain("Call counts can't be read right now.");
  });

  it("keeps the counts and says they are old when a refresh fails", async () => {
    await render();
    expect(rowOf("Git").textContent).toContain("40 calls in the last year");

    api.fetchCapabilityToolUsage.mockRejectedValue(httpFailure(503));
    await act(async () => void client.invalidateQueries({ queryKey: USAGE_KEY }));
    await settle();

    expect(rowOf("Git").textContent).toContain("40 calls in the last year");
    expect(text()).not.toContain("Calls unknown");
    expect(text()).not.toContain("Call counts can't be read right now.");
    expect(text()).toContain(`Call counts can't be refreshed right now. ${describeApiError(httpFailure(503)).summary}`);
    expect(text()).toMatch(/Showing the last version from/);
    expect(button("Try again")).toBeUndefined();
  });

  it("refreshes the counts through the Gateway and writes the answer into the cache", async () => {
    await render();
    expect(api.fetchCapabilityToolUsage).toHaveBeenCalledTimes(1);
    expect(api.fetchCapabilityToolUsage).toHaveBeenLastCalledWith(expect.not.objectContaining({ refresh: true }));

    const fresh = usageOf("most_used", ["memory", "git", "files", "browser"], {
      memory: 1300,
      git: 41,
      files: 2,
      browser: 21,
    });
    api.fetchCapabilityToolUsage.mockResolvedValue(fresh);
    await click(button("Refresh counts"));

    expect(api.fetchCapabilityToolUsage).toHaveBeenCalledTimes(2);
    expect(api.fetchCapabilityToolUsage).toHaveBeenLastCalledWith({ refresh: true });
    expect(client.getQueryData(USAGE_KEY)).toEqual(fresh);
    expect(rowOf("Git").textContent).toContain("41 calls in the last year");
  });

  it("keeps the counts and says so when Refresh counts fails", async () => {
    await render();
    api.fetchCapabilityToolUsage.mockRejectedValue(httpFailure(503));
    await click(button("Refresh counts"));

    expect(rowOf("Git").textContent).toContain("40 calls in the last year");
    // The line says why, in the same words the list's own warning would use.
    expect(text()).toContain(`Call counts can't be refreshed right now. ${describeApiError(httpFailure(503)).summary}`);
    // The button is there to try again.
    expect(button("Refresh counts")).toBeDefined();
  });

  it("shows Core always on with no switch", async () => {
    await render();

    const core = rowOf("Core");
    expect(core.textContent).toContain("Always on");
    expect(core.textContent).toContain("GoatCitadel needs these to run chats and connectors, so they stay on.");
    expect(core.querySelector('[role="switch"]')).toBeNull();
    expect(switchNames()).not.toContain("Core");
    // Every other group has its switch in the list, and the four cards have theirs.
    expect(switchNames().filter((name) => !name?.endsWith(", most used"))).toHaveLength(13);
    expect(switchNames().filter((name) => name?.endsWith(", most used"))).toHaveLength(4);
  });

  it("names each switch and button by its group, once per place", async () => {
    await render();

    expect(switchNamed("Files")).not.toBeNull();
    expect(switchNamed("Files, most used")).not.toBeNull();
    expect(new Set(switchNames()).size).toBe(switchNames().length);
    expect(rowOf("Files").contains(switchNamed("Files"))).toBe(true);
    expect(cardOf("Most used", "Files").contains(switchNamed("Files, most used"))).toBe(true);

    // The card is not a click target: a button opens the panel, named to start with what it says.
    const names = [...container.querySelectorAll("li button:not([role='switch'])")].map((entry) =>
      entry.getAttribute("aria-label"),
    );
    expect(names).toContain("View Files");
    expect(names).toContain("View Files, most used");
    expect(new Set(names).size).toBe(names.length);
    for (const entry of container.querySelectorAll("li button:not([role='switch'])")) {
      expect(entry.getAttribute("aria-label")?.startsWith(entry.textContent ?? "?")).toBe(true);
    }
  });

  it("opens the group from its button and from nothing else", async () => {
    await render();

    await click(rowOf("Git"));
    await click(rowOf("Git").querySelector("h3"));
    expect(onOpen).not.toHaveBeenCalled();

    await click(button("View Git", rowOf("Git")));
    expect(onOpen).toHaveBeenLastCalledWith("git");
    await click(button("View Files, most used"));
    expect(onOpen).toHaveBeenLastCalledWith("files");
    await click(button("View Core"));
    expect(onOpen).toHaveBeenLastCalledWith("core");
  });

  it("says under the switch what on and off mean", async () => {
    api.fetchCapabilityTools.mockResolvedValue(listOf({ git: { state: "off" } }));
    await render();

    expect(rowOf("Files").textContent).toContain("Takes effect in new chats.");
    expect(rowOf("Git").textContent).toContain("The AI can't use these in any chat.");
    expect(rowOf("Git").textContent).not.toContain("Takes effect in new chats.");
  });

  it("shows risk, tool count and what blocks a group", async () => {
    const blocked = (toolName: string) => tool({ toolName, asks: "unknown", blockedBy: "safety_rules" });
    api.fetchCapabilityTools.mockResolvedValue(
      listOf({
        files: { risk: "danger", tools: [blocked("fs.write"), tool({ toolName: "fs.read" })], blockedToolCount: 1 },
        git: { risk: "safe", tools: [blocked("git.push")], blockedToolCount: 1 },
        browser: { tools: [tool({ asks: "unknown" }), tool()] },
        memory: { tools: [tool({ asks: "unknown" }), tool()], state: "off" },
        schedules: { risk: "nuclear", tools: [tool()] },
      }),
    );
    await render();

    expect(rowOf("Files").textContent).toContain("Danger");
    expect(rowOf("Files").textContent).toContain("2 tools");
    expect(rowOf("Files").textContent).toContain("1 tool blocked by other rules");
    expect(rowOf("Git").textContent).toContain("Safe");
    expect(rowOf("Git").textContent).toContain("1 tool");
    expect(rowOf("Git").textContent).toContain("Blocked by other rules");
    expect(rowOf("Git").textContent).not.toContain("1 tool blocked by other rules");
    expect(rowOf("Schedules").textContent).toContain("Nuclear");
    // A tool that can't be checked yet is said so; in a group that is off, unknown only means switched off.
    expect(rowOf("Browser").textContent).toContain("Some tools can't be checked before they're used");
    expect(rowOf("Memory").textContent).not.toContain("can't be checked");
    expect(rowOf("Web search").textContent).not.toContain("blocked");
    expect(rowOf("Web search").textContent).not.toContain("can't be checked");
    // Tool ids belong to the inspector, never to a row.
    expect(text()).not.toContain("fs.write");
  });

  describe("a switch that waits in Inbox", () => {
    const WAITING_RECEIPT = (approvalId?: string) => ({
      revision: 8,
      changePlanReceipt: {
        planId: "plan-git",
        status: "awaiting_approval",
        revision: 3,
        risk: "caution",
        summary: "Switch Git on.",
        requiredAction: {
          kind: "approval",
          actionId: "action-1",
          actionNonce: "n".repeat(32),
          title: "Switch Git on",
          risk: "caution",
          ...(approvalId ? { approvalId } : {}),
        },
      },
    });

    beforeEach(() => {
      api.fetchCapabilityTools.mockResolvedValue(listOf({ git: { state: "off" } }));
    });

    it("shows Waiting on you in Inbox with a link", async () => {
      settings.patchSettings.mockResolvedValueOnce(WAITING_RECEIPT("approval-1"));
      await render();
      await click(switchNamed("Git"));

      expect(rowOf("Git").textContent).toContain("Waiting on you in Inbox");
      expect(rowOf("Git").textContent).not.toContain("The AI can't use these in any chat.");
      const link = [...rowOf("Git").querySelectorAll("a")].find((entry) => entry.textContent === "Open in Inbox");
      const target = new URL(link?.getAttribute("href") ?? "", "http://localhost");
      expect(target.pathname).toBe("/inbox");
      expect(target.searchParams.get("approvalId")).toBe("approval-1");
      expect(target.searchParams.get("workspaceId")).toBe("default");
      // It stays off until the approval lands, and it can't be switched again meanwhile.
      expect(switchNamed("Git")?.getAttribute("aria-checked")).toBe("false");
      expect(switchNamed("Git")?.getAttribute("aria-busy")).toBe("true");
    });

    it("shows the wait without a link when the plan names no approval", async () => {
      settings.patchSettings.mockResolvedValueOnce(WAITING_RECEIPT());
      await render();
      await click(switchNamed("Git"));

      expect(rowOf("Git").textContent).toContain("Waiting on you in Inbox");
      expect(rowOf("Git").querySelector("a")).toBeNull();
    });

    it("shows the wait on a Most used card too, under its own switch name", async () => {
      api.fetchCapabilityToolUsage.mockResolvedValue(
        usageOf("most_used", ["git", "files", "memory", "browser"], { git: 5, files: 4, memory: 3, browser: 2 }),
      );
      settings.patchSettings.mockResolvedValueOnce(WAITING_RECEIPT("approval-1"));
      await render();
      await click(switchNamed("Git, most used"));

      expect(cardOf("Most used", "Git").textContent).toContain("Waiting on you in Inbox");
      expect(rowOf("Git").textContent).toContain("Waiting on you in Inbox");
    });
  });

  it("says plainly when a switch didn't change, and offers Reload for a conflict", async () => {
    settings.patchSettings.mockRejectedValueOnce(conflict());
    await render();
    await click(switchNamed("Files"));

    const message = "Changed elsewhere. Reload to see the latest.";
    expect(rowOf("Files").textContent).toContain(message);
    expect(rowOf("Files").querySelector('[role="alert"]')?.textContent).toContain(message);
    // The card announces nothing of its own: the row's line is the one read out.
    expect(cardOf("Most used", "Files").textContent).toContain(message);
    expect(cardOf("Most used", "Files").querySelector('[role="alert"]')).toBeNull();

    const reads = api.fetchCapabilityTools.mock.calls.length;
    await click(button("Reload", rowOf("Files")));
    expect(api.fetchCapabilityTools.mock.calls.length).toBeGreaterThan(reads);
    expect(rowOf("Files").textContent).not.toContain(message);
  });

  describe("narrow screens", () => {
    // The longest line a switch can show, from a change that waited in Inbox and then met changed settings.
    const LONG = "Not switched on. Settings changed while this waited in Inbox. Switch it on again.";

    /** The ancestors between `element` and `card` that can't shrink: text inside one takes its full unwrapped width. */
    const fixedWidthAncestors = (element: Element, card: Element) => {
      const found: Element[] = [];
      for (let parent = element.parentElement; parent && parent !== card; parent = parent.parentElement) {
        if (parent.classList.contains("shrink-0")) found.push(parent);
      }
      return found;
    };

    beforeEach(() => {
      api.fetchCapabilityTools.mockResolvedValue(listOf({ git: { state: "off" } }));
    });

    it("keeps the note and a long failure in the card's text flow, not in a column that can't shrink", async () => {
      await render();
      await act(async () => setToolGroupSwitch("git", { phase: "failed", message: LONG, conflict: true }));

      for (const card of [rowOf("Git"), cardOf("Most used", "Git")]) {
        expect(card.textContent).toContain(LONG);
        const failure = [...card.querySelectorAll("p")].find((line) => line.textContent === LONG)!;
        const note = [...card.querySelectorAll("p")].find(
          (line) => line.textContent === "The AI can't use these in any chat.",
        )!;
        expect(failure).toBeDefined();
        expect(note).toBeDefined();
        expect(fixedWidthAncestors(failure, card)).toEqual([]);
        expect(fixedWidthAncestors(note, card)).toEqual([]);
        // The Reload button stands with the failure, not in the switch's column.
        expect(fixedWidthAncestors(button("Reload", card)!, card)).toEqual([]);
      }
    });

    it("keeps the wait and its link in the card's text flow too", async () => {
      await render();
      await act(async () =>
        setToolGroupSwitch("git", {
          phase: "waiting",
          approvalId: "approval-1",
          groupId: "git",
          planId: "plan-git",
          enabled: true,
        }),
      );

      for (const card of [rowOf("Git"), cardOf("Most used", "Git")]) {
        const link = [...card.querySelectorAll("a")].find((entry) => entry.textContent === "Open in Inbox")!;
        expect(link).toBeDefined();
        expect(fixedWidthAncestors(link, card)).toEqual([]);
      }
    });

    it("keeps the switch beside the name and lets the name column take the rest of the row", async () => {
      await render();
      const row = rowOf("Git");

      // The switch sits in a column that holds only the switch and the View button; the name column shrinks and grows.
      const column = [...row.querySelectorAll("div.shrink-0")].find((entry) => entry.contains(switchNamed("Git")))!;
      expect(column).toBeDefined();
      expect(column.textContent).toBe("OffView");
      const names = row.querySelector("h3")!.parentElement!.parentElement!;
      expect(names.classList.contains("flex-1")).toBe(true);
      expect(names.classList.contains("min-w-0")).toBe(true);
      expect(column.parentElement).toBe(names.parentElement);
    });
  });

  describe("search", () => {
    it("filters the list and leaves Most used out while searching", async () => {
      await render();
      expect(searchBox().placeholder).toBe('Try "memory"');
      expect(container.querySelector('[role="search"]')?.textContent).toContain("Tools");

      await type("GIT");
      expect(labelsIn("All tools")).toEqual(["Git"]);
      expect(section("Most used")).toBeUndefined();
    });

    it("offers Clear search when nothing matches", async () => {
      await render();
      await type("spreadsheets");

      expect(text()).toContain("Nothing matches");
      expect(section("All tools")).toBeUndefined();
      await click(button("Clear search"));

      expect(searchBox().value).toBe("");
      expect(labelsIn("All tools")).toHaveLength(14);
      expect(document.activeElement).toBe(searchBox());
    });

    it("suggests the first Essentials group while counts are missing", async () => {
      api.fetchCapabilityToolUsage.mockResolvedValue(STARTER);
      await render();
      expect(searchBox().placeholder).toBe('Try "files"');
    });
  });

  describe("the list", () => {
    it("says it is checking while the first read runs", async () => {
      api.fetchCapabilityTools.mockReturnValue(new Promise(() => {}));
      await render();
      expect(text()).toContain("Checking for changes…");
      expect(container.querySelector("input")).toBeNull();
    });

    it("says it couldn't load, with Retry, when the first read fails", async () => {
      api.fetchCapabilityTools.mockRejectedValueOnce(httpFailure(500));
      await render();

      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Tool groups couldn't load.");
      expect(labelsIn("All tools")).toEqual([]);
      await click(button("Retry"));

      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(labelsIn("All tools")).toHaveLength(14);
    });

    it("keeps the list with one warning when a recheck fails", async () => {
      await render();
      api.fetchCapabilityTools.mockRejectedValue(httpFailure(500));
      await act(async () => void client.invalidateQueries({ queryKey: LIST_KEY }));
      await settle();

      expect(labelsIn("All tools")).toHaveLength(14);
      expect(text()).toMatch(/Showing the last version/);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });

    it("says each note about what couldn't be read, one line each", async () => {
      api.fetchCapabilityTools.mockResolvedValue(
        listOf({}, ["Some tools' rules couldn't be checked right now.", "Another note."]),
      );
      await render();

      expect(text()).toContain("Some tools' rules couldn't be checked right now.");
      expect(text()).toContain("Another note.");
      expect(labelsIn("All tools")).toHaveLength(14);
    });

    it("says so, with Retry, when the list comes back with no group", async () => {
      api.fetchCapabilityTools.mockResolvedValue({ ...listOf(), groups: [] });
      await render();

      expect(text()).toContain("Couldn't load any tool groups right now.");
      expect(button("Retry")).toBeDefined();
      expect(container.querySelector("input")).toBeNull();
    });
  });
});
