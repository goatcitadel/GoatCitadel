// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilityPluginDetail,
  CapabilityPluginInspectionRequest,
  CapabilityPluginInstallRequest,
  CapabilitySkillOperationRequest,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENDA,
  CALENDAR,
  INSPECTION_ID,
  NOTES,
  PLUGIN_ID,
  PLUGIN_KEY,
  approvePlugin,
  fakeGateway,
  httpError,
  inspectionOf,
  install,
  networkError,
  readDetail,
  readPlan,
  step,
  type FakeGateway,
} from "./plugin-install.test-support";
import { draftPluginInstallKey } from "./plugin-install-store";
import {
  __resetPluginInstallsForTests,
  takePluginInstallMove,
  usePluginInstall,
  type PluginInstall,
} from "./use-plugin-install";

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
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "ws-1" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));

const DRAFT = draftPluginInstallKey(`built_in:${PLUGIN_ID}`);
const BUILT_IN = { kind: "built_in", pluginId: PLUGIN_ID } as const;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let gateway: FakeGateway;
const shown: Record<string, PluginInstall> = {};

function Probe({ installKey, seed }: { installKey: string; seed?: CapabilityPluginDetail }) {
  shown[installKey] = usePluginInstall(installKey, installKey === PLUGIN_KEY && seed ? { detail: seed } : undefined);
  return null;
}

async function settle() {
  await act(async () => {
    for (let round = 0; round < 10; round += 1) await vi.advanceTimersByTimeAsync(0);
  });
}

async function beat(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function render(keys: string[] = [DRAFT, INSPECTION_ID, PLUGIN_KEY], seed?: CapabilityPluginDetail) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        {keys.map((key) => (
          <Probe key={key} installKey={key} seed={seed} />
        ))}
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function inspect() {
  await act(async () => shown[DRAFT]!.inspect(BUILT_IN));
  await settle();
}

async function confirm(key = INSPECTION_ID, secrets: Record<string, string> = {}) {
  let spent: boolean | undefined;
  await act(async () => {
    spent = await shown[key]!.confirm(secrets);
  });
  await settle();
  return spent;
}

/** Reads on the pace the flow keeps, until the plugin's state is done or the reads run out. */
async function follow(times = 20) {
  for (let read = 0; read < times && shown[PLUGIN_KEY]?.state.phase !== "done"; read += 1) await beat(1_000);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  preferences.activeWorkspaceId = "ws-1";
  gateway = fakeGateway();
  api.inspectCapabilityPlugin.mockReset().mockImplementation(async (_input: CapabilityPluginInspectionRequest) => {
    gateway.calls.push("inspect");
    return gateway.inspection;
  });
  api.installCapabilityPlugin.mockReset().mockImplementation(async () => install(gateway));
  api.fetchCapabilityPluginDetail.mockReset().mockImplementation(async () => {
    if (!gateway.installed) throw httpError(404, { error: "This plugin isn't installed." });
    return readDetail(gateway);
  });
  plans.fetchChangePlan.mockReset().mockImplementation(async () => readPlan(gateway));
  skills.requestCapabilitySkillOperation
    .mockReset()
    .mockImplementation(async (request: CapabilitySkillOperationRequest) => step(gateway, request));
  skills.fetchCapabilitySkillInstalls.mockReset();
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
  vi.useRealTimers();
});

