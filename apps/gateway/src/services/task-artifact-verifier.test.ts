import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import type { TaskArtifactClaim } from "@goatcitadel/contracts";
import { verifyClaimedArtifacts } from "./task-artifact-verifier.js";

describe("verifyClaimedArtifacts", () => {
  const now = () => "2026-05-15T12:00:00.000Z";

  it("marks a file claim verified when fs.statExists returns true", async () => {
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "artifacts/exists.txt" }];
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
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "artifacts/nope" }];
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
      networkAllowlist: ["example.com"],
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
    const claims: TaskArtifactClaim[] = [{ kind: "file", value: "artifacts/explodes" }];
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

  it("blocks file claims outside the configured read roots before fs probing", async () => {
    const statExists = vi.fn(async () => true);
    const allowedRoot = path.resolve(process.cwd(), "allowed-artifacts");
    const outsidePath = path.resolve(process.cwd(), "..", "outside-artifact.txt");

    const results = await verifyClaimedArtifacts([{ kind: "file", value: outsidePath }], {
      fs: { statExists },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      fileReadRoots: [allowedRoot],
      now,
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].detail).toMatch(/outside read allowlist/i);
    expect(statExists).not.toHaveBeenCalled();
  });

  it("blocks unallowlisted or private URL claims before HTTP probing", async () => {
    const headOk = vi.fn(async () => true);

    const results = await verifyClaimedArtifacts([{ kind: "url", value: "http://169.254.169.254/latest" }], {
      fs: { statExists: async () => false },
      http: { headOk },
      git: { hasCommit: async () => false },
      networkAllowlist: ["*"],
      now,
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].detail).toMatch(/private|reserved|metadata/i);
    expect(headOk).not.toHaveBeenCalled();
  });

  it("redacts malformed URL claim details before surfacing verification errors", async () => {
    const results = await verifyClaimedArtifacts([{ kind: "url", value: "http://bad host/path?token=secret" }], {
      fs: { statExists: async () => false },
      http: { headOk: async () => false },
      git: { hasCommit: async () => false },
      networkAllowlist: ["*"],
      now,
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].detail).not.toContain("token=secret");
    expect(results[0].detail).not.toContain("/path");
    expect(results[0].detail).not.toContain("secret");
  });

  it("bounds concurrent probes", async () => {
    let active = 0;
    let maxActive = 0;
    const claims: TaskArtifactClaim[] = Array.from({ length: 6 }, (_value, index) => ({
      kind: "commit_sha",
      value: `deadbee${index}`,
    }));

    const results = await verifyClaimedArtifacts(claims, {
      fs: { statExists: async () => false },
      http: { headOk: async () => false },
      git: {
        hasCommit: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return true;
        },
      },
      maxConcurrency: 2,
      now,
    });

    expect(results.every((result) => result.status === "verified")).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
