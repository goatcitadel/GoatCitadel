import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "./tool-registry.js";

describe("tool registry", () => {
  it("includes browser session-state tools", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    expect(catalog.some((tool) => tool.toolName === "browser.cookies.get")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "browser.cookies.set")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "browser.cookies.clear")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "browser.storage.get")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "browser.storage.set")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "browser.storage.clear")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "browser.context.configure")).toBe(true);
  });

  it("includes specialized file/code/background-shell tools", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    expect(catalog.some((tool) => tool.toolName === "file.read_range")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "file.find")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "code.search")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "code.search_files")).toBe(true);
    expect(catalog.some((tool) => tool.toolName === "shell.exec_background")).toBe(true);
  });

  it("points the background dev-server example at Mission Control Next", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "shell.exec_background");

    expect(tool?.examples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          args: expect.objectContaining({ cwd: "./apps/mission-control-next" }),
        }),
      ]),
    );
  });

  it("passes ranking metadata through the public catalog", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "code.search");
    expect(tool?.recommendedContexts).toContain("code");
    expect(tool?.preferredForIntents).toContain("search_code");
    expect(tool?.usageHints?.length).toBeGreaterThan(0);
  });

  it("exposes PowerPoint deck creation as a governed artifact tool", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "presentations.create");

    expect(tool).toMatchObject({
      category: "knowledge",
      riskLevel: "caution",
      requiresApproval: false,
      pack: "knowledge",
    });
    expect(tool?.preferredForIntents).toContain("powerpoint");
    expect(tool?.argSchema).toMatchObject({
      required: ["path", "title", "slides"],
    });
  });

  it("exposes document creation as a governed artifact tool", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "documents.create");

    expect(tool).toMatchObject({
      category: "knowledge",
      riskLevel: "caution",
      requiresApproval: false,
      pack: "knowledge",
    });
    expect(tool?.preferredForIntents).toContain("document_generation");
    expect(tool?.argSchema).toMatchObject({
      required: ["path", "title"],
    });
  });
});
