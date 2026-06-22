import { describe, expect, it } from "vitest";
import { inspectToolCallProtocolIssues } from "./chat-agent-completion-adapters.js";
import {
  boundedLevenshtein,
  extractFirstBalancedObject,
  fuzzyResolveAllowedToolName,
  repairToolCalls,
  salvageJsonObject,
  unwrapSingleObjectArray,
  type ToolCallRepairMaps,
} from "./chat-agent-tool-call-repair.js";

function makeMaps(canonicalNames: string[], aliases: Record<string, string> = {}): ToolCallRepairMaps {
  const modelToCanonical = new Map<string, string>();
  const canonicalToModel = new Map<string, string>();
  for (const canonical of canonicalNames) {
    // Identity entry: the canonical name is also a valid model-facing name.
    modelToCanonical.set(canonical, canonical);
    canonicalToModel.set(canonical, canonical);
  }
  for (const [alias, canonical] of Object.entries(aliases)) {
    modelToCanonical.set(alias, canonical);
    canonicalToModel.set(canonical, alias);
  }
  return { modelToCanonical, canonicalToModel };
}

function inspectAndRepair(message: Record<string, unknown>, maps: ToolCallRepairMaps) {
  const issues = inspectToolCallProtocolIssues(message, maps.modelToCanonical);
  return { issues, result: repairToolCalls(message, issues, maps) };
}

describe("repairToolCalls — unsupported_name", () => {
  it("fuzzy-resolves a separator-fuzzed name onto an allowed canonical tool", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "browser-search", arguments: JSON.stringify({ query: "weather" }) },
        },
      ],
    };
    const { issues, result } = inspectAndRepair(message, maps);
    expect(issues.map((issue) => issue.kind)).toEqual(["unsupported_name"]);
    expect(result.unresolved).toHaveLength(0);
    expect(result.feedback).toHaveLength(0);
    expect(result.repaired).toEqual([
      { id: "call-1", toolName: "browser.search", args: { query: "weather" }, rawArguments: JSON.stringify({ query: "weather" }) },
    ]);
  });

  it("fuzzy-resolves a single-typo name via bounded Levenshtein", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "browser.serach", arguments: "{}" } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]?.toolName).toBe("browser.search");
  });

  it("resolves an alias name onto its canonical target", () => {
    const maps = makeMaps(["browser.search"], { search_web: "browser.search" });
    const message = {
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "Search-Web", arguments: JSON.stringify({ q: "x" }) } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired[0]?.toolName).toBe("browser.search");
    expect(result.unresolved).toHaveLength(0);
  });

  it("emits role:tool feedback (not a substituted call) when no allowed tool is close enough", () => {
    const maps = makeMaps(["browser.search", "memory.search"]);
    const message = {
      tool_calls: [
        { id: "call-9", type: "function", function: { name: "delete_production_database", arguments: "{}" } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
    expect(result.feedback).toHaveLength(1);
    const [feedback] = result.feedback;
    expect(feedback?.toolCallId).toBe("call-9");
    const payload = JSON.parse(feedback!.content) as Record<string, unknown>;
    expect(payload.error).toBe("unsupported_tool");
    // Feedback lists the valid tool names so the model can self-correct.
    expect(feedback!.content).toContain("browser.search");
    expect(feedback!.content).toContain("memory.search");
  });

  it("does not bind an ambiguous fuzzy match (two equally-close tools)", () => {
    // "toox" is edit-distance 1 from both "toola" and "toolb" after normalization.
    const maps = makeMaps(["toola", "toolb"]);
    const message = {
      tool_calls: [{ id: "call-1", type: "function", function: { name: "toox", arguments: "{}" } }],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired).toHaveLength(0);
    expect(result.unresolved).toHaveLength(1);
  });
});

describe("repairToolCalls — malformed_arguments", () => {
  it("salvages fenced + smart-quoted + trailing-comma JSON", () => {
    const maps = makeMaps(["browser.search"]);
    const rawArguments = '```json\n{ “query”: “gateway tests”, }\n```';
    const message = {
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "browser.search", arguments: rawArguments } },
      ],
    };
    const { issues, result } = inspectAndRepair(message, maps);
    expect(issues.map((issue) => issue.kind)).toEqual(["malformed_arguments"]);
    expect(result.unresolved).toHaveLength(0);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toMatchObject({
      id: "call-1",
      toolName: "browser.search",
      args: { query: "gateway tests" },
    });
    // rawArguments is re-serialized to clean JSON.
    expect(JSON.parse(result.repaired[0]!.rawArguments)).toEqual({ query: "gateway tests" });
  });

  it("extracts the first balanced object from surrounding prose", () => {
    const maps = makeMaps(["browser.search"]);
    const rawArguments = 'Here you go: {"query":"x"} hope that helps';
    const message = {
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "browser.search", arguments: rawArguments } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired[0]?.args).toEqual({ query: "x" });
  });

  it("falls back to feedback when nothing parseable remains", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "browser.search", arguments: "not json at all" } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired).toHaveLength(0);
    expect(result.feedback).toHaveLength(1);
    expect(JSON.parse(result.feedback[0]!.content).error).toBe("malformed_arguments");
  });
});

