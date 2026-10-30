// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ApprovalRequest,
  CapabilitySkillActionOutcome,
  CapabilitySkillInstall,
  CapabilitySkillOperationRequest,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { InspectorProvider } from "../../../app/inspector";
import { __resetInboxApprovalAttemptsForTests } from "../../inbox/inbox-approval-attempts";
import { __resetSettingsApprovalDialogsForTests } from "../../settings/SettingsApprovalDialog";
import { __resetSkillInstallPanelsForTests, SkillInstallPanel } from "./SkillInstallPanel";
import { __resetSkillInstallsForTests } from "./use-skill-install";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const api = vi.hoisted(() => ({
  reviewCapabilitySkill: vi.fn(),
  requestCapabilitySkillOperation: vi.fn(),
  fetchCapabilitySkillInstalls: vi.fn(),
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

const CHECK_ID = "snap-1";
const PACK = { kind: "pack", packId: "himalaya" } as const;
const NO_ASKS = {
  tools: [],
  networkHosts: [],
  envVars: [],
  readsFiles: [],
  writesFiles: [],
  includesScripts: false,
  requires: [],
};

function checked(overrides: Partial<CapabilitySkillInstall> = {}): CapabilitySkillInstall {
  return {
    snapshotId: CHECK_ID,
    name: "Himalaya",
    description: "Read, search, organise and send mail.",
    source: PACK,
    step: "check_passed",
    blockers: [],
    asksFor: { ...NO_ASKS, tools: ["tool:shell.exec"], requires: ["himalaya"] },
    ...overrides,
  };
}

/** A Skill Hub step's approval as the Gateway makes it: danger, never expiring, linked to the workspace that asked. */
function hubApproval(approvalId: string, operationKind: "install_inactive" | "activate"): ApprovalRequest {
  const intent = {
    operationId: `operation-${operationKind}`,
    idempotencyKey: "key-1",
    workspaceId: "ws-1",
    operationKind,
    snapshotId: CHECK_ID,
    contentTreeSha256: "b".repeat(64),
    skillId: "extra:himalaya",
    targetCandidateId: "skill-hub-candidate-1",
    targetVersionId: "skill-hub-version-1",
    expectedCandidateAbsent: true,
    expectedRuntimeAbsent: true,
    actorId: "operator",
    createdAt: "2026-10-30T10:00:00.000Z",
  };
  return {
    approvalId,
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

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
/** The install as the Gateway reads it now, and whether the operator's skip applies. */
let server: CapabilitySkillInstall;
let skip: boolean | "unreadable";
let stored: Record<string, ApprovalRequest>;
const onMove = vi.fn();
const onDone = vi.fn();

const text = () => container.textContent ?? "";
const button = (name: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );
const headings = () => [...container.querySelectorAll("h3")].map((heading) => heading.textContent);
const section = (title: string) =>
  [...container.querySelectorAll("section")].find((entry) => entry.querySelector("h3")?.textContent === title);
const lines = (title: string) => [...(section(title)?.querySelectorAll("li") ?? [])].map((line) => line.textContent);
/** Each step as "<name> <status>", with the button beside a step that waits. */
const steps = () =>
  [...(section("Progress")?.querySelectorAll("ol > li") ?? [])].map((row) =>
    [...row.querySelectorAll(":scope > span:first-child, [data-tone], button")]
      .map((part) => part.textContent?.trim())
      .join(" "),
  );
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

async function settle() {
  await act(async () => {
    for (let round = 0; round < 8; round += 1) await vi.advanceTimersByTimeAsync(0);
  });
}

async function beat(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function render(installKey = CHECK_ID) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>
            <SkillInstallPanel installKey={installKey} onMove={onMove} onDone={onDone} />
          </InspectorProvider>
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function press(element: HTMLElement | undefined | null) {
  if (!element) throw new Error("nothing to press");
  element.focus();
  await act(async () => element.click());
  await settle();
}

/** The Gateway's answer to a step: `approved` with the skip on, `waiting` without it, and where it leaves the install. */
function answerSteps(status: "approved" | "waiting") {
  api.requestCapabilitySkillOperation.mockImplementation(
    async ({ operationKind }: CapabilitySkillOperationRequest): Promise<CapabilitySkillActionOutcome> => {
      const install = operationKind === "install_inactive";
      const approvalId = install ? "approval-install" : "approval-on";
      stored[approvalId] = hubApproval(approvalId, operationKind);
      server =
        status === "approved"
          ? checked({ step: install ? "installing" : "switching_on" })
          : checked({ step: install ? "waiting_install" : "waiting_switch_on", approvalId });
      return { status, approvalId };
    },
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  prefs.showTechnicalDetails = false;
  server = checked();
  skip = false;
  stored = {};
  api.reviewCapabilitySkill.mockReset();
  api.requestCapabilitySkillOperation.mockReset();
  api.fetchCapabilitySkillInstalls
    .mockReset()
    .mockImplementation(async (_workspaceId: string, options: { snapshotId?: string }) => {
      if (!options.snapshotId && skip === "unreadable") throw new Error("offline");
      return {
        workspaceId: "ws-1",
        installs: options.snapshotId === server.snapshotId ? [server] : [],
        operatorApprovalSkip: skip === true,
        generatedAt: "2026-10-30T10:00:00.000Z",
      };
    });
  approvals.fetchApproval.mockReset().mockImplementation(async (approvalId: string) => stored[approvalId]);
  decisions.resolveApproval.mockReset().mockImplementation(async (approvalId: string, decision: string) => {
    stored[approvalId] = {
      ...stored[approvalId]!,
      status: decision === "approve" ? "approved" : "rejected",
      resolvedBy: "operator",
      resolvedAt: "2026-10-30T10:01:00.000Z",
    };
    return { approval: stored[approvalId], effects: [] };
  });
  onMove.mockReset();
  onDone.mockReset();
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
  __resetSkillInstallsForTests();
  __resetSkillInstallPanelsForTests();
  __resetSettingsApprovalDialogsForTests();
  __resetInboxApprovalAttemptsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

describe("Install panel: what the operator judges", () => {
  it("lists what the skill asks for with tool labels, not ids", async () => {
    server = checked({
      asksFor: {
        tools: ["tool:shell.exec", "tool:shell.exec", "tool:browser.search"],
        networkHosts: ["api.github.com", "uploads.github.com"],
        envVars: ["GH_TOKEN", "GH_HOST"],
        readsFiles: ["~/.config/gh"],
        writesFiles: ["~/.cache/gh"],
        includesScripts: true,
        requires: ["gh"],
      },
    });
    await render();

    expect(lines("What it asks for")).toEqual([
      "Run a shell command",
      "Search the web",
      "Reaches api.github.com and uploads.github.com",
      "Needs settings: GH_TOKEN, GH_HOST",
      "Reads ~/.config/gh",
      "Writes ~/.cache/gh",
      "Needs gh",
      "Includes scripts. Installing it doesn't run them.",
    ]);
    expect(text()).not.toContain("tool:");
    expect(text()).not.toContain("shell.exec");
  });

  it("says when a skill asks for nothing beyond its instructions", async () => {
    server = checked({ asksFor: NO_ASKS });
    await render();
    expect(lines("What it asks for")).toEqual(["Nothing beyond its instructions"]);
  });

  it("shows a pack's program and where it was adapted from", async () => {
    await render();

    const where = section("Where it comes from")!;
    expect(where.textContent).toContain("A skill pack that ships with GoatCitadel");
    expect(where.textContent).toContain("Needs the himalaya program on the computer running GoatCitadel.");
    expect(where.textContent).toContain("Adapted from OpenClaw skills/himalaya (MIT)");
    const program = where.querySelector("a")!;
    expect(program.textContent).toBe("himalaya");
    expect(program.getAttribute("href")).toBe("https://github.com/pimalaya/himalaya");
    expect(program.getAttribute("target")).toBe("_blank");
    expect(program.getAttribute("rel")?.split(" ").sort()).toEqual(["noopener", "noreferrer"]);
    expect(section("What it does")?.textContent).toContain("Read, search, organise and send mail.");
  });

  it("omits What it does when the source has no description", async () => {
    server = checked({
      name: "acme-skills",
      description: "",
      source: {
        kind: "git",
        sourceRef: "https://github.com/acme/skills",
        host: "github.com",
        commit: "0123456789abcdef0123456789abcdef01234567",
      },
    });
    await render();

    expect(headings()).not.toContain("What it does");
    expect(section("Where it comes from")?.textContent).toContain("A Git repository on github.com");
    // The address and the commit are only in Technical details.
    expect(text()).not.toContain("https://github.com/acme/skills");
    expect(text()).not.toContain("0123456789abcdef");
    act(() => {
      prefs.showTechnicalDetails = true;
    });
    await render();
    expect(section("Where it comes from")?.textContent).toContain("https://github.com/acme/skills");
  });

  it("explains each blocker in plain words and offers no Install", async () => {
    server = checked({
      step: "blocked",
      blockers: ["SUSPICIOUS_SCRIPT_INDICATOR", "AUDIT_MISSING", "SOMETHING_NEW"],
    });
    await render();

    expect(lines("Checks")).toEqual([
      "It includes scripts that look unsafe.",
      "Some of GoatCitadel's checks didn't run on it.",
      "It didn't pass one of GoatCitadel's checks.",
      "So it can't be installed.",
    ]);
    expect(button("Install and switch on")).toBeUndefined();
    expect(headings()).not.toContain("What happens next");
    expect(steps()[0]).toContain("Didn't pass");
    // The codes are only in the details, which are off unless the operator turned them on.
    expect(text()).not.toContain("SUSPICIOUS_SCRIPT_INDICATOR");
    prefs.showTechnicalDetails = true;
    await render();
    const details = [...(section("Checks")?.querySelectorAll("details") ?? [])];
    expect(details[0]?.querySelector("summary")?.textContent).toBe("Show details");
    expect(details[0]?.textContent).toContain("SUSPICIOUS_SCRIPT_INDICATOR, AUDIT_MISSING, SOMETHING_NEW");
  });

  it("says only that a skill is installed already when that is why", async () => {
    server = checked({ step: "blocked", blockers: ["SOURCE_ALREADY_INSTALLED"] });
    await render();
    expect(lines("Checks")).toEqual(["It's already installed."]);
  });

  it("says what happens next from the skip setting, and nothing when it can't be read", async () => {
    skip = true;
    await render();
    expect(section("What happens next")?.textContent).toContain(
      "Installs and switches on at once, because your setting to skip approvals for your own changes is on.",
    );
    expect(section("Checks")?.textContent).toContain("Passed GoatCitadel's checks");
    expect(button("Install and switch on")?.disabled).toBe(false);

    skip = false;
    await act(async () => client.invalidateQueries());
    await settle();
    expect(section("What happens next")?.textContent).toContain(
      "Asks you twice: once to install it and once to switch it on.",
    );

    skip = "unreadable";
    client.clear();
    __resetSkillInstallsForTests();
    await render();
    expect(headings()).not.toContain("What happens next");
    expect(button("Install and switch on")).toBeDefined();
  });
});

describe("Install panel: installing", () => {
  it("waits for each step in place when the setting is off", async () => {
    answerSteps("waiting");
    await render();
    await press(button("Install and switch on"));

    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Approve installing Himalaya?");
    expect(dialog()?.textContent).toContain("Installs Himalaya switched off. It can't be used until you switch it on.");
    // A Skill Hub approval belongs to the workspace that asked, so it is read there, never in "default".
    expect(approvals.fetchApproval).toHaveBeenCalledWith(
      "approval-install",
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
    expect(steps()[1]).toContain("Waiting for your approval");
    expect(button("Review the change")).toBeDefined();
    for (const where of [container, dialog()!]) {
      expect(where.querySelector('a[href*="inbox"]')).toBeNull();
      expect(where.textContent).not.toContain("Inbox");
    }
    expect(api.requestCapabilitySkillOperation).toHaveBeenCalledTimes(1);

    // Approved in place: read at once, and installed it asks to switch on, which waits for its own approval.
    server = checked({ step: "installed_off" });
    await press(button("Approve once", dialog()!));
    expect(decisions.resolveApproval).toHaveBeenCalledWith("approval-install", "approve");
    await settle();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Approve switching on Himalaya?");
    expect(dialog()?.textContent).toContain("Lets the AI use Himalaya in new chats.");
    expect(api.requestCapabilitySkillOperation.mock.calls.map(([request]) => request.operationKind)).toEqual([
      "install_inactive",
      "activate",
    ]);
    expect(steps()).toEqual(["Check Passed", "Install Done", "Switch on Waiting for your approval Review the change"]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it("never shows Installed before switch on settles", async () => {
    skip = true;
    answerSteps("approved");
    await render();
    await press(button("Install and switch on"));

    const notYet = () => {
      expect(text()).not.toMatch(/installed/iu);
      expect(onDone).not.toHaveBeenCalled();
    };
    expect(steps()[1]).toContain("Installing…");
    notYet();
    server = checked({ step: "installed_off" });
    await beat(1_000);
    expect(steps()[2]).toContain("Switching on…");
    notYet();
    await beat(1_000);
    notYet();
    server = checked({ step: "done", installedSkillId: "extra:himalaya" });
    await beat(1_000);

    expect(onDone).toHaveBeenCalledExactlyOnceWith("extra:himalaya", "Himalaya");
    expect(text()).toContain("Himalaya is installed and switched on.");
  });

  it("picks up an install left between its steps after a reload, and offers Switch on", async () => {
    answerSteps("waiting");
    server = checked({ step: "installed_off" });
    await render();

    expect(text()).toContain("Installed, not switched on");
    expect(button("Install and switch on")).toBeUndefined();
    await press(button("Switch on"));
    expect(api.requestCapabilitySkillOperation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      snapshotId: CHECK_ID,
      operationKind: "activate",
    });
    await settle();
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Approve switching on Himalaya?");
  });

  it("says the request was declined and offers Install again", async () => {
    answerSteps("waiting");
    await render();
    await press(button("Install and switch on"));
    await settle();
    expect(dialog()).not.toBeNull();
    await press(button("Close dialog", dialog()!));

    // Declined in the Inbox: the next read finds the check as it was.
    server = checked();
    await beat(5_000);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Not installed. The request was declined.");
    expect(button("Install and switch on")?.disabled).toBe(false);
    expect(button("Review the change")).toBeUndefined();
  });

  it("names the step that didn't finish and checks the source again afresh", async () => {
    skip = true;
    answerSteps("approved");
    await render();
    await press(button("Install and switch on"));
    server = checked({ step: "failed", failure: "GoatCitadel's checks stopped the install." });
    await beat(1_000);

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Installing didn't finish.GoatCitadel's checks stopped the install.",
    );
    expect(steps()[1]).toContain("Didn't finish");
    // Asking for the same step again would hand back the same approval and run nothing, so a new check is offered.
    expect(button("Install and switch on")).toBeUndefined();
    api.reviewCapabilitySkill.mockResolvedValue(checked({ snapshotId: "snap-2" }));
    await press(button("Check again"));

    expect(api.reviewCapabilitySkill).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      source: PACK,
      idempotencyKey: expect.any(String),
    });
    // The panel showed a check of its own, so the new one takes its place in the address.
    expect(onMove).toHaveBeenCalledExactlyOnceWith("snap-2", true);
  });

  it("says when an address names an install that can't be found", async () => {
    server = checked({ snapshotId: "another" });
    await render();
    expect(text()).toContain("This install can't be found anymore.");
  });
});
