import { describe, expect, it } from "vitest";
import { parseImportedPlatformProof } from "./code-mode-hostile-sandbox-proof.js";

const run = { commit: "a".repeat(40), repository: "goatcitadel/GoatCitadel", runId: "123" };
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