describe("repairToolCalls — non_object_arguments", () => {
  it("unwraps a one-element object array", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "browser.search", arguments: JSON.stringify([{ query: "x" }]) },
        },
      ],
    };
    const { issues, result } = inspectAndRepair(message, maps);
    expect(issues.map((issue) => issue.kind)).toEqual(["non_object_arguments"]);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]?.args).toEqual({ query: "x" });
  });

  it("feeds back when the array is not a single object", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      tool_calls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "browser.search", arguments: JSON.stringify(["a", "b"]) },
        },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired).toHaveLength(0);
    expect(JSON.parse(result.feedback[0]!.content).error).toBe("non_object_arguments");
  });
});

describe("repairToolCalls — missing_function / missing_name via serialized body", () => {
  it("promotes a prose-encoded <function=...> call from the message content", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      content:
        'I will search now. <function=browser.search><parameter=query>gateway coverage</parameter></function>',
      tool_calls: [{ id: "call-1", type: "function", function: { name: "" } }],
    };
    const { issues, result } = inspectAndRepair(message, maps);
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_name"]);
    expect(result.unresolved).toHaveLength(0);
    expect(result.repaired).toHaveLength(1);
    expect(result.repaired[0]).toMatchObject({
      toolName: "browser.search",
      args: { query: "gateway coverage" },
    });
  });

  it("feeds back when the body has no recoverable call", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      content: "Just some plain text with no tool markup.",
      tool_calls: [{ id: "call-1", type: "function" }],
    };
    const { issues, result } = inspectAndRepair(message, maps);
    expect(issues.map((issue) => issue.kind)).toEqual(["missing_function"]);
    expect(result.repaired).toHaveLength(0);
    expect(JSON.parse(result.feedback[0]!.content).error).toBe("missing_tool_name");
    expect(result.feedback[0]?.toolCallId).toBe("call-1");
  });
});

