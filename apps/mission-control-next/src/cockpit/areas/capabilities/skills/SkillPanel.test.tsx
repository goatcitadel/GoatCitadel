// @vitest-environment happy-dom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ApprovalRequest,
  CapabilitySkillDetail,
  CapabilitySkillItem,
  CapabilitySkillsResponse,
  CapabilitySkillUsageResponse,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider, useInspector } from "../../../app/inspector";
import { skillListQuery } from "../../../data/capability-skills-query";
import { __resetInboxApprovalAttemptsForTests } from "../../inbox/inbox-approval-attempts";
import { __resetSettingsApprovalDialogsForTests } from "../../settings/SettingsApprovalDialog";
import { connectorPanelSource } from "../connectors/connector-links";
import { toolPanelSource } from "../tools/tool-links";
import { setSkillSwitch } from "./skill-switch-store";
import { SkillPanel } from "./SkillPanel";
import { SkillsTab } from "./SkillsTab";
import { __resetSkillSwitchesForTests } from "./use-skill-switch";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
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
const decisions = vi.hoisted(() => ({ resolveApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...decisions,
}));
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));

const LIST_KEY = skillListQuery("ws-1").queryKey;
const APPROVAL_ID = "5f0b6d2e-6c1a-4d3e-9b7a-2f1e0c9d8b7a";
const SOURCE_URL = "https://github.com/acme/writing-skills.git";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TREE = "fe".repeat(32);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

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

const ITEMS: CapabilitySkillItem[] = [
  skill({
    skillId: "acme-writer-v2",
    name: "Writer",
    description: "Drafts and edits prose.",
    origin: "imported",
    tags: ["prose", "editing"],
  }),
  skill({ skillId: "notes", name: "Notes", category: "personal", state: "paused", lifecycleState: "trusted" }),
  skill({ skillId: "planner", name: "Planner", category: "planning", state: "off", callable: false, tags: ["prose"] }),
  skill({ skillId: "locked", name: "Locked down", category: "automation", pinned: true }),
  skill({ skillId: "house-style-id", name: "House style", origin: "workspace", switchable: false }),
];

function listOf(items: readonly CapabilitySkillItem[] = ITEMS): CapabilitySkillsResponse {
  return {
    workspaceId: "ws-1",
    items: [...items],
    operatorApprovalSkip: false,
    issues: [],
    generatedAt: "2026-10-29T10:00:00.000Z",
  };
}

function usageOf(entries: CapabilitySkillUsageResponse["skills"] = []): CapabilitySkillUsageResponse {
  return { since: "2025-10-29T00:00:00.000Z", generatedAt: "2026-10-29T10:00:00.000Z", skills: entries };
}

function detailOf(skillId: string, overrides: Partial<CapabilitySkillDetail> = {}): CapabilitySkillDetail {
  return {
    skillId,
    instructionBody: "Write in plain words.\n\nKeep each sentence short.",
    keywords: ["drafting"],
    declaredTools: ["fs.read"],
    requires: ["pandoc"],
    provenance: { source: "git", sourceRef: SOURCE_URL, sourceProvider: "github", commitSha: COMMIT, treeSha256: TREE },
    trustLabel: "operator_reviewed",
    reviewWarning: "Reads the files you name.",
    note: "Kept on for the newsletter.",
    catalogEntry: {
      capabilityId: `skill:${skillId}`,
      kind: "skill",
      category: "community_imported",
      title: "Writer",
      summary: "Drafts and edits prose.",
      callable: true,
      lifecycleState: "approved",
      sourceRef: SOURCE_URL,
      sourceProvider: "github",
      skillId,
    },
    ...overrides,
  };
}

