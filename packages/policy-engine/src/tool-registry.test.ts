import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry, listReadOnlyBuiltinToolNames } from "./tool-registry.js";

describe("tool registry", () => {
  it("gates outbound channel tools behind approval (review Finding 2)", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    for (const name of ["channel.send", "channel.react", "channel.unsend"]) {
      const tool = catalog.find((item) => item.toolName === name);
      expect(tool, `${name} should be registered`).toBeDefined();
      expect(tool?.requiresApproval, `${name} must require approval by default`).toBe(true);
    }
  });

  it("registers agent.fanout as a governed, non-read-only spawn tool (R3-8)", () => {
    const catalog = createDefaultToolRegistry().toCatalog();
    const tool = catalog.find((item) => item.toolName === "agent.fanout");

    expect(tool).toMatchObject({
      category: "session",
      riskLevel: "caution",
      requiresApproval: false,
      pack: "core",
    });
    // It spawns LLM work: it must never be classified read-only, or the
    // parallel read-only batch pre-executor would treat it as side-effect free.
    expect(tool?.readOnly).not.toBe(true);
    expect(listReadOnlyBuiltinToolNames().has("agent.fanout")).toBe(false);
    expect(tool?.recommendedContexts).toEqual(["cowork", "code"]);
    expect(tool?.argSchema).toMatchObject({ required: ["subtasks"] });
    const subtasksSchema = (tool?.argSchema as { properties?: { subtasks?: Record<string, unknown> } }).properties
      ?.subtasks;
    expect(subtasksSchema).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
  });

  it("registers runtime.configure as a Chat-only typed secure-flow request with no secret arguments", () => {
    const tool = createDefaultToolRegistry()
      .toCatalog()
      .find((entry) => entry.toolName === "runtime.configure");

    expect(tool).toMatchObject({
      category: "ops",
      riskLevel: "caution",
      requiresApproval: false,
      pack: "core",
      recommendedContexts: ["chat"],
      argSchema: {
        type: "object",
        properties: {
          targetId: { type: "string", enum: ["search.brave", "search.parallel"] },
        },
        required: ["targetId"],
        additionalProperties: false,
      },
    });
    expect(JSON.stringify(tool?.argSchema)).not.toMatch(/secret|credential|apiKey/i);
    expect(tool?.usageHints?.join(" ")).toContain("Never ask the operator to paste credentials into Chat");
  });

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

  it("keeps browser.search as the single governed model-callable official search path", () => {
    const tool = createDefaultToolRegistry()
      .toCatalog()
      .find((entry) => entry.toolName === "browser.search");
    expect(tool).toMatchObject({ category: "research", riskLevel: "caution", requiresApproval: false });
    expect(tool?.argSchema).toMatchObject({
      required: ["query"],
      properties: {
        backend: { enum: ["native", "firecrawl", "official"] },
        mode: { enum: ["quick", "research"] },
        providers: { maxItems: 2 },
        maxResults: { maximum: 20 },
      },
    });
    expect(
      createDefaultToolRegistry()
        .toCatalog()
        .filter((entry) => entry.toolName.includes("search"))
        .map((entry) => entry.toolName),
    ).toContain("browser.search");
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
      properties: {
        research: { required: expect.arrayContaining(["asOfDate", "comparisonCriteria"]) },
        sources: {
          items: {
            properties: {
              role: { enum: expect.arrayContaining(["official", "retailer", "financial"]) },
            },
          },
        },
        slides: {
          items: {
            properties: {
              archetype: { enum: expect.arrayContaining(["matrix", "chart", "sources", "closing"]) },
              bullets: {
                items: { oneOf: expect.arrayContaining([expect.objectContaining({ maxLength: 240 })]) },
              },
              table: { required: ["headers", "rows"] },
              chart: { required: ["type", "categories", "series"] },
            },
          },
        },
        design: {
          properties: {
            skillId: { enum: ["design-intelligence"] },
          },
        },
      },
    });
    expect(tool?.usageHints?.join("\n")).toContain("Design Quality V1");
    expect(JSON.stringify(tool?.argSchema)).not.toContain("speakerNotes");
    expect(tool?.usageHints?.join("\n")).toContain("does not accept model-authored presenter notes");
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
      properties: {
        design: {
          properties: {
            skillId: { enum: ["design-intelligence"] },
          },
        },
      },
    });
    expect(tool?.usageHints?.join("\n")).toContain("Design Quality V1");
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

  it("registers session.history as an exact, safe, read-only anchored-history tool", () => {
    const tool = createDefaultToolRegistry()
      .toCatalog()
      .find((item) => item.toolName === "session.history");
    expect(tool).toMatchObject({
      category: "session",
      riskLevel: "safe",
      requiresApproval: false,
      readOnly: true,
      pack: "core",
    });
    expect(tool?.argSchema).toMatchObject({ required: ["messageId", "sequence"] });
  });

  it("bounds delegated work evidence references and rejects control characters", () => {
    const tool = createDefaultToolRegistry()
      .toCatalog()
      .find((item) => item.toolName === "submit_work_result");
    const evidenceRefs = (
      tool?.argSchema as {
        properties?: { evidenceRefs?: { items?: Record<string, unknown> } };
      }
    ).properties?.evidenceRefs;

    expect(evidenceRefs?.items).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 1_000,
      pattern: "^[^\\u0000-\\u001f\\u007f]+$",
    });
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

  it("publishes complete argument contracts for deterministic pre-QA capability probes", () => {
    const byName = new Map(
      createDefaultToolRegistry()
        .toCatalog()
        .map((tool) => [tool.toolName, tool]),
    );

    expect(byName.get("fs.stat")?.argSchema).toEqual({
      type: "object",
      properties: { path: { type: "string", minLength: 1 } },
      required: ["path"],
      additionalProperties: false,
    });
    expect(byName.get("memory.search")?.argSchema).toEqual({
      type: "object",
      properties: {
        namespace: { type: "string" },
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    });
    expect(byName.get("citations.build")?.argSchema).toEqual({
      type: "object",
      properties: {
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              citationId: { type: "string", minLength: 1 },
              title: { type: "string" },
              url: { type: "string", minLength: 1 },
              snippet: { type: "string" },
              description: { type: "string" },
              sourceType: { type: "string", minLength: 1 },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
      },
      required: ["sources"],
      additionalProperties: false,
    });
  });
});

describe("listReadOnlyBuiltinToolNames", () => {
  it("contains only safe, approval-free, read-only tools", () => {
    const names = listReadOnlyBuiltinToolNames();
    expect(names.has("session.search")).toBe(true);
    expect(names.has("session.history")).toBe(true);
    expect(names.has("memory.read")).toBe(true);
    expect(names.has("time.now")).toBe(true);
    expect(names.has("fs.write")).toBe(false);
    expect(names.has("shell.exec")).toBe(false);
    expect(names.size).toBeGreaterThanOrEqual(5);

    const byName = new Map(
      createDefaultToolRegistry()
        .list()
        .map((tool) => [tool.name, tool]),
    );
    for (const name of names) {
      const definition = byName.get(name);
      expect(definition?.readOnly).toBe(true);
      expect(definition?.requiresApproval).toBe(false);
      expect(definition?.riskLevel).toBe("safe");
    }
  });
});