describe("repairToolCalls — valid calls pass through alongside repairs", () => {
  it("keeps an already-valid call and adds the repaired one", () => {
    const maps = makeMaps(["browser.search", "memory.search"]);
    const message = {
      tool_calls: [
        {
          id: "call-valid",
          type: "function",
          function: { name: "browser.search", arguments: JSON.stringify({ query: "ok" }) },
        },
        {
          id: "call-fuzzy",
          type: "function",
          function: { name: "memory-search", arguments: JSON.stringify({ query: "notes" }) },
        },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    const ids = result.repaired.map((call) => call.id).sort();
    expect(ids).toEqual(["call-fuzzy", "call-valid"]);
    expect(result.repaired.find((call) => call.id === "call-fuzzy")?.toolName).toBe("memory.search");
  });

  it("preserves arguments for an id-less call mixed with an id-bearing one (positional fallback)", () => {
    // Regression: a provider emitted a MIXED batch — one call carries an id, one
    // is id-less. inspect assigns the id-less call a fresh synthetic id, so it can
    // never match by id. Grouping must still pair it positionally, or the id-less
    // call loses its rawCall and its arguments are silently dropped (args:{}).
    const maps = makeMaps(["browser.search", "memory.search"]);
    const message = {
      tool_calls: [
        // id-bearing, fuzzed name -> matched by id
        {
          id: "call_1",
          type: "function",
          function: { name: "browser-search", arguments: JSON.stringify({ query: "weather" }) },
        },
        // id-LESS, fuzzed name -> synthetic id, must be matched positionally
        {
          type: "function",
          function: { name: "memory-search", arguments: JSON.stringify({ query: "notes" }) },
        },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.unresolved).toHaveLength(0);
    expect(result.feedback).toHaveLength(0);
    expect(result.repaired).toHaveLength(2);

    const idBearing = result.repaired.find((call) => call.id === "call_1");
    expect(idBearing).toMatchObject({ toolName: "browser.search", args: { query: "weather" } });

    // The id-less call keeps BOTH its resolved name and its arguments.
    const idLess = result.repaired.find((call) => call.id !== "call_1");
    expect(idLess?.toolName).toBe("memory.search");
    expect(idLess?.args).toEqual({ query: "notes" });
    expect(JSON.parse(idLess!.rawArguments)).toEqual({ query: "notes" });
  });
});

describe("repairToolCalls — fail-closed security invariant", () => {
  it("never executes anything when the registry is empty (deny-wins)", () => {
    const maps: ToolCallRepairMaps = { modelToCanonical: new Map(), canonicalToModel: new Map() };
    const message = {
      content: '<function=browser.search><parameter=query>x</parameter></function>',
      tool_calls: [
        { id: "call-1", type: "function", function: { name: "browser.search", arguments: "{}" } },
        { id: "call-2", type: "function", function: { name: "browser-search", arguments: "{not json" } },
        { id: "call-3", type: "function", function: { name: "", arguments: "{}" } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    expect(result.repaired).toHaveLength(0);
    // Every flagged issue is surfaced as feedback; nothing is silently executed.
    expect(result.unresolved.length).toBe(result.feedback.length);
    expect(result.feedback.length).toBeGreaterThan(0);
    for (const feedback of result.feedback) {
      expect(typeof feedback.toolCallId).toBe("string");
      expect(feedback.toolCallId.length).toBeGreaterThan(0);
      // content is valid JSON.
      expect(() => JSON.parse(feedback.content)).not.toThrow();
    }
  });

  it("fuzzy matching cannot resolve to a name outside the active schema", () => {
    const maps = makeMaps(["browser.search"]);
    // "browser.navigate" is plausibly close but NOT in the schema -> must miss.
    expect(fuzzyResolveAllowedToolName("browser.navigate", maps.modelToCanonical)).toBeUndefined();
    // Empty registry always fails closed.
    expect(fuzzyResolveAllowedToolName("browser.search", new Map())).toBeUndefined();
  });

  it("every feedback entry is a valid role:tool payload tied to its issue id", () => {
    const maps = makeMaps(["browser.search"]);
    const message = {
      tool_calls: [
        { id: "id-A", type: "function", function: { name: "totally_unknown", arguments: "{}" } },
        { id: "id-B", type: "function", function: { name: "browser.search", arguments: "}{ broken" } },
      ],
    };
    const { result } = inspectAndRepair(message, maps);
    const feedbackIds = result.feedback.map((entry) => entry.toolCallId).sort();
    expect(feedbackIds).toEqual(["id-A", "id-B"]);
    for (const entry of result.feedback) {
      expect(() => JSON.parse(entry.content)).not.toThrow();
    }
  });
});

describe("salvage helpers", () => {
  it("extractFirstBalancedObject ignores braces inside strings", () => {
    expect(extractFirstBalancedObject('{"a":"}{","b":1}')).toBe('{"a":"}{","b":1}');
    expect(extractFirstBalancedObject("no object here")).toBeUndefined();
  });

  it("salvageJsonObject returns undefined for non-objects", () => {
    expect(salvageJsonObject("[1,2,3]")).toBeUndefined();
    expect(salvageJsonObject("42")).toBeUndefined();
    expect(salvageJsonObject("")).toBeUndefined();
  });

  it("unwrapSingleObjectArray only unwraps single-object arrays", () => {
    expect(unwrapSingleObjectArray('[{"a":1}]')).toEqual({ a: 1 });
    expect(unwrapSingleObjectArray('[{"a":1},{"b":2}]')).toBeUndefined();
    expect(unwrapSingleObjectArray('{"a":1}')).toBeUndefined();
  });

  it("boundedLevenshtein short-circuits beyond the cap", () => {
    expect(boundedLevenshtein("abc", "abc", 2)).toBe(0);
    expect(boundedLevenshtein("abc", "abd", 2)).toBe(1);
    expect(boundedLevenshtein("abc", "xyz", 2)).toBe(3);
  });
});
