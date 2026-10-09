import { inboxLocalReadKey } from "@goatcitadel/mission-control-shared/api/inbox-local-read-store";
// @vitest-environment happy-dom
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetInboxViewedUpdatesForTests,
  inboxUpdateVersion,
  isInboxUpdateViewed,
  markInboxUpdateViewed,
} from "./inbox-viewed-updates";

const installation = "http://localhost:8787";
const update: OperatorInboxItem = {
  id: "task_deliverable:delivery-a",
  kind: "task_deliverable",
  group: "updates",
  version: "a".repeat(64),
  title: "Report",
  summary: "A deliverable was recorded.",
  createdAt: "2026-09-30T00:00:00Z",
  source: { workspaceId: "workspace-a", taskId: "task-a", deliverableId: "delivery-a" },
  href: "/ops/kanban?taskId=task-a",
};

beforeEach(async () => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, _options: unknown, fn: () => unknown) => fn() },
  });
  __resetInboxViewedUpdatesForTests();
});

describe("app-session viewed Inbox updates", async () => {
  it("isolates installations and workspaces without changing the owner projection", async () => {
    const original = structuredClone(update);
    expect(await markInboxUpdateViewed(installation, "workspace-a", update)).toBe(true);
    expect(await markInboxUpdateViewed(installation, "workspace-a", update)).toBe(true);
    expect(isInboxUpdateViewed(installation, "workspace-a", update)).toBe(true);
    expect(isInboxUpdateViewed("http://localhost:9999", "workspace-a", update)).toBe(false);
    expect(
      isInboxUpdateViewed(installation, "workspace-b", {
        ...update,
        source: { ...update.source, workspaceId: "workspace-b" },
      }),
    ).toBe(false);
    expect(update).toEqual(original);
    __resetInboxViewedUpdatesForTests();
    expect(isInboxUpdateViewed(installation, "workspace-a", update)).toBe(true);
  });

  it.each<Partial<OperatorInboxItem>>([
    { updatedAt: "2026-09-30T00:00:01Z" },
    { summary: "A newer result is available." },
    { source: { ...update.source, deliverableId: "delivery-b" } },
    { href: "/ops/kanban?taskId=task-b" },
  ])("makes a changed version unviewed: %j", async (change) => {
    await markInboxUpdateViewed(installation, "workspace-a", update);
    expect(isInboxUpdateViewed(installation, "workspace-a", { ...update, ...change, version: "b".repeat(64) })).toBe(
      false,
    );
  });

  it("does not treat object key ordering as a new version", async () => {
    await markInboxUpdateViewed(installation, "workspace-a", update);
    expect(
      isInboxUpdateViewed(installation, "workspace-a", {
        ...update,
        source: { deliverableId: "delivery-a", taskId: "task-a", workspaceId: "workspace-a" },
      }),
    ).toBe(true);
  });

  it.each<Partial<OperatorInboxItem>>([
    { kind: "approval" },
    { kind: "failed_run" },
    { kind: "runtime_health" },
    { group: "needs_attention" },
    { riskLevel: "danger" },
    { source: { ...update.source, approvalId: "approval-a" } },
    { source: { ...update.source, planId: "plan-a" } },
    { source: { ...update.source, promptId: "prompt-a" } },
    { source: { ...update.source, proposalId: "proposal-a" } },
    { source: { ...update.source, deadLetterId: "dead-a" } },
    { source: { ...update.source, workspaceId: "other" } },
    { source: { workspaceId: "workspace-a", taskId: "task-a" } },
    { createdAt: "invalid" },
  ])("never hides pending, risky, foreign or unbound evidence: %j", async (change) => {
    const item = { ...update, ...change };
    expect(inboxUpdateVersion(item, "workspace-a")).toBeUndefined();
    expect(await markInboxUpdateViewed(installation, "workspace-a", item)).toBe(false);
    expect(isInboxUpdateViewed(installation, "workspace-a", item)).toBe(false);
  });

  it("admits only a completed background summary with an exact run source", async () => {
    const item: OperatorInboxItem = {
      ...update,
      id: "completed_background_run:watcher-a",
      kind: "completed_background_run",
      source: { workspaceId: "workspace-a", runId: "run-a" },
    };
    expect(await markInboxUpdateViewed(installation, "workspace-a", item)).toBe(true);
    expect(
      await markInboxUpdateViewed(installation, "workspace-a", { ...item, source: { workspaceId: "workspace-a" } }),
    ).toBe(false);
    expect(await markInboxUpdateViewed("", "workspace-a", item)).toBe(false);
  });
});

it("sanitizes pre-existing local receipt fields to exact ID/version pairs", async () => {
  const key = inboxLocalReadKey(installation, "workspace-a");
  localStorage.setItem(
    key,
    JSON.stringify([{ id: "old", version: "b".repeat(64), title: "never retained", summary: "never retained" }]),
  );
  expect(await markInboxUpdateViewed(installation, "workspace-a", update)).toBe(true);
  expect(JSON.parse(localStorage.getItem(key)!)).toEqual([
    { id: "old", version: "b".repeat(64) },
    { id: update.id, version: update.version },
  ]);
});
it("does not overwrite unknown state when the storage read is denied", async () => {
  const get = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  const set = vi.spyOn(localStorage, "setItem");
  expect(await markInboxUpdateViewed(installation, "workspace-a", update)).toBe(false);
  expect(set).not.toHaveBeenCalled();
  get.mockRestore();
  set.mockRestore();
});
