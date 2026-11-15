import { describe, expect, it } from "vitest";
import { attachOperatorSummary, readOperatorSummary } from "./startup-errors.js";
import { withBundledDatabaseTimeoutSummary } from "./startup-build-failure.js";

const open = (id: string, ageMs: number) => ({
  phases: [],
  inProgress: [{ id, owner: "x", startedAt: "t", ageMs }],
  ready: false,
});

function timeoutError(): Error {
  return Object.assign(new Error("plugin did not start in time"), { code: "ERR_AVVIO_PLUGIN_TIMEOUT" });
}

describe("withBundledDatabaseTimeoutSummary", () => {
  it("names the database when the plugin timeout fired during its start", () => {
    const error = withBundledDatabaseTimeoutSummary(timeoutError(), open("bundled_postgres", 120_300));
    expect(readOperatorSummary(error)).toBe(
      "The local database did not start within 120 seconds. Open Logs shows its last messages.",
    );
  });

  it("leaves other timeouts and other errors alone", () => {
    expect(
      readOperatorSummary(withBundledDatabaseTimeoutSummary(timeoutError(), open("init_critical", 1000))),
    ).toBeUndefined();
    expect(
      readOperatorSummary(withBundledDatabaseTimeoutSummary(new Error("x"), open("bundled_postgres", 1000))),
    ).toBeUndefined();
  });

  it("keeps a summary that is already attached", () => {
    const error = attachOperatorSummary(timeoutError(), "Already plain.");
    expect(readOperatorSummary(withBundledDatabaseTimeoutSummary(error, open("bundled_postgres", 1000)))).toBe(
      "Already plain.",
    );
  });
});
