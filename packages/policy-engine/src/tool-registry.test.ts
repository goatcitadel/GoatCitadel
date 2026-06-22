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

  it("registers session.search as a safe, read-only recall tool (P2-S4a)", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "session.search");

    expect(tool).toMatchObject({
      category: "session",
      riskLevel: "safe",
      requiresApproval: false,
      readOnly: true,
      pack: "core",
    });
    expect(tool?.argSchema).toMatchObject({ required: ["query"] });
    const scopeSchema = (tool?.argSchema as { properties?: { scope?: { enum?: string[] } } } | undefined)?.properties
      ?.scope;
    expect(scopeSchema?.enum).toEqual(["session", "all"]);
    expect(tool?.recommendedContexts).toEqual(expect.arrayContaining(["chat", "cowork", "code"]));
  });

  it("registers schedule.manage as a danger, approval-gated tool (P1-F2)", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "schedule.manage");

    expect(tool).toMatchObject({
      category: "ops",
      riskLevel: "danger",
      requiresApproval: true,
      pack: "core",
    });
    // op is the only required arg; create/list/cancel are the allowed values.
    expect(tool?.argSchema).toMatchObject({ required: ["op"] });
    const opSchema = (tool?.argSchema as { properties?: { op?: { enum?: string[] } } } | undefined)?.properties?.op;
    expect(opSchema?.enum).toEqual(["create", "list", "cancel"]);
    // Offered to interactive surfaces only (never auto-offered to scheduled turns).
    expect(tool?.recommendedContexts).toEqual(["chat", "cowork"]);
  });
});
