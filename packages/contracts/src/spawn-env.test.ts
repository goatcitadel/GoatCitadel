import { describe, expect, it } from "vitest";

import { SECRET_ENV_KEY_PATTERN, buildScrubbedSpawnEnv } from "./spawn-env.js";

describe("SECRET_ENV_KEY_PATTERN", () => {
  it("matches secret-shaped key names case-insensitively", () => {
    for (const key of [
      "FAKE_API_KEY",
      "fake_api_key",
      "ApiKey",
      "GOATCITADEL_AUTH_TOKEN",
      "Goatcitadel_Auth_Token",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "PG_CONNECTION_STRING",
      "GOATCITADEL_POSTGRES_PASSWORD",
      "TLS_PRIVATE_KEY",
      "RELEASE_SIGNING_KEY",
      "SSH_KEY_PASSPHRASE",
      "DATABASE_URL",
      "NPM_CONFIG__AUTH",
    ]) {
      expect(SECRET_ENV_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it("does not match platform and toolchain key names", () => {
    for (const key of [
      "PATH",
      "Path",
      "PATHEXT",
      "SYSTEMROOT",
      "ComSpec",
      "HOME",
      "TEMP",
      "TMP",
      "APPDATA",
      "LOCALAPPDATA",
      "USERPROFILE",
      "PNPM_HOME",
      "NODE_ENV",
      "TZ",
      "LANG",
      "HTTP_PROXY",
      "GOATCITADEL_BASE_URL",
      "GOATCITADEL_CODE_MODE",
    ]) {
      expect(SECRET_ENV_KEY_PATTERN.test(key), key).toBe(false);
    }
  });

  it("keeps git author identity while still matching real auth keys", () => {
    for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE", "BOOK_AUTHOR"]) {
      expect(SECRET_ENV_KEY_PATTERN.test(key), key).toBe(false);
    }
    for (const key of ["AUTHORIZATION", "GOATCITADEL_AUTH_TOKEN", "OAUTH_CLIENT_ID", "AUTH", "GIT_AUTH_HEADER"]) {
      expect(SECRET_ENV_KEY_PATTERN.test(key), key).toBe(true);
    }
  });
});

describe("buildScrubbedSpawnEnv", () => {
  it("drops keys matching the secret pattern case-insensitively", () => {
    const env = buildScrubbedSpawnEnv({
      FAKE_API_KEY: "canary",
      fake_api_key_lower: "canary",
      Goatcitadel_Auth_Token: "canary",
      AWS_ACCESS_KEY_ID: "canary",
      PG_CONNECTION_STRING: "canary",
      SAFE_VALUE: "kept",
    });
    expect(env).toEqual({ SAFE_VALUE: "kept" });
  });

  it("retains non-secret platform and toolchain keys", () => {
    const base = {
      PATH: "/usr/bin",
      PATHEXT: ".EXE",
      SYSTEMROOT: String.raw`C:\Windows`,
      HOME: "/home/u",
      TEMP: "/tmp",
      GOATCITADEL_BASE_URL: "http://127.0.0.1:3000",
    };
    expect(buildScrubbedSpawnEnv(base)).toEqual(base);
  });

  it("preserves the original casing of retained keys", () => {
    const env = buildScrubbedSpawnEnv({ ComSpec: String.raw`C:\Windows\system32\cmd.exe`, Path: "C:\\bin" });
    expect(Object.keys(env).sort()).toEqual(["ComSpec", "Path"]);
  });

  it("rescues passthrough keys case-insensitively while other secret keys stay dropped", () => {
    const env = buildScrubbedSpawnEnv(
      { FAKE_API_KEY: "canary", OTHER_SECRET: "hidden" },
      { passthroughKeys: ["fake_api_key"] },
    );
    expect(env).toEqual({ FAKE_API_KEY: "canary" });
  });

  it("merges extraEnv last without pattern filtering", () => {
    const env = buildScrubbedSpawnEnv(
      { SAFE_VALUE: "base" },
      { extraEnv: { SAFE_VALUE: "overridden", INJECTED_TOKEN: "explicit-caller-intent" } },
    );
    expect(env).toEqual({ SAFE_VALUE: "overridden", INJECTED_TOKEN: "explicit-caller-intent" });
  });

  it("omits undefined values and does not mutate the base env", () => {
    const base: NodeJS.ProcessEnv = { DEFINED: "yes", MISSING: undefined };
    const env = buildScrubbedSpawnEnv(base);
    expect(env).toEqual({ DEFINED: "yes" });
    expect(base).toEqual({ DEFINED: "yes", MISSING: undefined });
    env.DEFINED = "changed";
    expect(base.DEFINED).toBe("yes");
  });

  it("honors a caller-supplied dropPattern override", () => {
    const env = buildScrubbedSpawnEnv(
      { CUSTOM_BLOCKED: "no", FAKE_API_KEY: "yes-under-override" },
      { dropPattern: /CUSTOM_BLOCKED/i },
    );
    expect(env).toEqual({ FAKE_API_KEY: "yes-under-override" });
  });

  it("drops every matching key even when the dropPattern override is global", () => {
    // A /g pattern carries lastIndex across .test() calls; the scrubber must
    // neutralize that or alternate matching keys leak through.
    const env = buildScrubbedSpawnEnv(
      { BLOCKED_ONE: "a", BLOCKED_TWO: "b", BLOCKED_THREE: "c", KEPT: "d" },
      { dropPattern: /BLOCKED/g },
    );
    expect(env).toEqual({ KEPT: "d" });
  });
});
