import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverProjectAgentProfiles, validateAgentProfileFileRecord } from "./agent-profile-files.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("discoverProjectAgentProfiles", () => {
  it("returns valid project-local YAML profiles as enabled records", async () => {
    const root = await createTempProject();
    await writeAgentProfile(
      root,
      "qa.yaml",
      [
        "profileId: project-qa",
        "name: Project QA",
        "description: Checks regressions.",
        "tools: [shell.exec, fs.read]",
        "contextMode: fork",
        "maxIterations: 3",
        "requiresApproval:",
        "  - shell.exec",
        "surfaces: [cowork, code]",
        "workspaceKind: worktree",
      ].join("\n"),
    );

    const records = await discoverProjectAgentProfiles({ projectRoot: root });

    expect(records).toEqual([
      expect.objectContaining({
        profileId: "project-qa",
        path: ".goatcitadel/agents/qa.yaml",
        name: "Project QA",
        tools: ["shell.exec", "fs.read"],
        contextMode: "fork",
        maxIterations: 3,
        requiresApproval: ["shell.exec"],
        surfaces: ["cowork", "code"],
        workspaceKind: "worktree",
        status: "enabled",
        enabled: true,
      }),
    ]);
  });

  it("keeps invalid profiles inspectable as disabled-with-reason records", async () => {
    const root = await createTempProject();
    await writeAgentProfile(
      root,
      "broken.yaml",
      [
        "profileId: broken-profile",
        "name: Broken",
        "description: Missing tools and unsupported mode.",
        "contextMode: shared",
      ].join("\n"),
    );

    const records = await discoverProjectAgentProfiles({ projectRoot: root });

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        profileId: "broken",
        path: ".goatcitadel/agents/broken.yaml",
        name: "broken",
        tools: [],
        contextMode: "isolated",
        status: "disabled",
        enabled: false,
      }),
    );
    expect(records[0]?.disabledReason).toContain("tools must include at least one string");
  });

  it("returns an empty list when the project has no local agent directory", async () => {
    const root = await createTempProject();

    await expect(discoverProjectAgentProfiles({ projectRoot: root })).resolves.toEqual([]);
  });
});

describe("validateAgentProfileFileRecord", () => {
  it("validates enum-backed contract fields", () => {
    expect(() =>
      validateAgentProfileFileRecord(
        {
          profileId: "bad-surface",
          name: "Bad Surface",
          description: "Invalid surface.",
          tools: ["fs.read"],
          contextMode: "isolated",
          surfaces: ["chat", "deploy"],
        },
        ".goatcitadel/agents/bad.yaml",
      ),
    ).toThrow('surfaces contains unsupported value "deploy"');
  });
});

async function createTempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-agent-profiles-"));
  tempRoots.push(root);
  return root;
}

async function writeAgentProfile(root: string, filename: string, content: string): Promise<void> {
  const agentsDir = path.join(root, ".goatcitadel", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, filename), content, "utf8");
}
