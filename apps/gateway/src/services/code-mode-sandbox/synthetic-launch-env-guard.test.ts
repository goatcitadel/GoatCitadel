import { describe, expect, it } from "vitest";
import { assertCodeModeSyntheticLaunchEnv, buildAdvisoryUnsandboxedLaunchSpec } from "./types.js";

describe("assertCodeModeSyntheticLaunchEnv", () => {
  it("accepts a minimal synthetic env", () => {
    expect(() =>
      assertCodeModeSyntheticLaunchEnv({
        GOATCITADEL_CODE_MODE: "1",
        TZ: "UTC",
        SystemRoot: "C:/Windows",
        USERPROFILE: "/home/op",
      }),
    ).not.toThrow();
  });

  it("accepts proof-only hostile canary env keys except the secret sentinel", () => {
    expect(() =>
      assertCodeModeSyntheticLaunchEnv({
        GOATCITADEL_CODE_MODE: "1",
        GOATCITADEL_HOSTILE_CANARY_REPORT_PATH: "/tmp/report.json",
        GOATCITADEL_HOSTILE_CANARY_EXPECTED_SHA256: "a".repeat(64),
      }),
    ).not.toThrow();
    expect(() =>
      assertCodeModeSyntheticLaunchEnv({
        GOATCITADEL_CODE_MODE: "1",
        GOATCITADEL_HOSTILE_CANARY_SECRET: "must-not-pass",
      }),
    ).toThrow(/non-synthetic key/);
  });

  it("rejects the live process.env reference", () => {
    expect(() => assertCodeModeSyntheticLaunchEnv(process.env)).toThrow("not the live process.env");
  });

  it("requires the Code Mode marker", () => {
    expect(() => assertCodeModeSyntheticLaunchEnv({ TZ: "UTC" })).toThrow(/GOATCITADEL_CODE_MODE/);
    expect(() => assertCodeModeSyntheticLaunchEnv({ GOATCITADEL_CODE_MODE: "0" })).toThrow(/GOATCITADEL_CODE_MODE/);
  });

  it("rejects cloned host-env keys, including URL and DSN secrets without obvious suffixes", () => {
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GOATCITADEL_AUTH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_ACCESS_KEY_ID",
      "DB_PASSWORD",
      "SOME_CREDENTIAL",
      "DATABASE_URL",
      "REDIS_URL",
      "SENTRY_DSN",
      "CONNECTION_STRING",
      "NODE_ENV",
      "PATH",
    ]) {
      expect(() => assertCodeModeSyntheticLaunchEnv({ GOATCITADEL_CODE_MODE: "1", [key]: "x" })).toThrow(
        /non-synthetic key/,
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
    ).toThrow(/GOATCITADEL_CODE_MODE|non-synthetic key/);
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
