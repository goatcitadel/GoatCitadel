// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  APPROVAL_EXPIRY_ACTOR_ID,
  type ApprovalRequest,
  type CapabilitySkillActionOutcome,
  type CapabilitySkillItem,
  type CapabilitySkillState,
  type CapabilitySkillsResponse,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillListQuery } from "../../../data/capability-skills-query";
import { __resetSkillSwitchesForTests, useSkillSwitch, type SkillSwitch } from "./use-skill-switch";

const skills = vi.hoisted(() => ({
  fetchCapabilitySkills: vi.fn(),
  fetchCapabilitySkillUsage: vi.fn(),
  fetchCapabilitySkillDetail: vi.fn(),
  setCapabilitySkillState: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => skills);
const approvals = vi.hoisted(() => ({ fetchApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", async (original) => ({
  ...(await original<object>()),
  ...approvals,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
}));

const KEY = skillListQuery("ws-1").queryKey;
type ShownSkill = "writer" | "planner" | "notes";

/** The list: Writer on, Planner off and Notes paused, unless `states` or `extra` say otherwise. */
function listOf(
  states: Partial<Record<ShownSkill, CapabilitySkillState>> = {},
  extra: Partial<Record<ShownSkill, Partial<CapabilitySkillItem>>> = {},
): CapabilitySkillsResponse {
  const item = (skillId: ShownSkill, name: string, state: CapabilitySkillState): CapabilitySkillItem => ({
    skillId,
    name,
    description: `${name} skill`,
    category: "writing",
    origin: "built_in",
    state,
    callable: state === "on",
    revision: 4,
    switchable: true,
    pinned: false,
    tags: [],
    ...extra[skillId],
  });
  return {
    workspaceId: "ws-1",
    items: [
      item("writer", "Writer", states.writer ?? "on"),
      item("planner", "Planner", states.planner ?? "off"),
      item("notes", "Notes", states.notes ?? "paused"),
    ],
    operatorApprovalSkip: false,
    issues: [],
    generatedAt: "2026-10-29T10:00:00.000Z",
  };
}

/** The skill approval `approvalId` at `status`; a decision by the operator unless `resolvedBy` says otherwise. */
function approval(status: ApprovalRequest["status"], resolvedBy = "operator", approvalId = "approval-1") {
  return {
    approvalId,
    kind: "skill.lifecycle",
    riskLevel: "caution",
    status,
    payload: {},
    preview: {},
    createdAt: "2026-10-29T10:00:00.000Z",
    ...(status === "pending" ? {} : { resolvedBy, resolvedAt: "2026-10-29T10:01:00.000Z" }),
  } as unknown as ApprovalRequest;
}

const WAITING: CapabilitySkillActionOutcome = { status: "waiting", approvalId: "approval-1" };
const APPROVED: CapabilitySkillActionOutcome = { status: "approved", approvalId: "approval-1" };

/** A refusal from the switch route, with the route's own body. */
function refused(status: number, error: string, reason?: string) {
  return new ApiRequestError(error, {
    kind: "http",
    method: "POST",
    path: "/api/v1/capabilities/skills/state",
    status,
    body: { error, code: "X", ...(reason ? { details: { reason } } : {}) },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
/** What the list route says now; every read of the list answers it. */
let server: CapabilitySkillsResponse;
/** The latest switch of each skill, read the way a row or the panel reads it. */
let shown: Partial<Record<ShownSkill, SkillSwitch>>;

/** One view of a skill, reading its row live from the cached list like the Skills tab. */
function Probe({ skillId }: { skillId: ShownSkill }) {
  const list = useQuery(skillListQuery("ws-1")).data!;
  shown[skillId] = useSkillSwitch(list.items.find((entry) => entry.skillId === skillId)!);
  return null;
}

const sw = (skillId: ShownSkill) => shown[skillId]!;
const listReads = () => skills.fetchCapabilitySkills.mock.calls.length;

/** Lets every awaited mock, list notification and zero-delay timer settle, without moving the polls on. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 8; round += 1) await vi.advanceTimersByTimeAsync(0);
  });
}

async function render(skillIds: readonly ShownSkill[] = ["writer", "planner", "notes"]) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {skillIds.map((skillId) => (
          <Probe key={skillId} skillId={skillId} />
        ))}
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** Moves the polls on by `ms`, then lets what they started settle. */
async function beat(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

/**
 * The switch has stopped checking: two more minutes pass without a list or approval read. (A timer count can't say
 * this: the list's change notice leaves a zero-delay timeout behind after each `act`.)
 */
async function expectNoMoreChecks() {
  const reads = [listReads(), approvals.fetchApproval.mock.calls.length];
  await beat(120_000);
  expect([listReads(), approvals.fetchApproval.mock.calls.length]).toEqual(reads);
}

/** A fresh page: no switches remembered, a new cache holding the list route's answer. */
function freshPage() {
  act(() => root.unmount());
  client.clear();
  __resetSkillSwitchesForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(KEY, server);
  root = createRoot(container);
  shown = {};
}

/** Switches Planner on and leaves it waiting on approval-1. */
async function waitOnPlanner() {
  skills.setCapabilitySkillState.mockResolvedValueOnce(WAITING);
  await act(async () => sw("planner").setOn(true));
  await settle();
  expect(sw("planner")).toMatchObject({ waiting: true, waitingApprovalId: "approval-1", waitingTarget: "on" });
}

beforeEach(() => {
  // Only timeouts are faked: the switch's checks are timeouts, and so is the list's change notice, which `settle` runs.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  skills.fetchCapabilitySkills.mockReset();
  skills.setCapabilitySkillState.mockReset();
  approvals.fetchApproval.mockReset();
  server = listOf();
  skills.fetchCapabilitySkills.mockImplementation(async () => server);
  approvals.fetchApproval.mockResolvedValue(approval("pending"));
  // Data is fresh until something reads it again, so a mount reads nothing and every read here is one the hook asked for.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(KEY, server);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  shown = {};
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetSkillSwitchesForTests();
  vi.useRealTimers();
});

describe("useSkillSwitch", () => {
  it("doesn't show the new state before the change applies", async () => {
    const saving = deferred<CapabilitySkillActionOutcome>();
    skills.setCapabilitySkillState.mockReturnValueOnce(saving.promise);
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(skills.setCapabilitySkillState).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      skillId: "planner",
      state: "enabled",
      expectedRevision: 4,
    });
    expect(sw("planner")).toMatchObject({ checked: false, paused: false, pending: true, waiting: false });

    // Approved, but the list read after it still says off: the switch keeps waiting for the list.
    await act(async () => saving.resolve(APPROVED));
    await settle();
    await beat(1_000);
    expect(listReads()).toBe(1);
    expect(sw("planner")).toMatchObject({ checked: false, pending: true });

    server = listOf({ planner: "on" });
    await beat(2_000);
    expect(sw("planner")).toMatchObject({ checked: true, pending: false, waiting: false });
    expect(sw("planner").failure).toBeUndefined();
  });

  it("turns on at once when the route approves it", async () => {
    skills.setCapabilitySkillState.mockResolvedValueOnce(APPROVED);
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(sw("planner")).toMatchObject({ checked: false, pending: true, waiting: false });

    server = listOf({ planner: "on" });
    await beat(999);
    expect(listReads()).toBe(0);
    await beat(1);
    expect(listReads()).toBe(1);
    expect(sw("planner")).toMatchObject({ checked: true, pending: false, waiting: false });
    expect(approvals.fetchApproval).not.toHaveBeenCalled();
    await expectNoMoreChecks();
  });

  it("checks the list at 1, 3, 7 and 15 seconds, then says it is still applying", async () => {
    skills.setCapabilitySkillState.mockResolvedValueOnce(APPROVED);
    await render();
    await act(async () => sw("planner").setOn(true));
    await settle();

    const readsAt: number[] = [];
    for (let second = 1; second <= 20; second += 1) {
      const before = listReads();
      await beat(1_000);
      if (listReads() > before) readsAt.push(second);
    }
    expect(readsAt).toEqual([1, 3, 7, 15]);
    expect(sw("planner")).toMatchObject({
      checked: false,
      pending: false,
      failure: { message: "Still applying. Refresh to check.", conflict: false },
    });
    await expectNoMoreChecks();

    // The change lands later (the list is read again by an event): the line goes.
    server = listOf({ planner: "on" });
    await act(async () => client.invalidateQueries({ queryKey: KEY }));
    await settle();
    expect(sw("planner")).toMatchObject({ checked: true, pending: false });
    expect(sw("planner").failure).toBeUndefined();
  });

  it("waits, then turns on when the approval lands", async () => {
    await render();
    await waitOnPlanner();
    expect(sw("planner")).toMatchObject({ checked: false, pending: false });

    await beat(4_999);
    expect(approvals.fetchApproval).not.toHaveBeenCalled();
    await beat(1);
    expect(approvals.fetchApproval).toHaveBeenCalledOnce();
    expect(sw("planner")).toMatchObject({ checked: false, waiting: true, waitingApprovalId: "approval-1" });

    approvals.fetchApproval.mockResolvedValue(approval("approved"));
    await beat(5_000);
    // Approved: the switch stops waiting and stays pending until the list shows the change.
    expect(sw("planner")).toMatchObject({ checked: false, pending: true, waiting: false });
    expect(sw("planner").waitingApprovalId).toBeUndefined();

    server = listOf({ planner: "on" });
    await beat(1_000);
    expect(sw("planner")).toMatchObject({ checked: true, pending: false, waiting: false });
    expect(sw("planner").failure).toBeUndefined();
    await expectNoMoreChecks();
  });

  it("stops waiting as soon as the list shows the change", async () => {
    await render();
    await waitOnPlanner();

    // The applied event reads the list again before any approval read.
    server = listOf({ planner: "on" });
    await act(async () => client.invalidateQueries({ queryKey: KEY }));
    await settle();
    expect(sw("planner")).toMatchObject({ checked: true, pending: false, waiting: false });
    await expectNoMoreChecks();
    expect(approvals.fetchApproval).not.toHaveBeenCalled();
  });

  it("reads a waiting approval every 5 seconds at first, then less often", async () => {
    await render();
    await waitOnPlanner();

    const readsAt: number[] = [];
    for (let second = 1; second <= 120; second += 1) {
      const before = approvals.fetchApproval.mock.calls.length;
      await beat(1_000);
      if (approvals.fetchApproval.mock.calls.length > before) readsAt.push(second);
    }
    expect(readsAt).toEqual([5, 10, 15, 25, 45, 75, 105]);
    expect(sw("planner")).toMatchObject({ waiting: true, waitingApprovalId: "approval-1" });
  });

  it("reads the approval without a workspace", async () => {
    await render(["planner"]);
    await waitOnPlanner();

    // Every view goes away (the panel closes, the tab changes), and the approval is still read.
    await act(async () => root.render(null));
    await beat(5_000);
    expect(approvals.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-1", {
      signal: expect.any(AbortSignal),
    });
    const options = approvals.fetchApproval.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(options)).toEqual(["signal"]);
  });

  it("says it was declined and stays off", async () => {
    await render();
    await waitOnPlanner();

    approvals.fetchApproval.mockResolvedValue(approval("rejected"));
    await beat(5_000);
    expect(sw("planner")).toMatchObject({
      checked: false,
      pending: false,
      waiting: false,
      failure: { message: "Not changed. The change was declined.", conflict: false },
    });
    expect(sw("planner").waitingApprovalId).toBeUndefined();
    // A decline sends no skill event, so the list is read again for its waiting mark.
    expect(listReads()).toBe(1);

    // Nothing is checked any more, and the line stays until the next click.
    await expectNoMoreChecks();
    expect(sw("planner").failure?.message).toBe("Not changed. The change was declined.");
  });

  it("says the request expired", async () => {
    skills.setCapabilitySkillState
      .mockResolvedValueOnce({ status: "declined", approvalId: "approval-1", expired: true })
      .mockResolvedValueOnce({ status: "declined", approvalId: "approval-2", expired: false });
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(sw("planner")).toMatchObject({
      checked: false,
      pending: false,
      waiting: false,
      failure: { message: "Not changed. The request expired.", conflict: false },
    });

    await act(async () => sw("writer").setOn(false));
    await settle();
    expect(sw("writer").failure).toEqual({ message: "Not changed. The change was declined.", conflict: false });
    expect(sw("writer").checked).toBe(true);
  });

  it("says the request expired when the approval was rejected by the expiry check", async () => {
    await render();
    await waitOnPlanner();

    approvals.fetchApproval.mockResolvedValue(approval("rejected", APPROVAL_EXPIRY_ACTOR_ID));
    await beat(5_000);
    expect(sw("planner")).toMatchObject({
      checked: false,
      waiting: false,
      failure: { message: "Not changed. The request expired.", conflict: false },
    });
  });

  it("treats an edited approval as declined", async () => {
    await render();
    await waitOnPlanner();

    approvals.fetchApproval.mockResolvedValue(approval("edited"));
    await beat(5_000);
    expect(sw("planner")).toMatchObject({
      checked: false,
      pending: false,
      waiting: false,
      failure: { message: "Not changed. The change was declined.", conflict: false },
    });
    expect(listReads()).toBe(1);
  });

  it("takes a decline on at once when asked to check", async () => {
    await render();
    await waitOnPlanner();
    expect(approvals.fetchApproval).not.toHaveBeenCalled();

    // Declined where the panel showed it: no skill event follows, so the panel asks the switch to look now.
    approvals.fetchApproval.mockResolvedValue(approval("rejected"));
    await act(async () => sw("planner").checkApproval());
    await settle();
    expect(approvals.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-1", {
      signal: expect.any(AbortSignal),
    });
    expect(sw("planner")).toMatchObject({
      waiting: false,
      failure: { message: "Not changed. The change was declined.", conflict: false },
    });
  });

  it("reads the approval at once when asked, and starts its back-off again", async () => {
    await render();
    await waitOnPlanner();
    // The reads have slowed down: 5, 10, 15 and 25 seconds in, the next one 20 seconds later.
    for (const wait of [5_000, 5_000, 5_000, 10_000]) await beat(wait);
    expect(approvals.fetchApproval).toHaveBeenCalledTimes(4);

    await act(async () => sw("planner").checkApproval());
    await settle();
    expect(approvals.fetchApproval).toHaveBeenCalledTimes(5);
    // Still waiting, so the reads start again at their first pace.
    await beat(5_000);
    expect(approvals.fetchApproval).toHaveBeenCalledTimes(6);
    expect(sw("planner")).toMatchObject({ waiting: true, waitingApprovalId: "approval-1" });
  });

  it("reads nothing when asked to check a skill that waits on nothing", async () => {
    await render();
    await act(async () => sw("writer").checkApproval());
    await settle();
    expect(approvals.fetchApproval).not.toHaveBeenCalled();
    expect(sw("writer")).toMatchObject({ waiting: false });
    expect(sw("writer").failure).toBeUndefined();
  });

  it("says it can't check the approval after repeated failed reads, and keeps waiting", async () => {
    await render();
    await waitOnPlanner();

    approvals.fetchApproval.mockRejectedValue(new Error("offline"));
    await beat(5_000);
    await beat(5_000);
    expect(sw("planner").failure).toBeUndefined();
    await beat(5_000);
    const failure = sw("planner").failure;
    expect(failure).toEqual({ message: "Can't check the approval right now. It will try again.", conflict: false });
    expect(sw("planner")).toMatchObject({ waiting: true, waitingApprovalId: "approval-1" });

    // Another failed read keeps the same line (the same object), and a read that works clears it.
    await beat(10_000);
    expect(sw("planner").failure).toBe(failure);
    approvals.fetchApproval.mockResolvedValue(approval("pending"));
    await beat(20_000);
    expect(sw("planner").failure).toBeUndefined();
    expect(sw("planner")).toMatchObject({ waiting: true, waitingApprovalId: "approval-1" });
  });

  it("asks again after a decline", async () => {
    skills.setCapabilitySkillState
      .mockResolvedValueOnce({ status: "declined", approvalId: "approval-1", expired: false })
      .mockResolvedValueOnce({ status: "waiting", approvalId: "approval-2" });
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(sw("planner").failure?.message).toBe("Not changed. The change was declined.");

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(skills.setCapabilitySkillState).toHaveBeenCalledTimes(2);
    expect(skills.setCapabilitySkillState).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      skillId: "planner",
      state: "enabled",
      expectedRevision: 4,
    });
    expect(sw("planner")).toMatchObject({ waiting: true, waitingApprovalId: "approval-2" });
    expect(sw("planner").failure).toBeUndefined();
  });

  it("picks up a wait from the list after a reload", async () => {
    server = listOf({}, { planner: { pendingApprovalId: "approval-9" } });
    client.setQueryData(KEY, server);
    await render();
    expect(sw("planner")).toMatchObject({
      checked: false,
      pending: false,
      waiting: true,
      waitingApprovalId: "approval-9",
      waitStartedHere: false,
    });
    // Nobody here asked for it, so what it asks for is unknown.
    expect(sw("planner").waitingTarget).toBeUndefined();
    expect(sw("writer").waiting).toBe(false);

    // A click while it waits sends nothing.
    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(skills.setCapabilitySkillState).not.toHaveBeenCalled();

    approvals.fetchApproval.mockResolvedValue(approval("approved", "operator", "approval-9"));
    await beat(5_000);
    expect(approvals.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-9", {
      signal: expect.any(AbortSignal),
    });
    expect(sw("planner")).toMatchObject({ checked: false, pending: true, waiting: false });

    // The target isn't known after a reload: the list's state moving on ends the wait.
    server = listOf({ planner: "on" });
    await beat(1_000);
    expect(sw("planner")).toMatchObject({ checked: true, pending: false, waiting: false });
    expect(sw("planner").failure).toBeUndefined();

    // A wait whose approval was declined shows the declined line once the list drops its waiting mark.
    server = listOf({}, { notes: { pendingApprovalId: "approval-7" } });
    freshPage();
    approvals.fetchApproval.mockReset();
    approvals.fetchApproval.mockResolvedValue(approval("rejected", "operator", "approval-7"));
    await render();
    expect(sw("notes")).toMatchObject({ waiting: true, waitingApprovalId: "approval-7", paused: true });
    server = listOf();
    await act(async () => client.invalidateQueries({ queryKey: KEY }));
    await settle();
    expect(approvals.fetchApproval).toHaveBeenCalledExactlyOnceWith("approval-7", {
      signal: expect.any(AbortSignal),
    });
    expect(sw("notes")).toMatchObject({
      waiting: false,
      paused: true,
      failure: { message: "Not changed. The change was declined.", conflict: false },
    });
  });

  it("explains a conflict and reloads", async () => {
    const message = "This skill changed since you opened it. Reload and try again.";
    skills.setCapabilitySkillState.mockRejectedValueOnce(refused(409, message, "stale"));
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(sw("planner").failure).toEqual({ message, conflict: true });
    expect(sw("planner")).toMatchObject({ checked: false, pending: false, waiting: false });

    const reads = listReads();
    await act(async () => sw("planner").reload());
    await settle();
    expect(listReads()).toBe(reads + 1);
    expect(sw("planner").failure).toBeUndefined();
  });

  it("shows the pinned message", async () => {
    const message = "This skill is pinned. Change it through a proposal in Library.";
    skills.setCapabilitySkillState.mockRejectedValueOnce(refused(409, message, "pinned"));
    await render();

    await act(async () => sw("writer").setOn(false));
    await settle();
    expect(sw("writer").failure).toEqual({ message, conflict: false });
    expect(sw("writer")).toMatchObject({ checked: true, pending: false });
  });

  it("shows the route's own message for a 409 or 404", async () => {
    const duplicate = "This exact change was already asked for elsewhere. Check the Inbox.";
    const notSwitchable = "This skill can't be switched from here.";
    skills.setCapabilitySkillState
      .mockRejectedValueOnce(refused(409, duplicate, "duplicate"))
      .mockRejectedValueOnce(refused(404, notSwitchable))
      .mockRejectedValueOnce(refused(500, "TypeError: boom"));
    await render();

    await act(async () => sw("planner").setOn(true));
    await act(async () => sw("writer").setOn(false));
    await act(async () => sw("notes").setPaused(false));
    await settle();
    expect(sw("planner").failure).toEqual({ message: duplicate, conflict: false });
    expect(sw("writer").failure).toEqual({ message: notSwitchable, conflict: false });
    // Anything else is the plain sentence for that kind of failure, never the raw text.
    expect(sw("notes").failure).toEqual({
      message: "The gateway hit an error. Try again, or check System health.",
      conflict: false,
    });
  });

  it("ignores a second click while saving", async () => {
    const saving = deferred<CapabilitySkillActionOutcome>();
    skills.setCapabilitySkillState.mockReturnValueOnce(saving.promise).mockResolvedValueOnce(APPROVED);
    await render();

    await act(async () => {
      sw("planner").setOn(true);
      sw("planner").setOn(true);
      sw("planner").setPaused(true);
    });
    await settle();
    expect(skills.setCapabilitySkillState).toHaveBeenCalledOnce();
    expect(sw("planner").pending).toBe(true);

    // Another skill may change at the same time.
    await act(async () => sw("writer").setPaused(true));
    await settle();
    expect(skills.setCapabilitySkillState).toHaveBeenCalledTimes(2);
    expect(skills.setCapabilitySkillState).toHaveBeenLastCalledWith({
      workspaceId: "ws-1",
      skillId: "writer",
      state: "sleep",
      expectedRevision: 4,
    });

    await act(async () => saving.resolve({ status: "unchanged" }));
    await settle();
    // Unchanged: the list is read once, and the switch shows it.
    expect(listReads()).toBe(1);
    expect(sw("planner")).toMatchObject({ checked: false, pending: false, waiting: false });
    expect(sw("planner").failure).toBeUndefined();
  });

  it("sends nothing when asked for the state the skill already has", async () => {
    await render();

    await act(async () => {
      sw("writer").setOn(true);
      sw("planner").setOn(false);
      sw("notes").setPaused(true);
    });
    await settle();
    expect(skills.setCapabilitySkillState).not.toHaveBeenCalled();
    expect(sw("writer")).toMatchObject({ checked: true, pending: false });

    // Each switch maps to its own state: off, resume and pause.
    skills.setCapabilitySkillState.mockResolvedValue(APPROVED);
    await act(async () => {
      sw("writer").setOn(false);
      sw("notes").setPaused(false);
      sw("planner").setPaused(true);
    });
    await settle();
    expect(skills.setCapabilitySkillState.mock.calls.map(([body]) => [body.skillId, body.state])).toEqual([
      ["writer", "disabled"],
      ["notes", "enabled"],
      ["planner", "sleep"],
    ]);
  });

  it("sends nothing for a skill it can't switch", async () => {
    server = listOf({}, { planner: { switchable: false } });
    client.setQueryData(KEY, server);
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    expect(skills.setCapabilitySkillState).not.toHaveBeenCalled();
    expect(sw("planner")).toMatchObject({ checked: false, pending: false, waiting: false });
  });

  it("shares one list refetch between two switches", async () => {
    skills.setCapabilitySkillState.mockResolvedValue(APPROVED);
    const reading = deferred<CapabilitySkillsResponse>();
    skills.fetchCapabilitySkills.mockReturnValueOnce(reading.promise);
    await render();

    await act(async () => sw("planner").setOn(true));
    await settle();
    await beat(500);
    await act(async () => sw("writer").setOn(false));
    await settle();

    // Planner's first check starts a read; Writer's comes while it is still under way and joins it.
    await beat(500);
    expect(listReads()).toBe(1);
    await beat(500);
    expect(listReads()).toBe(1);

    await act(async () => reading.resolve(listOf({ planner: "on", writer: "off" })));
    await settle();
    expect(sw("planner")).toMatchObject({ checked: true, pending: false });
    expect(sw("writer")).toMatchObject({ checked: false, pending: false });
    expect(listReads()).toBe(1);
    await expectNoMoreChecks();
  });
});
