import { describe, expect, it } from "vitest";
import { __buildSeatbeltProfileForTests } from "./darwin-seatbelt-adapter.js";
import type { CodeModeSandboxLaunchInput } from "./types.js";

const baseInput: CodeModeSandboxLaunchInput = {
  runId: "run-1",
  nodePath: "/usr/local/bin/node",
  harnessPath: "/tmp/run-1/harness.mjs",
  runTempRoot: "/tmp/run-1",
  heapMb: 64,
  env: { GOATCITADEL_CODE_MODE: "1" },
};

describe("darwin seatbelt profile read scope", () => {
  const profile = __buildSeatbeltProfileForTests(baseInput);

  it("keeps the deny-default, no-network posture", () => {
    expect(profile).toContain("(deny default)");
    expect(profile).toContain("(deny network*)");
  });

  it("grants only runtime-essential system read subpaths", () => {
    expect(profile).toContain('(subpath "/System")');
    expect(profile).toContain('(subpath "/usr/lib")');
    expect(profile).toContain('(subpath "/usr/share")');
  });

  it("no longer grants broad reads of /Library or bare /usr", () => {
    // /Library holds third-party software, Keychains, and Application Support.
    expect(profile).not.toContain('(subpath "/Library")');
    // Bare /usr would re-expose /usr/local (Homebrew) and friends.
    expect(profile).not.toContain('(subpath "/usr")');
  });

  it("still allows read+write to the run temp root only", () => {
    expect(profile).toContain('(allow file-read* (subpath "/tmp/run-1"))');
    expect(profile).toContain('(allow file-write* (subpath "/tmp/run-1"))');
  });
});

describe("darwin seatbelt runtime dependency prefix grant", () => {
  it("grants the Homebrew (Intel) prefix when Node resolves under /usr/local", () => {
    const profile = __buildSeatbeltProfileForTests({
      ...baseInput,
      nodePath: "/usr/local/Cellar/node/22.0.0/bin/node",
    });
    // dyld needs the linked dylibs (e.g. icu4c under /usr/local/opt) at startup.
    expect(profile).toContain('(allow file-read* (subpath "/usr/local"))');
  });

  it("grants the Homebrew (Apple Silicon) prefix when Node resolves under /opt/homebrew", () => {
    const profile = __buildSeatbeltProfileForTests({
      ...baseInput,
      nodePath: "/opt/homebrew/bin/node",
    });
    expect(profile).toContain('(allow file-read* (subpath "/opt/homebrew"))');
  });

  it("keeps the tight profile for a bundled/static Node outside any package-manager prefix", () => {
    const profile = __buildSeatbeltProfileForTests({
      ...baseInput,
      nodePath: "/Applications/GoatCitadel.app/Contents/Resources/node",
    });
    expect(profile).not.toContain('(subpath "/usr/local")');
    expect(profile).not.toContain('(subpath "/opt/homebrew")');
  });

  it("does not match a lookalike prefix that only shares a string boundary", () => {
    const profile = __buildSeatbeltProfileForTests({
      ...baseInput,
      nodePath: "/usr/localhost/node",
    });
    expect(profile).not.toContain('(subpath "/usr/local")');
  });
});
