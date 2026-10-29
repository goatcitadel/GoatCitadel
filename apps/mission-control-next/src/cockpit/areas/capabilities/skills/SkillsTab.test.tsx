// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilitySkillItem,
  CapabilitySkillsResponse,
  CapabilitySkillUsageResponse,
} from "@goatcitadel/contracts";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillListQuery, skillUsageQuery } from "../../../data/capability-skills-query";
import { setSkillSwitch } from "./skill-switch-store";
import { SkillRow } from "./SkillRow";
import { SkillsTab } from "./SkillsTab";
import { __resetSkillSwitchesForTests } from "./use-skill-switch";

const api = vi.hoisted(() => ({
  fetchCapabilitySkills: vi.fn(),
  fetchCapabilitySkillUsage: vi.fn(),
  fetchCapabilitySkillDetail: vi.fn(),
  setCapabilitySkillState: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => api);
const approvals = vi.hoisted(() => ({ fetchApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (original) => ({
  ...(await original<object>()),
  ...approvals,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "default", activeWorkspaceId: "ws-1" }),
}));
// The panel and the address have their own tests (SkillPanel.test.tsx); here only the hand-off is checked.
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("../../../app/use-cockpit-route", () => ({ useCockpitRoute: () => route }));
const inspector = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), content: null as null | { source?: string } }));
vi.mock("../../../app/inspector", () => ({ useInspector: () => inspector }));

const LIST_KEY = skillListQuery("ws-1").queryKey;
const USAGE_KEY = skillUsageQuery().queryKey;

function skill(
  overrides: Partial<CapabilitySkillItem> & Pick<CapabilitySkillItem, "skillId" | "name">,
): CapabilitySkillItem {
  return {
    description: `${overrides.name} does its job.`,
    category: "writing",
    origin: "built_in",
    state: "on",
    callable: true,
    revision: 3,
    switchable: true,
    pinned: false,
    lifecycleState: "approved",
    tags: [],
    ...overrides,
  };
}

/** Eight skills, one for each way a row can read. */
const ITEMS: CapabilitySkillItem[] = [
  skill({ skillId: "writer", name: "Writer", description: "Drafts and edits prose.", revision: 3 }),
  skill({ skillId: "reviewer", name: "Code reviewer", category: "coding", tags: ["pull-request"] }),
  skill({
    skillId: "planner",
    name: "Planner",
    category: "planning",
    origin: "imported",
    state: "off",
    callable: false,
  }),
  skill({ skillId: "notes", name: "Notes", category: "personal", origin: "imported", state: "paused" }),
  skill({
    skillId: "fresh",
    name: "Fresh import",
    category: "coding",
    origin: "imported",
    callable: false,
    lifecycleState: "candidate",
  }),
  skill({ skillId: "mailer", name: "Mailer", category: "email", leftOutOfWorkspace: true }),
  skill({ skillId: "locked", name: "Locked down", category: "automation", pinned: true }),
  skill({ skillId: "house-style-id", name: "House style", origin: "workspace", switchable: false }),
];

function listOf(
  items: readonly CapabilitySkillItem[] = ITEMS,
  extra: Partial<CapabilitySkillsResponse> = {},
): CapabilitySkillsResponse {
  return {
    workspaceId: "ws-1",
    items: [...items],
    operatorApprovalSkip: false,
    issues: [],
    generatedAt: "2026-10-29T10:00:00.000Z",
    ...extra,
  };
}

function usageOf(uses: Record<string, number>): CapabilitySkillUsageResponse {
  return {
    since: "2025-10-29T00:00:00.000Z",
    generatedAt: "2026-10-29T10:00:00.000Z",
    skills: Object.entries(uses).map(([skillId, count]) => ({
      skillId,
      uses: count,
      lastUsedAt: "2026-10-28T10:00:00.000Z",
    })),
  };
}

const USAGE = usageOf({ writer: 1204, reviewer: 1 });

const httpFailure = (status: number) =>
  new ApiRequestError("failed", { kind: "http", method: "GET", path: "/api/v1/capabilities/skills", status });
