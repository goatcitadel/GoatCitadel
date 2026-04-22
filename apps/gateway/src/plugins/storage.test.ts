import { describe, expect, it } from "vitest";
import { shouldStopBundledPostgresOnClose } from "./storage-runtime.js";

describe("shouldStopBundledPostgresOnClose", () => {
  it("keeps bundled Postgres running for supervised dev restarts", () => {
    expect(shouldStopBundledPostgresOnClose("1")).toBe(false);
  });

  it("stops bundled Postgres when the gateway is not supervisor-managed", () => {
    expect(shouldStopBundledPostgresOnClose(undefined)).toBe(true);
    expect(shouldStopBundledPostgresOnClose("0")).toBe(true);
  });
});
