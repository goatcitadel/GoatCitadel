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
import { removalLeftoversKey } from "./skill-removal-outcome";
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
  requestCapabilitySkillRemoval: vi.fn(),
  fetchCapabilitySkillRemoval: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => api);
const hub = vi.hoisted(() => ({ fetchSkillHubOperator: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/skill-hub", async (original) => ({
  ...(await original<object>()),
  ...hub,
}));
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

const featureState = vi.hoisted(() => ({ skillsInChat: undefined as boolean | undefined }));
vi.mock("../../settings/feature-switches", async (original) => ({
  ...(await original<object>()),
  useFeatureSwitchOn: () => featureState.skillsInChat,
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
        schemaVersion: "goatcitadel.skill-lifecycle-request-envelope.v1",
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
const review = () => body()?.querySelector("section[aria-labelledby]");
const buttonIn = (parent: ParentNode | null | undefined, name: string) =>
  [...(parent?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );
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
  api.requestCapabilitySkillRemoval.mockReset();
  api.fetchCapabilitySkillRemoval
    .mockReset()
    .mockImplementation(async ({ approvalId }: { approvalId: string }) => ({ approvalId, approvalStatus: "approved" }));
  hub.fetchSkillHubOperator.mockReset();
  hub.fetchSkillHubOperator.mockResolvedValue({ items: [] });
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
  __resetInboxApprovalAttemptsForTests();
  __resetSettingsApprovalDialogsForTests();
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

  it("labels a skill whose content check warned and lists what the check found", async () => {
    const mine = skill({ skillId: "house-style-id", name: "House style", origin: "workspace", scanWarning: true });
    api.fetchCapabilitySkills.mockResolvedValue(
      listOf([mine, ...ITEMS.filter((item) => item.skillId !== mine.skillId)]),
    );
    api.fetchCapabilitySkillDetail.mockImplementation(async (_workspaceId: string, skillId: string) =>
      detailOf(skillId, {
        scanFindings: [{ code: "unsafe_script", path: "scripts/install.sh", line: 2, dangerous: true }],
      }),
    );
    await renderTab();

    expect(rowOf("House style").textContent).toContain("Warning");
    expect(rowOf("Notes").textContent).not.toContain("Warning");

    await openPanel("House style");
    const disclosure = [...body()!.querySelectorAll("details")].find((entry) =>
      entry.querySelector("summary")?.textContent?.includes("What the check found"),
    );
    expect(disclosure).toBeDefined();
    expect(disclosure!.open).toBe(false);
    expect(disclosure!.textContent).toContain("It includes scripts that look unsafe.");
    expect(disclosure!.textContent).toContain("scripts/install.sh");
  });

  it("shows no check findings for a clean skill", async () => {
    await renderTab();
    await openPanel("Notes");
    expect(panelText()).not.toContain("What the check found");
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
  afterEach(() => {
    featureState.skillsInChat = undefined;
  });

  it("says Chat can't use skills while Skills in Chat is off, with a link to its switch", async () => {
    featureState.skillsInChat = false;
    await renderTab();
    await openPanel("Writer");
    expect(panelText()).toContain("Takes effect in new chats.");
    expect(panelText()).toContain("Chat can't use skills yet: Skills in Chat is turned off.");
    const link = [...body()!.querySelectorAll("a")].find(
      (entry) => entry.textContent === "Turn it on in Settings › Advanced",
    );
    expect(new URL(link!.getAttribute("href")!, "http://cockpit.invalid").hash).toBe("#feature-switch-skills-in-chat");
  });

  it("says nothing extra once Skills in Chat is on, or before it has been read", async () => {
    for (const value of [true, undefined]) {
      featureState.skillsInChat = value;
      await renderTab();
      await openPanel("Writer");
      expect(panelText()).not.toContain("Skills in Chat is turned off");
      await press(buttonIn(document.body, "Close inspector"));
    }
  });

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
    expect(panelText()).toContain(
      "Paused skills are used when you name them in Chat. Chat picks one on its own for a close match only if you've turned off first use confirmation.",
    );
    expect(buttonIn(body(), "Pause")).toBeUndefined();
    await press(buttonIn(body(), "Resume"));
    expect(api.setCapabilitySkillState).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      skillId: "notes",
      state: "enabled",
      expectedRevision: 3,
    });
  });

  // Switched on or paused, but the AI can't use it: the line under the state says why, and neither note claims it works.
  it.each([
    [
      "a candidate that is on",
      skill({ skillId: "fresh", name: "Fresh import", callable: false, lifecycleState: "candidate" }),
    ],
    ["a left-out skill that is on", skill({ skillId: "mailer", name: "Mailer", leftOutOfWorkspace: true })],
    [
      "a left-out skill that is paused",
      skill({ skillId: "mailer", name: "Mailer", state: "paused", leftOutOfWorkspace: true }),
    ],
  ])("shows neither the On nor the Paused note for %s", async (_what, item) => {
    api.fetchCapabilitySkills.mockResolvedValue(listOf([...ITEMS, item]));
    await renderTab();
    await openPanel(item.name);
    expect(body()!.querySelector('[role="switch"]')).not.toBeNull();
    expect(panelText()).toContain("so the AI can't use it");
    expect(panelText()).not.toContain("Takes effect in new chats.");
    expect(panelText()).not.toContain(
      "Paused skills are used when you name them in Chat. Chat picks one on its own for a close match only if you've turned off first use confirmation.",
    );
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

  it("keeps review and decisions beside the switch without opening a dialog", async () => {
    await renderTab();
    await openPanel("Planner");
    const toggle = body()!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    toggle.focus();
    waitOnPlanner();
    await settle();

    await vi.waitFor(() => expect(buttonIn(review(), "Approve once")).toBeDefined());
    expect(dialog()).toBeUndefined();
    expect(document.activeElement).toBe(toggle);
    expect(review()?.querySelector("h3")?.textContent).toBe("Approve skill state change");
    expect(review()?.textContent).toContain("Turn Planner on");
    expect(review()?.textContent).toContain("Applies to every workspace.");
    expect(review()?.querySelector("details")?.open).toBe(false);
    // The approval belongs to no workspace, so it is read without one.
    expect(approvals.fetchApproval).toHaveBeenCalled();
    for (const [, options] of approvals.fetchApproval.mock.calls) {
      expect(options === undefined || !("workspaceId" in (options as object))).toBe(true);
    }
    expect(panelText()).toContain("The change applies once you approve it.");
    await press(buttonIn(document.body, "Close inspector"));
    await openPanel("Planner");
    await vi.waitFor(() => expect(buttonIn(review(), "Approve once")).toBeDefined());
    expect(dialog()).toBeUndefined();
  });

  it("keeps the list in place when a row switch asks and opens the panel on Review", async () => {
    // Notes waits on an approval found when the list loads: nobody here just asked, so nothing opens by itself.
    api.fetchCapabilitySkills.mockResolvedValue(
      listOf(
        ITEMS.map((entry) => (entry.skillId === "notes" ? { ...entry, pendingApprovalId: "approval-old" } : entry)),
      ),
    );
    api.setCapabilitySkillState.mockResolvedValueOnce({ status: "waiting", approvalId: APPROVAL_ID });
    await renderTab();
    expect(buttonIn(rowOf("Notes"), "Review Notes")).toBeDefined();
    expect(body()).toBeNull();
    expect(dialog()).toBeUndefined();

    const toggle = rowOf("Planner").querySelector<HTMLElement>('button[role="switch"]');
    await press(toggle);
    expect(api.setCapabilitySkillState).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      skillId: "planner",
      state: "enabled",
      expectedRevision: 3,
    });
    expect(body()).toBeNull();
    expect(document.activeElement).toBe(toggle);
    await press(buttonIn(rowOf("Planner"), "Review Planner"));
    await vi.waitFor(() => expect(inspectorNamed("Planner")).not.toBeNull());
    await vi.waitFor(() => expect(buttonIn(review(), "Approve once")).toBeDefined());
    expect(review()?.textContent).toContain("Turn Planner on");
    expect(dialog()).toBeUndefined();
    await press(buttonIn(review(), "Approve once"));
    await vi.waitFor(() => expect(decisions.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "approve"));
  });

  it("names the exact recorded change for a wait found on load", async () => {
    api.fetchCapabilitySkills.mockResolvedValue(
      listOf(
        ITEMS.map((entry) => (entry.skillId === "planner" ? { ...entry, pendingApprovalId: APPROVAL_ID } : entry)),
      ),
    );
    await renderTab();
    await openPanel("Planner");
    await vi.waitFor(() => expect(buttonIn(review(), "Approve once")).toBeDefined());
    expect(review()?.textContent).toContain("Turn Planner on");
  });

  it("approves a skill change in its panel and never points it at the Inbox, where it also waits", async () => {
    await renderTab();
    waitOnPlanner();
    await settle();
    const noInbox = (where: Element | null | undefined) => {
      expect(where).toBeTruthy();
      expect(where?.querySelector('a[href*="inbox"]')).toBeNull();
      expect(where?.textContent).not.toContain("Inbox");
    };
    noInbox(rowOf("Planner"));
    await openPanel("Planner");
    await vi.waitFor(() => expect(buttonIn(review(), "Approve once")).toBeDefined());
    noInbox(body());

    // Nor when the approval can't be read: the panel says it will try again, and reloading is the way forward.
    await press(buttonIn(document.body, "Close inspector"));
    client.removeQueries({ queryKey: ["approvals", "record"] });
    approvals.fetchApproval.mockRejectedValue(new Error("offline"));
    act(() =>
      setSkillSwitch("planner", {
        phase: "waiting",
        skillId: "planner",
        approvalId: APPROVAL_ID,
        target: "on",
        from: "off",
        unreadable: true,
      }),
    );
    await openPanel("Planner");
    await vi.waitFor(() => expect(panelText()).toContain("Reload to try again."));
    expect(panelText()).toContain("Can't check the approval right now. It will try again.");
    noInbox(body());
    noInbox(rowOf("Planner"));
  });

  it("reads a skill approval without a workspace and approves it in one click", async () => {
    await renderTab();
    await openPanel("Planner");
    waitOnPlanner();
    await vi.waitFor(() => expect(buttonIn(review(), "Approve once")).toBeDefined());

    await press(buttonIn(review(), "Approve once"));
    expect(decisions.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "approve");
    expect(buttonIn(review(), "Approve once")).toBeUndefined();
    expect(document.activeElement).toBe(body()?.querySelector('[role="switch"]'));
    for (const [, options] of approvals.fetchApproval.mock.calls) {
      expect(options === undefined || !("workspaceId" in (options as object))).toBe(true);
    }
  });

  it("shows a decline from the panel at once", async () => {
    await renderTab();
    await openPanel("Planner");
    waitOnPlanner();
    await vi.waitFor(() => expect(buttonIn(review(), "Deny")).toBeDefined());

    await press(buttonIn(review(), "Deny"));
    expect(decisions.resolveApproval).toHaveBeenCalledExactlyOnceWith(APPROVAL_ID, "reject");
    // The switch reads the approval at once, without waiting for its next check.
    await vi.waitFor(() => expect(panelText()).toContain("Not changed. The change was declined."));
    expect(buttonIn(review(), "Deny")).toBeUndefined();
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

describe("Skill panel removal", () => {
  const LEFT_BEHIND = skill({
    skillId: "extra:meeting-notes",
    name: "Meeting notes",
    state: "off",
    callable: false,
    switchable: false,
    lifecycleState: "revoked",
    removedWithPlugin: { name: "Meeting tools" },
    removable: true,
  });
  const WITHOUT_REMOVAL: CapabilitySkillItem = { ...LEFT_BEHIND, removable: undefined };
  const DESCRIPTION =
    "Removes Meeting notes from this install and deletes its folder from GoatCitadel's skills folder. Its plugin was uninstalled, so the AI can't use it. GoatCitadel keeps its check and its records, so you can install it again later. This can't be undone here.";

  /** The removal's approval as the Gateway makes it: danger, never expiring, linked to the workspace that asked. */
  function removalApproval(): ApprovalRequest {
    const intent = {
      operationId: "operation-remove",
      idempotencyKey: "key-1",
      workspaceId: "ws-1",
      operationKind: "remove",
      snapshotId: "check-1",
      contentTreeSha256: "b".repeat(64),
      skillId: "extra:meeting-notes",
      targetCandidateId: "skill-hub-candidate-1",
      targetVersionId: "skill-hub-version-1",
      expectedCandidateRevision: 3,
      expectedRuntimeRevision: 2,
      expectedCandidateAbsent: false,
      expectedRuntimeAbsent: false,
      actorId: "operator",
      createdAt: "2026-10-30T10:00:00.000Z",
    };
    return {
      approvalId: APPROVAL_ID,
      kind: "skill_hub.lifecycle",
      riskLevel: "danger",
      status: "pending",
      payload: { ...intent, requestSha256: "a".repeat(64) },
      preview: { schemaVersion: "goatcitadel.skill-hub-operation-intent.v1", intent },
      linkage: { workspaceId: "ws-1" },
      createdAt: "2026-10-30T10:00:00.000Z",
      explanationStatus: "not_requested",
    } as unknown as ApprovalRequest;
  }

  async function openLeftBehind(item: CapabilitySkillItem = LEFT_BEHIND) {
    api.fetchCapabilitySkills.mockResolvedValue(listOf([...ITEMS, item]));
    await renderTab();
    await openPanel("Meeting notes");
  }

  it("offers Remove skill only for a skill GoatCitadel can remove", async () => {
    await openLeftBehind(WITHOUT_REMOVAL);
    expect(buttonIn(body(), "Remove skill")).toBeUndefined();
    await press(buttonIn(document.body, "Close inspector"));
    await press(buttonIn(rowOf("Planner"), "View Planner"));
    await vi.waitFor(() => expect(inspectorNamed("Planner")).not.toBeNull());
    expect(buttonIn(body(), "Remove skill")).toBeUndefined();
  });

  it("asks before it removes, and keeps the skill when you keep it", async () => {
    await openLeftBehind();
    expect(panelText()).toContain("Removed with Meeting tools");

    await press(buttonIn(body(), "Remove skill"));
    expect(dialog()?.textContent).toContain("Remove this skill?");
    expect(dialog()?.textContent).toContain(DESCRIPTION);
    // The deferred dialog shell renders its description before its controls load.
    await vi.waitFor(() => expect(buttonIn(dialog(), "Keep it")).toBeDefined());
    await press(buttonIn(dialog(), "Keep it"));

    expect(dialog()).toBeUndefined();
    expect(api.requestCapabilitySkillRemoval).not.toHaveBeenCalled();
  });

  it("asks for the removal and opens its danger approval in place", async () => {
    stored = removalApproval();
    api.requestCapabilitySkillRemoval.mockResolvedValue({
      status: "waiting",
      approvalId: APPROVAL_ID,
      workspaceId: "ws-1",
    });
    await openLeftBehind();

    await press(buttonIn(body(), "Remove skill"));
    await press(buttonIn(dialog(), "Remove skill"));

    expect(api.requestCapabilitySkillRemoval).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      skillId: "extra:meeting-notes",
    });
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Approve removing this skill?"));
    // The approval is read in the workspace the Gateway names, and the red two-step review stays.
    expect(approvals.fetchApproval.mock.calls.some(([, options]) => options?.workspaceId === "ws-1")).toBe(true);
    expect(buttonIn(dialog(), "Review danger approval")).toBeDefined();
    expect(buttonIn(dialog(), "Approve once")).toBeUndefined();
    expect(decisions.resolveApproval).not.toHaveBeenCalled();
    // While it waits there is nothing to ask for again.
    await press(buttonIn(dialog(), "Close dialog"));
    expect(buttonIn(body(), "Remove skill")).toBeUndefined();
    expect(buttonIn(body(), "Review the removal")).toBeDefined();
  });

  it("says it is removing once approved, until the list no longer holds the skill", async () => {
    api.requestCapabilitySkillRemoval.mockResolvedValue({
      status: "approved",
      approvalId: APPROVAL_ID,
      workspaceId: "ws-1",
    });
    await openLeftBehind();
    await press(buttonIn(body(), "Remove skill"));
    await press(buttonIn(dialog(), "Remove skill"));

    expect(panelText()).toContain("Removing Meeting notes…");
    expect(buttonIn(body(), "Remove skill")).toBeUndefined();

    // The next read of the list no longer holds it.
    api.fetchCapabilitySkills.mockResolvedValue(listOf(ITEMS));
    await act(async () => {
      await client.invalidateQueries({ queryKey: skillListQuery("ws-1").queryKey });
    });
    await settle();
    expect(panelText()).toContain("This skill isn't in the list anymore.");
  });

  it("says once the skill is gone how many temporary folders the removal left", async () => {
    api.requestCapabilitySkillRemoval.mockResolvedValue({
      status: "approved",
      approvalId: APPROVAL_ID,
      workspaceId: "ws-1",
    });
    api.fetchCapabilitySkillRemoval.mockResolvedValue({
      approvalId: APPROVAL_ID,
      approvalStatus: "approved",
      settlement: { disposition: "applied", reason: "applied", otherScratchFolders: 2 },
    });
    await openLeftBehind();
    // Once the removal settled, the next read of the list no longer holds the skill.
    api.fetchCapabilitySkills.mockResolvedValue(listOf(ITEMS));
    await press(buttonIn(body(), "Remove skill"));
    await press(buttonIn(dialog(), "Remove skill"));

    await vi.waitFor(() => expect(panelText()).toContain("This skill isn't in the list anymore."));
    expect(panelText()).toContain(
      "Removed. GoatCitadel left 2 temporary folders in the skills folder that it couldn't confirm were its own.",
    );
  });

  it("stops reading once the removal applied, and never says it didn't finish", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // An earlier removal's left-over line must not read as this one's.
      client.setQueryData(removalLeftoversKey("ws-1", "extra:meeting-notes"), "an earlier line");
      api.requestCapabilitySkillRemoval.mockResolvedValue({
        status: "approved",
        approvalId: APPROVAL_ID,
        workspaceId: "ws-1",
      });
      api.fetchCapabilitySkillRemoval.mockResolvedValue({
        approvalId: APPROVAL_ID,
        approvalStatus: "approved",
        settlement: { disposition: "applied", reason: "applied" },
      });
      await openLeftBehind();
      await press(buttonIn(body(), "Remove skill"));
      await press(buttonIn(dialog(), "Remove skill"));
      expect(client.getQueryData(removalLeftoversKey("ws-1", "extra:meeting-notes"))).toBeUndefined();

      await vi.waitFor(() => expect(panelText()).toContain("Removed Meeting notes."));
      const reads = api.fetchCapabilitySkillRemoval.mock.calls.length;
      // Well past the 20 reads the panel would otherwise make: nothing more is read, and no "didn't finish".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(api.fetchCapabilitySkillRemoval.mock.calls.length).toBe(reads);
      expect(panelText()).not.toContain("Removing didn't finish");
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains a removal that left the folder alone, and lets you ask again", async () => {
    api.requestCapabilitySkillRemoval.mockResolvedValue({
      status: "approved",
      approvalId: APPROVAL_ID,
      workspaceId: "ws-1",
    });
    api.fetchCapabilitySkillRemoval.mockResolvedValue({
      approvalId: APPROVAL_ID,
      approvalStatus: "approved",
      settlement: { disposition: "manual_reconciliation", reason: "runtime_projection_diverged" },
    });
    await openLeftBehind();
    await press(buttonIn(body(), "Remove skill"));
    await press(buttonIn(dialog(), "Remove skill"));

    await vi.waitFor(() =>
      expect(panelText()).toContain(
        "Not removed. The skill's folder no longer matches the files GoatCitadel checked, so nothing was deleted. Put the checked files back or delete the folder yourself, then remove the skill again.",
      ),
    );
    // Read by the approval it tracks, never by scanning the newest checks.
    expect(api.fetchCapabilitySkillRemoval).toHaveBeenCalledWith({ workspaceId: "ws-1", approvalId: APPROVAL_ID });
    expect(hub.fetchSkillHubOperator).not.toHaveBeenCalled();
    expect(panelText()).not.toContain("Removing Meeting notes…");
    expect(buttonIn(body(), "Remove skill")).toBeDefined();
  });

  it("puts the plain refusal under the button and lets you ask again", async () => {
    api.requestCapabilitySkillRemoval.mockRejectedValueOnce(
      Object.assign(new Error("This skill can't be removed."), { status: 409 }),
    );
    await openLeftBehind();
    await press(buttonIn(body(), "Remove skill"));
    await press(buttonIn(dialog(), "Remove skill"));

    expect(panelText()).toContain("This skill can't be removed.");
    expect(buttonIn(body(), "Remove skill")).toBeDefined();
  });

  it("says a declined removal was declined", async () => {
    stored = removalApproval();
    api.requestCapabilitySkillRemoval.mockResolvedValue({
      status: "waiting",
      approvalId: APPROVAL_ID,
      workspaceId: "ws-1",
    });
    await openLeftBehind();
    await press(buttonIn(body(), "Remove skill"));
    await press(buttonIn(dialog(), "Remove skill"));
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("Approve removing this skill?"));

    await press(buttonIn(dialog(), "Deny"));
    await vi.waitFor(() => expect(panelText()).toContain("Not removed. The request was declined."));
    expect(buttonIn(body(), "Remove skill")).toBeDefined();
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
