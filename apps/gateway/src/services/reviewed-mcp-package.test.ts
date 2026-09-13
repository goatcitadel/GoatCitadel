import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerRecord } from "@goatcitadel/contracts";
import { fetchAllowlistedOnce } from "@goatcitadel/policy-engine";
import {
  isReviewedPlaywrightServer,
  resolveReviewedMcpLaunch,
  verifyReviewedArchive,
  verifyReviewedMcpTree,
  REVIEWED_PLAYWRIGHT_MANIFEST_SHA256,
} from "./reviewed-mcp-package.js";

vi.mock("@goatcitadel/policy-engine", async (original) => ({
  ...(await original<object>()),
  fetchAllowlistedOnce: vi.fn(),
}));
const roots: string[] = [];
const server = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@playwright/mcp@0.0.80", "--isolated", "--headless"],
} as McpServerRecord;
async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "goat-reviewed-mcp-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("reviewed MCP package enforcement", () => {
  it("recognizes the exact pinned package without changing unrelated stdio launches", async () => {
    expect(isReviewedPlaywrightServer(server)).toBe(true);
    expect(isReviewedPlaywrightServer({ ...server, command: "npx.cmd" })).toBe(true);
    for (const other of [
      { ...server, command: "echo" },
      { ...server, args: ["-y", "@playwright/mcp@latest"] },
      { ...server, args: ["-y", "@playwright/mcp@0.0.800"] },
    ])
      expect(await resolveReviewedMcpLaunch(other, {})).toBeUndefined();
    await expect(resolveReviewedMcpLaunch(server, {})).rejects.toThrow("storage owner");
    expect(fetchAllowlistedOnce).not.toHaveBeenCalled();
  });

  it("checks all compressed bytes before an archive can reach the extractor", () => {
    const bytes = Buffer.from("reviewed fixture");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    verifyReviewedArchive(bytes, integrity);
    expect(() => verifyReviewedArchive(Buffer.from("changed fixture"), integrity)).toThrow("integrity");
  });

  it("uses the Gateway network policy and removes only its failed staging directory", async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, "operator-file.txt"), "preserve");
    vi.mocked(fetchAllowlistedOnce).mockResolvedValue(new Response("changed archive"));
    await expect(
      resolveReviewedMcpLaunch(server, { packageRoot: root, networkAllowlist: ["registry.npmjs.org"] }),
    ).rejects.toThrow("integrity");
    expect(fetchAllowlistedOnce).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.80.tgz",
      expect.objectContaining({ allowlist: ["registry.npmjs.org"], maxResponseBytes: 32 * 1024 * 1024 }),
    );
    expect(await readdir(root)).toEqual(["operator-file.txt"]);
  });

  it("preserves a corrupt existing installation and refuses to execute or repair it silently", async () => {
    const root = await temporaryRoot();
    const installed = path.join(root, REVIEWED_PLAYWRIGHT_MANIFEST_SHA256);
    await mkdir(installed);
    await writeFile(path.join(installed, "unexpected.js"), "changed");
    await expect(resolveReviewedMcpLaunch(server, { packageRoot: root })).rejects.toThrow("extra files");
    expect(fetchAllowlistedOnce).not.toHaveBeenCalled();
    expect(await readdir(installed)).toEqual(["unexpected.js"]);
  });

  it("rejects incomplete package contents even when the dependency names look correct", async () => {
    const root = await temporaryRoot();
    for (const name of ["@playwright/mcp", "playwright", "playwright-core"]) {
      await mkdir(path.join(root, "node_modules", name), { recursive: true });
    }
    await expect(verifyReviewedMcpTree(root)).rejects.toThrow("differs from its approved artifact");
  });

  it("rejects a linked package storage directory", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(resolveReviewedMcpLaunch(server, { packageRoot: path.join(root, "linked") })).rejects.toThrow(
      "ordinary directories",
    );
    expect(fetchAllowlistedOnce).not.toHaveBeenCalled();
  });
});