/** A skill change waiting on the operator, as the Gateway makes it: danger, and in no workspace. */
function skillApproval(): ApprovalRequest {
  return {
    approvalId: APPROVAL_ID,
    kind: "skill.lifecycle",
    riskLevel: "danger",
    status: "pending",
    payload: {
      skillLifecycle: {
        schemaVersion: "goatcitadel.skill-lifecycle-approval.v1",
        scopeKind: "global",
        subjectKind: "skill",
        subjectId: "planner",
        action: "skill_state_set",
        requestSha256: "a".repeat(64),
        expectedStateSha256: "b".repeat(64),
      },
      request: {
        schemaVersion: "goatcitadel.skill-lifecycle-request.v1",
        requesterId: "operator",
        mutation: { skillId: "planner", state: "enabled", note: null },
      },
    },
    preview: {
      title: "Approve skill state change",
      action: "skill_state_set",
      skillId: "planner",
      state: "enabled",
      currentState: "disabled",
    },
    createdAt: "2026-10-29T10:00:00.000Z",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    explanationStatus: "not_requested",
  };
}

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
/** The approval as the Gateway holds it now: every read answers it, and a decision changes it. */
let stored: ApprovalRequest;

const body = () => document.body.querySelector<HTMLElement>('[data-inspector-body="true"]');
const panelText = () => body()?.textContent ?? "";
const inspectorNamed = (name: string) => document.body.querySelector(`[aria-label="Inspector: ${name}"]`);
const dialog = () =>
  [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
    (entry) => !entry.querySelector('[data-inspector-body="true"]'),
  );
