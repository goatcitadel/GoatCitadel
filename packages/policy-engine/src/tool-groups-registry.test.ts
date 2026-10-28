import { describe, expect, it } from "vitest";
import { TOOL_GROUPS } from "@goatcitadel/contracts";
import { createDefaultToolRegistry } from "./tool-registry.js";

const registryToolNames = createDefaultToolRegistry()
  .list()
  .map((tool) => tool.name);
const groupedToolNames = TOOL_GROUPS.flatMap((group) => group.toolNames);

describe("tool group map against the default tool registry", () => {
  it("puts every registry tool in exactly one group", () => {
    for (const toolName of registryToolNames) {
      expect(
        groupedToolNames.filter((name) => name === toolName),
        toolName,
      ).toHaveLength(1);
    }
  });

  it("names no tool the registry lacks", () => {
    const registered = new Set(registryToolNames);
    expect(groupedToolNames.filter((name) => !registered.has(name))).toEqual([]);
  });
});
