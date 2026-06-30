import { describe, expect, it } from "vitest";
import { assertCodeModeSyntheticLaunchEnv, buildAdvisoryUnsandboxedLaunchSpec } from "./types.js";

describe("assertCodeModeSyntheticLaunchEnv", () => {
  it("accepts a minimal synthetic env", () => {
    expect(() =>
      assertCodeModeSyntheticLaunchEnv({
        GOATCITADEL_CODE_MODE: "1",
        TZ: "UTC",
        SystemRoot: "C:/Windows",
        PATH: "/usr/bin",
        USERPROFILE: "/home/op",
      }),
    ).not.toThrow();
  });

  it("rejects the live process.env reference", () => {
    expect(() => assertCodeModeSyntheticLaunchEnv(process.env)).toThrow("not the live process.env");
  });

  it("rejects host secret-bearing keys", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOATCITADEL_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "DB_PASSWORD",
      "SOME_CREDENTIAL",
    ]) {
      expect(() => assertCodeModeSyntheticLaunchEnv({ GOATCITADEL_CODE_MODE: "1", [key]: "x" })).toThrow(
        /host secret-bearing key/,
      );
    }
  });

  it("guards the advisory unsandboxed launch spec builder", () => {
    expect(() =>
      buildAdvisoryUnsandboxedLaunchSpec({
        runId: "run-1",
        nodePath: "/usr/bin/node",
        harnessPath: "/tmp/run-1/harness.mjs",
        runTempRoot: "/tmp/run-1",
        heapMb: 64,
        env: { OPENAI_API_KEY: "leak" },
      }),
    ).toThrow(/host secret-bearing key/);
    expect(() =>
      buildAdvisoryUnsandboxedLaunchSpec({
        runId: "run-1",
        nodePath: "/usr/bin/node",
        harnessPath: "/tmp/run-1/harness.mjs",
        runTempRoot: "/tmp/run-1",
        heapMb: 64,
        env: { GOATCITADEL_CODE_MODE: "1" },
      }),
    ).not.toThrow();
  });
});
