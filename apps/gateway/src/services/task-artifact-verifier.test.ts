import { describe, it, expect } from "vitest";
import type { TaskArtifactClaim } from "@goatcitadel/contracts";
import { verifyClaimedArtifacts } from "./task-artifact-verifier.js";

describe("verifyClaimedArtifacts", () => {
  const now = () => "2026-05-15T12:00:00.000Z";

  it("marks a file claim verified when fs.statExists returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "/tmp/exists.txt" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => true },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      now,
    });
    expect(results[0].status).toBe("verified");
    expect(results[0].claim.kind).toBe("file");
  });

  it("marks a file claim missing when fs.statExists returns false", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "/nope" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      now,
    });
    expect(results[0].status).toBe("missing");
  });

  it("marks a url claim verified when http.headOk returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "url", value: "https://example.com" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => true },
      git: { hasCommit: async () => false },
      now,
    });
    expect(results[0].status).toBe("verified");
  });

  it("marks a commit_sha claim verified when git.hasCommit returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "commit_sha", value: "deadbeef" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => false },
      git: { hasCommit: async () => true },
      now,
    });
    expect(results[0].status).toBe("verified");
  });

  it("marks claim error and includes detail when the prober throws", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "/explodes" }];
    const results = await verifyClaimedArtifacts(claims, {
      fs: {
        statExists: async () => {
          throw new Error("EACCES");
        },
      },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      now,
    });
    expect(results[0].status).toBe("failed");
    expect(results[0].detail).toMatch(/EACCES/);
  });
});
