// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SHIPPED_SKILL_PACKS } from "@goatcitadel/contracts";
import type { SkillHubOperatorItem } from "@goatcitadel/mission-control-shared/api/client";
import { findSkillPackItem, LibrarySkillPacks, nextSkillPackStep } from "./LibrarySkillPacks";

const api = vi.hoisted(() => ({
  fetchSkillHubOperator: vi.fn(),
  reviewSkillHubPack: vi.fn(),
  createSkillHubOperatorApproval: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));

const himalaya = SHIPPED_SKILL_PACKS.find((pack) => pack.packId === "himalaya")!;
const guard = (allowed: boolean, blockers: string[] = []) => ({ allowed, blockers });
function item(overrides: Partial<SkillHubOperatorItem> = {}, snapshot: Partial<SkillHubOperatorItem["snapshot"]> = {}) {
  return {
    snapshotId: "snap-1",
    title: "himalaya",
    lineage: { versionCount: 0, inventoryTruncated: false, ambiguous: false },
    snapshot: {
      operation: "review",
      sourceProvider: "local",
      sourceType: "local_path",
      sourceRef: "C:\\GoatCitadel\\skills\\import-packs\\himalaya",
      canonicalSourceKey: "k",
      contentTreeSha256: "a",
      digestChangedFromPrior: false,
      sameVersionDifferentBytes: false,
      riskLevel: "medium",
      trustDisposition: "candidate",
      blockerCodes: [],
      createdAt: "2026-10-24T00:00:00.000Z",
      ...snapshot,
    },
    runtime: { callable: false, activeVersion: false, inactiveCandidate: false },
    approvals: {},
    actions: {
      install_inactive: guard(true),
      stage_update_candidate: guard(false),
      stage_rollback_candidate: guard(false),
      activate: guard(false),
      revoke: guard(false),
    },
    ...overrides,
  } as unknown as SkillHubOperatorItem;
}

it("matches a pack to its newest local review and derives the next governed step", () => {
  const older = item({ snapshotId: "old" }, { createdAt: "2026-10-01T00:00:00.000Z" });
  const newer = item({ snapshotId: "new" });
  const other = item({ snapshotId: "other" }, { sourceRef: "/srv/skills/import-packs/github-cli" });
  const remote = item({ snapshotId: "remote" }, { sourceType: "git_url", sourceRef: "https://github.com/x/himalaya" });
  expect(findSkillPackItem(himalaya, [older, other, remote, newer])?.snapshotId).toBe("new");
  expect(nextSkillPackStep(undefined)).toEqual({ kind: "review" });
  expect(nextSkillPackStep(newer)).toMatchObject({ kind: "action", action: "install_inactive" });
  expect(nextSkillPackStep(item({}, { blockerCodes: ["UNMAPPED_TOOL"] }))).toEqual({
    kind: "blocked",
    codes: ["UNMAPPED_TOOL"],
  });
  expect(nextSkillPackStep(item({ latestApproval: { approvalId: "ap-1", status: "pending" } as never }))).toEqual({
    kind: "waiting",
    approvalId: "ap-1",
  });
  expect(
    nextSkillPackStep(item({ actions: { ...newer.actions, install_inactive: guard(false), activate: guard(true) } })),
  ).toMatchObject({ kind: "action", action: "activate" });
  expect(
    nextSkillPackStep(item({ runtime: { callable: true, activeVersion: true, inactiveCandidate: false } })),
  ).toEqual({ kind: "active" });
});

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <LibrarySkillPacks workspaceId="default" />
      </QueryClientProvider>,
    );
  });
}
const button = (text: string) => [...container.querySelectorAll("button")].find((entry) => entry.textContent === text);

it("reviews a pack through the Gateway, then offers the inactive install approval", async () => {
  api.fetchSkillHubOperator.mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [item()] });
  api.reviewSkillHubPack.mockResolvedValue({
    replayed: false,
    snapshot: { snapshotId: "snap-1", trustDisposition: "candidate", blockerCodes: [] },
  });
  api.createSkillHubOperatorApproval.mockResolvedValue({ operatorMessage: "Approval requested in Inbox." });
  await render();
  await vi.waitFor(() => expect(button(`Review ${himalaya.label}`)).toBeTruthy());
  await act(async () => button(`Review ${himalaya.label}`)!.click());
  expect(api.reviewSkillHubPack).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: "default", packId: "himalaya" }),
  );
  await vi.waitFor(() => expect(button(`Install inactive: ${himalaya.label}`)).toBeTruthy());
  expect(container.textContent).toContain("nothing is callable yet");
  await act(async () => button(`Install inactive: ${himalaya.label}`)!.click());
  expect(api.createSkillHubOperatorApproval).toHaveBeenCalledWith({
    workspaceId: "default",
    snapshotId: "snap-1",
    operationKind: "install_inactive",
  });
  expect(container.textContent).toContain("Approval requested in Inbox.");
});
