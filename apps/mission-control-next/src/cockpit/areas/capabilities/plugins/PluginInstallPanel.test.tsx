// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ApprovalRequest,
  CapabilityPluginInspection,
  CapabilityPluginListResponse,
  CapabilitySkillOperationRequest,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSettingsApprovalDialogsForTests } from "../../settings/SettingsApprovalDialog";
import { PluginInstallPanel } from "./PluginInstallPanel";
import {
  CALENDAR,
  INSPECTION_ID,
  NOTES,
  PLAN_ID,
  PLUGIN_APPROVAL,
  PLUGIN_KEY,
  WATCH,
  approvePlugin,
  approveStep,
  fakeGateway,
  httpError,
  inspectionOf,
  install,
  readDetail,
  readPlan,
  step,
  type FakeGateway,
} from "./plugin-install.test-support";
import { draftPluginInstallKey } from "./plugin-install-store";
import { __resetPluginInstallsForTests } from "./use-plugin-install";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const api = vi.hoisted(() => ({
  inspectCapabilityPlugin: vi.fn(),
  installCapabilityPlugin: vi.fn(),
  fetchCapabilityPluginDetail: vi.fn(),
  fetchCapabilityPluginInspection: vi.fn(),
  fetchCapabilityPlugins: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-plugins", () => api);
const skills = vi.hoisted(() => ({
  requestCapabilitySkillOperation: vi.fn(),
  fetchCapabilitySkillInstalls: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => skills);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));
const approvals = vi.hoisted(() => ({ fetchApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (original) => ({
  ...(await original<object>()),
  ...approvals,
}));
vi.mock("../../../../features/native-routes/projects/use-project-access", () => ({
  useProjectAccess: () => ({ identity: "access-1" }),
}));
vi.mock("../../inbox/ApprovalReviewSummary", () => ({ ApprovalReviewSummary: () => <p>Full review</p> }));
// The shared decision bar: one Approve once, which decides the approval and reports it as the real one does.
const decided = vi.hoisted(() => ({ approve: (_id: string) => {} }));
vi.mock("../../inbox/ApprovalDecisionBar", () => ({
  ApprovalDecisionBar: (props: { approval: { approvalId: string }; onResolved: () => void }) => (
    <button
      type="button"
      onClick={() => {
        decided.approve(props.approval.approvalId);
        props.onResolved();
      }}
    >
      Approve once
    </button>
  ),
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let gateway: FakeGateway;
let stored: Record<string, ApprovalRequest>;
let list: CapabilityPluginListResponse | "unreadable";
const onMove = vi.fn();

const text = () => container.textContent ?? "";
const button = (name: string, within: ParentNode = container) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );
const section = (title: string) =>
  [...container.querySelectorAll("section")].find((entry) => entry.querySelector("h3")?.textContent === title);
const paragraphs = (title: string) =>
  [...(section(title)?.querySelectorAll("p") ?? [])].map((paragraph) => paragraph.textContent);
const alerts = () => [...container.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent);
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const secretField = () => container.querySelector<HTMLInputElement>('input[type="password"]');

/**
 * Lets every pending answer and render through. The rounds step 1ms: a zero-delay timer set while another timer runs
 * (the query cache's notifications, after a paced read) is due 1ms later under fake timers, never at once.
 */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await vi.advanceTimersByTimeAsync(1);
  });
}

async function beat(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function render(installKey: string, props: { form?: "git" | "folder"; pluginWorkspaceId?: string } = {}) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <PluginInstallPanel installKey={installKey} onMove={onMove} {...props} />
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

async function type(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error("no field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function approval(approvalId: string, preview: Record<string, unknown>): ApprovalRequest {
  return {
    approvalId,
    kind: approvalId === PLUGIN_APPROVAL ? "change_plan_effect" : "skill_hub.lifecycle",
    riskLevel: "danger",
    status: "pending",
    payload: approvalId === PLUGIN_APPROVAL ? { planId: PLAN_ID } : {},
    preview,
    linkage: { workspaceId: "ws-1" },
    createdAt: "2026-11-01T10:00:00.000Z",
    explanationStatus: "not_requested",
  } as unknown as ApprovalRequest;
}

function listAnswer(skip: boolean): CapabilityPluginListResponse {
  return { installed: [], builtIn: [], operatorApprovalSkip: skip, folderSourcesAllowed: true, issues: [] };
}

/** The panel at an inspection, as an address opens it: read from the Gateway. */
async function renderInspection(inspection: CapabilityPluginInspection) {
  gateway = fakeGateway(inspection);
  await render(inspection.inspectionId);
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
  gateway = fakeGateway();
  list = listAnswer(true);
  stored = {};
  api.fetchCapabilityPlugins.mockReset().mockImplementation(async () => {
    if (list === "unreadable") throw httpError(503, { error: "Plugins can't be read right now." });
    return list;
  });
  api.fetchCapabilityPluginInspection.mockReset().mockImplementation(async () => gateway.inspection);
  api.inspectCapabilityPlugin.mockReset().mockImplementation(async () => gateway.inspection);
  api.installCapabilityPlugin.mockReset().mockImplementation(async () => {
    const outcome = install(gateway);
    if (outcome.approvalId) {
      stored[outcome.approvalId] = approval(outcome.approvalId, {
        title: "Install Meeting tools",
        summary: "Adds Calendar and Meeting notes.",
      });
    }
    return outcome;
  });
  api.fetchCapabilityPluginDetail.mockReset().mockImplementation(async () => {
    if (!gateway.installed) throw httpError(404, { error: "This plugin isn't installed." });
    return readDetail(gateway);
  });
  plans.fetchChangePlan.mockReset().mockImplementation(async () => readPlan(gateway));
  skills.requestCapabilitySkillOperation
    .mockReset()
    .mockImplementation(async (request: CapabilitySkillOperationRequest) => {
      const outcome = step(gateway, request);
      // A Skill Hub step's approval carries no title of its own.
      if (outcome.status === "waiting")
        stored[outcome.approvalId] = approval(outcome.approvalId, { schemaVersion: "v1" });
      return outcome;
    });
  skills.fetchCapabilitySkillInstalls.mockReset();
  approvals.fetchApproval.mockReset().mockImplementation(async (approvalId: string) => stored[approvalId]);
  decided.approve = (approvalId) => {
    stored[approvalId] = { ...stored[approvalId]!, status: "approved" };
  };
  onMove.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetPluginInstallsForTests();
  __resetSettingsApprovalDialogsForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Plugin install panel: what the operator judges", () => {
  it("says what it is, where it comes from and what it adds, piece by piece", async () => {
    await renderInspection(inspectionOf([CALENDAR, NOTES]));

    const about = section("What it is")!;
    expect(about.textContent).toContain("Meeting tools");
    expect(about.textContent).toContain("Version 1.2.0");
    expect(about.textContent).toContain("By Acme");
    expect(about.textContent).toContain("Notes and agendas for meetings.");
    expect(section("Where it comes from")?.textContent).toContain("Ships with GoatCitadel");
    expect(section("Where it comes from")?.textContent).toContain("Built in");
    expect(section("Where it comes from")?.textContent).not.toContain("hasn't reviewed");

    const rows = [...section("What it adds")!.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("Connector");
    expect(rows[0]).toContain("Calendar");
    expect(rows[0]).toContain("Reading runs freely; creating or changing something asks first in Chat.");
    expect(rows[0]).toContain("Allows calendar.example.com and api.calendar.example.com");
    expect(rows[0]).toContain("Passed GoatCitadel's checks");
    expect(rows[1]).toContain("Skill");
    expect(rows[1]).toContain("Meeting notes");
    // No piece here needs a secret.
    expect(secretField()).toBeNull();
    expect(button("Install")?.disabled).toBe(false);
  });

  it("shows the pin and the unverified warning", async () => {
    await renderInspection(
      inspectionOf([CALENDAR], {
        trust: "unverified",
        sourceKind: "git",
        sourceDisplay: "github.com/acme/meeting-tools",
        pin: { kind: "commit", commit: "0123456789abcdef0123456789abcdef01234567" },
      }),
    );

    const where = section("Where it comes from")!;
    expect(where.textContent).toContain("Git repository github.com/acme/meeting-tools, pinned to commit 0123456");
    expect(where.textContent).toContain("Unverified");
    expect(where.textContent).toContain(
      "GoatCitadel hasn't reviewed this plugin. Its pieces still go through GoatCitadel's checks.",
    );
    // The full pin, the ids and the manifest's hash are only in Technical details.
    expect(text()).not.toContain("0123456789abcdef");
    expect(text()).not.toContain(INSPECTION_ID);
    prefs.showTechnicalDetails = true;
    await render(INSPECTION_ID);
    expect(text()).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(text()).toContain("d".repeat(64));
    expect(text()).toContain(INSPECTION_ID);
  });

  it("says what happens next from the skip setting, and nothing when it can't be read", async () => {
    list = listAnswer(false);
    await renderInspection(inspectionOf([CALENDAR, NOTES]));
    expect(paragraphs("What happens next")).toEqual([
      "Asks you 3 times: once for the plugin and twice for its skill.",
      "Connectors that need a sign-in ask you to sign in afterwards.",
    ]);

    act(() => root.unmount());
    client.clear();
    __resetPluginInstallsForTests();
    root = createRoot(container);
    list = listAnswer(true);
    await renderInspection(inspectionOf([NOTES]));
    expect(paragraphs("What happens next")).toEqual([
      "Installs everything at once, because your setting to skip approvals for your own changes is on.",
    ]);

    act(() => root.unmount());
    client.clear();
    __resetPluginInstallsForTests();
    root = createRoot(container);
    list = "unreadable";
    await renderInspection(inspectionOf([NOTES]));
    expect(section("What happens next")).toBeUndefined();
    expect(button("Install")).toBeDefined();
  });

  it("keeps Install disabled until every hook secret is filled", async () => {
    await renderInspection(inspectionOf([WATCH, NOTES]));
    const install = () => button("Install")!;
    expect(container.querySelectorAll('input[type="password"]')).toHaveLength(1);
    expect(secretField()?.getAttribute("autocomplete")).toBe("new-password");
    expect(section("What it adds")?.textContent).toContain(
      "The secret your receiver checks. GoatCitadel keeps it and never shows it again.",
    );
    expect(install().disabled).toBe(true);

    // The same rule GoatCitadel holds it to: 1 to 512 characters, with no space at either end.
    await type(secretField(), " s3cret");
    expect(install().disabled).toBe(true);
    expect(alerts()).toContain("Use 1 to 512 characters, with no space at either end.");
    await type(secretField(), "x".repeat(513));
    expect(install().disabled).toBe(true);
    await type(secretField(), "s3cret");
    expect(install().disabled).toBe(false);
    expect(alerts()).toEqual([]);

    // A refusal that still comes back shows in its own words, and the secret it spent is gone from the field.
    api.installCapabilityPlugin.mockRejectedValueOnce(
      httpError(400, {
        error: "A signing secret is 1 to 512 characters, with no space at either end.",
        details: { field: "hookSecrets" },
      }),
    );
    await press(install());
    expect(api.installCapabilityPlugin).toHaveBeenCalledWith(
      { workspaceId: "ws-1", inspectionId: INSPECTION_ID, hookSecrets: { watch: "s3cret" } },
      { attemptKey: expect.any(String) },
    );
    expect(alerts()).toContain("A signing secret is 1 to 512 characters, with no space at either end.");
    expect(secretField()?.value).toBe("");
    expect(install().disabled).toBe(true);
  });

  it("explains each refusal in plain words and offers no Install", async () => {
    await renderInspection(
      inspectionOf([], {
        pluginId: "",
        name: "",
        description: "",
        trust: "unverified",
        sourceKind: "git",
        sourceDisplay: "github.com/acme/hooks",
        pin: { kind: "commit", commit: "fedcba9876543210fedcba9876543210fedcba98" },
        manifestSha256: "",
        refusal: {
          code: "HOOK_CODE_NOT_ALLOWED",
          message: "Hook mode managed_package runs code.",
          field: "pieces[1].mode",
        },
        installable: false,
      }),
    );

    expect(alerts()).toEqual(["Its hooks would run code, which plugins can't.So it can't be installed."]);
    expect(button("Install")).toBeUndefined();
    expect(section("Where it comes from")?.textContent).toContain("Git repository github.com/acme/hooks");
    // The refusal's own words and code are for Technical details.
    expect(text()).not.toContain("managed_package");
    expect(text()).not.toContain("HOOK_CODE_NOT_ALLOWED");
    prefs.showTechnicalDetails = true;
    await render(INSPECTION_ID);
    expect(text()).toContain("Hook mode managed_package runs code.");
    expect(text()).toContain("HOOK_CODE_NOT_ALLOWED");
    expect(text()).toContain("pieces[1].mode");

    // A piece GoatCitadel's checks blocked: its own line, and still no Install.
    act(() => root.unmount());
    client.clear();
    __resetPluginInstallsForTests();
    root = createRoot(container);
    prefs.showTechnicalDetails = false;
    await renderInspection(
      inspectionOf(
        [
          {
            ...WATCH,
            needsSecret: true,
            check: { status: "blocked", code: "HOST_NOT_PUBLIC", message: "That address isn't a public host." },
          },
        ],
        {
          installable: false,
        },
      ),
    );
    expect(section("What it adds")?.textContent).toContain("That address isn't a public host.");
    expect(section("What it adds")?.textContent).toContain("So it can't be installed.");
    expect(button("Install")).toBeUndefined();
    expect(secretField()).toBeNull();
    expect(text()).not.toContain("HOST_NOT_PUBLIC");
  });
});

describe("Plugin install panel: installing", () => {
  it("opens each approval in place when the setting is off", async () => {
    list = listAnswer(false);
    gateway.skip = false;
    await render(INSPECTION_ID);
    await press(button("Install"));

    // The plugin's own approval keeps the title GoatCitadel gives it.
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Install Meeting tools");
    expect(approvals.fetchApproval).toHaveBeenCalledWith(
      PLUGIN_APPROVAL,
      expect.objectContaining({ workspaceId: "ws-1" }),
    );
    expect(text()).toContain("Waiting for your approval to install Meeting tools.");
    approvePlugin(gateway);
    await press(button("Approve once", dialog()!));
    expect(onMove).toHaveBeenLastCalledWith(PLUGIN_KEY);

    // At the plugin's own address, its skill's two steps each open their approval in place.
    await render(PLUGIN_KEY);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Approve installing Meeting notes?");
    expect(text()).toContain("Waiting for your approval to install Meeting notes.");
    approveStep(gateway, "notes", "install_inactive");
    await press(button("Approve once", dialog()!));
    await beat(1_000);
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Approve switching on Meeting notes?");
    // Never Installed before the skill is switched on.
    expect(text()).not.toContain("is installed");
    approveStep(gateway, "notes", "activate");
    await press(button("Approve once", dialog()!));
    await beat(1_000);

    expect(gateway.steps).toEqual(["snap-notes install_inactive", "snap-notes activate"]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Meeting tools is installed.");
    expect(text()).toContain("Takes effect in new chats.");
    expect(dialog()).toBeNull();
  });

  it("installs every piece from one press when the setting is on, and says it takes effect in new chats", async () => {
    await render(INSPECTION_ID);
    await press(button("Install"));
    expect(onMove).toHaveBeenLastCalledWith(PLUGIN_KEY);
    await render(PLUGIN_KEY);
    for (let read = 0; read < 10 && !text().includes("is installed"); read += 1) await beat(1_000);

    expect(dialog()).toBeNull();
    expect(text()).toContain("Meeting tools is installed.");
    expect(text()).toContain("Takes effect in new chats.");
    const rows = [...section("What it adds")!.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows.every((row) => row?.includes("Added"))).toBe(true);
  });

  it("continues an install left unfinished after a reload, from its first unfinished piece", async () => {
    gateway.installed = true;
    gateway.workspaceId = "ws-plugin";
    gateway.pieces = { calendar: "added", notes: "installed_off" };
    await render(PLUGIN_KEY, { pluginWorkspaceId: "ws-plugin" });

    expect(api.fetchCapabilityPluginDetail).toHaveBeenCalledWith("ws-plugin", "meeting-tools", expect.anything());
    expect(text()).toContain("Meeting notes is installed, not switched on.");
    expect(skills.requestCapabilitySkillOperation).not.toHaveBeenCalled();
    await press(button("Continue"));
    expect(skills.requestCapabilitySkillOperation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-plugin",
      snapshotId: "snap-notes",
      operationKind: "activate",
    });
    await beat(1_000);
    expect(text()).toContain("Meeting tools is installed.");
  });

  it("shows the folder path typed in Technical details while the panel is open, and its name after a reload", async () => {
    prefs.showTechnicalDetails = true;
    gateway = fakeGateway(
      inspectionOf([NOTES], { trust: "unverified", sourceKind: "folder", sourceDisplay: "meeting-tools" }),
    );
    const draft = draftPluginInstallKey("folder");
    await render(draft, { form: "folder" });
    await type(container.querySelector("input"), "D:\\plugins\\meeting-tools");
    await press(button("Check"));
    expect(api.inspectCapabilityPlugin).toHaveBeenCalledWith(
      { workspaceId: "ws-1", source: { kind: "folder", path: "D:\\plugins\\meeting-tools" } },
      { attemptKey: expect.any(String) },
    );
    expect(onMove).toHaveBeenLastCalledWith(INSPECTION_ID);

    await render(INSPECTION_ID);
    expect(section("Where it comes from")?.textContent).toContain("Folder on this computer");
    expect(text()).toContain("D:\\plugins\\meeting-tools");

    // After a reload only the Gateway's answer is left, which names the folder, never its path.
    __resetPluginInstallsForTests();
    client.clear();
    await render(INSPECTION_ID);
    expect(text()).not.toContain("D:\\plugins");
    expect(text()).toContain("meeting-tools");
  });
});
