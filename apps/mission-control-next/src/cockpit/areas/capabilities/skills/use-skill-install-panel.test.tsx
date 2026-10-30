// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilitySkillDiscoverItem,
  CapabilitySkillInstall,
  CapabilitySkillItem,
  CapabilitySkillsResponse,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider } from "../../../app/inspector";
import { __resetSettingsApprovalDialogsForTests } from "../../settings/SettingsApprovalDialog";
import { __resetSkillInstallPanelsForTests } from "./SkillInstallPanel";
import { SkillsTab } from "./SkillsTab";
import { __resetSkillInstallsForTests } from "./use-skill-install";
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
  fetchCapabilitySkillDiscover: vi.fn(),
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
vi.mock("@goatcitadel/mission-control-shared/api/workspaces", () => ({
  fetchWorkspaces: vi.fn(async () => ({ items: [] })),
}));

const PACK = { kind: "pack", packId: "himalaya" } as const;
const HIMALAYA: CapabilitySkillDiscoverItem = {
  id: "pack:himalaya",
  name: "Himalaya",
  description: "Read, search, organise and send mail.",
  category: "email",
  provider: "goatcitadel",
  providerLabel: "GoatCitadel",
  state: "available",
  install: PACK,
};
const STAGED: CapabilitySkillDiscoverItem = {
  ...HIMALAYA,
  id: "pack:github-cli",
  name: "GitHub CLI",
  state: "installing",
  install: { kind: "pack", packId: "github-cli" },
};

function checked(overrides: Partial<CapabilitySkillInstall> = {}): CapabilitySkillInstall {
  return {
    snapshotId: "snap-1",
    name: "Himalaya",
    description: "Read, search, organise and send mail.",
    source: PACK,
    step: "check_passed",
    blockers: [],
    asksFor: {
      tools: [],
      networkHosts: [],
      envVars: [],
      readsFiles: [],
      writesFiles: [],
      includesScripts: false,
      requires: [],
    },
    ...overrides,
  };
}

function installedOf(items: CapabilitySkillItem[] = []): CapabilitySkillsResponse {
  return { workspaceId: "ws-1", items, operatorApprovalSkip: false, issues: [], generatedAt: "" };
}

const MAIL_SKILL: CapabilitySkillItem = {
  skillId: "extra:himalaya",
  name: "Mail through Himalaya",
  description: "Reads and sends mail.",
  category: "email",
  origin: "built_in",
  state: "on",
  callable: true,
  revision: 1,
  switchable: true,
  pinned: false,
  tags: [],
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
/** The installs the Gateway holds, by check. */
let installs: CapabilitySkillInstall[];

const address = () => window.location.pathname + window.location.search;
const inspectorNamed = (name: string) => document.body.querySelector(`[aria-label="Inspector: ${name}"]`);
const body = () => document.body.querySelector<HTMLElement>('[data-inspector-body="true"]');
const button = (name: string, within: ParentNode | null = document.body) =>
  [...(within?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );
const field = () => body()?.querySelector<HTMLInputElement>("form input") ?? null;

async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderTab(at: string) {
  window.history.replaceState(null, "", at);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>
            <SkillsTab />
            <InspectorPanel />
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

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field(), value);
    field()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  installs = [];
  api.fetchCapabilitySkills.mockReset().mockResolvedValue(installedOf());
  api.fetchCapabilitySkillUsage.mockReset().mockResolvedValue({ since: "", generatedAt: "", skills: [] });
  api.fetchCapabilitySkillDetail.mockReset().mockResolvedValue({
    skillId: "extra:himalaya",
    instructionBody: "Use himalaya.",
    keywords: [],
    declaredTools: [],
    requires: [],
  });
  api.setCapabilitySkillState.mockReset();
  api.fetchCapabilitySkillDiscover.mockReset().mockResolvedValue({
    items: [HIMALAYA, STAGED],
    unavailableProviders: [],
    generatedAt: "",
  });
  api.reviewCapabilitySkill.mockReset().mockImplementation(async () => {
    installs = [checked()];
    return checked();
  });
  api.requestCapabilitySkillOperation.mockReset();
  api.fetchCapabilitySkillInstalls
    .mockReset()
    .mockImplementation(async (_workspaceId: string, options: { snapshotId?: string }) => ({
      workspaceId: "ws-1",
      installs: options.snapshotId
        ? installs.filter((install) => install.snapshotId === options.snapshotId)
        : installs.filter((install) => !["check_passed", "blocked", "done"].includes(install.step)),
      operatorApprovalSkip: false,
      generatedAt: "",
    }));
  approvals.fetchApproval.mockReset();
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
  __resetSkillSwitchesForTests();
  __resetSettingsApprovalDialogsForTests();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Opening the install panel", () => {
  it("checks a Discover source in the panel, then names the check in the address", async () => {
    let answer!: (install: CapabilitySkillInstall) => void;
    api.reviewCapabilitySkill.mockImplementation(
      () =>
        new Promise<CapabilitySkillInstall>((resolve) => {
          answer = resolve;
        }),
    );
    await renderTab("/capabilities/skills?view=discover&shell=cockpit");
    await press(button("Install Himalaya"));

    expect(inspectorNamed("Himalaya")).not.toBeNull();
    expect(body()?.textContent).toContain("Checking it…");
    expect(api.reviewCapabilitySkill).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      source: PACK,
      idempotencyKey: expect.any(String),
    });

    installs = [checked()];
    await act(async () => answer(checked()));
    await settle();
    // The check answered: the address names it, with the view kept, and its panel opens again from there.
    expect(address()).toBe("/capabilities/skills?item=install%3Asnap-1&view=discover&shell=cockpit");
    expect(inspectorNamed("Himalaya")).not.toBeNull();
    expect(button("Install and switch on", body())).toBeDefined();
    expect(api.reviewCapabilitySkill).toHaveBeenCalledTimes(1);
  });

  it("reopens an install from its address and closes back to the view it came from", async () => {
    installs = [checked({ step: "installed_off" })];
    await renderTab("/capabilities/skills?item=install%3Asnap-1&view=discover&shell=cockpit");

    expect(inspectorNamed("Himalaya")).not.toBeNull();
    expect(body()?.textContent).toContain("Installed, not switched on");
    expect(button("Switch on", body())).toBeDefined();

    await press(button("Close inspector"));
    expect(body()).toBeNull();
    expect(address()).toBe("/capabilities/skills?view=discover&shell=cockpit");
  });

  it("continues an install from Discover at the step it reached", async () => {
    installs = [checked({ snapshotId: "snap-9", name: "GitHub CLI", source: STAGED.install!, step: "installed_off" })];
    await renderTab("/capabilities/skills?view=discover&shell=cockpit");
    await press(button("Continue GitHub CLI"));

    expect(address()).toBe("/capabilities/skills?item=install%3Asnap-9&view=discover&shell=cockpit");
    expect(inspectorNamed("GitHub CLI")).not.toBeNull();
    expect(button("Switch on", body())).toBeDefined();
    // Nothing was checked again.
    expect(api.reviewCapabilitySkill).not.toHaveBeenCalled();
  });

  it("hands over to the installed skill's panel once switching on is done", async () => {
    installs = [checked({ step: "done", installedSkillId: "extra:himalaya" })];
    api.fetchCapabilitySkills.mockResolvedValue(installedOf([MAIL_SKILL]));
    await renderTab("/capabilities/skills?item=install%3Asnap-1&view=discover&shell=cockpit");

    expect(address()).toBe("/capabilities/skills?item=skill%3Aextra%3Ahimalaya&view=discover&shell=cockpit");
    expect(inspectorNamed("Mail through Himalaya")).not.toBeNull();
  });
});

