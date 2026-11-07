import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const fixtureUrl = new URL("../../test/fixtures/remote-worker-execution-diagnostic-gateway.mjs", import.meta.url);
async function observer() {
  expect(existsSync(fixtureUrl), "test-only bounded execution diagnostic entry must exist").toBe(true);
  // Do not start the Gateway when the fixture is imported as a unit-test module.
  const fixture = await import(/* @vite-ignore */ fixtureUrl.href);
  expect(fixture.observeExecutionRejections).toBeTypeOf("function");
  return fixture.observeExecutionRejections as (
    execute: (...args: unknown[]) => Promise<unknown>,
    read: (error: unknown) => unknown,
    emit: (line: string) => void,
    maximum?: number,
  ) => (...args: unknown[]) => Promise<unknown>;
}

describe("test-only native execution rejection observer", () => {
  it("calls the original exactly once and preserves both success and thrown object identity", async () => {
    const observe = await observer(), emit = vi.fn(), read = vi.fn(() => ({ stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" }));
    const success = Object.freeze({ disposition: "artifact_recorded" });
    const failure = new Error("synthetic-secret");
    const execute = vi.fn().mockResolvedValueOnce(success).mockRejectedValueOnce(failure);
    const wrapped = observe(execute, read, emit);
    const input = { payload: "synthetic-secret" };
    expect(await wrapped(input)).toBe(success);
    expect(read).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    await expect(wrapped(input)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls).toEqual([[input], [input]]);
    expect(read).toHaveBeenCalledExactlyOnceWith(failure);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit.mock.calls[0]![0]).not.toContain("synthetic-secret");
  });

  it("bounds emitted rows and projects closed values, never arbitrary diagnostic keys", async () => {
    const observe = await observer(), emit = vi.fn();
    const failure = new Error("synthetic-secret");
    const wrapped = observe(async () => { throw failure; }, () => ({
      stage: "artifact_admission", reason: "other", token: "synthetic-secret", stack: "synthetic-secret",
    }), emit, 2);
    for (let index = 0; index < 5; index++) await expect(wrapped()).rejects.toBe(failure);
    expect(emit).toHaveBeenCalledTimes(2);
    for (const [index, call] of emit.mock.calls.entries()) {
      const line = call[0] as string;
      expect(line.startsWith("GOAT_WORKER_EXECUTION_DIAGNOSTIC ")).toBe(true);
      expect(JSON.parse(line.slice("GOAT_WORKER_EXECUTION_DIAGNOSTIC ".length))).toStrictEqual({
        sequence: index + 1, stage: "artifact_admission", reason: "other",
      });
      expect(line).not.toContain("synthetic-secret");
      expect(line.length).toBeLessThan(256);
    }
  });

  it("records absence/malformed provenance as unclassified and never replaces the original throw", async () => {
    const observe = await observer(), failure = new Error("synthetic-secret");
    for (const read of [() => undefined, () => ({ stage: "forged", reason: "synthetic-secret" }),
      () => { throw new Error("synthetic-secret observer failure"); }]) {
      const emit = vi.fn();
      const wrapped = observe(async () => { throw failure; }, read, emit);
      await expect(wrapped()).rejects.toBe(failure);
      expect(emit).toHaveBeenCalledOnce();
      expect(emit.mock.calls[0]![0]).toBe('GOAT_WORKER_EXECUTION_DIAGNOSTIC {"sequence":1,"stage":"unclassified","reason":"unclassified"}');
    }
    const wrapped = observe(async () => { throw failure; }, () => undefined, () => { throw new Error("synthetic-secret sink failure"); });
    await expect(wrapped()).rejects.toBe(failure);
  });

  it("retains only bounded complete prefix rows across chunks and rejects sequence drift", async () => {
    expect(existsSync(fixtureUrl), "test-only bounded execution diagnostic entry must exist").toBe(true);
    const { createExecutionDiagnosticCollector } = await import(/* @vite-ignore */ fixtureUrl.href);
    const collector = createExecutionDiagnosticCollector();
    const prefix = "GOAT_WORKER_EXECUTION_DIAGNOSTIC ";
    const first = prefix + JSON.stringify({ sequence: 1, stage: "artifact_admission", reason: "other", token: "synthetic-secret" });
    collector.push(Buffer.from("synthetic-secret\n" + "x".repeat(10_000) + "\n" + first.slice(0, 25)));
    collector.push(Buffer.from(first.slice(25) + "\n"));
    collector.push(Buffer.from(prefix + JSON.stringify({ sequence: 7, stage: "artifact_admission", reason: "other" }) + "\n"));
    collector.push(Buffer.from(prefix + JSON.stringify({ sequence: 2, stage: "synthetic-secret", reason: "synthetic-secret" }) + "\n"));
    expect(collector.rows()).toStrictEqual([
      { sequence: 1, stage: "artifact_admission", reason: "other" },
      { sequence: 2, stage: "unclassified", reason: "unclassified" },
    ]);
    for (let sequence = 3; sequence <= 100; sequence++) collector.push(Buffer.from(prefix + JSON.stringify({
      sequence, stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch",
    }) + "\n"));
    expect(collector.rows()).toHaveLength(8);
    expect(JSON.stringify(collector.rows())).not.toContain("synthetic-secret");
    const exposed = collector.rows();
    exposed.length = 0;
    expect(collector.rows()).toHaveLength(8);
  });

  it.each([
    ["malformed", 'GOAT_WORKER_EXECUTION_DIAGNOSTIC {synthetic-secret}\n'],
    ["outOfSequence", 'GOAT_WORKER_EXECUTION_DIAGNOSTIC {"sequence":3,"stage":"artifact_admission","reason":"other"}\n'],
    ["overlong", "GOAT_WORKER_EXECUTION_DIAGNOSTIC " + "synthetic-secret".repeat(50) + "\n"],
    ["incomplete", 'GOAT_WORKER_EXECUTION_DIAGNOSTIC {"sequence":2,"synthetic-secret":'],
  ] as const)("does not call partial evidence complete after classified row 1 followed by %s", async (kind, discarded) => {
    const { createExecutionDiagnosticCollector } = await import(/* @vite-ignore */ fixtureUrl.href);
    const collector = createExecutionDiagnosticCollector();
    collector.push(Buffer.from('GOAT_WORKER_EXECUTION_DIAGNOSTIC {"sequence":1,"stage":"artifact_admission","reason":"lease_parent_dispatch_mismatch"}\n'));
    collector.push(Buffer.from(discarded));
    expect(collector.finish, "collector must finalize incomplete diagnostic evidence").toBeTypeOf("function");
    const evidence = collector.finish();
    expect(evidence.rows).toStrictEqual([{ sequence: 1, stage: "artifact_admission", reason: "lease_parent_dispatch_mismatch" }]);
    expect(evidence.diagnosticGap).toBe(true);
    expect(evidence.capReached).toBe(false);
    expect(evidence.discarded).toStrictEqual({ malformed: 0, outOfSequence: 0, overlong: 0, incomplete: 0, [kind]: 1 });
    expect(collector.finish()).toStrictEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain("synthetic-secret");
  });

  it("marks the eight-row observer ceiling conservatively incomplete without requiring extra emission", async () => {
    const { createExecutionDiagnosticCollector } = await import(/* @vite-ignore */ fixtureUrl.href);
    const collector = createExecutionDiagnosticCollector();
    for (let sequence = 1; sequence <= 8; sequence++) collector.push(Buffer.from("GOAT_WORKER_EXECUTION_DIAGNOSTIC " + JSON.stringify({
      sequence, stage: "artifact_admission", reason: "other",
    }) + "\n"));
    expect(collector.finish, "collector must account for the observer emission ceiling").toBeTypeOf("function");
    const evidence = collector.finish();
    expect(evidence.rows).toHaveLength(8);
    expect(evidence.capReached).toBe(true);
    expect(evidence.diagnosticGap).toBe(true);
    expect(evidence.discarded).toStrictEqual({ malformed: 0, outOfSequence: 0, overlong: 0, incomplete: 0 });
  });

  it("bounds gap accounting and ignores ordinary Gateway logs including long and unfinished non-prefix lines", async () => {
    const { createExecutionDiagnosticCollector } = await import(/* @vite-ignore */ fixtureUrl.href);
    const clean = createExecutionDiagnosticCollector();
    clean.push(Buffer.from('Gateway started\n' + "synthetic-secret".repeat(1000) + '\n'));
    clean.push(Buffer.from('GOAT_WORKER_EXECUTION_DIAGNOSTIC {"sequence":1,"stage":"artifact_admission","reason":"other"}\n'));
    clean.push(Buffer.from("ordinary unfinished Gateway log synthetic-secret"));
    expect(clean.finish, "collector must report bounded evidence completeness").toBeTypeOf("function");
    expect(clean.finish()).toStrictEqual({
      rows: [{ sequence: 1, stage: "artifact_admission", reason: "other" }],
      diagnosticGap: false, capReached: false,
      discarded: { malformed: 0, outOfSequence: 0, overlong: 0, incomplete: 0 },
    });
    const damaged = createExecutionDiagnosticCollector();
    for (let index = 0; index < 100; index++) damaged.push(Buffer.from("GOAT_WORKER_EXECUTION_DIAGNOSTIC {synthetic-secret}\n"));
    const evidence = damaged.finish();
    expect(evidence.diagnosticGap).toBe(true);
    expect(evidence.rows).toEqual([]);
    expect(evidence.discarded).toStrictEqual({ malformed: 8, outOfSequence: 0, overlong: 0, incomplete: 0 });
    expect(JSON.stringify(evidence)).not.toContain("synthetic-secret");
  });
});
