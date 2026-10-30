// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilitySkillActionOutcome,
  CapabilitySkillInstall,
  CapabilitySkillInstallStep,
  CapabilitySkillOperationRequest,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetSkillInstallsForTests,
  resetSkillInstall,
  useSkillInstall,
  type SkillInstall,
} from "./use-skill-install";

const api = vi.hoisted(() => ({
  reviewCapabilitySkill: vi.fn(),
  requestCapabilitySkillOperation: vi.fn(),
  fetchCapabilitySkillInstalls: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => api);
const preferences = vi.hoisted(() => ({ activeWorkspaceId: "ws-1" }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));

const CHECK_ID = "snap-1";
const PACK = { kind: "pack", packId: "himalaya" } as const;

function checked(overrides: Partial<CapabilitySkillInstall> = {}): CapabilitySkillInstall {
  return {
    snapshotId: CHECK_ID,
    name: "Himalaya",
    description: "Read, search, organise and send mail.",
    source: PACK,
    step: "check_passed",
    blockers: [],
    asksFor: {
      tools: ["tool:shell.exec"],
      networkHosts: [],
      envVars: [],
      readsFiles: [],
      writesFiles: [],
      includesScripts: false,
      requires: ["himalaya"],
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
/** The install as the Gateway reads it now: every installs read answers it. */
let server: CapabilitySkillInstall;
/** Every request and read, in the order they were made. */
let calls: string[];
let shown: SkillInstall;

function Probe({ installKey }: { installKey: string }) {
  shown = useSkillInstall(installKey);
  return null;
}

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
        <Probe installKey={installKey} />
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function checkPack() {
  await act(async () => shown.check(PACK));
  await settle();
}

async function confirm() {
  await act(async () => shown.confirm());
  await settle();
}

/** The Gateway's answer to a step request: `approved` with the skip on, `waiting` without it, and where it leaves the install. */
function answerSteps(outcomes: Record<CapabilitySkillOperationRequest["operationKind"], "approved" | "waiting">) {
  api.requestCapabilitySkillOperation.mockImplementation(
    async ({ operationKind }: CapabilitySkillOperationRequest): Promise<CapabilitySkillActionOutcome> => {
      calls.push(operationKind);
      const approvalId = operationKind === "install_inactive" ? "approval-install" : "approval-on";
      const status = outcomes[operationKind];
      const step: CapabilitySkillInstallStep =
        operationKind === "install_inactive"
          ? status === "approved"
            ? "installing"
            : "waiting_install"
          : status === "approved"
            ? "switching_on"
            : "waiting_switch_on";
      server = checked({ step, ...(status === "waiting" ? { approvalId } : {}) });
      return { status, approvalId };
    },
  );
}

const reads = () => api.fetchCapabilitySkillInstalls.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  preferences.activeWorkspaceId = "ws-1";
  calls = [];
  server = checked();
  api.reviewCapabilitySkill.mockReset().mockImplementation(async () => {
    calls.push("check");
    return checked();
  });
  api.requestCapabilitySkillOperation.mockReset();
  api.fetchCapabilitySkillInstalls.mockReset().mockImplementation(async () => {
    calls.push(`read ${server.step}`);
    return { workspaceId: "ws-1", installs: [server], operatorApprovalSkip: true, generatedAt: "" };
  });
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
  vi.useRealTimers();
});

describe("useSkillInstall", () => {
  it("checks a reset panel in the workspace active now, not the one its last check was made in", async () => {
    const draft = "draft:git";
    const git = { kind: "git", sourceRef: "https://github.com/acme/skill" } as const;
    await render(draft);
    await act(async () => shown.check(git));
    await settle();
    expect(api.reviewCapabilitySkill).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "ws-1" }));

    preferences.activeWorkspaceId = "ws-2";
    await act(async () => resetSkillInstall(draft));
    await render(draft);
    expect(shown.workspaceId).toBe("ws-2");
    await act(async () => shown.check(git));
    await settle();
    expect(api.reviewCapabilitySkill).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: "ws-2" }));
  });

  it("requests install, then switch on, from one confirmation when the setting is on", async () => {
    answerSteps({ install_inactive: "approved", activate: "approved" });
    const refreshed = vi.spyOn(client, "invalidateQueries");
    await render();
    await checkPack();
    expect(shown.state).toMatchObject({ phase: "ready", install: { step: "check_passed" } });
    expect(api.reviewCapabilitySkill).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-1",
      source: PACK,
      idempotencyKey: expect.any(String),
    });

    await confirm();
    // Asked to install, then read at once: it is being installed.
    expect(shown.state).toMatchObject({ phase: "following", install: { step: "installing" } });
    // A second each while a step is applied.
    await beat(1_000);
    expect(calls.at(-1)).toBe("read installing");
    server = checked({ step: "installed_off" });
    await beat(1_000);

    // Installed after this confirmation: switching on is asked for with no other press.
    expect(shown.state).toMatchObject({ phase: "following", install: { step: "switching_on" } });
    server = checked({ step: "done", installedSkillId: "extra:himalaya" });
    await beat(1_000);

    expect(shown.state).toEqual({ phase: "done", skillId: "extra:himalaya", install: server });
    expect(calls).toEqual([
      "check",
      "install_inactive",
      "read installing",
      "read installing",
      "read installed_off",
      "activate",
      "read switching_on",
      "read done",
    ]);
    expect(api.requestCapabilitySkillOperation.mock.calls).toEqual([
      [{ workspaceId: "ws-1", snapshotId: CHECK_ID, operationKind: "install_inactive" }],
      [{ workspaceId: "ws-1", snapshotId: CHECK_ID, operationKind: "activate" }],
    ]);
    // Discover's marks, the installed list and the installs show it at once: Hub installs send no event.
    for (const queryKey of [
      ["skills", "capability-skill-discover"],
      ["skills", "capability-skills"],
      ["skills", "capability-skill-installs"],
    ]) {
      expect(refreshed).toHaveBeenCalledWith({ queryKey });
    }
    // Done stops the reads.
    const before = reads();
    await beat(60_000);
    expect(reads()).toBe(before);
  });

  it("refreshes Discover and the installs at every step and every answered request, the installed list only when done", async () => {
    answerSteps({ install_inactive: "waiting", activate: "waiting" });
    const refreshed = vi.spyOn(client, "invalidateQueries");
    const refreshes = () => refreshed.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
    const DISCOVER = JSON.stringify(["skills", "capability-skill-discover"]);
    const INSTALLS = JSON.stringify(["skills", "capability-skill-installs"]);
    const INSTALLED = JSON.stringify(["skills", "capability-skills"]);
    await render();
    await checkPack();
    expect(refreshes()).toEqual([]);

    // The request answered and the install now waits: Discover's row and the installs read it at once.
    await confirm();
    expect(shown.state).toMatchObject({ install: { step: "waiting_install" } });
    expect(refreshes()).toContain(DISCOVER);
    expect(refreshes()).toContain(INSTALLS);
    expect(refreshes()).not.toContain(INSTALLED);

    // A read that finds the same step changes nothing anywhere.
    refreshed.mockClear();
    await beat(5_000);
    expect(reads()).toBe(2);
    expect(refreshes()).toEqual([]);

    // Declined: back at the passed check, which Discover offers to install again.
    server = checked({ step: "check_passed" });
    await beat(5_000);
    expect(shown.notice).toBe("Not installed. The request was declined.");
    expect(refreshes()).toEqual([DISCOVER, INSTALLS]);

    // A request the checks refuse answers too.
    refreshed.mockClear();
    api.requestCapabilitySkillOperation.mockRejectedValueOnce(
      new ApiRequestError("blocked", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/skills/operations",
        status: 409,
        body: { error: "GoatCitadel's checks don't allow this step right now.", code: "STATE_CONFLICT" },
      }),
    );
    await confirm();
    expect(refreshes()).toContain(DISCOVER);
    expect(refreshes()).toContain(INSTALLS);
    expect(refreshes()).not.toContain(INSTALLED);

    // A stop is a step too.
    refreshed.mockClear();
    answerSteps({ install_inactive: "approved", activate: "approved" });
    await confirm();
    refreshed.mockClear();
    server = checked({ step: "failed", failure: "GoatCitadel's checks stopped the install." });
    await beat(1_000);
    expect(shown.state).toMatchObject({ phase: "failed" });
    expect(refreshes()).toEqual([DISCOVER, INSTALLS]);
  });

  it("waits for each step's approval, reading every 5 seconds, and asks for nothing more meanwhile", async () => {
    answerSteps({ install_inactive: "waiting", activate: "waiting" });
    await render();
    await checkPack();
    await confirm();
    expect(shown.state).toMatchObject({
      phase: "following",
      install: { step: "waiting_install", approvalId: "approval-install" },
    });

    await beat(4_999);
    expect(reads()).toBe(1);
    await beat(1);
    expect(reads()).toBe(2);
    expect(calls.filter((call) => call === "activate")).toEqual([]);

    // Approved in the panel: read at once rather than at the next check, and installed it goes on to switch on.
    server = checked({ step: "installed_off" });
    await act(async () => shown.checkNow());
    await settle();
    expect(shown.state).toMatchObject({
      phase: "following",
      install: { step: "waiting_switch_on", approvalId: "approval-on" },
    });
    expect(calls.filter((call) => call === "activate")).toHaveLength(1);
  });

  it("tells done apart from a decline by reading the one install", async () => {
    answerSteps({ install_inactive: "approved", activate: "waiting" });
    await render();
    await checkPack();
    await confirm();
    server = checked({ step: "installed_off" });
    await beat(1_000);
    expect(shown.state).toMatchObject({ install: { step: "waiting_switch_on" } });
    // Every read asks for this one check, so a step that left the in-progress list is still found.
    for (const [workspaceId, options] of api.fetchCapabilitySkillInstalls.mock.calls) {
      expect([workspaceId, options]).toEqual(["ws-1", { snapshotId: CHECK_ID, signal: expect.any(AbortSignal) }]);
    }

    // Declined: the install reads as the step before, and nothing says it is done.
    server = checked({ step: "installed_off" });
    await beat(5_000);
    expect(shown.state).toMatchObject({ phase: "following", install: { step: "installed_off" } });
    expect(shown.notice).toBe("Installed, not switched on. The request to switch it on was declined.");
    expect(shown.chain).toBe(false);
    const after = reads();
    await beat(60_000);
    expect(reads()).toBe(after);

    // Asked again and approved this time: done.
    answerSteps({ install_inactive: "approved", activate: "approved" });
    await confirm();
    expect(shown.notice).toBeUndefined();
    server = checked({ step: "done", installedSkillId: "extra:himalaya" });
    await beat(1_000);
    expect(shown.state).toMatchObject({ phase: "done", skillId: "extra:himalaya" });
  });

  it("says the install request was declined and can be asked again", async () => {
    answerSteps({ install_inactive: "waiting", activate: "waiting" });
    await render();
    await checkPack();
    await confirm();
    server = checked({ step: "check_passed" });
    await beat(5_000);

    expect(shown.state).toMatchObject({ phase: "ready", install: { step: "check_passed" } });
    expect(shown.notice).toBe("Not installed. The request was declined.");
    expect(shown.declined).toBe(true);
    await confirm();
    expect(calls.filter((call) => call === "install_inactive")).toHaveLength(2);
  });

  it("names the step that didn't finish and the Gateway's reason", async () => {
    answerSteps({ install_inactive: "approved", activate: "approved" });
    await render();
    await checkPack();
    await confirm();
    server = checked({ step: "failed", failure: "GoatCitadel's checks stopped the install." });
    await beat(1_000);

    expect(shown.state).toEqual({
      phase: "failed",
      message: "Installing didn't finish.",
      install: server,
    });
    expect(shown.asked).toBe("install_inactive");
  });

  it("reads a step that waits less often over time, down to every 30 seconds, after the panel closes too", async () => {
    answerSteps({ install_inactive: "waiting", activate: "waiting" });
    await render();
    await checkPack();
    await confirm();
    expect(reads()).toBe(1);
    // The flow outlasts the panel: nothing about the wait depends on a mounted view.
    act(() => root.unmount());

    const readAt: number[] = [];
    for (let second = 1; second <= 135; second += 1) {
      const before = reads();
      await beat(1_000);
      if (reads() > before) readAt.push(second);
    }
    // 5 seconds three times, then 10, 20 and every 30, as the skill switch reads its approval.
    expect(readAt).toEqual([5, 10, 15, 25, 45, 75, 105, 135]);
    root = createRoot(container);
  });

  it("reads a step being applied every second for 30 reads, then every 3 seconds", async () => {
    answerSteps({ install_inactive: "approved", activate: "approved" });
    await render();
    await checkPack();
    await confirm();
    expect(reads()).toBe(1);

    await beat(30_000);
    expect(reads()).toBe(31);
    await beat(2_999);
    expect(reads()).toBe(31);
    await beat(1);
    expect(reads()).toBe(32);
    await beat(3_000);
    expect(reads()).toBe(33);
  });

  it("reads an approval asked for again at the first pace, however long the last one waited", async () => {
    answerSteps({ install_inactive: "waiting", activate: "waiting" });
    await render();
    await checkPack();
    await confirm();
    const readAt = async (seconds: number) => {
      const at: number[] = [];
      for (let second = 1; second <= seconds; second += 1) {
        const before = reads();
        await beat(1_000);
        if (reads() > before) at.push(second);
      }
      return at;
    };
    // Waited long enough to be read every 30 seconds.
    expect(await readAt(75)).toEqual([5, 10, 15, 25, 45, 75]);

    // Declined somewhere else: the next read finds the passed check, and nothing more is read.
    server = checked({ step: "check_passed" });
    expect(await readAt(30)).toEqual([30]);
    expect(shown.notice).toBe("Not installed. The request was declined.");

    // Asked again: read at once, then 5 seconds later, not 30.
    const before = reads();
    await confirm();
    expect(reads()).toBe(before + 1);
    expect(await readAt(10)).toEqual([5, 10]);

    // Approved somewhere else at the slow pace of a long wait: once it is being installed, it is read every second.
    expect(await readAt(35)).toEqual([5, 15, 35]);
    server = checked({ step: "installing" });
    expect(await readAt(32)).toEqual([30, 31, 32]);
  });

  it("retries a failed read at a step that is not read on its own every 5 seconds", async () => {
    answerSteps({ install_inactive: "approved", activate: "waiting" });
    await render();
    await checkPack();
    await confirm();
    server = checked({ step: "installed_off" });
    await beat(1_000);
    // Declined: installed, not switched on, and nothing is read on its own.
    server = checked({ step: "installed_off" });
    await beat(5_000);
    expect(shown.notice).toBe("Installed, not switched on. The request to switch it on was declined.");

    // Switch on is refused, and the read that would say why fails.
    api.requestCapabilitySkillOperation.mockRejectedValueOnce(
      new ApiRequestError("blocked", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/skills/operations",
        status: 409,
        body: { error: "GoatCitadel's checks don't allow this step right now.", code: "STATE_CONFLICT" },
      }),
    );
    api.fetchCapabilitySkillInstalls.mockRejectedValue(new Error("offline"));
    const before = reads();
    await confirm();
    expect(reads()).toBe(before + 1);
    await beat(4_000);
    expect(reads()).toBe(before + 1);
    await beat(1_000);
    expect(reads()).toBe(before + 2);
    await beat(5_000);
    expect(reads()).toBe(before + 3);
  });

  it("counts failed reads toward the slower pace, and says when it can't check", async () => {
    answerSteps({ install_inactive: "approved", activate: "approved" });
    await render();
    await checkPack();
    await confirm();
    api.fetchCapabilitySkillInstalls.mockRejectedValue(new Error("offline"));

    await beat(3_000);
    expect(shown.unreadable).toBe(true);
    expect(shown.state).toMatchObject({ phase: "following", install: { step: "installing" } });
    // Thirty waits of a second, read or not, then every 3 seconds: a failing read doesn't hold the fast pace.
    await beat(27_000);
    expect(reads()).toBe(31);
    await beat(2_999);
    expect(reads()).toBe(31);
    await beat(1);
    expect(reads()).toBe(32);
  });

  it("keeps the check's key only to retry a check whose answer never came", async () => {
    await render();
    api.reviewCapabilitySkill.mockRejectedValueOnce(
      new ApiRequestError("offline", { kind: "network", method: "POST", path: "/reviews" }),
    );
    await checkPack();
    expect(shown.state).toMatchObject({ phase: "check_failed" });
    const first = api.reviewCapabilitySkill.mock.calls[0]![0].idempotencyKey as string;

    await checkPack();
    expect(api.reviewCapabilitySkill.mock.calls[1]![0].idempotencyKey).toBe(first);
    expect(shown.state).toMatchObject({ phase: "ready" });

    // A new check of the same source is a new check.
    await checkPack();
    expect(api.reviewCapabilitySkill.mock.calls[2]![0].idempotencyKey).not.toBe(first);
  });

  it("explains a refused source by its reason", async () => {
    await render();
    api.reviewCapabilitySkill.mockRejectedValueOnce(
      new ApiRequestError("refused", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/skills/reviews",
        status: 422,
        body: {
          error: "That source can't be checked.",
          code: "SKILL_SOURCE_REFUSED",
          details: { reason: "UNTRUSTED_GIT_HOST" },
        },
      }),
    );
    await act(async () => shown.check({ kind: "git", sourceRef: "https://example.com/acme/skills" }));
    await settle();

    expect(shown.state).toEqual({
      phase: "check_failed",
      message: "GoatCitadel installs skills only from GitHub, GitLab, Bitbucket or Codeberg.",
      code: "UNTRUSTED_GIT_HOST",
    });
  });

  it("points a panel whose check answered at the check, once", async () => {
    await render("draft:pack:himalaya");
    await checkPack();
    expect(shown.movedTo).toBe(CHECK_ID);
    expect(shown.state).toMatchObject({ phase: "ready", install: { snapshotId: CHECK_ID } });
  });

  it("shows a step the checks refuse with the route's own words", async () => {
    await render();
    await checkPack();
    api.requestCapabilitySkillOperation.mockRejectedValueOnce(
      new ApiRequestError("blocked", {
        kind: "http",
        method: "POST",
        path: "/api/v1/capabilities/skills/operations",
        status: 409,
        body: {
          error: "GoatCitadel's checks don't allow this step right now.",
          code: "STATE_CONFLICT",
          details: { reason: "blocked", blockers: ["SOURCE_ALREADY_INSTALLED"] },
        },
      }),
    );
    server = checked({ step: "blocked", blockers: ["SOURCE_ALREADY_INSTALLED"] });
    await confirm();

    expect(shown.notice).toBe("GoatCitadel's checks don't allow this step right now.");
    // A refusal is not the operator's own decline.
    expect(shown.declined).toBe(false);
    expect(shown.state).toMatchObject({ phase: "ready", install: { step: "blocked" } });
  });
});
