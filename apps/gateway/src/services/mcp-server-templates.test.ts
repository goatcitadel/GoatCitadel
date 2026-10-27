import { describe, expect, it } from "vitest";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

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

  it("keeps the playwright pin at the reviewed 0.0.80 package", () => {
    const playwright = MCP_SERVER_TEMPLATES.find((template) => template.templateId === "playwright");

    expect(packageArgument(playwright?.args)).toBe("@playwright/mcp@0.0.80");
  });
});
