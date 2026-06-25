import { describe, expect, it } from "vitest";
import { parseSmokeArgs } from "./smoke.js";

describe("gateway smoke profiles", () => {
  it("defaults to the full smoke profile", () => {
    expect(parseSmokeArgs([])).toEqual({ profile: "full" });
  });

  it("parses fast and full profile flags", () => {
    expect(parseSmokeArgs(["--profile", "fast"])).toEqual({ profile: "fast" });
    expect(parseSmokeArgs(["--", "--profile", "fast"])).toEqual({ profile: "fast" });
    expect(parseSmokeArgs(["--profile=full"])).toEqual({ profile: "full" });
  });

  it("rejects unknown profiles and arguments", () => {
    expect(() => parseSmokeArgs(["--profile"])).toThrow("Missing smoke profile");
    expect(() => parseSmokeArgs(["--profile", "tiny"])).toThrow("Unknown smoke profile");
    expect(() => parseSmokeArgs(["--tiny"])).toThrow("Unknown smoke argument");
  });
});
