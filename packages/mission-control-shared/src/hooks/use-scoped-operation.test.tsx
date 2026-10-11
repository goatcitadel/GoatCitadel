import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiRequestError } from "../api/http-internal";
import { __resetApprovalOperationAttemptsForTests } from "../state/scoped-operation-attempts";
import { useScopedOperation } from "./use-scoped-operation";

type HookValue = ReturnType<typeof useScopedOperation>;

function Harness({ onValue }: { onValue: (value: HookValue) => void }) {
  onValue(useScopedOperation(JSON.stringify(["test-owner", "record-1"])));
  return null;
}

const http = (status: number) =>
  new ApiRequestError(`API error ${status}`, { kind: "http", method: "POST", path: "/api/v1/x", status, body: { message: "Content is required." } });
const network = () => new ApiRequestError("Network error: socket closed", { kind: "network", method: "POST", path: "/api/v1/x" });

describe("useScopedOperation", () => {
  let renderer: ReactTestRenderer | null = null;
  let latest!: HookValue;
  const preflight = vi.fn(async () => "fresh");
  const dispatch = vi.fn<(fresh: string) => Promise<string>>();

  beforeEach(async () => {
    __resetApprovalOperationAttemptsForTests();
    preflight.mockClear();
    dispatch.mockReset();
    await act(async () => {
      renderer = create(<Harness onValue={(value) => (latest = value)} />);
    });
  });
  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  async function run() {
    let outcome: { value?: string; error?: unknown } = {};
    await act(async () => {
      try {
        outcome = { value: await latest.run("rev-1", preflight, dispatch) };
      } catch (error) {
        outcome = { error };
      }
    });
    return outcome;
  }

  it("records a receipt and leaves the owner unlocked", async () => {
    dispatch.mockResolvedValue("receipt");
    expect((await run()).value).toBe("receipt");
    expect(latest.locked).toBe(false);
    expect(latest.attempt?.phase).toBe("resolved");
  });

  it.each([400, 409, 422])("treats a Gateway %s after dispatch as a refusal: no lock, user-facing error only", async (status) => {
    dispatch.mockRejectedValue(http(status));
    const { error } = await run();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("remains locked");
    expect((error as Error).message).toBe(status === 409 ? "This changed somewhere else. Refresh and try again." : "Content is required.");
    expect(latest.locked).toBe(false);
    expect(latest.attempt).toBeUndefined();
    dispatch.mockResolvedValue("receipt");
    expect((await run()).value).toBe("receipt");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "5xx", "abort", "unknown"])("keeps a %s failure after dispatch uncertain and locked until dismissed", async (kind) => {
    const abort = new Error("The operation was aborted.");
    abort.name = "AbortError";
    dispatch.mockRejectedValue(kind === "network" ? network() : kind === "5xx" ? http(503) : kind === "abort" ? abort : new Error("socket closed"));
    const { error } = await run();
    expect((error as Error).message).toContain("The original attempt remains locked.");
    expect(latest.locked).toBe(true);
    expect(latest.attempt?.phase).toBe("uncertain");
    expect(latest.attempt?.message).toContain("The request outcome is uncertain.");
    expect(latest.attempt?.message).toContain("reloaded");
    expect(latest.attempt?.message).not.toContain("a plain refresh does not settle");
    dispatch.mockResolvedValue("receipt");
    expect(await run()).toEqual({ value: undefined });
    expect(dispatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(latest.dismissUncertain()).toBe(true);
    });
    expect(latest.locked).toBe(false);
    expect((await run()).value).toBe("receipt");
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("does not lock when the preflight fails before anything is sent", async () => {
    preflight.mockRejectedValueOnce(http(500));
    const { error } = await run();
    expect((error as Error).message).toContain("No action was submitted.");
    expect(latest.locked).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(latest.dismissUncertain()).toBe(false);
  });
});