const buttonIn = (parent: ParentNode | null | undefined, name: string) =>
  [...(parent?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );
const linkIn = (parent: ParentNode | null | undefined, name: string) =>
  [...(parent?.querySelectorAll("a") ?? [])].find((entry) => entry.textContent === name);
const rowOf = (name: string) =>
  [
    ...([...container.querySelectorAll("section")]
      .find((entry) => entry.querySelector("h2")?.textContent === "Installed")
      ?.querySelectorAll("li") ?? []),
  ].find((entry) => entry.querySelector("h3")?.textContent === name)!;
const searchBox = () => container.querySelector<HTMLInputElement>('[role="search"] input')!;
const address = () => window.location.pathname + window.location.search;

async function settle() {
  await act(async () => {
    for (let round = 0; round < 8; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The Skills tab with the real address and the real inspector, as the cockpit shell mounts them. */
async function renderTab(extra: ReactNode = null) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>
            {extra}
            <SkillsTab />
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

async function openPanel(name: string) {
  await press(buttonIn(rowOf(name), `View ${name}`));
  await vi.waitFor(() => expect(inspectorNamed(name)).not.toBeNull());
  await settle();
}

/** Planner's switch waits on the approval, as a click in this tab leaves it. */
function waitOnPlanner() {
  act(() =>
    setSkillSwitch("planner", {
      phase: "waiting",
      skillId: "planner",
      approvalId: APPROVAL_ID,
      target: "on",
      from: "off",
    }),
  );
}

beforeEach(() => {
  // The docked desktop layout.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  prefs.showTechnicalDetails = false;
  api.fetchCapabilitySkills.mockReset().mockResolvedValue(listOf());
  api.fetchCapabilitySkillUsage.mockReset().mockResolvedValue(usageOf());
  api.fetchCapabilitySkillDetail
    .mockReset()
    .mockImplementation(async (_workspaceId: string, skillId: string) => detailOf(skillId));
  api.setCapabilitySkillState.mockReset();
  stored = skillApproval();
  approvals.fetchApproval.mockReset().mockImplementation(async () => stored);
  decisions.resolveApproval.mockReset().mockImplementation(async (_id: string, decision: "approve" | "reject") => {
    stored = {
      ...stored,
      status: decision === "approve" ? "approved" : "rejected",
      resolvedBy: "operator",
      resolvedAt: "2026-10-29T10:01:00.000Z",
    };
    return { approval: stored, effects: [] };
  });
  window.history.replaceState(null, "", "/capabilities/skills?shell=cockpit");
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
  __resetSettingsApprovalDialogsForTests();
  __resetInboxApprovalAttemptsForTests();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Skill panel", () => {
  it("leads with the state, where the skill came from and its category, then its description", async () => {
    await renderTab();
    await openPanel("Notes");

    const badge = body()!.querySelector("[data-tone]");
    expect(badge?.textContent).toBe("Paused");
    expect(panelText()).toContain("Built in");
    expect(panelText()).toContain("Personal");
    expect(panelText()).toContain("Notes does its job.");
    // The inspector's title names the skill, so the panel doesn't say it again.
    expect(document.body.querySelector("aside h2")?.textContent).toBe("Notes");
    expect([...body()!.querySelectorAll("p, h3, span")].some((entry) => entry.textContent === "Notes")).toBe(false);
    // The state word stands once: the switch prints none of its own beside it.
    const control = body()!.querySelector('button[role="switch"]');
    expect(control?.getAttribute("aria-label")).toBe("Turn it on or off: Notes");
    expect(control?.parentElement?.firstElementChild).toBe(control);
    expect([...body()!.querySelectorAll("span, p")].filter((entry) => entry.textContent === "Paused")).toHaveLength(1);
  });

  it("renders a script tag in the instructions as text", async () => {
    api.fetchCapabilitySkillDetail.mockResolvedValue(
      detailOf("acme-writer-v2", {
        instructionBody: "Say hello.\n\n<script>alert(1)</script>\n\nUse **plain** words.",
      }),
    );
    await renderTab();
    await openPanel("Writer");

    // Formatted as safe markdown by Chat's renderer, which leaves HTML out: the tag never becomes an element.
    await vi.waitFor(() => expect(body()!.querySelector(".cockpit-chat-documents strong")?.textContent).toBe("plain"));
    const instructions = body()!.querySelector(".cockpit-chat-documents");
    expect(instructions?.querySelector(".mc-assistant-markdown")).not.toBeNull();
    expect(instructions?.textContent).toContain("Say hello.");
    expect(body()!.querySelector("script")).toBeNull();

    // As written, every character shows, the tag as text.
    await press(buttonIn(body(), "Show as written"));
    expect(body()!.querySelector("pre")?.textContent).toBe(
      "Say hello.\n\n<script>alert(1)</script>\n\nUse **plain** words.",
    );
    expect(panelText()).toContain("<script>alert(1)</script>");
    expect(body()!.querySelector("script")).toBeNull();
    await press(buttonIn(body(), "Show formatted"));
    expect(body()!.querySelector("pre")).toBeNull();
  });

  it("shows the first 12 lines of the instructions, then all of them", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `Step ${index + 1} of the work`);
    api.fetchCapabilitySkillDetail.mockResolvedValue(detailOf("acme-writer-v2", { instructionBody: lines.join("\n") }));
    await renderTab();
    await openPanel("Writer");

    await vi.waitFor(() => expect(panelText()).toContain("Step 12 of the work"));
    expect(panelText()).not.toContain("Step 13 of the work");
    await press(buttonIn(body(), "Show all"));
    expect(panelText()).toContain("Step 20 of the work");
    expect(buttonIn(body(), "Show all")).toBeUndefined();
  });

  it("says how often the skill was used and when it was last used", async () => {
    api.fetchCapabilitySkillUsage.mockResolvedValue(
      usageOf([{ skillId: "acme-writer-v2", uses: 4, lastUsedAt: minutesAgo(5) }]),
    );
    await renderTab();
    await openPanel("Writer");
    expect(panelText()).toContain("Used 4 times in the last year, last used 5 minutes ago");

    await press(buttonIn(document.body, "Close inspector"));
    await openPanel("Notes");
    expect(panelText()).toContain("Not used yet");
    expect(panelText()).not.toContain("last used");
  });

  it("says the uses are unknown when the counts can't be read", async () => {
    api.fetchCapabilitySkillUsage.mockRejectedValue(new Error("offline"));
    await renderTab();
    await openPanel("Writer");
    expect(panelText()).toContain("Uses unknown");
    expect(panelText()).not.toContain("Not used yet");
  });

  it("says where the skill came from and how far it was reviewed, in plain words", async () => {
    await renderTab();
    await openPanel("Writer");
    await vi.waitFor(() => expect(panelText()).toContain("Imported from a Git repository on github.com"));
    expect(panelText()).toContain("Reviewed");

    await press(buttonIn(document.body, "Close inspector"));
    await openPanel("Notes");
    await vi.waitFor(() => expect(panelText()).toContain("Ships with GoatCitadel"));
    expect(panelText()).toContain("Trusted");
  });

  it("checks for changes while the details load, and offers Retry when they can't", async () => {
    const detail = deferred<CapabilitySkillDetail>();
    api.fetchCapabilitySkillDetail.mockReturnValueOnce(detail.promise);
    await renderTab();
    await openPanel("Writer");
    expect(panelText()).toContain("Checking for changes…");

    await act(async () => detail.reject(new Error("The connection dropped.")));
    await settle();
    expect(panelText()).toContain("The skill's instructions couldn't load.");
    // The parts that come from the list still work, the switch with them.
    api.setCapabilitySkillState.mockReturnValue(new Promise(() => {}));
    await press(body()!.querySelector<HTMLButtonElement>('button[role="switch"]'));
    expect(api.setCapabilitySkillState).toHaveBeenCalledTimes(1);

    await press(buttonIn(body(), "Retry"));
    await vi.waitFor(() => expect(panelText()).toContain("Keep each sentence short."));
    expect(panelText()).not.toContain("couldn't load");
  });

  it("says when the skill is not in the list anymore", async () => {
    client.setQueryData(LIST_KEY, listOf(ITEMS.filter((entry) => entry.skillId !== "notes")));
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SkillPanel skillId="notes" onTag={vi.fn()} />
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toContain("This skill isn't in the list anymore.");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("keeps ids, URLs and hashes inside Technical details", async () => {
    const hidden = [
      "acme-writer-v2",
      SOURCE_URL,
      COMMIT,
      TREE,
      "operator_reviewed",
      "Reads the files you name.",
      "Kept on for the newsletter.",
    ];
    await renderTab();
    await openPanel("Writer");
    await vi.waitFor(() => expect(panelText()).toContain("Keep each sentence short."));
    // With Technical details off, none of it is anywhere on the panel.
    expect(body()!.querySelector("details")).toBeNull();
    for (const value of hidden) expect(panelText()).not.toContain(value);

    await press(buttonIn(document.body, "Close inspector"));
    prefs.showTechnicalDetails = true;
    await openPanel("Writer");
    await vi.waitFor(() => expect(panelText()).toContain("Keep each sentence short."));
    const details = [...body()!.querySelectorAll("details")].find(
      (entry) => entry.querySelector("summary")?.textContent === "Technical details",
    )!;
    for (const value of [...hidden, "drafting", "fs.read", "pandoc", "github"]) {
      expect(details.textContent).toContain(value);
    }
    // The catalog entry's policy and source, as Library showed them.
    expect(details.textContent).toContain("Listed as callable.");
    expect(details.textContent).toContain("Source reference:");
    // Outside Technical details, still none of it.
    const outside = panelText().replace(details.textContent ?? "", "");
    for (const value of [...hidden, "github.com/"]) expect(outside).not.toContain(value);
  });
});

describe("Skill panel switch", () => {
  it("pauses and resumes from the panel", async () => {
    api.setCapabilitySkillState.mockReturnValue(new Promise(() => {}));
    await renderTab();

    await openPanel("Writer");
    expect(panelText()).toContain("Takes effect in new chats.");
    expect(buttonIn(body(), "Resume")).toBeUndefined();
    await press(buttonIn(body(), "Pause"));
    expect(api.setCapabilitySkillState).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      skillId: "acme-writer-v2",
      state: "sleep",
      expectedRevision: 3,
    });

    await press(buttonIn(document.body, "Close inspector"));
    await openPanel("Notes");
    expect(panelText()).toContain("Paused skills are used only when you name them in Chat.");
    expect(buttonIn(body(), "Pause")).toBeUndefined();
    await press(buttonIn(body(), "Resume"));
    expect(api.setCapabilitySkillState).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      skillId: "notes",
      state: "enabled",
      expectedRevision: 3,
    });
  });

  it.each([
    ["an off skill", "Planner"],
    ["a pinned skill", "Locked down"],
    ["a skill it can't switch", "House style"],
  ])("offers no Pause or Resume for %s", async (_what, name) => {
    await renderTab();
    await openPanel(name);
    expect(buttonIn(body(), "Pause")).toBeUndefined();
    expect(buttonIn(body(), "Resume")).toBeUndefined();
  });

  it("says why a skill can't be switched, and how a pinned one changes", async () => {
    await renderTab();
    await openPanel("House style");
    expect(body()!.querySelector('[role="switch"]')).toBeNull();
    expect(panelText()).toContain("Can't be switched from here");

    await press(buttonIn(document.body, "Close inspector"));
    await openPanel("Locked down");
    expect(body()!.querySelector<HTMLButtonElement>('[role="switch"]')?.disabled).toBe(true);
    expect(panelText()).toContain("Pinned. Change it through a proposal in Library.");
  });

  it("opens the approval in place once, and keeps Open in Inbox", async () => {
    await renderTab();
    await openPanel("Planner");
    waitOnPlanner();
    await settle();

    await vi.waitFor(() => expect(dialog()).toBeDefined());
    expect(dialog()?.textContent).toContain("Approve skill state change");
    // The approval belongs to no workspace, so it is read without one.
    expect(approvals.fetchApproval).toHaveBeenCalled();
    for (const [, options] of approvals.fetchApproval.mock.calls) {
      expect(options === undefined || !("workspaceId" in (options as object))).toBe(true);
    }
    // Inbox stays one link away, beside the line that says the change waits.
    const link = linkIn(body(), "Open in Inbox");
    const target = new URL(link?.getAttribute("href") ?? "", "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe(APPROVAL_ID);

    // Closed, it doesn't open on its own again, even when the panel opens again; Review approval brings it back.
    await press(buttonIn(dialog(), "Close dialog"));
    expect(dialog()).toBeUndefined();
    await press(buttonIn(document.body, "Close inspector"));
    await openPanel("Planner");
    expect(dialog()).toBeUndefined();
    expect(linkIn(body(), "Open in Inbox")).toBeDefined();
    await press(buttonIn(body(), "Review approval"));
    expect(dialog()).toBeDefined();
  });

  it("reads a skill approval without a workspace and approves it in one click", async () => {
    await renderTab();
    await openPanel("Planner");
    waitOnPlanner();
    await vi.waitFor(() => expect(dialog()).toBeDefined());

    await press(buttonIn(dialog(), "Approve once"));
    expect(decisions.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "approve");
    expect(dialog()).toBeUndefined();
    for (const [, options] of approvals.fetchApproval.mock.calls) {
      expect(options === undefined || !("workspaceId" in (options as object))).toBe(true);
    }
  });

  it("shows a decline from the panel at once", async () => {
    await renderTab();
    await openPanel("Planner");
    waitOnPlanner();
    await vi.waitFor(() => expect(dialog()).toBeDefined());

    await press(buttonIn(dialog(), "Deny"));
    expect(decisions.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "reject");
    // The switch reads the approval at once, without waiting for its next check.
    await vi.waitFor(() => expect(panelText()).toContain("Not changed. The change was declined."));
    expect(linkIn(body(), "Open in Inbox")).toBeUndefined();
  });
});

describe("Opening the skill panel", () => {
  it("opens from ?item= once the list loads and ignores unknown ids", async () => {
    window.history.replaceState(null, "", "/capabilities/skills?item=skill%3Aacme-writer-v2&shell=cockpit");
    const list = deferred<CapabilitySkillsResponse>();
    api.fetchCapabilitySkills.mockReturnValue(list.promise);
    await renderTab();
    // Nothing to open yet: the list has not arrived.
    expect(body()).toBeNull();

    await act(async () => list.resolve(listOf()));
    await vi.waitFor(() => expect(inspectorNamed("Writer")).not.toBeNull());
    expect(address()).toContain("item=skill%3Aacme-writer-v2");
  });

  // An id the list doesn't have, another tab's item, and an id without the prefix are left alone: nothing opens and
  // the address is not rewritten.
  it.each([
    ["a skill the list doesn't have", "skill%3Anope"],
    ["a tool group's item", "group%3Afiles"],
    ["a connector's item", "mcp-server%3Alinear"],
    ["an id without the skill prefix", "acme-writer-v2"],
    ["an empty skill id", "skill%3A"],
  ])("ignores %s", async (_what, item) => {
    window.history.replaceState(null, "", `/capabilities/skills?item=${item}&shell=cockpit`);
    await renderTab();
    await vi.waitFor(() => expect(container.textContent).toContain("Installed"));
    expect(body()).toBeNull();
    expect(address()).toBe(`/capabilities/skills?item=${item}&shell=cockpit`);
  });

  it("puts the skill in the address when View is pressed, and clears it when the panel closes", async () => {
    await renderTab();
    await press(buttonIn(rowOf("Writer"), "View Writer"));
    expect(address()).toBe("/capabilities/skills?item=skill%3Aacme-writer-v2&shell=cockpit");
    await vi.waitFor(() => expect(inspectorNamed("Writer")).not.toBeNull());

    await press(buttonIn(document.body, "Close inspector"));
    expect(body()).toBeNull();
    expect(address()).toBe("/capabilities/skills?shell=cockpit");
    await press(buttonIn(rowOf("Writer"), "View Writer"));
    await vi.waitFor(() => expect(body()).not.toBeNull());
  });

  it("searches the tab when a tag is pressed", async () => {
    await renderTab();
    await openPanel("Writer");
    const tags = [...body()!.querySelectorAll("section")].find(
      (entry) => entry.querySelector("h3")?.textContent === "Tags",
    );
    expect([...(tags?.querySelectorAll("button") ?? [])].map((entry) => entry.textContent)).toEqual([
      "prose",
      "editing",
    ]);

    await press(buttonIn(tags, "prose"));
    expect(body()).toBeNull();
    expect(searchBox().value).toBe("prose");
    expect(address()).toBe("/capabilities/skills?shell=cockpit");
    const shown = [...container.querySelectorAll("li h3")].map((entry) => entry.textContent);
    expect(shown).toEqual(["Writer", "Planner"]);
  });

  describe("keeps the Skills panel apart from the Connectors and Tools panels", () => {
    it.each([
      ["a connector's", connectorPanelSource("acme-writer-v2")],
      ["a tool group's", toolPanelSource("files")],
    ])("does not take %s panel on screen for its own", async (_whose, source) => {
      window.history.replaceState(null, "", "/capabilities/skills?item=skill%3Aacme-writer-v2&shell=cockpit");
      const list = deferred<CapabilitySkillsResponse>();
      api.fetchCapabilitySkills.mockReturnValue(list.promise);
      function OtherPanelOnScreen() {
        const { open } = useInspector();
        useEffect(() => {
          open({ source, title: "Another panel", body: <p>Another panel</p> });
        }, [open]);
        return null;
      }
      await renderTab(<OtherPanelOnScreen />);
      await vi.waitFor(() => expect(inspectorNamed("Another panel")).not.toBeNull());

      // The skill the address names still opens, in place of the other panel.
      await act(async () => list.resolve(listOf()));
      await vi.waitFor(() => expect(inspectorNamed("Writer")).not.toBeNull());
      expect(inspectorNamed("Another panel")).toBeNull();
    });
  });
});

describe("Skill panel focus", () => {
  it("returns focus to the View button", async () => {
    await renderTab();
    const opener = buttonIn(rowOf("Writer"), "View Writer")!;
    await press(opener);
    await vi.waitFor(() => expect(body()).not.toBeNull());

    // Focus moves into the panel, as it does when someone works in it.
    buttonIn(document.body, "Close inspector")?.focus();
    await press(buttonIn(document.body, "Close inspector"));
    expect(body()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
