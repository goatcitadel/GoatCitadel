// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ApprovalRequest,
  CapabilityPluginDetail,
  CapabilityPluginDetailPiece,
  CapabilityPluginInstalledItem,
  CapabilityPluginListItem,
  CapabilityPluginListResponse,
  PluginActionOutcome,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider } from "../../../app/inspector";
import { __resetSettingsApprovalDialogsForTests } from "../../settings/SettingsApprovalDialog";
import { PluginsTab } from "./PluginsTab";
import { httpError } from "./plugin-install.test-support";
import { PLUGINS_LIST_ID } from "./plugin-links";
import { __resetPluginUninstallsForTests } from "./plugin-uninstall-store";
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
  uninstallCapabilityPlugin: vi.fn(),
  fetchCapabilityPluginDetail: vi.fn(),
  fetchCapabilityPluginInspection: vi.fn(),
  fetchCapabilityPlugins: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-plugins", () => api);
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

const PLUGIN_ID = "meeting-tools";
const PLAN_APPROVAL = "approval-uninstall";
const REVOKE_APPROVAL = "approval-revoke-notes";

const CALENDAR: CapabilityPluginDetailPiece = {
  pieceId: "calendar",
  kind: "connector",
  label: "Calendar",
  asksFirst: "Everything it does asks first in Chat.",
  check: { status: "ready" },
  hosts: ["calendar.example.com"],
  state: "added",
  href: "/capabilities/connectors?item=mcp-server%3Aserver-1",
};
const NOTES: CapabilityPluginDetailPiece = {
  pieceId: "notes",
  kind: "skill",
  label: "Meeting notes",
  asksFirst: "Follows your tool rules.",
  check: { status: "ready" },
  skillSnapshotId: "snap-notes",
  state: "added",
  href: "/capabilities/skills?item=skill:extra:meeting-notes",
};
const NO_GIT: CapabilityPluginDetailPiece = {
  pieceId: "no-git",
  kind: "tool_group_off",
  label: "Git",
  asksFirst: "Already off. It stays your own switch.",
  check: { status: "already_there" },
  state: "kept",
};
const CHECKS: CapabilityPluginDetailPiece = {
  pieceId: "checks",
  kind: "prompt_pack",
  label: "Page checks",
  asksFirst: "Adds a prompt pack.",
  check: { status: "ready" },
  state: "added",
};

const ROW: CapabilityPluginInstalledItem = {
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  description: "Notes and agendas for meetings.",
  version: "1.2.0",
  trust: "unverified",
  sourceDisplay: "github.com/acme/meeting-tools",
  state: "installed",
  pieceCounts: { connector: 1, skill: 1 },
  workspaceId: "ws-plugin",
  sourceKind: "git",
};
const BUILT_IN: CapabilityPluginListItem = {
  pluginId: "browser-checks",
  name: "Browser checks",
  description: "Checks pages in a browser.",
  version: "1.0.0",
  trust: "built_in",
  sourceDisplay: "Ships with GoatCitadel",
  state: "available",
  pieceCounts: { connector: 1, skill: 1 },
};

/** The plugin as the Gateway holds it, and how its uninstall moves. */
interface Plugin {
  exists: boolean;
  state: CapabilityPluginDetail["state"];
  pieces: CapabilityPluginDetailPiece[];
  /** Approvals waiting, by id; deciding one moves the plugin on. */
  waiting: Set<string>;
  posts: Array<{ attemptKey?: string }>;
}

let plugin: Plugin;
let list: CapabilityPluginListResponse;
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function detailOf(current: Plugin): CapabilityPluginDetail {
  return {
    ...ROW,
    state: current.state,
    pin: { kind: "commit", commit: "c".repeat(40) },
    manifestSha256: "d".repeat(64),
    installPlanId: "plan-install",
    installedAt: "2026-11-01T10:00:00.000Z",
    pieces: current.pieces,
  };
}

function approval(approvalId: string, preview: Record<string, unknown>): ApprovalRequest {
  return {
    approvalId,
    kind: approvalId === PLAN_APPROVAL ? "change_plan_effect" : "skill_hub.lifecycle",
    riskLevel: "danger",
    status: plugin.waiting.has(approvalId) ? "pending" : "approved",
    payload: {},
    preview,
    linkage: { workspaceId: "ws-plugin" },
    createdAt: "2026-11-01T10:00:00.000Z",
    explanationStatus: "not_requested",
  } as unknown as ApprovalRequest;
}