describe("usePluginInstall", () => {
  it("installs every piece from one confirmation when the setting is on", async () => {
    await render();
    await inspect();
    expect(api.inspectCapabilityPlugin).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "ws-1", source: BUILT_IN },
      { attemptKey: expect.any(String) },
    );
    // The check answered: its panel moves to the inspection's own key, which holds it ready.
    expect(shown[DRAFT]!.movedTo).toBe(INSPECTION_ID);
    expect(shown[INSPECTION_ID]!.state).toMatchObject({ phase: "ready", inspection: { pluginId: PLUGIN_ID } });

    expect(await confirm()).toBe(true);
    expect(api.installCapabilityPlugin).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "ws-1", inspectionId: INSPECTION_ID },
      { attemptKey: expect.any(String) },
    );
    // The plan applied, so the plugin's own key goes on, where a reload finds it too.
    expect(shown[INSPECTION_ID]!.movedTo).toBe(PLUGIN_KEY);
    await follow();

    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ phase: "done", pluginId: PLUGIN_ID });
    // Each skill's two steps, in order, with no other press.
    expect(gateway.steps).toEqual(["snap-notes install_inactive", "snap-notes activate"]);
    expect(skills.requestCapabilitySkillOperation).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      snapshotId: "snap-notes",
      operationKind: "install_inactive",
    });
    expect(gateway.calls.filter((call) => !call.startsWith("detail") && !call.startsWith("plan"))).toEqual([
      "inspect",
      "install",
      "install_inactive",
      "activate",
    ]);
  });

  it("never shows Installed before every skill is switched on", async () => {
    gateway = fakeGateway(inspectionOf([CALENDAR, NOTES, AGENDA]));
    await render();
    await inspect();
    await confirm();

    for (let read = 0; read < 30 && shown[PLUGIN_KEY]?.state.phase !== "done"; read += 1) {
      const left = [NOTES, AGENDA].filter((piece) => gateway.pieces[piece.pieceId] !== "added");
      // The detail is the truth: while a skill isn't switched on, the plugin isn't installed.
      if (left.length > 0) expect(shown[PLUGIN_KEY]?.state.phase).not.toBe("done");
      await beat(1_000);
    }
    expect(shown[PLUGIN_KEY]!.state.phase).toBe("done");
    expect(gateway.steps).toEqual([
      "snap-notes install_inactive",
      "snap-notes activate",
      "snap-agenda install_inactive",
      "snap-agenda activate",
    ]);
  });

  it("continues an install left unfinished after a reload", async () => {
    gateway.installed = true;
    gateway.workspaceId = "ws-plugin";
    gateway.pieces = { calendar: "added", notes: "installed_off" };
    await render([PLUGIN_KEY], readDetail(gateway));

    // Nothing is asked for until the operator presses Continue.
    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ phase: "following" });
    expect(skills.requestCapabilitySkillOperation).not.toHaveBeenCalled();
    expect(shown[PLUGIN_KEY]!.workspaceId).toBe("ws-plugin");

    // Continue carries on from the first piece that isn't done, in the plugin's own workspace.
    expect(await confirm(PLUGIN_KEY)).toBe(false);
    expect(skills.requestCapabilitySkillOperation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-plugin",
      snapshotId: "snap-notes",
      operationKind: "activate",
    });
    await follow();
    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ phase: "done", pluginId: PLUGIN_ID });
  });

  it("names a skill's waiting step after a reload from the skill's own install", async () => {
    gateway.installed = true;
    gateway.workspaceId = "ws-plugin";
    gateway.pieces = { calendar: "added", notes: "waiting_for_approval" };
    gateway.pending = { notes: "approval-notes-on" };
    skills.fetchCapabilitySkillInstalls.mockResolvedValue({
      workspaceId: "ws-plugin",
      installs: [{ snapshotId: "snap-notes", step: "waiting_switch_on", approvalId: "approval-notes-on" }],
      operatorApprovalSkip: false,
      generatedAt: "",
    });
    await render([PLUGIN_KEY], readDetail(gateway));

    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ phase: "following", waitingApprovalId: "approval-notes-on" });
    expect(skills.fetchCapabilitySkillInstalls).toHaveBeenCalledWith(
      "ws-plugin",
      expect.objectContaining({ snapshotId: "snap-notes" }),
    );
    expect(shown[PLUGIN_KEY]!.waitingStep).toBe("activate");
  });

  it("asks again for a step the rate limit refused, on the paced schedule", async () => {
    skills.requestCapabilitySkillOperation
      .mockImplementationOnce(async () => {
        throw httpError(429, { error: "Too many requests." });
      })
      .mockImplementation(async (request: CapabilitySkillOperationRequest) => step(gateway, request));
    await render();
    await inspect();
    await confirm();

    expect(skills.requestCapabilitySkillOperation).toHaveBeenCalledTimes(1);
    // Not a refusal the operator has to act on: no line, and the confirmation goes on.
    expect(shown[PLUGIN_KEY]!.notice).toBeUndefined();
    await beat(5_000);
    expect(skills.requestCapabilitySkillOperation).toHaveBeenCalledTimes(2);
    for (let read = 0; read < 30 && shown[PLUGIN_KEY]?.state.phase !== "done"; read += 1) await beat(1_000);
    expect(shown[PLUGIN_KEY]!.state.phase).toBe("done");
  });

  it("backs off while the rate limit keeps refusing a step, and refreshes nothing for a refusal", async () => {
    skills.requestCapabilitySkillOperation.mockImplementation(async () => {
      throw httpError(429, { error: "Too many requests." });
    });
    await render();
    await inspect();
    await confirm();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const reads = api.fetchCapabilityPluginDetail.mock.calls.length;

    for (let second = 0; second < 60; second += 1) await beat(1_000);

    // The waiting pace: 5, 5, 5, 10, 20 and then every 30 seconds, never once a second.
    expect(skills.requestCapabilitySkillOperation.mock.calls.length).toBeLessThanOrEqual(7);
    expect(skills.requestCapabilitySkillOperation.mock.calls.length).toBeGreaterThanOrEqual(5);
    // One detail read per retry, far below the 60-a-minute detail limit, and no list refetch for a refusal.
    expect(api.fetchCapabilityPluginDetail.mock.calls.length - reads).toBeLessThanOrEqual(7);
    expect(invalidate).not.toHaveBeenCalled();
    expect(shown[PLUGIN_KEY]!.notice).toBeUndefined();
  });

  it("stops following a plugin plan that was declined or ran out of time", async () => {
    gateway.skip = false;
    await render();
    await inspect();
    await confirm();
    expect(shown[INSPECTION_ID]!.state).toMatchObject({ phase: "planned", approvalId: "approval-plugin" });

    gateway.plan = { status: "cancelled", failureCode: "approval_denied", summary: "Approval is denied." };
    await act(async () => shown[INSPECTION_ID]!.checkNow());
    await settle();
    expect(shown[INSPECTION_ID]!.state).toMatchObject({ phase: "ready" });
    expect(shown[INSPECTION_ID]!.notice).toBe("Not installed. The request was declined.");
    expect(shown[INSPECTION_ID]!.declined).toBe(true);
    const firstKey = api.installCapabilityPlugin.mock.calls[0]![1].attemptKey;

    await confirm();
    expect(api.installCapabilityPlugin.mock.calls[1]![1].attemptKey).not.toBe(firstKey);
    gateway.plan = { status: "failed", failureCode: "approval_expired", summary: "Approval is expired." };
    await beat(5_000);
    expect(shown[INSPECTION_ID]!.state).toMatchObject({ phase: "ready" });
    expect(shown[INSPECTION_ID]!.notice).toBe("The request expired after 15 minutes. Nothing was changed.");
    expect(shown[INSPECTION_ID]!.declined).toBe(false);
  });

  it("follows a plugin plan approved in place to its skills", async () => {
    gateway.skip = false;
    await render();
    await inspect();
    await confirm();
    approvePlugin(gateway);
    await act(async () => shown[INSPECTION_ID]!.checkNow());
    await settle();

    expect(shown[INSPECTION_ID]!.movedTo).toBe(PLUGIN_KEY);
    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ phase: "following", waitingApprovalId: "approval-notes-install" });
    // This confirmation asked for that step, so it is known without a read.
    expect(shown[PLUGIN_KEY]!.waitingStep).toBe("install_inactive");
    expect(skills.fetchCapabilitySkillInstalls).not.toHaveBeenCalled();

    // Its check keeps only the hand-over: reopening its address goes to the plugin again, never to a frozen install.
    let moved: string | undefined;
    await act(async () => {
      moved = takePluginInstallMove(INSPECTION_ID);
    });
    expect(moved).toBe(PLUGIN_KEY);
    expect(shown[INSPECTION_ID]!.state).toEqual({ phase: "idle" });
    expect(shown[INSPECTION_ID]!.movedTo).toBe(PLUGIN_KEY);
  });

  it("says a skill's step that came back didn't go through, claiming no decline", async () => {
    gateway.skip = false;
    await render();
    await inspect();
    await confirm();
    approvePlugin(gateway);
    await act(async () => shown[INSPECTION_ID]!.checkNow());
    await settle();
    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ waitingApprovalId: "approval-notes-install" });

    // The step's approval expired or was withdrawn: the skill reads as not installed again.
    gateway.pieces.notes = "check_passed";
    delete gateway.pending.notes;
    await act(async () => shown[PLUGIN_KEY]!.checkNow());
    await settle();

    expect(shown[PLUGIN_KEY]!.notice).toBe(
      "Meeting notes wasn't installed: the step didn't go through. Continue to ask again.",
    );
    expect(shown[PLUGIN_KEY]!.notice).not.toContain("declined");
  });

  it("sends a check or an install again with the same key only when its answer never came", async () => {
    await render();
    api.inspectCapabilityPlugin.mockRejectedValueOnce(networkError());
    await inspect();
    expect(shown[DRAFT]!.state).toMatchObject({ phase: "check_failed" });
    await inspect();
    const [first, second] = api.inspectCapabilityPlugin.mock.calls.map(([, options]) => options.attemptKey);
    expect(second).toBe(first);

    api.inspectCapabilityPlugin.mockRejectedValueOnce(
      httpError(404, {
        error: "GoatCitadel has no built-in plugin with that id.",
        code: "PLUGIN_REFUSED",
        details: { code: "BUILT_IN_NOT_FOUND" },
      }),
    );
    await inspect();
    expect(shown[DRAFT]!.state).toEqual({
      phase: "check_failed",
      message: "GoatCitadel has no built-in plugin with that id.",
      code: "BUILT_IN_NOT_FOUND",
    });
    await inspect();
    expect(api.inspectCapabilityPlugin.mock.calls[3]![1].attemptKey).not.toBe(first);

    api.installCapabilityPlugin.mockRejectedValueOnce(networkError());
    // An answer that never came keeps the secrets for the retry; one that came spends them.
    expect(await confirm(INSPECTION_ID, { watch: "s3cret" })).toBe(false);
    expect(shown[INSPECTION_ID]!.state.phase).toBe("ready");
    expect(shown[INSPECTION_ID]!.notice).toBeDefined();
    expect(await confirm(INSPECTION_ID, { watch: "s3cret" })).toBe(true);
    const sent = (
      api.installCapabilityPlugin.mock.calls as [CapabilityPluginInstallRequest, { attemptKey: string }][]
    ).map(([body, options]) => [body.hookSecrets, options.attemptKey]);
    expect(sent[1]).toEqual(sent[0]);
    expect(sent[0]![0]).toEqual({ watch: "s3cret" });
  });

  it("sends a secret typed again differently after a lost answer under a new key", async () => {
    await render();
    await inspect();
    api.installCapabilityPlugin.mockRejectedValueOnce(networkError());
    expect(await confirm(INSPECTION_ID, { watch: "first-secret" })).toBe(false);
    // Under the lost request's key the first secret would be what the Gateway keeps, so this one goes out afresh.
    expect(await confirm(INSPECTION_ID, { watch: "second-secret" })).toBe(true);
    const [first, second] = (
      api.installCapabilityPlugin.mock.calls as [CapabilityPluginInstallRequest, { attemptKey: string }][]
    ).map(([, options]) => options.attemptKey);
    expect(second).not.toBe(first);
  });

  it("says a refused install in its own words and keeps the check", async () => {
    await render();
    await inspect();
    api.installCapabilityPlugin.mockRejectedValueOnce(
      httpError(409, {
        error: "A plugin that ships with GoatCitadel already uses this id.",
        code: "PLUGIN_ID_RESERVED",
      }),
    );
    expect(await confirm()).toBe(true);
    expect(shown[INSPECTION_ID]!.state.phase).toBe("ready");
    expect(shown[INSPECTION_ID]!.notice).toBe("A plugin that ships with GoatCitadel already uses this id.");
    expect(shown[INSPECTION_ID]!.declined).toBe(false);
  });

  it("stops at a piece that isn't a skill with the plan's own summary, and asks for no skill step", async () => {
    const summary = "Couldn't save Calendar. Uninstall Meeting tools to remove what it added, then install it again.";
    gateway.installed = true;
    gateway.pieces = { calendar: "failed", notes: "check_passed" };
    gateway.plan = { status: "manual_required", summary };
    await render([PLUGIN_KEY], readDetail(gateway));

    expect(shown[PLUGIN_KEY]!.state).toMatchObject({ phase: "failed", message: summary });
    await act(async () => shown[PLUGIN_KEY]!.confirm({}));
    await settle();
    expect(skills.requestCapabilitySkillOperation).not.toHaveBeenCalled();
  });
});
