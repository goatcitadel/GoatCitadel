import { describe, expect, it } from "vitest";
import { shouldStartDeferredInitInBackground, shouldStopBundledPostgresOnClose } from "./storage-runtime.js";

describe("shouldStopBundledPostgresOnClose", () => {
  it("keeps bundled Postgres running for supervised dev restarts", () => {
    expect(shouldStopBundledPostgresOnClose("1")).toBe(false);
  });

  it("stops bundled Postgres when the gateway is not supervisor-managed", () => {
    expect(shouldStopBundledPostgresOnClose(undefined)).toBe(true);
    expect(shouldStopBundledPostgresOnClose("0")).toBe(true);
  });
});

describe("shouldStartDeferredInitInBackground", () => {
  it("only backgrounds deferred startup for supervised dev restarts", () => {
    expect(shouldStartDeferredInitInBackground("1")).toBe(true);
    expect(shouldStartDeferredInitInBackground(undefined)).toBe(false);
    expect(shouldStartDeferredInitInBackground("0")).toBe(false);
  });
});