const address = () => window.location.pathname + window.location.search;
const body = () => document.body.querySelector<HTMLElement>('[data-inspector-body="true"]');
const dialog = () => [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1) ?? null;
const button = (name: string, within: ParentNode | null = document.body) =>
  [...(within?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );

/** Lets every answer and render through, one act per round, so each step that opens or reads something next runs. */
async function settle() {
  for (let round = 0; round < 12; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderTab(at: string) {
  window.history.replaceState(null, "", at);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>
            <PluginsTab />
            <InspectorPanel />
          </InspectorProvider>
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** Moves the address as a link would, and lets the panel it names open and read. */
async function openAddress(at: string) {
  await act(async () => {
    window.history.pushState(null, "", at);
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await settle();
  await settle();
}

async function press(element: HTMLElement | undefined | null) {
  if (!element) throw new Error("nothing to press");
  element.focus();
  await act(async () => element.click());
  await settle();
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  plugin = { exists: true, state: "installed", pieces: [CALENDAR, NOTES], waiting: new Set(), posts: [] };
  list = { installed: [ROW], builtIn: [], operatorApprovalSkip: false, folderSourcesAllowed: true, issues: [] };
  api.fetchCapabilityPlugins.mockReset().mockImplementation(async () => list);
  api.fetchCapabilityPluginDetail.mockReset().mockImplementation(async () => {
    if (!plugin.exists) throw httpError(404, { error: "This plugin isn't installed." });
    return detailOf(plugin);
  });
  api.uninstallCapabilityPlugin.mockReset();
  plans.fetchChangePlan
    .mockReset()
    .mockImplementation(async () => ({ planId: "plan-uninstall", status: "awaiting_approval" }));
  approvals.fetchApproval
    .mockReset()
    .mockImplementation(async (approvalId: string) =>
      approval(
        approvalId,
        approvalId === PLAN_APPROVAL ? { title: "Uninstall Meeting tools" } : { schemaVersion: "v1" },
      ),
    );
  decided.approve = () => {};
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
  __resetPluginUninstallsForTests();
  __resetSettingsApprovalDialogsForTests();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Plugin panel", () => {
  it("shows what the plugin added, each piece with its state and its own link", async () => {
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);

    expect(api.fetchCapabilityPluginDetail).toHaveBeenCalledWith("ws-plugin", PLUGIN_ID, expect.anything());
    const panel = body()!;
    expect(panel.textContent).toContain("Git repository github.com/acme/meeting-tools, pinned to commit ccccccc");
    expect(panel.textContent).toContain("Unverified");
    const links = [...panel.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Calendar", expect.stringContaining("/capabilities/connectors?item=mcp-server%3Aserver-1")],
      ["Meeting notes", expect.stringContaining("/capabilities/skills?item=skill")],
    ]);
    expect(panel.textContent).toContain("Added");
    // Ids and hashes stay out of sight until technical details are asked for.
    expect(panel.textContent).not.toContain("d".repeat(64));
  });

  it("shows an installed Claude Code plugin's format, coverage, left-out list and warnings", async () => {
    const warning = "Its pre-approved tools aren't kept. Your own tool rules and approvals apply.";
    plugin = { ...plugin, pieces: [CALENDAR, { ...NOTES, warnings: [warning] }] };
    api.fetchCapabilityPluginDetail.mockImplementation(async () => ({
      ...detailOf(plugin),
      sourceFormat: "claude_code",
      claudeCode: { translatorVersion: 1, pluginJsonSha256: "e".repeat(64), coverage: { usable: 2, total: 3 } },
      ignored: [
        { kind: "command", label: "go", path: "commands/go.md", reason: "A command runs only in Claude Code." },
      ],
    }));
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);

    const panel = body()!;
    expect(panel.textContent).toContain("Claude Code format · Unverified");
    expect(panel.textContent).toContain("Experimental");
    expect(panel.textContent).toContain("GoatCitadel can use 2 of this plugin's 3 parts.");
    expect(panel.textContent).toContain(warning);
    const titles = [...panel.querySelectorAll("section h3")].map((heading) => heading.textContent);
    expect(titles.indexOf("What it leaves out")).toBe(titles.indexOf("What it added") + 1);
    expect(panel.textContent).toContain("A command runs only in Claude Code.");
    expect(panel.textContent).not.toContain("commands/go.md");
    expect(panel.textContent).not.toContain("e".repeat(64));
  });

  it("opens an available built-in plugin from the list alone, with Install", async () => {
    list = { ...list, installed: [], builtIn: [BUILT_IN] };
    await renderTab("/capabilities/plugins?shell=cockpit&item=plugin%3Abrowser-checks");

    const panel = body()!;
    expect(panel.textContent).toContain("Ready to install");
    expect(panel.textContent).toContain("Ships with GoatCitadel");
    expect(button("Install Browser checks", panel)).toBeDefined();
    expect(api.fetchCapabilityPluginDetail).not.toHaveBeenCalled();
  });

  it("lists what uninstall removes and what stays", async () => {
    plugin.pieces = [CALENDAR, NOTES, NO_GIT, CHECKS];
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    await press(button("Uninstall", body()));

    const lines = [...(dialog()?.querySelectorAll("li") ?? [])].map((item) => item.textContent);
    expect(lines).toEqual([
      "Removes: Calendar, Meeting notes and Page checks",
      "Stays: Git, and the hosts it allowed (calendar.example.com)",
      "Deletes the runs of its prompt packs.",
    ]);
    expect(dialog()?.textContent).toContain("This can't be undone here.");
    await press(button("Keep it", dialog()));
    expect(api.uninstallCapabilityPlugin).not.toHaveBeenCalled();
  });

  it("follows an uninstall until the plugin is gone", async () => {
    api.uninstallCapabilityPlugin.mockImplementation(
      async (_input: unknown, options: { attemptKey?: string }): Promise<PluginActionOutcome> => {
        plugin.posts.push(options);
        if (plugin.posts.length === 1) {
          plugin.waiting.add(PLAN_APPROVAL);
          return {
            planId: "plan-uninstall",
            outcome: "waiting",
            approvalId: PLAN_APPROVAL,
            summary: "Uninstall Meeting tools.",
          };
        }
        plugin.exists = false;
        return { planId: "plan-uninstall-2", outcome: "applied", summary: "Uninstalled Meeting tools." };
      },
    );
    decided.approve = (approvalId) => {
      plugin.waiting.delete(approvalId);
      if (approvalId === PLAN_APPROVAL) {
        // The plan removed the connector and asked to remove the skill: the first pass waits on that.
        plugin.state = "uninstalling";
        plugin.waiting.add(REVOKE_APPROVAL);
        plugin.pieces = [
          { ...CALENDAR, state: "removed", href: undefined },
          {
            ...NOTES,
            state: "waiting_for_approval",
            pendingApprovalId: REVOKE_APPROVAL,
            pendingStep: "revoke",
            href: undefined,
          },
        ];
      } else {
        plugin.pieces = plugin.pieces.map((piece) => ({
          ...piece,
          state: "removed",
          pendingApprovalId: undefined,
          pendingStep: undefined,
        }));
      }
    };
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    await press(button("Uninstall", body()));
    await press(button("Uninstall Meeting tools", dialog()));

    // The plan's own approval opens in place, titled by GoatCitadel.
    expect(dialog()?.textContent).toContain("Uninstall Meeting tools");
    // While it waits, Uninstall isn't offered again: a second press would only make a second plan.
    expect(button("Uninstall", body())).toBeUndefined();
    expect(button("Finish uninstalling", body())).toBeUndefined();
    await press(button("Approve once", dialog()));
    // Then the skill's removal, which carries no title of its own.
    expect(dialog()?.textContent).toContain("Approve removing Meeting notes?");
    await press(button("Approve once", dialog()));

    // The first pass is over and the plugin still reads as uninstalling: the operator finishes it.
    expect(body()?.textContent).toContain("Meeting tools isn't fully uninstalled yet.");
    await press(button("Finish uninstalling", body()));

    expect(plugin.posts).toHaveLength(2);
    expect(plugin.posts[1]?.attemptKey).not.toBe(plugin.posts[0]?.attemptKey);
    expect(api.uninstallCapabilityPlugin).toHaveBeenLastCalledWith(
      { workspaceId: "ws-plugin", pluginId: PLUGIN_ID },
      { attemptKey: expect.any(String) },
    );
    // Gone: the panel closes, the address is the tab's, and focus is back on the list.
    await settle();
    expect(body()).toBeNull();
    expect(address()).toBe("/capabilities/plugins?shell=cockpit");
    expect(document.activeElement?.id).toBe(PLUGINS_LIST_ID);

    // Installed again in the same session: its panel reads the live plugin, with nothing left of the uninstall.
    plugin.exists = true;
    plugin.state = "installed";
    plugin.pieces = [CALENDAR, NOTES];
    await openAddress(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    expect(body()?.textContent).toContain("What it added");
    expect(body()?.textContent).not.toContain("This plugin isn't installed.");
    expect(body()?.textContent).not.toContain("Uninstalled Meeting tools.");
    expect(button("Uninstall", body())).toBeDefined();
  });

  it("stops reading once the next move is the operator's, and ends when the second pass is declined", async () => {
    plugin.state = "uninstalling";
    plugin.pieces = [
      { ...CALENDAR, state: "removed", href: undefined },
      { ...NOTES, state: "removed", href: undefined },
    ];
    list = { ...list, installed: [{ ...ROW, state: "uninstalling" }] };
    api.uninstallCapabilityPlugin.mockResolvedValue({
      planId: "plan-uninstall-2",
      outcome: "waiting",
      approvalId: "approval-second",
      summary: "Uninstall Meeting tools.",
    });
    // The operator declined the second pass in Inbox.
    plans.fetchChangePlan.mockResolvedValue({
      planId: "plan-uninstall-2",
      status: "failed",
      result: { failureCode: "approval_denied", summary: "Approval denied." },
    });
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    await press(button("Finish uninstalling", body()));

    expect(body()?.querySelector('[role="alert"]')?.textContent).toBe("Not uninstalled. The request was declined.");
    const reads = api.fetchCapabilityPluginDetail.mock.calls.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    });
    await settle();
    expect(api.fetchCapabilityPluginDetail.mock.calls.length).toBe(reads);
    expect(button("Finish uninstalling", body())).toBeDefined();
  });

  it("reads a failed uninstall out once, as an alert", async () => {
    api.uninstallCapabilityPlugin.mockResolvedValue({
      planId: "plan-uninstall",
      outcome: "failed",
      summary: "Calendar couldn't be removed. Uninstall Meeting tools again to finish.",
    });
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    await press(button("Uninstall", body()));
    await press(button("Uninstall Meeting tools", dialog()));

    const alert = body()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Calendar couldn't be removed. Uninstall Meeting tools again to finish.");
    expect(body()?.textContent?.split("Calendar couldn't be removed.").length).toBe(2);
  });

  it("offers Finish uninstalling for a plugin an uninstall left part way", async () => {
    plugin.state = "uninstalling";
    plugin.pieces = [
      { ...CALENDAR, state: "removed", href: undefined },
      { ...NOTES, state: "added" },
    ];
    list = { ...list, installed: [{ ...ROW, state: "uninstalling" }] };
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);

    expect(button("Finish uninstalling", body())).toBeDefined();
    expect(button("Uninstall", body())).toBeUndefined();
  });

  it("shows GoatCitadel's own words when an uninstall is refused", async () => {
    api.uninstallCapabilityPlugin.mockRejectedValue(
      httpError(409, { error: "Another change to Meeting tools is under way. Try again once it ends." }),
    );
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    await press(button("Uninstall", body()));
    await press(button("Uninstall Meeting tools", dialog()));

    expect(body()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Another change to Meeting tools is under way. Try again once it ends.",
    );
  });

  it("offers Uninstall when an install stopped at a piece that isn't a skill", async () => {
    plugin.state = "install_not_finished";
    plugin.pieces = [
      { ...CALENDAR, state: "failed", href: undefined },
      { ...NOTES, state: "check_passed" },
    ];
    list = { ...list, installed: [{ ...ROW, state: "install_not_finished" }] };
    plans.fetchChangePlan.mockResolvedValue({
      planId: "plan-install",
      status: "manual_required",
      result: { summary: "Calendar couldn't be added. Uninstall Meeting tools to remove what it added." },
    });
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);

    expect(body()?.textContent).toContain(
      "Calendar couldn't be added. Uninstall Meeting tools to remove what it added.",
    );
    expect(button("Uninstall", body())).toBeDefined();
    expect(button("Continue", body())).toBeUndefined();

    // Nothing was added for the connector whose add failed, nor for the skill that never started.
    await press(button("Uninstall", body()));
    const lines = [...(dialog()?.querySelectorAll("li") ?? [])].map((item) => item.textContent ?? "");
    expect(lines.some((line) => line.startsWith("Removes"))).toBe(false);
    expect(lines).toContain("Stays: the hosts it allowed (calendar.example.com)");
  });
});
