import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CuratorSkillStatusItem, CuratorStatusResponse } from "@goatcitadel/contracts";
import {
  archiveCuratorSkill,
  fetchCuratorStatus,
  listCuratorArchived,
  runCurator,
} from "@goatcitadel/mission-control-shared/api/platform";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { LibraryCurator } from "./LibraryCurator";

vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({
  archiveCuratorSkill: vi.fn(),
  fetchCuratorStatus: vi.fn(),
  listCuratorArchived: vi.fn(),
  runCurator: vi.fn(),
}));

function skill(overrides: Partial<CuratorSkillStatusItem>): CuratorSkillStatusItem {
  return {
    skillId: "skill-alpha",
    name: "alpha",
    source: "managed",
    pinned: false,
    bundled: false,
    immune: false,
    state: "enabled",
    usageCount: 3,
    ageDays: 40,
    score: { mean: 0.25 } as CuratorSkillStatusItem["score"],
    signals: ["unused-30d"],
    recommendation: "archive",
    archived: false,
    ...overrides,
  };
}
const status: CuratorStatusResponse = {
  generatedAt: "2026-10-07T10:00:00.000Z",
  cycleDays: 7,
  items: [
    skill({}),
    skill({
      skillId: "skill-gamma",
      name: "gamma",
      usageCount: 90,
      recommendation: "keep",
      score: { mean: 0.9 } as CuratorSkillStatusItem["score"],
    }),
    skill({
      skillId: "skill-delta",
      name: "delta",
      source: "bundled",
      bundled: true,
      immune: true,
      immunityReason: "bundled",
      recommendation: "keep",
    }),
  ],
};
let root: Root, container: HTMLDivElement, client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  __resetApprovalOperationAttemptsForTests();
  __resetSessionViewStateForTests();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(fetchCuratorStatus).mockResolvedValue(status);
  vi.mocked(listCuratorArchived).mockResolvedValue({ generatedAt: status.generatedAt, items: [] });
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
});

async function open(path = "/library/curator") {
  await act(async () => {
    window.history.replaceState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <LibraryCurator workspaceId="one" />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain("gamma"));
}
const button = (name: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name,
  );
async function click(name: string) {
  await vi.waitFor(() => expect(button(name), name).toBeDefined());
  await act(async () => button(name)!.click());
}
const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]");

it("ranks skills by the chosen sort and names the sort truthfully", async () => {
  await open();
  const names = () =>
    [...container.querySelectorAll("[data-curator-skill]")].map((row) => row.getAttribute("data-curator-skill"));
  expect(names()).toEqual(["skill-gamma", "skill-alpha", "skill-delta"]);
  expect(container.textContent).toContain("Skills, sorted by usage");
  const select = container.querySelector<HTMLSelectElement>("select")!;
  await act(async () => {
    select.value = "name";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(names()).toEqual(["skill-alpha", "skill-delta", "skill-gamma"]);
  expect(container.textContent).toContain("Skills, sorted by name");
});

it("generates a proposal-only report and says nothing was archived", async () => {
  vi.mocked(runCurator).mockResolvedValue({
    runId: "run-1",
    scheduled: false,
    report: { proposalCount: 2, immuneCount: 1 } as never,
  });
  await open();
  await click("Generate report");
  expect(runCurator).toHaveBeenCalledExactlyOnceWith({ sync: true, dryRun: true });
  await vi.waitFor(() =>
    expect(container.textContent).toContain("2 archive proposals, 1 immune. Nothing was archived."),
  );
});

it("reviews an archive with honest re-enable copy: Cancel sends nothing, Confirm sends one request", async () => {
  await open("/library/curator?skillId=skill-alpha");
  await click("Review archive");
  const text = dialog()!.textContent!;
  expect(text).toContain("alpha");
  expect(text).toContain("installation-wide");
  expect(text).toContain("Curator has no restore");
  await click("Cancel");
  expect(archiveCuratorSkill).not.toHaveBeenCalled();
  vi.mocked(archiveCuratorSkill).mockResolvedValue({
    skillId: "skill-alpha",
    archived: true,
    archivedAt: "2026-10-07T11:00:00.000Z",
    state: "disabled",
  });
  await click("Review archive");
  await click("Archive skill");
  expect(archiveCuratorSkill).toHaveBeenCalledExactlyOnceWith({
    skillId: "skill-alpha",
    confirm: true,
    reason: "manual archive from Mission Control",
  });
  await vi.waitFor(() => expect(container.textContent).toContain("alpha archived."));
});

it("keeps a lost archive response locked and offers only the exact replay", async () => {
  vi.mocked(archiveCuratorSkill).mockRejectedValueOnce(new Error("socket closed")).mockResolvedValueOnce({
    skillId: "skill-alpha",
    archived: true,
    alreadyArchived: true,
    archivedAt: "2026-10-07T11:00:00.000Z",
    state: "disabled",
  });
  await open("/library/curator?skillId=skill-alpha");
  await click("Review archive");
  await click("Archive skill");
  expect(button("Archive skill")).toBeUndefined();
  await click("Replay exact archive request");
  expect(vi.mocked(archiveCuratorSkill).mock.calls).toHaveLength(2);
  await vi.waitFor(() => expect(container.textContent).toContain("alpha was already archived; nothing changed."));
});

it("offers no archive for an immune skill and states why", async () => {
  await open("/library/curator?skillId=skill-delta");
  await vi.waitFor(() => expect(container.textContent).toContain("Immune: bundled"));
  expect(button("Review archive")).toBeUndefined();
});

it("keeps the page and its list when an archive is refused", async () => {
  vi.mocked(archiveCuratorSkill).mockRejectedValue(
    Object.assign(new Error("Curator: pinned skill cannot be archived"), { status: 409 }),
  );
  await open("/library/curator?skillId=skill-alpha");
  await click("Review archive");
  await click("Archive skill");
  await vi.waitFor(() => expect(dialog()!.textContent).toContain("cannot be archived"));
  expect(container.textContent).toContain("gamma");
});

it("shows a load failure without inventing an empty catalog", async () => {
  vi.mocked(fetchCuratorStatus).mockRejectedValue(new Error("Curator unavailable"));
  await act(async () => {
    window.history.replaceState(null, "", "/library/curator");
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <LibraryCurator workspaceId="one" />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Curator unavailable"));
  expect(container.textContent).not.toContain("No skills");
});
