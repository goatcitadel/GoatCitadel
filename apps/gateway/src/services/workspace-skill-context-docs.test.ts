import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceSkillContextDocReader } from "./workspace-skill-context-docs.js";

let rootDir = "";

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-skill-context-"));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

const host = {
  get config() {
    return { rootDir };
  },
  normalizeWorkspaceId: (workspaceId?: string) => (workspaceId ?? "default").trim().toLowerCase().replace(/\s+/g, "-"),
};

describe("createWorkspaceSkillContextDocReader", () => {
  it("reads the workspace's PRODUCT.md and DESIGN.md exactly and reports missing ones", async () => {
    await fs.mkdir(path.join(rootDir, "workspaces", "ws-one"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "workspaces", "ws-one", "DESIGN.md"), "# Design\n\ncolors: é\n", "utf8");
    const read = createWorkspaceSkillContextDocReader(host, " WS One ");

    expect(read("design")).toEqual({ exists: true, content: "# Design\n\ncolors: é\n" });
    expect(read("product")).toEqual({ exists: false, content: "" });
  });

  it("never reads a global copy when the workspace has none", async () => {
    await fs.writeFile(path.join(rootDir, "DESIGN.md"), "# repo design\n", "utf8");
    const read = createWorkspaceSkillContextDocReader(host, "ws-two");

    expect(read("design")).toEqual({ exists: false, content: "" });
  });
});