describe("Import from Git", () => {
  it("sits beside the search in both views", async () => {
    await renderTab("/capabilities/skills?shell=cockpit");
    expect(button("Import from Git", container.querySelector('[role="search"]'))).toBeDefined();
    await renderTab("/capabilities/skills?view=discover&shell=cockpit");
    expect(button("Import from Git", container.querySelector('[role="search"]'))).toBeDefined();
  });

  it("refuses an address that isn't https before checking", async () => {
    await renderTab("/capabilities/skills?shell=cockpit");
    await press(button("Import from Git"));
    expect(inspectorNamed("Import from Git")).not.toBeNull();
    expect(body()?.querySelector("label")?.textContent).toContain("Git repository address");
    expect(body()?.textContent).toContain("From GitHub, GitLab, Bitbucket or Codeberg");

    for (const typed of ["http://github.com/acme/skills", "github.com/acme/skills", "  "]) {
      await type(typed);
      await press(button("Check", body()));
      expect(body()?.querySelector('[role="alert"]')?.textContent).toBe(
        "Enter an https address, like https://github.com/name/repo.",
      );
      expect(field()?.getAttribute("aria-invalid")).toBe("true");
    }
    expect(api.reviewCapabilitySkill).not.toHaveBeenCalled();

    await type(" https://github.com/acme/skills ");
    await press(button("Check", body()));
    expect(api.reviewCapabilitySkill).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      source: { kind: "git", sourceRef: "https://github.com/acme/skills" },
      idempotencyKey: expect.any(String),
    });
  });

  it("explains a Git host it won't install from", async () => {
    api.reviewCapabilitySkill.mockRejectedValue(
      new ApiRequestError("refused", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/skills/reviews",
        status: 422,
        body: {
          error: "That address can't be checked.",
          code: "SKILL_SOURCE_REFUSED",
          details: { reason: "UNTRUSTED_GIT_HOST" },
        },
      }),
    );
    await renderTab("/capabilities/skills?shell=cockpit");
    await press(button("Import from Git"));
    await type("https://git.example.com/acme/skills");
    await press(button("Check", body()));

    expect(body()?.querySelector('[role="alert"]')?.textContent).toBe(
      "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.",
    );
    // The address stays for the operator to correct.
    expect(field()?.value).toBe("https://git.example.com/acme/skills");
    expect(address()).toBe("/capabilities/skills?shell=cockpit");
  });
});
