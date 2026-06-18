import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeLatestFollowOnParityArtifacts,
  readLatestFollowOnParityArtifactFromWorkspace,
} from "./follow-on-parity-artifacts.js";

async function writeArtifact(rootDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf8");
}

describe("follow-on-parity-artifacts", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (tempRoot) => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }),
    );
  });

  it("prefers the latest artifact for the active deployment profile", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-follow-on-"));
    tempRoots.push(rootDir);
    const workspaceDir = "workspace";

    await writeArtifact(
      rootDir,
      "workspace/artifacts/follow-on-parity/browser/2026-04-02/browser-control-proof-bundle-trusted_local-2026-04-02T04-39-42-799Z.md",
      "# Trusted Local\n\n## Summary\nTrusted local browser proof is current.\n",
    );
    await writeArtifact(
      rootDir,
      "workspace/artifacts/follow-on-parity/browser/2026-04-02/browser-control-proof-bundle-remote_hardened-2026-04-02T04-39-42-818Z.md",
      "# Remote Hardened\n\n## Summary\nRemote hardened browser proof is current.\n",
    );

    const artifact = readLatestFollowOnParityArtifactFromWorkspace(rootDir, workspaceDir, "browser", "trusted_local");

    expect(artifact).toMatchObject({
      laneId: "browser",
      summary: "Trusted local browser proof is current.",
    });
    expect(artifact?.relativePath).toContain("trusted_local");
  });

  it("falls back to the newest artifact when no profile-matching artifact exists", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-follow-on-"));
    tempRoots.push(rootDir);
    const workspaceDir = "workspace";

    await writeArtifact(
      rootDir,
      "workspace/artifacts/follow-on-parity/voice/2026-04-02/voice-proof-bundle-local_dev-2026-04-02T04-25-42-216Z.md",
      "# Voice\n\n## Summary\nLocal voice proof is current.\n",
    );

    const artifact = readLatestFollowOnParityArtifactFromWorkspace(rootDir, workspaceDir, "voice", "trusted_local");

    expect(artifact).toMatchObject({
      laneId: "voice",
      summary: "Local voice proof is current.",
    });
    expect(artifact?.relativePath).toContain("local_dev");
  });

  it("replaces a stored artifact when the workspace scan finds the active-profile artifact", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-follow-on-"));
    tempRoots.push(rootDir);
    const workspaceDir = "workspace";

    await writeArtifact(
      rootDir,
      "workspace/artifacts/follow-on-parity/packaging/2026-04-02/packaging-deployment-proof-bundle-trusted_local-2026-04-02T04-39-42-797Z.md",
      "# Packaging\n\n## Summary\nTrusted local packaging proof is current.\n",
    );

    const merged = mergeLatestFollowOnParityArtifacts(
      {
        packaging: {
          laneId: "packaging",
          generatedAt: "2026-04-02T04:39:42.816Z",
          summary: "Remote hardened packaging proof is current.",
          relativePath:
            "artifacts/follow-on-parity/packaging/2026-04-02/packaging-deployment-proof-bundle-remote_hardened-2026-04-02T04-39-42-816Z.md",
          fullPath:
            "./workspace/artifacts/follow-on-parity/packaging/2026-04-02/packaging-deployment-proof-bundle-remote_hardened-2026-04-02T04-39-42-816Z.md",
          bytes: 128,
        },
      },
      rootDir,
      workspaceDir,
      "trusted_local",
    );

    expect(merged.packaging).toMatchObject({
      summary: "Trusted local packaging proof is current.",
    });
    expect(merged.packaging?.relativePath).toContain("trusted_local");
  });

  it("collapses extension starter-pack files to the starter-pack root README", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-follow-on-"));
    tempRoots.push(rootDir);
    const workspaceDir = "workspace";

    await writeArtifact(
      rootDir,
      "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-04-02/extension-starter-pack-2026-04-02T04-18-57-894Z/README.md",
      "# Starter Pack\n\n## Summary\nExtension starter pack exported.\n",
    );
    await writeArtifact(
      rootDir,
      "workspace/artifacts/follow-on-parity/extensions/starter-pack/2026-04-02/extension-starter-pack-2026-04-02T04-18-57-894Z/integration-plugins/reference-integration-plugin/README.md",
      "# Nested Plugin README\n\nNested file content.\n",
    );

    const artifact = readLatestFollowOnParityArtifactFromWorkspace(rootDir, workspaceDir, "extensions");

    expect(artifact).toMatchObject({
      laneId: "extensions",
      summary: "Extension starter pack exported.",
    });
    expect(artifact?.relativePath).toBe(
      "artifacts/follow-on-parity/extensions/starter-pack/2026-04-02/extension-starter-pack-2026-04-02T04-18-57-894Z/README.md",
    );
  });
});
