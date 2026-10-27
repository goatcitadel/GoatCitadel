import { describe, expect, it } from "vitest";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { REVIEWED_PLAYWRIGHT_PACKAGE } from "./reviewed-mcp-package-manifest.js";

// `@modelcontextprotocol/server-fetch` does not exist on npm (the reference fetch server is a
// Python package), so there is no version to pin yet. Remove this entry once the template is fixed.
const UNPINNABLE_TEMPLATE_IDS = new Set(["fetch"]);

const EXACT_VERSION_SUFFIX = /@\d+\.\d+\.\d+$/;

// The package argument is the first argument that is not a flag (`-y`, `--isolated`, ...).
function packageArgument(args: readonly string[] | undefined): string | undefined {
  return (args ?? []).find((arg) => !arg.startsWith("-"));
}

const localPackageTemplates = MCP_SERVER_TEMPLATES.filter(
  (template) => template.transport === "stdio" && (template.command === "npx" || template.command === "uvx"),
);

describe("mcp server templates", () => {
  it("covers every local npx and uvx template", () => {
    expect(localPackageTemplates.map((template) => template.templateId)).toEqual(
      expect.arrayContaining(["filesystem", "playwright", "context7", "gpt-researcher", "openspec"]),
    );
  });

  it("pins every local template to an exact version", () => {
    const unpinned = localPackageTemplates
      .filter((template) => !UNPINNABLE_TEMPLATE_IDS.has(template.templateId))
      .map((template) => ({ templateId: template.templateId, packageArgument: packageArgument(template.args) }))
      .filter((entry) => !entry.packageArgument || !EXACT_VERSION_SUFFIX.test(entry.packageArgument));

    expect(unpinned).toEqual([]);
  });

  it("never asks a local template to run @latest", () => {
    const floating = MCP_SERVER_TEMPLATES.filter((template) =>
      (template.args ?? []).some((arg) => arg.includes("@latest")),
    ).map((template) => template.templateId);

    expect(floating).toEqual([]);
  });

  // Every release through 2026.8.31 can write outside the allowed folders (GHSA-53mr-w429-c597, GHSA-7rgq-gccq-qphx,
  // GHSA-4gxg-m5jx-9j57, GHSA-hhwq-wxfx-cj7g); 2.0.1 is the first fixed release.
  it("pins the filesystem template to the release that fixes its path-escape advisories", () => {
    const filesystem = MCP_SERVER_TEMPLATES.find((template) => template.templateId === "filesystem");

    expect(packageArgument(filesystem?.args)).toBe("@modelcontextprotocol/server-filesystem@2.0.1");
    expect(filesystem?.description).toContain("Needs Node.js 24 or later");
  });

  it("keeps the playwright pin at the reviewed 0.0.80 package", () => {
    const playwright = MCP_SERVER_TEMPLATES.find((template) => template.templateId === "playwright");

    expect(packageArgument(playwright?.args)).toBe("@playwright/mcp@0.0.80");
  });

  // A Capabilities install allows a template's network hosts and nothing else, and the connection goes through the
  // allowlist, so a host left out here leaves the installed connector unable to connect.
  it("lists every remote template's endpoint host among its network hosts", () => {
    const uncovered = MCP_SERVER_TEMPLATES.filter(
      (template) => template.url?.startsWith("https://") && !/[<>]/.test(template.url),
    )
      .map((template) => ({ templateId: template.templateId, host: new URL(template.url!).hostname }))
      .filter(({ templateId, host }) => {
        const listed = MCP_SERVER_TEMPLATES.find((template) => template.templateId === templateId)?.networkHosts ?? [];
        return !listed.includes(host);
      });

    expect(uncovered).toEqual([]);
  });

  it("lists the hosts the reviewed playwright packages download from", () => {
    const playwright = MCP_SERVER_TEMPLATES.find((template) => template.templateId === "playwright");
    const downloadHosts = [...new Set(REVIEWED_PLAYWRIGHT_PACKAGE.packages.map((pkg) => new URL(pkg.url).hostname))];

    expect(playwright?.networkHosts).toEqual(expect.arrayContaining(downloadHosts));
  });
});
