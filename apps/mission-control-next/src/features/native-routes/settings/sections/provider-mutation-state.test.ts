import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import { freshReadsActive } from "@goatcitadel/mission-control-shared/api/fresh-reads";
import {
  __resetProviderMutationStateForTests,
  beginProviderMutation,
  checkProviderMutationOutcome,
  dispatchProviderMutation,
  finishProviderMutation,
  readProviderMutationState,
  retainProviderMutationUncertainty,
} from "./provider-mutation-state";

const api = vi.hoisted(() => ({ fetchLlmConfig: vi.fn() }));
// The connected installation can be switched by a test; the real capture records the installation it actually used.
const gateway = vi.hoisted(() => ({ override: undefined as string | undefined }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client-core")>();
  return { ...original, getGatewayApiBaseUrl: () => gateway.override ?? original.getGatewayApiBaseUrl() };
});
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchLlmConfig: api.fetchLlmConfig,
}));

type AttemptReply = { status: number; body: unknown };
let attemptReply: AttemptReply;
let fetchMock: ReturnType<typeof vi.fn>;
const reload = vi.fn(async () => undefined);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function sentKey() {
  const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
  return ((call?.[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
}
function attemptReads() {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/api/v1/mutation-attempts/"));
}

/** A provider save whose reply is lost after dispatch, exactly as the owner hooks run it. */
async function loseProviderSave(dispatch = () => request("/api/v1/settings", { method: "PATCH", body: "{}" })) {
  expect(beginProviderMutation()).toBe(true);
  try {
    await dispatchProviderMutation(dispatch);
  } catch {
    retainProviderMutationUncertainty();
  } finally {
    finishProviderMutation();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  gateway.override = undefined;
  __resetProviderMutationStateForTests();
  api.fetchLlmConfig.mockResolvedValue({ revision: 8, providers: [] });
  reload.mockResolvedValue(undefined);
  attemptReply = { status: 200, body: { attempt: { status: "completed", claimExpired: false } } };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/v1/mutation-attempts/")) return json(attemptReply.status, attemptReply.body);
    if (init?.method === "PATCH") throw new TypeError("Failed to fetch");
    throw new Error("Unexpected request " + url);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  __resetProviderMutationStateForTests();
  vi.unstubAllGlobals();
});

describe("provider lost-response recovery", () => {
  it("reads the Gateway record of the exact lost attempt and unlocks only after a canonical readback", async () => {
    await loseProviderSave();
    expect(readProviderMutationState()).toMatchObject({ pending: false, checkable: true });
    expect(readProviderMutationState().uncertain).toMatch(/locked/i);
    expect(beginProviderMutation()).toBe(false);

    await checkProviderMutationOutcome(reload);

    const [read] = attemptReads();
    expect(read).toContain(`/api/v1/mutation-attempts/${sentKey()}?`);
    expect(read).toContain("method=PATCH");
    expect(read).toContain(`route=${encodeURIComponent("/api/v1/settings")}`);
    expect(api.fetchLlmConfig).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
    const state = readProviderMutationState();
    expect(state.uncertain).toBeUndefined();
    expect(state.outcome).toMatch(/recorded .* as processed/i);
    expect(state.outcome).toMatch(/read back/i);
    expect(beginProviderMutation()).toBe(true);
  });

  it("unlocks a released attempt after readback without claiming nothing was applied", async () => {
    attemptReply = { status: 200, body: { attempt: { status: "failed", claimExpired: false } } };
    await loseProviderSave();
    await checkProviderMutationOutcome(reload);
    const state = readProviderMutationState();
    expect(state.uncertain).toBeUndefined();
    expect(state.outcome).toMatch(/may still have been applied/i);
    expect(state.outcome).not.toMatch(/not applied|nothing was applied/i);
  });

  it.each([
    [{ status: "pending", claimExpired: false }, /still running/i],
    [{ status: "pending", claimExpired: true }, /expired/i],
    [{ status: "absent" }, /no record .* yet.*if this persists/i],
  ])("keeps the lock for %o and lets the operator check again", async (attempt, message) => {
    attemptReply = { status: 200, body: { attempt } };
    await loseProviderSave();
    await checkProviderMutationOutcome(reload);
    const state = readProviderMutationState();
    expect(state.uncertain).toBeTruthy();
    expect(state.checkable).toBe(true);
    expect(state.outcome).toMatch(message);
    expect(api.fetchLlmConfig).not.toHaveBeenCalled();
    expect(beginProviderMutation()).toBe(false);
    attemptReply = { status: 200, body: { attempt: { status: "completed", claimExpired: false } } };
    await checkProviderMutationOutcome(reload);
    expect(readProviderMutationState().uncertain).toBeUndefined();
  });

  it("keeps the lock when the attempt read is refused", async () => {
    attemptReply = { status: 403, body: { error: "forbidden" } };
    await loseProviderSave();
    await checkProviderMutationOutcome(reload);
    expect(readProviderMutationState().uncertain).toBeTruthy();
    expect(readProviderMutationState().outcome).toMatch(/check failed/i);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the lock when the canonical readback fails after a committed record", async () => {
    api.fetchLlmConfig.mockRejectedValue(new Error("Gateway unavailable"));
    await loseProviderSave();
    await checkProviderMutationOutcome(reload);
    expect(readProviderMutationState().uncertain).toBeTruthy();
    expect(readProviderMutationState().outcome).toMatch(/check failed/i);
    expect(reload).not.toHaveBeenCalled();
  });

  it("offers no check for a mutation it could not identify", async () => {
    await loseProviderSave(async () => {
      await Promise.resolve();
      return request("/api/v1/settings", { method: "PATCH", body: "{}" });
    });
    expect(readProviderMutationState()).toMatchObject({ checkable: false });
    await checkProviderMutationOutcome(reload);
    expect(attemptReads()).toEqual([]);
    expect(readProviderMutationState().uncertain).toBeTruthy();
  });

  it("never lends an earlier completed write's key to a later lost write it could not identify", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/v1/mutation-attempts/")) return json(attemptReply.status, attemptReply.body);
      if (init?.method === "PATCH" && String(url).includes("/api/v1/llm/config")) return json(200, { ok: true });
      throw new TypeError("Failed to fetch");
    });
    expect(beginProviderMutation()).toBe(true);
    try {
      await dispatchProviderMutation(() => request("/api/v1/llm/config", { method: "PATCH", body: "{}" }));
      await dispatchProviderMutation(async () => {
        await Promise.resolve();
        return request("/api/v1/settings", { method: "PATCH", body: "{}" });
      });
    } catch {
      retainProviderMutationUncertainty();
    } finally {
      finishProviderMutation();
    }
    expect(readProviderMutationState()).toMatchObject({ checkable: false });
    await checkProviderMutationOutcome(reload);
    expect(attemptReads()).toEqual([]);
    expect(readProviderMutationState().uncertain).toBeTruthy();
  });

  it("offers no check for a route outside the provider owner", async () => {
    await loseProviderSave(() => request("/api/v1/integrations/connections", { method: "PATCH", body: "{}" }));
    expect(readProviderMutationState()).toMatchObject({ checkable: false });
  });
  it("refuses to check a lost attempt against a different Gateway installation", async () => {
    await loseProviderSave();
    gateway.override = "http://other-gateway.invalid";
    await checkProviderMutationOutcome(reload);
    expect(attemptReads()).toEqual([]);
    expect(readProviderMutationState().uncertain).toBeTruthy();
    expect(readProviderMutationState().outcome).toMatch(/different Gateway/);
  });

  it.each(["during the attempt read", "during the readback"])(
    "keeps the lock when the Gateway connection changes %s",
    async (when) => {
      await loseProviderSave();
      if (when === "during the attempt read")
        fetchMock.mockImplementation(async () => {
          gateway.override = "http://other-gateway.invalid";
          return json(attemptReply.status, attemptReply.body);
        });
      else
        api.fetchLlmConfig.mockImplementation(async () => {
          gateway.override = "http://other-gateway.invalid";
          return { revision: 8, providers: [] };
        });
      await checkProviderMutationOutcome(reload);
      const state = readProviderMutationState();
      expect(state.uncertain).toBeTruthy();
      expect(state.checking).toBe(false);
      expect(state.outcome).toMatch(/different Gateway/);
      expect(reload).not.toHaveBeenCalled();
      if (when === "during the attempt read") expect(api.fetchLlmConfig).not.toHaveBeenCalled();
    },
  );
  it("reloads fresh as well", async () => {
    await loseProviderSave();
    let fresh = false;
    reload.mockImplementation(async () => {
      fresh = freshReadsActive();
    });
    await checkProviderMutationOutcome(reload);
    expect(fresh).toBe(true);
  });

  it("reads back fresh, never joining an older in-flight read", async () => {
    await loseProviderSave();
    let fresh = false;
    api.fetchLlmConfig.mockImplementation(async () => {
      fresh = freshReadsActive();
      return { revision: 8, providers: [] };
    });
    await checkProviderMutationOutcome(reload);
    expect(fresh).toBe(true);
  });
});
