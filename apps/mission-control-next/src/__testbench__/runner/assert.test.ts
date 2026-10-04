import { describe, expect, it } from "vitest";
import { CheckAssertionError, ensure, fail, pass, sleep, summarizeEvidence, waitFor } from "./assert";

describe("ensure", () => {
  it("throws a CheckAssertionError that carries the evidence", () => {
    expect(() => ensure(false, "Expected ok.", { ok: false })).toThrow(CheckAssertionError);
    try {
      ensure(0, "Expected a count.", { count: 0 });
    } catch (error) {
      expect(error).toMatchObject({ message: "Expected a count.", evidence: { count: 0 } });
    }
  });

  it("does nothing when the condition holds", () => {
    expect(() => ensure("value", "unused")).not.toThrow();
  });
});

describe("pass and fail", () => {
  it("build results and omit undefined evidence", () => {
    expect(pass("ok")).toEqual({ status: "pass", summary: "ok" });
    expect(fail("bad", { code: 1 })).toEqual({ status: "fail", summary: "bad", evidence: { code: 1 } });
  });
});

describe("waitFor", () => {
  it("resolves with the first value that satisfies the condition", async () => {
    let calls = 0;
    const value = await waitFor(
      async () => {
        calls += 1;
        return calls;
      },
      (count) => count >= 3,
      { signal: new AbortController().signal, timeoutMs: 1_000, intervalMs: 1, label: "Counting" },
    );
    expect(value).toBe(3);
  });

  it("fails with the label and the last value after the timeout", async () => {
    await expect(
      waitFor(
        async () => "still waiting",
        () => false,
        {
          signal: new AbortController().signal,
          timeoutMs: 20,
          intervalMs: 5,
          label: "The approval",
        },
      ),
    ).rejects.toMatchObject({ name: "CheckAssertionError", evidence: "still waiting" });
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const waiting = waitFor(
      async () => false,
      (done) => done,
      {
        signal: controller.signal,
        timeoutMs: 10_000,
        intervalMs: 5,
        label: "Never",
      },
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sleep", () => {
  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("summarizeEvidence", () => {
  it("keeps small values and truncates large ones", () => {
    expect(summarizeEvidence({ ok: true })).toEqual({ ok: true });
    const summarized = summarizeEvidence("x".repeat(50), 10);
    expect(summarized).toBe("xxxxxxxxxx… (40 more characters)");
  });
});
