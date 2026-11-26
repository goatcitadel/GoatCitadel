import { describe, expect, it } from "vitest";
import { parseCliOptions, parseImportedPlatformProof } from "./code-mode-hostile-sandbox-proof.js";

const run = { commit: "a".repeat(40), repository: "goatcitadel/GoatCitadel", runId: "123", attempt: "2" };
const windowsProof = { platform: "win32", status: "pass", checksPassed: [], checksFailed: [] };
const linuxProof = { ...windowsProof, platform: "linux" };
const artifact = {
  githubRun: run,
  platform: "linux",
  currentPlatformProof: linuxProof,
  claim: { platformProof: [windowsProof] },
};

describe("sandbox platform proof imports", () => {
  it("accepts only the direct result from the matching Actions run and retains its provenance", () => {
    expect(parseImportedPlatformProof(artifact, run)).toEqual({ githubRun: run, proofs: [linuxProof] });
    expect(() => parseImportedPlatformProof({ ...artifact, platform: "win32" }, run)).toThrow(/own platform result/);
  });

  it("rejects missing or mismatched provenance before reading platform results", () => {
    for (const githubRun of [
      undefined,
      { ...run, commit: "b".repeat(40) },
      { ...run, repository: "another/repo" },
      { ...run, runId: "124" },
      { ...run, attempt: "1" },
      { ...run, attempt: undefined },
    ]) {
      expect(() => parseImportedPlatformProof({ ...artifact, githubRun }, run)).toThrow(/current GitHub repository/);
    }
  });

  it("keeps legacy unbound imports available for local diagnostics", () => {
    expect(parseImportedPlatformProof({ platformProof: [windowsProof] }, null)).toEqual({
      githubRun: null,
      proofs: [windowsProof],
    });
  });
});

describe("sandbox proof CLI arguments", () => {
  it("accepts both path syntaxes and repeated platform proofs", () => {
    expect(
      parseCliOptions(["--output=proof path.json", "--platform-proof", "one.json", "--platform-proof=two=a.json"]),
    ).toEqual({ output: "proof path.json", platformProofs: ["one.json", "two=a.json"] });
  });

  it("rejects missing, blank, and option-like path arguments", () => {
    for (const flag of ["--output", "--platform-proof"]) {
      for (const args of [[flag], [flag, "--platform-proof", "proof.json"], [`${flag}=`], [flag, "   "]]) {
        expect(() => parseCliOptions(args)).toThrow(`${flag} requires a nonempty path`);
      }
    }
    expect(() => parseCliOptions(["--unknown"])).toThrow(/Unknown sandbox proof argument/);
  });
});