const refused = (status: number, error: string, reason?: string) =>
  new ApiRequestError(error, {
    kind: "http",
    method: "POST",
    path: "/api/v1/capabilities/skills/state",
    status,
    body: { error, code: "X", ...(reason ? { details: { reason } } : {}) },
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

const text = () => container.textContent ?? "";
const section = (title: string) =>
  [...container.querySelectorAll("section")].find((entry) => entry.querySelector("h2")?.textContent === title);
const cards = () => [...container.querySelectorAll("li")];
const names = () => cards().map((card) => card.querySelector("h3")?.textContent);
const rowOf = (name: string) => cards().find((card) => card.querySelector("h3")?.textContent === name)!;
const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label || entry.getAttribute("aria-label") === label,
  );
const switchNamed = (name: string) =>
  container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${name}"]`);
/** The state word printed beside a row's switch. */
const wordOf = (name: string) => switchNamed(name)?.parentElement?.firstElementChild?.textContent;
const linkIn = (within: ParentNode, label: string) =>
  [...within.querySelectorAll("a")].find((entry) => entry.textContent === label);
const group = (label: string) => container.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`);
const chips = (label: string) =>
  [...(group(label)?.querySelectorAll("button") ?? [])].map((entry) => entry.textContent);
const searchBox = () => container.querySelector<HTMLInputElement>("input")!;
const alerts = () => container.querySelectorAll('[role="alert"]');

async function settle() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render() {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <SkillsTab />
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
  api.fetchCapabilitySkills.mockReset().mockResolvedValue(listOf());
  api.fetchCapabilitySkillUsage.mockReset().mockResolvedValue(USAGE);
  api.setCapabilitySkillState.mockReset();
  approvals.fetchApproval.mockReset().mockResolvedValue({ approvalId: "approval-9", status: "pending" });
  route.search = "";
  route.navigate.mockReset();
  inspector.open.mockReset();
  inspector.close.mockReset();
  inspector.content = null;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetSkillSwitchesForTests();
});

describe("Skills tab", () => {
  it("reads the active workspace's list and shows every skill under Installed with its count", async () => {
    await render();

    expect(api.fetchCapabilitySkills).toHaveBeenCalledWith("ws-1", expect.anything());
    expect(client.getQueryData<CapabilitySkillsResponse>(LIST_KEY)?.items).toHaveLength(8);
    expect(section("Installed")?.textContent).toContain("8 skills");
    expect(names()).toEqual(ITEMS.map((entry) => entry.name));
    expect(section("Installed")?.querySelector("ul")?.className).toBe("grid grid-cols-1 gap-2 sm:grid-cols-2");
    expect(container.querySelector('[role="search"] label')?.textContent).toBe("Skills search");
    expect(searchBox().placeholder).toBe('Try "coding"');
  });

  it("names each switch for its skill and gives a row with none no switch", async () => {
    await render();

    const names = [...container.querySelectorAll('button[role="switch"]')].map((entry) =>
      entry.getAttribute("aria-label"),
    );
    expect(names).toEqual(ITEMS.filter((entry) => entry.switchable).map((entry) => entry.name));
    expect(new Set(names).size).toBe(names.length);
  });

  describe("what each row says", () => {
    it("shows On, with how often it was used, for a skill that is on and usable", async () => {
      await render();

      expect(wordOf("Writer")).toBe("On");
      expect(switchNamed("Writer")?.getAttribute("aria-checked")).toBe("true");
      expect(rowOf("Writer").textContent).toContain("Used 1,204 times in the last year");
      expect(rowOf("Code reviewer").textContent).toContain("Used 1 time in the last year");
    });

    it("says Off and why, with the switch off", async () => {
      await render();

      expect(wordOf("Planner")).toBe("Off");
      expect(switchNamed("Planner")?.getAttribute("aria-checked")).toBe("false");
      expect(rowOf("Planner").textContent).toContain("The AI can't use it");
    });

    it("never shows plain On for a skill that isn't reviewed", async () => {
      await render();

      expect(wordOf("Fresh import")).toBe("Not usable yet");
      expect(rowOf("Fresh import").textContent).toContain("It hasn't been reviewed, so the AI can't use it");
      expect(rowOf("Fresh import").textContent).not.toMatch(/\bOn\b/);
      // Its switch is still on: the skill is switched on, it just can't be used yet.
      expect(switchNamed("Fresh import")?.getAttribute("aria-checked")).toBe("true");
    });

    it("never shows plain On for a paused or left-out skill", async () => {
      await render();

      expect(wordOf("Notes")).toBe("Paused");
      expect(switchNamed("Notes")?.getAttribute("aria-checked")).toBe("true");
      expect(rowOf("Notes").textContent).toContain("Used only when you name it");
      expect(rowOf("Notes").textContent).not.toMatch(/\bOn\b/);

      expect(wordOf("Mailer")).toBe("Left out of this workspace");
      expect(rowOf("Mailer").textContent).toContain(
        "This workspace's skill choices leave it out, so the AI can't use it here.",
      );
      expect(rowOf("Mailer").textContent).not.toMatch(/\bOn\b/);
      // The switch still works for the whole install, so it is not disabled.
      expect(switchNamed("Mailer")?.disabled).toBe(false);
    });

    it("says each state word once in a row", async () => {
      await render();
      for (const name of ["Writer", "Planner", "Notes", "Fresh import", "Mailer"]) {
        const word = wordOf(name)!;
        expect(rowOf(name).textContent?.split(word)).toHaveLength(2);
      }
    });

    it("points a left-out skill to this workspace's skill settings", async () => {
      await render();

      const link = linkIn(rowOf("Mailer"), "Change this workspace's skills");
      expect(link?.getAttribute("href")).toContain("/settings/citadel");
      expect(link?.getAttribute("href")).toContain("#workspace-capabilities");
    });

    it("shows the wait with a Review button that opens the skill's panel", async () => {
      api.fetchCapabilitySkills.mockResolvedValue(
        listOf(
          ITEMS.map((entry) => (entry.skillId === "planner" ? { ...entry, pendingApprovalId: "approval-9" } : entry)),
        ),
      );
      await render();

      expect(wordOf("Planner")).toBe("Waiting for your approval");
      // The approval is decided in the panel; the Inbox can't show a skill approval, so nothing points there.
      expect(rowOf("Planner").querySelector("a")).toBeNull();
      expect(rowOf("Planner").textContent).not.toContain("Inbox");
      const review = button("Review Planner", rowOf("Planner"));
      expect(review?.textContent).toBe("Review");
      expect(review?.getAttribute("aria-label")?.startsWith(review?.textContent ?? "?")).toBe(true);
      await click(review);
      expect(route.navigate).toHaveBeenLastCalledWith("/capabilities/skills?item=skill%3Aplanner");
      // A row that isn't waiting has no Review button.
      expect(button("Review Writer", rowOf("Writer"))).toBeUndefined();
      // It keeps its old state until the approval lands, and ignores toggles meanwhile.
      expect(switchNamed("Planner")?.getAttribute("aria-checked")).toBe("false");
      expect(switchNamed("Planner")?.getAttribute("aria-busy")).toBe("true");
    });

    it("doesn't announce a wait found when the list loads", async () => {
      api.fetchCapabilitySkills.mockResolvedValue(
        listOf(
          ITEMS.map((entry) => (entry.skillId === "planner" ? { ...entry, pendingApprovalId: "approval-9" } : entry)),
        ),
      );
      await render();

      // The row shows the wait, but nobody just asked for it, so nothing is read out.
      expect(wordOf("Planner")).toBe("Waiting for your approval");
      expect(rowOf("Planner").querySelector('[role="status"]')?.textContent).toBe("");
      expect(rowOf("Writer").querySelector('[role="status"]')?.textContent).toBe("");
    });

    it("names the skill when a click of its switch starts a wait", async () => {
      api.setCapabilitySkillState.mockResolvedValueOnce({ status: "waiting", approvalId: "approval-9" });
      await render();
      await click(switchNamed("Planner"));

      expect(wordOf("Planner")).toBe("Waiting for your approval");
      // One status line reads the wait out, in words of its own beside the visible ones, naming the skill.
      expect(rowOf("Planner").querySelector('[role="status"]')?.textContent).toBe(
        "Planner: waiting for your approval.",
      );
      // A row that isn't waiting has the same line, empty.
      expect(rowOf("Writer").querySelector('[role="status"]')?.textContent).toBe("");
    });

    it("colours the line under each switch by the state it explains", async () => {
      api.fetchCapabilitySkills.mockResolvedValue(
        listOf([...ITEMS, skill({ skillId: "gone", name: "Gone", callable: false, lifecycleState: "revoked" })]),
      );
      await render();
      const reasonOf = (name: string) =>
        rowOf(name).querySelector(`[id="${switchNamed(name)?.getAttribute("aria-describedby")}"] p`);

      // Only the states that warn take a colour: On's uses line stays neutral.
      expect(reasonOf("Writer")?.className).toContain("text-fg-secondary");
      expect(reasonOf("Writer")?.className).not.toContain("text-status-done");
      expect(reasonOf("Mailer")?.className).toContain("text-status-waiting");
      expect(reasonOf("Fresh import")?.className).toContain("text-status-waiting");
      expect(reasonOf("Gone")?.className).toContain("text-status-failed");
      expect(reasonOf("Planner")?.className).toContain("text-fg-secondary");
      expect(reasonOf("Notes")?.className).toContain("text-fg-secondary");
      // Revoked and left out read differently from paused, not only in their words.
      expect(reasonOf("Gone")?.className).not.toBe(reasonOf("Notes")?.className);
      expect(reasonOf("Mailer")?.className).not.toBe(reasonOf("Notes")?.className);
    });

    it("says a wait that can't be checked will be checked again, and keeps Review", async () => {
      await render();
      act(() =>
        setSkillSwitch("planner", {
          phase: "waiting",
          skillId: "planner",
          approvalId: "approval-9",
          from: "off",
          unreadable: true,
        }),
      );
      await settle();

      expect(wordOf("Planner")).toBe("Waiting for your approval");
      expect(rowOf("Planner").textContent).toContain("Can't check the approval right now. It will try again.");
      expect(rowOf("Planner").textContent).not.toContain("Inbox");
      expect(button("Review Planner", rowOf("Planner"))).toBeDefined();
    });
  });

  describe("rows that can't be switched freely", () => {
    it("offers no switch for a skill that can't be switched", async () => {
      await render();

      expect(switchNamed("House style")).toBeNull();
      expect(rowOf("House style").querySelector('[role="switch"]')).toBeNull();
      expect(rowOf("House style").textContent).toContain("Can't be switched from here");
      // The state still reads, and the skill id never does.
      expect(rowOf("House style").textContent).toContain("On");
      expect(text()).not.toContain("house-style-id");
    });

    it("disables the switch of a pinned skill and says how to change it", async () => {
      await render();

      expect(switchNamed("Locked down")?.disabled).toBe(true);
      expect(rowOf("Locked down").textContent).toContain("Pinned. Change it through a proposal in Library.");
      expect(switchNamed("Writer")?.disabled).toBe(false);
    });
  });

  describe("use counts", () => {
    it("says Not used yet for a skill the loaded counts don't name", async () => {
      await render();

      expect(rowOf("Locked down").textContent).toContain("Not used yet");
      expect(rowOf("House style").textContent).toContain("Not used yet");
      expect(text()).not.toContain("Uses unknown");
    });

    it("shows Uses unknown and keeps the list when counts fail", async () => {
      api.fetchCapabilitySkillUsage.mockRejectedValue(httpFailure(503));
      await render();

      expect(names()).toHaveLength(8);
      expect(rowOf("Writer").textContent).toContain("Uses unknown");
      expect(text()).not.toContain("Not used yet");
      expect(text()).toContain("Use counts can't be read right now.");
      expect(button("Refresh counts")).toBeUndefined();

      // Trying again reads them; the line goes and the counts come in.
      api.fetchCapabilitySkillUsage.mockResolvedValue(USAGE);
      await click(button("Try again"));
      expect(text()).not.toContain("Use counts can't be read right now.");
      expect(rowOf("Writer").textContent).toContain("Used 1,204 times in the last year");
    });

    it("never shows Not used yet while counts are loading or failed", async () => {
      const loading = deferred<CapabilitySkillUsageResponse>();
      api.fetchCapabilitySkillUsage.mockReturnValue(loading.promise);
      await render();
      expect(text()).not.toContain("Not used yet");
      expect(rowOf("Writer").textContent).toContain("Uses unknown");
      // The line about trouble is for a read that failed, not one still running.
      expect(text()).not.toContain("Use counts can't be read right now.");
      expect(button("Try again")).toBeUndefined();

      await act(async () => loading.reject(httpFailure(503)));
      await settle();
      expect(text()).not.toContain("Not used yet");
      expect(text()).toContain("Use counts can't be read right now.");
    });

    it("keeps the counts and says they are old when a recheck fails", async () => {
      await render();
      api.fetchCapabilitySkillUsage.mockRejectedValue(httpFailure(503));
      await act(async () => void client.invalidateQueries({ queryKey: USAGE_KEY }));
      await settle();

      expect(rowOf("Writer").textContent).toContain("Used 1,204 times in the last year");
      expect(text()).not.toContain("Uses unknown");
      expect(text()).toContain(
        `Use counts can't be refreshed right now. ${describeApiError(httpFailure(503)).summary}`,
      );
    });

    it("refreshes the counts through the Gateway and writes the answer into the cache", async () => {
      await render();
      expect(api.fetchCapabilitySkillUsage).toHaveBeenCalledTimes(1);
      expect(api.fetchCapabilitySkillUsage).toHaveBeenLastCalledWith(expect.not.objectContaining({ refresh: true }));

      const fresh = usageOf({ writer: 1300, reviewer: 2 });
      api.fetchCapabilitySkillUsage.mockResolvedValue(fresh);
      await click(button("Refresh counts"));

      expect(api.fetchCapabilitySkillUsage).toHaveBeenCalledTimes(2);
      expect(api.fetchCapabilitySkillUsage).toHaveBeenLastCalledWith({ refresh: true });
      expect(client.getQueryData(USAGE_KEY)).toEqual(fresh);
      expect(rowOf("Writer").textContent).toContain("Used 1,300 times in the last year");
    });

    it("keeps the counts and says so when Refresh counts fails", async () => {
      await render();
      api.fetchCapabilitySkillUsage.mockRejectedValue(httpFailure(503));
      await click(button("Refresh counts"));

      expect(rowOf("Writer").textContent).toContain("Used 1,204 times in the last year");
      expect(text()).toContain(
        `Use counts can't be refreshed right now. ${describeApiError(httpFailure(503)).summary}`,
      );
      expect(button("Refresh counts")).toBeDefined();
    });
  });

  describe("candidates waiting in Library", () => {
    const noticeFor = (pattern: RegExp) =>
      [...container.querySelectorAll("p")].find((p) => pattern.test(p.textContent ?? ""));

    it("links waiting candidates to Library, and hides the link when the count is missing", async () => {
      api.fetchCapabilitySkills.mockResolvedValue(listOf(ITEMS, { candidatesWaiting: 3 }));
      await render();

      const notice = noticeFor(/candidate/);
      expect(notice?.textContent).toBe("3 candidate skills waiting for review in Library");
      expect(notice?.querySelector("a")?.getAttribute("href")).toContain("/library?type=candidate_skill");
      // The count is for the whole install, so the line never says it is this workspace's.
      expect(notice?.textContent).not.toMatch(/this workspace/i);

      api.fetchCapabilitySkills.mockResolvedValue(listOf(ITEMS, { candidatesWaiting: 1 }));
      await act(async () => void client.invalidateQueries({ queryKey: LIST_KEY }));
      await settle();
      expect(noticeFor(/candidate/)?.textContent).toBe("1 candidate skill waiting for review in Library");

      for (const missing of [undefined, 0]) {
        api.fetchCapabilitySkills.mockResolvedValue(
          listOf(ITEMS, missing === undefined ? {} : { candidatesWaiting: missing }),
        );
        await act(async () => void client.invalidateQueries({ queryKey: LIST_KEY }));
        await settle();
        expect(noticeFor(/candidate/)).toBeUndefined();
        expect(container.querySelector('a[href*="candidate_skill"]')).toBeNull();
      }
    });
  });

  describe("filters", () => {
    it("names the origin group Where it came from, and shows only values the list has", async () => {
      await render();

      expect(group("Where it came from")).not.toBeNull();
      expect(chips("Where it came from")).toEqual(["All", "Built in", "Imported", "Workspace"]);
      // Categories come in the contract's order, three in the row and the rest under a count.
      expect(chips("Categories")).toEqual(["All", "Coding", "Writing and docs", "Planning", "+3"]);
    });

    it("filters by category and origin together", async () => {
      await render();

      await click(button("Coding", group("Categories")!));
      expect(names()).toEqual(["Code reviewer", "Fresh import"]);
      expect(section("Installed")?.textContent).toContain("2 of 8 skills");

      await click(button("Imported", group("Where it came from")!));
      expect(names()).toEqual(["Fresh import"]);

      await click(button("All", group("Categories")!));
      expect(names()).toEqual(["Planner", "Notes", "Fresh import"]);
    });

    it("searches the name, the description, the tags and the category label", async () => {
      await render();

      await type("pull-request");
      expect(names()).toEqual(["Code reviewer"]);
      await type("prose");
      expect(names()).toEqual(["Writer"]);
      await type("email and");
      expect(names()).toEqual(["Mailer"]);
    });

    it("offers Clear filters when nothing matches", async () => {
      await render();
      await click(button("Coding", group("Categories")!));
      await type("zzzz");

      expect(names()).toEqual([]);
      expect(text()).toContain("Nothing matches");
      await click(button("Clear filters"));

      expect(names()).toHaveLength(8);
      expect(searchBox().value).toBe("");
      expect(button("All", group("Categories")!)?.getAttribute("aria-pressed")).toBe("true");
      // The button that was pressed left, so focus goes to the search box.
      expect(document.activeElement).toBe(searchBox());
    });

    it("drops a chosen category that no longer has a skill", async () => {
      await render();
      await click(button("Coding", group("Categories")!));
      api.fetchCapabilitySkills.mockResolvedValue(listOf(ITEMS.filter((entry) => entry.category !== "coding")));
      await act(async () => void client.invalidateQueries({ queryKey: LIST_KEY }));
      await settle();

      expect(names()).toHaveLength(6);
      expect(chips("Categories")).not.toContain("Coding");
    });
  });

  describe("loading and trouble", () => {
    it("says it is checking while the first read runs", async () => {
      api.fetchCapabilitySkills.mockReturnValue(new Promise(() => {}));
      await render();

      expect(text()).toContain("Checking for changes…");
      expect(container.querySelector("li")).toBeNull();
    });

    it("says plainly when the list couldn't load, and offers Retry", async () => {
      api.fetchCapabilitySkills.mockRejectedValueOnce(httpFailure(503));
      await render();

      expect(text()).toContain("Skills couldn't load.");
      expect(text()).toContain(describeApiError(httpFailure(503)).summary);
      expect(alerts()).toHaveLength(1);
      expect(container.querySelector("li")).toBeNull();

      await click(button("Retry"));
      expect(names()).toHaveLength(8);
    });

    it("keeps the cached list beside one warning when a recheck fails", async () => {
      client.setQueryData(LIST_KEY, listOf());
      api.fetchCapabilitySkills.mockRejectedValue(httpFailure(503));
      await render();

      expect(names()).toHaveLength(8);
      expect(text()).toContain(`${describeApiError(httpFailure(503)).summary} Showing the last version`);
      expect(text()).not.toContain("Skills couldn't load.");
      expect(alerts()).toHaveLength(0);
    });

    it("shows each issue the Gateway names as its own line", async () => {
      api.fetchCapabilitySkills.mockResolvedValue(
        listOf(ITEMS, {
          issues: ["This workspace's skill choices couldn't be read.", "Candidates couldn't be counted."],
        }),
      );
      await render();

      expect(text()).toContain("This workspace's skill choices couldn't be read.");
      expect(text()).toContain("Candidates couldn't be counted.");
      expect(names()).toHaveLength(8);
    });

    it("says an empty list with an issue is a failed read, and one without is empty", async () => {
      api.fetchCapabilitySkills.mockResolvedValue(listOf([], { issues: ["Skills couldn't be read."] }));
      await render();
      expect(text()).toContain("Couldn't load any skills right now.");
      expect(button("Retry")).toBeDefined();

      api.fetchCapabilitySkills.mockResolvedValue(listOf([]));
      await click(button("Retry"));
      expect(text()).toContain("No skills installed yet");
      expect(container.querySelector('[role="search"]')).toBeNull();
    });
  });

  describe("the switch", () => {
    it("asks for the change through the skill's own request", async () => {
      api.setCapabilitySkillState.mockReturnValue(new Promise(() => {}));
      await render();
      await click(switchNamed("Writer"));

      expect(api.setCapabilitySkillState).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "ws-1",
        skillId: "writer",
        state: "disabled",
        expectedRevision: 3,
      });
      expect(switchNamed("Writer")?.getAttribute("aria-busy")).toBe("true");
    });

    it("says plainly when a switch didn't change, and offers Reload for a stale one", async () => {
      const message = "This skill changed since you opened it. Reload and try again.";
      api.setCapabilitySkillState.mockRejectedValueOnce(refused(409, message, "stale"));
      await render();
      await click(switchNamed("Writer"));

      expect(rowOf("Writer").textContent).toContain(message);
      expect(rowOf("Writer").querySelector('[role="alert"]')?.textContent).toContain(message);

      const reads = api.fetchCapabilitySkills.mock.calls.length;
      await click(button("Reload", rowOf("Writer")));
      expect(api.fetchCapabilitySkills.mock.calls.length).toBeGreaterThan(reads);
      expect(rowOf("Writer").textContent).not.toContain(message);
    });

    it("gives no Reload for a failure that reloading doesn't fix", async () => {
      const message = "This skill is pinned. Change it through a proposal in Library.";
      api.setCapabilitySkillState.mockRejectedValueOnce(refused(409, message, "pinned"));
      await render();
      await click(switchNamed("Writer"));

      expect(rowOf("Writer").textContent).toContain(message);
      expect(button("Reload", rowOf("Writer"))).toBeUndefined();
    });

    it("shows a failure that is still held quietly when the tab comes back", async () => {
      const message = "This skill changed since you opened it. Reload and try again.";
      api.setCapabilitySkillState.mockRejectedValueOnce(refused(409, message, "stale"));
      await render();
      await click(switchNamed("Writer"));
      expect(alerts()).toHaveLength(1);

      await act(async () => root.render(null));
      await render();
      // It was read out when it happened; the row shows it again with its Reload button, and says nothing.
      expect(rowOf("Writer").textContent).toContain(message);
      expect(button("Reload", rowOf("Writer"))).toBeDefined();
      expect(alerts()).toHaveLength(0);
    });
  });

  describe("the View button", () => {
    const WRITER = ITEMS[0]!;

    async function renderRow(onView = vi.fn()) {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <ul>
              <SkillRow item={WRITER} uses="Used 3 times in the last year" onView={onView} />
            </ul>
          </QueryClientProvider>,
        ),
      );
      return onView;
    }

    it("hands the skill's id to its caller, and the card itself is not a click target", async () => {
      const onView = await renderRow();

      await click(container.querySelector("li"));
      await click(container.querySelector("h3"));
      expect(onView).not.toHaveBeenCalled();

      await click(button("View Writer"));
      expect(onView).toHaveBeenCalledExactlyOnceWith("writer");
    });

    it("is named to start with what it says", async () => {
      await renderRow();
      const view = button("View Writer")!;
      expect(view.textContent).toBe("View");
      expect(view.getAttribute("aria-label")?.startsWith(view.textContent ?? "?")).toBe(true);
    });

    it("lists each skill with a View button of its own", async () => {
      await render();
      const labels = [...container.querySelectorAll("li button:not([role='switch'])")].map((entry) =>
        entry.getAttribute("aria-label"),
      );
      expect(labels).toEqual(ITEMS.map((entry) => `View ${entry.name}`));
    });

    it("opens the skill's panel by putting it in the address", async () => {
      await render();
      expect(route.navigate).not.toHaveBeenCalled();

      await click(button("View Writer"));
      expect(route.navigate).toHaveBeenLastCalledWith("/capabilities/skills?item=skill%3Awriter");
      await click(button("View House style"));
      expect(route.navigate).toHaveBeenLastCalledWith("/capabilities/skills?item=skill%3Ahouse-style-id");
    });
  });
});
