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
import { __resetSkillInstallsForTests, useSkillInstall, type SkillInstall } from "./use-skill-install";

const api = vi.hoisted(() => ({
  reviewCapabilitySkill: vi.fn(),
  requestCapabilitySkillOperation: vi.fn(),
  fetchCapabilitySkillInstalls: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "ws-1" }),
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
    expect(shown.state).toMatchObject({ phase: "ready", install: { step: "blocked" } });
  });
});
