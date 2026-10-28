// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type {
  CapabilityToolGroupState,
  CapabilityToolsResponse,
  ChangePlanReceipt,
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ToolGroupId,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toolListQuery } from "../../../data/capability-tools-query";
import { __resetToolGroupSwitchesForTests, useToolGroupSwitch, type ToolGroupSwitch } from "./use-tool-group-switch";

const settings = vi.hoisted(() => ({ patchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/settings-operations", () => settings);
const tools = vi.hoisted(() => ({ fetchCapabilityTools: vi.fn(), fetchCapabilityToolUsage: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capability-tools", () => tools);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn(), fetchChangePlans: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
}));

const KEY = toolListQuery("ws-1").queryKey;
type ShownGroup = "files" | "git" | "browser";

/** The list at `settingsRevision`: Files and Browser on and Git off, unless `states` says otherwise. */
function listOf(states: Partial<Record<ShownGroup, CapabilityToolGroupState>> = {}, settingsRevision = 7) {
  const group = (groupId: ShownGroup, label: string, state: CapabilityToolGroupState) => ({
    groupId,
    label,
    description: `${label} tools`,
    state,
    risk: "caution" as const,
    tools: [],
    blockedToolCount: 0,
  });
  return {
    workspaceId: "ws-1",
    groups: [
      group("files", "Files", states.files ?? "on"),
      group("git", "Git", states.git ?? "off"),
      group("browser", "Browser", states.browser ?? "on"),
    ],
    settingsRevision,
    issues: [],
    generatedAt: "2026-10-28T10:00:00.000Z",
  } satisfies CapabilityToolsResponse;
}

const APPROVAL: ChangePlanRequiredAction = {
  kind: "approval",
  actionId: "action-1",
  actionNonce: "n".repeat(32),
  title: "Switch Git on",
  risk: "caution",
  approvalId: "approval-1",
};
const WAITING: Partial<ChangePlanReceipt> = { status: "awaiting_approval", requiredAction: APPROVAL };

/** The settings save's answer at `revision`, with the Change Plan receipt when Change Plans are on. */
function saved(revision: number, receipt?: Partial<ChangePlanReceipt>) {
  return {
    revision,
    ...(receipt
      ? {
          changePlanReceipt: {
            planId: "plan-git",
            status: "completed",
            revision: 3,
            risk: "caution",
            summary: "Switch Git on.",
            ...receipt,
          },
        }
      : {}),
  };
}

/** The plan a switch-on of `groupId` makes, waiting in Inbox unless `overrides` says otherwise. */
function plan(overrides: Partial<ChangePlanRecord> = {}, groupId: ToolGroupId = "git"): ChangePlanRecord {
  return {
    planId: `plan-${groupId}`,
    kind: "runtime_configuration",
    origin: { workspaceId: "default", surface: "settings", actorId: "operator" },
    request: { kind: "runtime_configuration", change: { operation: "tool_group_access", groupId, enabled: true } },
    target: { ownerId: "runtime_settings", resourceId: `tool_group_access:${groupId}`, expectedRevision: 7 },
    status: "awaiting_approval",
    requiredAction: APPROVAL,
    revision: 3,
    ...overrides,
  } as unknown as ChangePlanRecord;
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
/** What the Gateway's list says now; every read of the list answers it. */
let server: CapabilityToolsResponse;
/** The latest switch of each group, read the way a Most used card, a row or the panel reads it. */
let shown: Partial<Record<ShownGroup, ToolGroupSwitch>>;

/** One view of a group, reading its row live from the cached list like the Tools tab. */
function Probe({ groupId }: { groupId: ShownGroup }) {
  const list = useQuery(toolListQuery("ws-1")).data!;
  shown[groupId] = useToolGroupSwitch(list.groups.find((entry) => entry.groupId === groupId)!, list.settingsRevision);
  return null;
}

const sw = (groupId: ShownGroup) => shown[groupId]!;
const cachedState = (groupId: ShownGroup) =>
  client.getQueryData<CapabilityToolsResponse>(KEY)?.groups.find((entry) => entry.groupId === groupId)?.state;

/** Lets every awaited mock and every list notification settle. Timeouts stay real; only the plan polls are faked. */
async function settle() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(groupIds: readonly ShownGroup[] = ["files", "git", "browser"]) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {groupIds.map((groupId) => (
          <Probe key={groupId} groupId={groupId} />
        ))}
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** A fresh page: no switches remembered, a new cache holding the Gateway's list. */
function freshPage() {
  act(() => root.unmount());
  client.clear();
  __resetToolGroupSwitchesForTests();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(KEY, server);
  root = createRoot(container);
  shown = {};
}

/** Moves the plan polls on by `ms`, then lets what they started settle. */
async function beat(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

/** Switches `groupId` on, waits in Inbox, and lets the next read of its plan answer `ended`. */
async function waitThenEnd(groupId: ShownGroup, ended: Partial<ChangePlanRecord>) {
  settings.patchSettings.mockResolvedValueOnce(saved(7, { ...WAITING, planId: `plan-${groupId}` }));
  plans.fetchChangePlan.mockResolvedValueOnce(plan({ requiredAction: undefined, ...ended }, groupId));
  await act(async () => sw(groupId).setEnabled(true));
  await settle();
  expect(sw(groupId).waiting).toBe(true);
  await beat(5_000);
}

const fakePolls = () => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

beforeEach(() => {
  settings.patchSettings.mockReset();
  tools.fetchCapabilityTools.mockReset();
  plans.fetchChangePlan.mockReset();
  plans.fetchChangePlans.mockReset();
  server = listOf();
  tools.fetchCapabilityTools.mockImplementation(async () => server);
  plans.fetchChangePlans.mockResolvedValue({ items: [] });
  // Data is fresh until something invalidates it, so a mount reads nothing and every read here is one the hook asked for.
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
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
  __resetToolGroupSwitchesForTests();
  vi.useRealTimers();
});

describe("useToolGroupSwitch", () => {
  it("turns off at once and rolls back only that group on failure", async () => {
    const saving = deferred<unknown>();
    settings.patchSettings.mockReturnValueOnce(saving.promise);
    // The read after the failure is held, so the cache shows exactly what the hook put back.
    tools.fetchCapabilityTools.mockReturnValueOnce(new Promise(() => {}));
    await render();

    await act(async () => sw("files").setEnabled(false));
    await settle();
    expect(settings.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      toolGroupChange: { groupId: "files", enabled: false },
    });
    expect(cachedState("files")).toBe("off");
    expect(sw("files")).toMatchObject({ checked: false, pending: true, waiting: false });

    // A newer list lands for another group while the save runs; the failure must not undo it.
    client.setQueryData<CapabilityToolsResponse>(KEY, (list) =>
      list ? { ...list, groups: list.groups.map((g) => (g.groupId === "browser" ? { ...g, state: "off" } : g)) } : list,
    );
    await act(async () =>
      saving.reject(
        new ApiRequestError("boom", { kind: "http", method: "PATCH", path: "/api/v1/settings", status: 500 }),
      ),
    );
    await settle();

    expect(cachedState("files")).toBe("on");
    expect(cachedState("browser")).toBe("off");
    expect(sw("files")).toMatchObject({
      checked: true,
      pending: false,
      failure: { message: "The gateway hit an error. Try again, or check System health.", conflict: false },
    });
    // A request that reported a failure can still have been committed, so the list is read again.
    expect(tools.fetchCapabilityTools).toHaveBeenCalledOnce();
  });

  it("doesn't show On before the save lands", async () => {
    const saving = deferred<unknown>();
    settings.patchSettings.mockReturnValueOnce(saving.promise);
    await render();

    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(settings.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      toolGroupChange: { groupId: "git", enabled: true },
    });
    expect(cachedState("git")).toBe("off");
    expect(sw("git")).toMatchObject({ checked: false, pending: true, waiting: false });

    // Change Plans are off, so the answer has no receipt. On shows once the list read after it says so.
    const reading = deferred<CapabilityToolsResponse>();
    tools.fetchCapabilityTools.mockReturnValueOnce(reading.promise);
    await act(async () => saving.resolve(saved(8)));
    await settle();
    expect(cachedState("git")).toBe("off");
    expect(sw("git")).toMatchObject({ checked: false, pending: true });

    await act(async () => reading.resolve(listOf({ git: "on" }, 8)));
    await settle();
    expect(sw("git")).toMatchObject({ checked: true, pending: false, waiting: false });
    expect(sw("git").failure).toBeUndefined();
  });

  it("waits in Inbox and turns on when the approval lands", async () => {
    fakePolls();
    settings.patchSettings.mockResolvedValueOnce(saved(7, WAITING));
    plans.fetchChangePlan
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce(plan({ status: "completed", requiredAction: undefined }));
    await render();

    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(sw("git")).toMatchObject({ checked: false, pending: false, waiting: true, waitingApprovalId: "approval-1" });
    expect(cachedState("git")).toBe("off");

    await beat(4_999);
    expect(plans.fetchChangePlan).not.toHaveBeenCalled();
    await beat(1);
    expect(plans.fetchChangePlan).toHaveBeenCalledExactlyOnceWith("plan-git", { workspaceId: "default" });
    expect(sw("git")).toMatchObject({ checked: false, waiting: true, waitingApprovalId: "approval-1" });

    server = listOf({ git: "on" }, 8);
    await beat(5_000);
    expect(sw("git")).toMatchObject({ checked: true, pending: false, waiting: false });
    expect(sw("git").waitingApprovalId).toBeUndefined();
    expect(sw("git").failure).toBeUndefined();
    // The plan is settled, so nothing reads it again.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says it was declined and stays off", async () => {
    fakePolls();
    await render();
    await waitThenEnd("git", {
      status: "cancelled",
      result: { summary: "Approval is denied. This plan cannot apply.", failureCode: "approval_denied" },
    });

    expect(sw("git")).toMatchObject({
      checked: false,
      pending: false,
      waiting: false,
      failure: { message: "Not switched on. The change was declined in Inbox.", conflict: false },
    });
    expect(sw("git").waitingApprovalId).toBeUndefined();
    expect(cachedState("git")).toBe("off");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says the request expired", async () => {
    fakePolls();
    server = listOf({ browser: "off" });
    client.setQueryData(KEY, server);
    await render();
    // Expired in Inbox, and expired before anyone answered it.
    await waitThenEnd("git", {
      status: "failed",
      result: { summary: "Approval is expired.", failureCode: "approval_expired" },
    });
    await waitThenEnd("browser", {
      status: "failed",
      result: { summary: "This Change Plan expired.", failureCode: "expired" },
    });

    expect(sw("git").failure).toEqual({ message: "Not switched on. The request expired.", conflict: false });
    expect(sw("browser").failure).toEqual({ message: "Not switched on. The request expired.", conflict: false });
  });

  it("says the request was cancelled", async () => {
    fakePolls();
    await render();
    await waitThenEnd("git", { status: "cancelled", result: { summary: "Cancelled by the operator." } });

    expect(sw("git")).toMatchObject({
      checked: false,
      waiting: false,
      failure: { message: "Not switched on. The request was cancelled.", conflict: false },
    });
  });

  it("says settings changed while it waited, and to switch it on again", async () => {
    fakePolls();
    server = listOf({ browser: "off" });
    client.setQueryData(KEY, server);
    await render();
    // How the Gateway ends it: any other save moves the settings revision before the approval, and the apply refuses
    // with a conflict. That lands as a generic adapter failure whose summary is the conflict's message.
    await waitThenEnd("git", {
      status: "failed",
      result: {
        summary: "Runtime settings changed after this Change Plan was prepared.",
        failureCode: "adapter_failed",
      },
    });
    // The same by its code, whatever the summary says.
    await waitThenEnd("browser", {
      status: "failed",
      result: { summary: "Something else entirely.", failureCode: "WRITE_CONFLICT" },
    });

    const message = "Not switched on. Settings changed while this waited in Inbox. Switch it on again.";
    expect(sw("git")).toMatchObject({ checked: false, pending: false, waiting: false, failure: { message } });
    expect(sw("git").failure?.conflict).toBe(false);
    expect(sw("browser").failure).toEqual({ message, conflict: false });
    // The list is read again, so the row shows what the Gateway holds.
    expect(cachedState("git")).toBe("off");
  });

  it("says plainly why any other ended plan didn't switch on", async () => {
    fakePolls();
    server = listOf({ browser: "off" });
    client.setQueryData(KEY, server);
    await render();
    await waitThenEnd("git", {
      status: "rolled_back",
      result: { summary: "The change didn't hold, so it was put back.", failureCode: "owner_verification_failed" },
    });
    await waitThenEnd("browser", {
      status: "failed",
      result: { summary: "TypeError: Cannot read properties of undefined", failureCode: "adapter_failed" },
    });

    expect(sw("git").failure?.message).toBe("Not switched on. The change didn't hold, so it was put back.");
    // Error text is never shown as the reason.
    expect(sw("browser").failure?.message).toBe("Not switched on. Something went wrong. Try again.");
  });

  it("keeps waiting without a link when the approval has no id", async () => {
    fakePolls();
    const { approvalId: _approvalId, ...withoutId } = APPROVAL as Extract<
      ChangePlanRequiredAction,
      { kind: "approval" }
    >;
    settings.patchSettings.mockResolvedValueOnce(saved(7, { status: "awaiting_approval", requiredAction: withoutId }));
    plans.fetchChangePlan.mockResolvedValueOnce(plan({ requiredAction: withoutId })).mockResolvedValueOnce(plan());
    await render();

    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(sw("git")).toMatchObject({ checked: false, pending: false, waiting: true });
    expect(sw("git").waitingApprovalId).toBeUndefined();

    await beat(5_000);
    expect(sw("git")).toMatchObject({ waiting: true });
    expect(sw("git").waitingApprovalId).toBeUndefined();
    await beat(5_000);
    expect(sw("git")).toMatchObject({ waiting: true, waitingApprovalId: "approval-1" });
  });

  it("explains a conflict and reloads", async () => {
    settings.patchSettings.mockRejectedValueOnce(
      new ApiRequestError("conflict", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/settings",
        status: 409,
        body: { code: "WRITE_CONFLICT" },
      }),
    );
    await render();

    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(sw("git").failure).toEqual({ message: "Changed elsewhere. Reload to see the latest.", conflict: true });
    expect(sw("git")).toMatchObject({ checked: false, pending: false });

    const reads = tools.fetchCapabilityTools.mock.calls.length;
    await act(async () => sw("git").reload());
    await settle();
    expect(tools.fetchCapabilityTools).toHaveBeenCalledTimes(reads + 1);
    expect(sw("git").failure).toBeUndefined();
  });

  it("ignores a second click while saving", async () => {
    const saving = deferred<unknown>();
    settings.patchSettings.mockReturnValueOnce(saving.promise);
    await render();

    await act(async () => {
      sw("files").setEnabled(false);
      sw("files").setEnabled(true);
    });
    await settle();
    await act(async () => sw("files").setEnabled(true));
    await settle();

    expect(settings.patchSettings).toHaveBeenCalledOnce();
    expect(cachedState("files")).toBe("off");
    expect(sw("files").pending).toBe(true);

    server = listOf({ files: "off" }, 8);
    await act(async () => saving.resolve(saved(8, { planId: "plan-files", status: "completed" })));
    await settle();
    expect(settings.patchSettings).toHaveBeenCalledOnce();
    expect(sw("files")).toMatchObject({ checked: false, pending: false });
  });

  it("ignores a second group's toggle while another saves", async () => {
    const saving = deferred<unknown>();
    settings.patchSettings.mockReturnValueOnce(saving.promise).mockResolvedValueOnce(saved(9));
    await render();

    await act(async () => sw("files").setEnabled(false));
    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(settings.patchSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 7,
      toolGroupChange: { groupId: "files", enabled: false },
    });
    expect(sw("git")).toMatchObject({ checked: false, pending: false, waiting: false });
    expect(sw("git").failure).toBeUndefined();

    // Once that save has landed, the other group can be switched.
    server = listOf({ files: "off" }, 8);
    await act(async () => saving.resolve(saved(8)));
    await settle();
    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(settings.patchSettings).toHaveBeenCalledTimes(2);
    expect(settings.patchSettings).toHaveBeenLastCalledWith({
      expectedRevision: 8,
      toolGroupChange: { groupId: "git", enabled: true },
    });
  });

  it("uses the revision the last save returned for the next toggle", async () => {
    // Every read of the list is held, so only the save's own answer can move the revision on.
    tools.fetchCapabilityTools.mockReturnValue(new Promise(() => {}));
    settings.patchSettings
      .mockResolvedValueOnce(saved(8, { planId: "plan-files", status: "completed" }))
      .mockResolvedValueOnce(saved(9));
    await render();

    await act(async () => sw("files").setEnabled(false));
    await settle();
    expect(client.getQueryData<CapabilityToolsResponse>(KEY)?.settingsRevision).toBe(8);
    // Files is still waiting for the list to confirm it, but that doesn't hold up another group.
    expect(sw("files").pending).toBe(true);

    await act(async () => sw("git").setEnabled(true));
    await settle();
    expect(settings.patchSettings).toHaveBeenLastCalledWith({
      expectedRevision: 8,
      toolGroupChange: { groupId: "git", enabled: true },
    });
  });

  it("keeps waiting after the hook unmounts and after a reload", async () => {
    fakePolls();
    settings.patchSettings.mockResolvedValueOnce(saved(7, WAITING));
    plans.fetchChangePlan.mockResolvedValue(plan());
    await render(["git"]);
    await act(async () => sw("git").setEnabled(true));
    await settle();

    // Every view of Git goes away (the panel closes, the tab changes), and the plan is still read.
    await act(async () => root.render(null));
    await beat(5_000);
    expect(plans.fetchChangePlan).toHaveBeenCalledOnce();
    await render(["git"]);
    expect(sw("git")).toMatchObject({ checked: false, waiting: true, waitingApprovalId: "approval-1" });

    // A reload forgets this tab's switches. The plan still waiting in Inbox is read back once for every view.
    freshPage();
    plans.fetchChangePlans.mockClear();
    const otherSetting = plan({
      planId: "plan-flag",
      request: { kind: "runtime_configuration", change: { operation: "feature_flag", flag: "x", enabled: true } },
      target: { ownerId: "runtime_settings", resourceId: "feature:x" },
    } as unknown as Partial<ChangePlanRecord>);
    const otherTarget = plan(
      { target: { ownerId: "runtime_settings", resourceId: "tool_group_access:files" } } as Partial<ChangePlanRecord>,
      "browser",
    );
    plans.fetchChangePlans.mockResolvedValueOnce({ items: [otherSetting, otherTarget, plan()] });
    await render(["files", "git", "browser"]);

    expect(plans.fetchChangePlans).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "default" },
      { status: "awaiting_approval", limit: 100 },
    );
    expect(sw("git")).toMatchObject({ checked: false, waiting: true, waitingApprovalId: "approval-1" });
    expect(sw("files").waiting).toBe(false);
    expect(sw("browser").waiting).toBe(false);

    plans.fetchChangePlan.mockResolvedValueOnce(plan({ status: "completed", requiredAction: undefined }));
    server = listOf({ git: "on" }, 8);
    await beat(5_000);
    expect(sw("git")).toMatchObject({ checked: true, waiting: false });
  });
});
